/**
 * Phase 5a: human-signal drain concurrency + idempotency.
 *
 * Validates:
 *   1. Concurrent drops + drain don't lose signals or race the processed/ marker
 *   2. Idempotent drain: re-running with the same envelopes produces zero
 *      outcomes (already processed).
 *   3. Invalid envelopes get marked invalid.
 *   4. Sort order is created_at asc.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FsHumanSignal } from "../../src/adapters/human-signal/fs.js";
import { FixedClock } from "../../src/ports/clock.js";
import {
  dropSignal,
  runHumanSignalDrain,
} from "../../src/application/human-signal-drain.js";
import { HumanSignalEnvelope } from "../../src/domain/schema/human-signal.js";
import { layout } from "../../src/application/persistence-layout.js";

function env(
  partial: Partial<HumanSignalEnvelope> & {
    signal_id: string;
    signal_type: HumanSignalEnvelope["signal_type"];
  },
): HumanSignalEnvelope {
  return HumanSignalEnvelope.parse({
    target_kind: "milestone",
    target_id: "01HZM00000000000000000000A",
    actor: "alice",
    created_at: "2026-05-08T00:00:00.000Z",
    source: "fs_drop",
    ...partial,
  });
}

function workdir() {
  return mkdtempSync(join(tmpdir(), "hsd-"));
}

describe("human-signal drain (Phase 5a)", () => {
  it("defers a single approve signal when no binding caller is supplied", async () => {
    // PR #74 codex P0 (gpt5.5): bindable signals (approve/reject/request_rework)
    // drained without binding deps stay pending and emit `deferred` so the
    // outer-coordinator's next cycle picks them up. Pre-PR-74 behavior was
    // markProcessed=applied which silently consumed the signal.
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    await dropSignal(
      store,
      env({
        signal_id: "sig-1",
        signal_type: "approve",
        related_object_id: "01HZSM0000000000000000000A",
      }),
    );

    const out = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("deferred");

    // Signal stays pending — listPending re-emits on next cycle.
    const stillPending = await sig.listPending();
    expect(stillPending.length).toBe(1);
    expect(stillPending[0]?.signal_id).toBe("sig-1");
  });

  it("rejects approve without related_object_id as invalid", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    await dropSignal(
      store,
      env({ signal_id: "sig-1", signal_type: "approve" }),
    );

    const out = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("invalid");
    if (out[0]?.kind === "invalid") {
      expect(out[0].reason).toMatch(/related_object_id/);
    }
  });

  it("rejects pause with non-system target as invalid", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    await dropSignal(
      store,
      env({ signal_id: "sig-1", signal_type: "pause" }),
    );

    const out = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("invalid");
  });

  it("orders by created_at asc", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    await dropSignal(
      store,
      env({
        signal_id: "later",
        signal_type: "approve",
        related_object_id: "01HZSM0000000000000000000A",
        created_at: "2026-05-08T02:00:00.000Z",
      }),
    );
    await dropSignal(
      store,
      env({
        signal_id: "earlier",
        signal_type: "approve",
        related_object_id: "01HZSM0000000000000000000A",
        created_at: "2026-05-08T01:00:00.000Z",
      }),
    );

    const out = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out.map((o) => o.signal_id)).toEqual(["earlier", "later"]);
  });

  it("concurrent drops + drains do not lose or duplicate signals (P0-2 regression)", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    // PR #74 codex P0: use a non-bindable signal type so the markProcessed
    // lock guard is exercised here. Bindable types (approve/reject/request_rework)
    // are deferred when no binding caller is supplied — see the dedicated
    // "defers a single approve signal" test above.
    const drops = Array.from({ length: 10 }, (_, i) =>
      dropSignal(
        store,
        env({
          signal_id: `sig-${i}`,
          signal_type: "request_recover",
          created_at: `2026-05-08T0${i}:00:00.000Z`,
        }),
      ),
    );
    await Promise.all(drops);

    // Force interleaving: both drains share the same pending snapshot so
    // markProcessed lock + already-processed check is exercised.
    const drainWithYield = async () => {
      // Yield once before draining so that the two drain loops actually
      // interleave inside the for-loop instead of one running to completion.
      await new Promise((r) => setImmediate(r));
      return runHumanSignalDrain({ store, signal: sig, clock });
    };
    const [a, b] = await Promise.all([drainWithYield(), drainWithYield()]);

    // Total outcomes must equal 10 — neither lost (< 10) nor duplicated
    // (> 10). Per signal_id we expect exactly one outcome emission.
    const all = [...a, ...b];
    expect(all.length).toBe(10);
    const ids = all.map((o) => o.signal_id);
    expect(new Set(ids).size).toBe(10);

    // After both drains, processed/ holds 10 records and listPending is empty.
    const pending = await sig.listPending();
    expect(pending).toEqual([]);
  });

  it("filename ↔ envelope.signal_id mismatch is quarantined (P0-1)", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    // Manually write a file named foo.json containing signal_id="bar".
    const envelope = env({
      signal_id: "bar",
      signal_type: "approve",
      related_object_id: "01HZSM0000000000000000000A",
    });
    await store.writeAtomic(
      "human_signals/foo.json",
      JSON.stringify(envelope, null, 2),
    );

    // First drain must NOT process it; instead it gets quarantined.
    const out = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out).toEqual([]);

    // foo.json moved to quarantine/, no processed/ entries.
    expect(await store.exists("human_signals/foo.json")).toBe(false);
    expect(await store.exists("human_signals/quarantine/foo.json")).toBe(true);
    expect(await store.exists("human_signals/processed/bar.json")).toBe(false);

    // Re-drain is also a noop (quarantine path is outside scan).
    const out2 = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out2).toEqual([]);
  });

  it("corrupt envelope is quarantined (P1-4)", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    await store.writeAtomic(
      "human_signals/garbage.json",
      "{ not valid json",
    );

    const out = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out).toEqual([]);
    expect(await store.exists("human_signals/garbage.json")).toBe(false);
    expect(await store.exists("human_signals/quarantine/garbage.json")).toBe(
      true,
    );
  });

  it("processed marker uses processing_state field", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    // PR #74 codex P0: use a non-bindable signal so the drain marks it
    // processed (bindable types defer without a binding caller).
    await dropSignal(
      store,
      env({
        signal_id: "sig-1",
        signal_type: "request_recover",
      }),
    );
    await runHumanSignalDrain({ store, signal: sig, clock });

    const proc = JSON.parse(
      (await store.readText(layout.humanSignalProcessed("sig-1")))!,
    );
    expect(proc.processing_state).toBe("applied");
    expect(proc.envelope.signal_id).toBe("sig-1");
  });
});
