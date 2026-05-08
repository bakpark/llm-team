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
  it("drains a single approve signal and marks it processed", async () => {
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
    expect(out[0]?.kind).toBe("applied");

    // Second drain returns nothing — already in processed/.
    const out2 = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out2).toEqual([]);
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

  it("concurrent drops + drains do not lose signals", async () => {
    const store = new FsStore({ workdir: workdir() });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-08T00:00:00.000Z"));

    // Drop 10 envelopes concurrently.
    const drops = Array.from({ length: 10 }, (_, i) =>
      dropSignal(
        store,
        env({
          signal_id: `sig-${i}`,
          signal_type: "approve",
          related_object_id: "01HZSM0000000000000000000A",
          created_at: `2026-05-08T0${i}:00:00.000Z`,
        }),
      ),
    );
    await Promise.all(drops);

    // Two parallel drain invocations must collectively process exactly 10
    // envelopes (each may return 0–10 depending on timing, but the union
    // covers all signals once).
    const [a, b] = await Promise.all([
      runHumanSignalDrain({ store, signal: sig, clock }),
      runHumanSignalDrain({ store, signal: sig, clock }),
    ]);
    const seen = new Set([...a, ...b].map((o) => o.signal_id));
    expect(seen.size).toBe(10);

    // After both drains, processed/ holds 10 records and listPending is empty.
    const pending = await sig.listPending();
    expect(pending).toEqual([]);
  });

  it("processed marker uses processing_state field", async () => {
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
    await runHumanSignalDrain({ store, signal: sig, clock });

    const proc = JSON.parse(
      (await store.readText(layout.humanSignalProcessed("sig-1")))!,
    );
    expect(proc.processing_state).toBe("applied");
    expect(proc.envelope.signal_id).toBe("sig-1");
  });
});
