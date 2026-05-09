/**
 * Phase 7b (G1-4) — daemon control state machine + prelude.
 *
 * Covers RGC-SIGNALS / Inv #4 / #8 transitions:
 *   - default RUNNING when state.json missing
 *   - pause: RUNNING → PAUSED, idempotent on duplicate signal_id
 *   - resume: PAUSED → RUNNING
 *   - stop: terminal (RUNNING|PAUSED → STOPPED, no further transitions)
 *   - prelude noop ledger row when paused, graceful shutdown gate when
 *     stopped.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsStore } from "../../src/adapters/store/fs.js";
import {
  CONTROL_STATE_PATH,
  applyControlSignal,
  readControlState,
  runDaemonPrelude,
} from "../../src/application/control-state.js";
import { FileLedger } from "../../src/application/ledger.js";
import { LEDGER_TRANSITIONS_PATH } from "../../src/application/persistence-layout.js";
import {
  HumanSignalEnvelope,
  type HumanSignalEnvelope as HumanSignalEnvelopeT,
} from "../../src/domain/schema/human-signal.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { FixedClock } from "../../src/ports/clock.js";

function workdir() {
  return mkdtempSync(join(tmpdir(), "control-state-"));
}

function controlSignal(
  partial: Partial<HumanSignalEnvelopeT> & {
    signal_id: string;
    signal_type: "pause" | "resume" | "stop";
  },
): HumanSignalEnvelopeT {
  return HumanSignalEnvelope.parse({
    target_kind: "system",
    target_id: "system",
    actor: "operator",
    created_at: "2026-05-09T00:00:00.000Z",
    source: "fs_drop",
    ...partial,
  });
}

function makeLedger(store: FsStore) {
  return new FileLedger({ store, auditHashSeed: "seed-7b" });
}

async function readLedgerRows(store: FsStore): Promise<LedgerRow[]> {
  const body = await store.readText(LEDGER_TRANSITIONS_PATH);
  if (body == null) return [];
  return body
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => LedgerRow.parse(JSON.parse(s)));
}

describe("readControlState", () => {
  it("returns RUNNING default when state.json missing", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const rec = await readControlState(store, clock);
    expect(rec.state).toBe("RUNNING");
    expect(rec.signal_id).toBe("system:default");
    expect(rec.changed_by).toBe("system");
  });

  it("falls back to RUNNING default on corrupt state.json", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    await store.writeAtomic(CONTROL_STATE_PATH, "{ not json");
    const rec = await readControlState(store, clock);
    expect(rec.state).toBe("RUNNING");
  });
});

describe("applyControlSignal", () => {
  it("RUNNING --pause--> PAUSED", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const out = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    expect(out).toEqual({ kind: "transitioned", from: "RUNNING", to: "PAUSED" });
    const rec = await readControlState(store, clock);
    expect(rec.state).toBe("PAUSED");
    expect(rec.signal_id).toBe("sig-pause");
    expect(rec.changed_by).toBe("operator");
  });

  it("duplicate signal_id is a noop (idempotent)", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const env = controlSignal({ signal_id: "sig-pause", signal_type: "pause" });
    await applyControlSignal(store, clock, env);
    const second = await applyControlSignal(store, clock, env);
    expect(second.kind).toBe("noop");
    if (second.kind === "noop") {
      expect(second.reason).toMatch(/duplicate/);
      expect(second.state).toBe("PAUSED");
    }
  });

  it("pause from PAUSED is a noop with reason", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    const out = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause-2", signal_type: "pause" }),
    );
    expect(out.kind).toBe("noop");
    if (out.kind === "noop") expect(out.reason).toMatch(/cannot pause/);
  });

  it("PAUSED --resume--> RUNNING", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    const out = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-resume", signal_type: "resume" }),
    );
    expect(out).toEqual({ kind: "transitioned", from: "PAUSED", to: "RUNNING" });
    expect((await readControlState(store, clock)).state).toBe("RUNNING");
  });

  it("resume from RUNNING is a noop", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const out = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-resume", signal_type: "resume" }),
    );
    expect(out.kind).toBe("noop");
    if (out.kind === "noop") expect(out.reason).toMatch(/cannot resume/);
  });

  it("RUNNING --stop--> STOPPED (terminal)", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const out = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-stop", signal_type: "stop" }),
    );
    expect(out).toEqual({ kind: "transitioned", from: "RUNNING", to: "STOPPED" });
    // pause / resume after stop are noops — STOPPED is immutable.
    const p = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    expect(p.kind).toBe("noop");
    const r = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-resume", signal_type: "resume" }),
    );
    expect(r.kind).toBe("noop");
    const s2 = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-stop-2", signal_type: "stop" }),
    );
    expect(s2.kind).toBe("noop");
    if (s2.kind === "noop") expect(s2.reason).toMatch(/already STOPPED/);
    expect((await readControlState(store, clock)).state).toBe("STOPPED");
  });

  it("PAUSED --stop--> STOPPED", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    const out = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-stop", signal_type: "stop" }),
    );
    expect(out).toEqual({ kind: "transitioned", from: "PAUSED", to: "STOPPED" });
  });

  it("PR #74 codex P1: emits applied ledger row for actual transitions when audit context supplied", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = makeLedger(store);
    // Pause first.
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
      { ledger, callerId: "test-caller", targetId: "test-target" },
    );
    // Resume — this transition was previously invisible in the ledger.
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-resume", signal_type: "resume" }),
      { ledger, callerId: "test-caller", targetId: "test-target" },
    );
    const rows = await readLedgerRows(store);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      action_kind: "pause_resume",
      result: "applied",
      from_state: "RUNNING",
      to_state: "PAUSED",
    });
    expect(rows[1]).toMatchObject({
      action_kind: "pause_resume",
      result: "applied",
      from_state: "PAUSED",
      to_state: "RUNNING",
    });
  });

  it("PR #74 codex P1: noop transitions do NOT emit an applied ledger row", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = makeLedger(store);
    // resume from RUNNING is a noop.
    const out = await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-resume", signal_type: "resume" }),
      { ledger, callerId: "test-caller", targetId: "test-target" },
    );
    expect(out.kind).toBe("noop");
    expect(await readLedgerRows(store)).toEqual([]);
  });
});

describe("runDaemonPrelude", () => {
  it("RUNNING → proceed, no ledger row", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = makeLedger(store);
    const out = await runDaemonPrelude({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "test-target",
      role: "turn-worker",
    });
    expect(out).toEqual({ action: "proceed", state: "RUNNING" });
    expect(await readLedgerRows(store)).toEqual([]);
  });

  it("PAUSED → emits noop ledger row with action_kind=pause_resume", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = makeLedger(store);
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    const out = await runDaemonPrelude({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "test-target",
      role: "turn-worker",
    });
    expect(out).toEqual({ action: "paused", state: "PAUSED" });
    const rows = await readLedgerRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0]?.action_kind).toBe("pause_resume");
    expect(rows[0]?.result).toBe("noop");
    expect(rows[0]?.to_state).toBe("PAUSED");
    expect(rows[0]?.object_kind).toBe("system");
    expect(rows[0]?.result_detail).toMatch(/role=turn-worker/);
    expect(rows[0]?.result_detail).toMatch(/sig-pause/);
  });

  it("PAUSED noop is idempotent across daemon loops (same signal_id)", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = makeLedger(store);
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    await runDaemonPrelude({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "test-target",
      role: "turn-worker",
    });
    await runDaemonPrelude({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "test-target",
      role: "turn-worker",
    });
    const rows = await readLedgerRows(store);
    // Both rows persist as `noop` — the ledger's dedup only folds
    // applied/recovered/rolled_back/escalated. Operators see one row per
    // loop they spent paused, but the shared idempotency_key keeps the
    // audit trail traceable to a single signal.
    expect(rows.length).toBe(2);
    expect(rows[0]?.result).toBe("noop");
    expect(rows[1]?.result).toBe("noop");
    expect(rows[0]?.idempotency_key).toBe(rows[1]?.idempotency_key);
  });

  it("a different role with the same paused signal emits its own noop row", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = makeLedger(store);
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    await runDaemonPrelude({
      store,
      clock,
      ledger,
      callerId: "tw",
      targetId: "test-target",
      role: "turn-worker",
    });
    await runDaemonPrelude({
      store,
      clock,
      ledger,
      callerId: "dc",
      targetId: "test-target",
      role: "dialogue-coordinator",
    });
    const rows = await readLedgerRows(store);
    expect(rows.map((r) => r.result)).toEqual(["noop", "noop"]);
    expect(rows[0]?.result_detail).toMatch(/role=turn-worker/);
    expect(rows[1]?.result_detail).toMatch(/role=dialogue-coordinator/);
  });

  it("STOPPED → action=stopped (caller graceful-exits)", async () => {
    const store = new FsStore({ workdir: workdir() });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = makeLedger(store);
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-stop", signal_type: "stop" }),
    );
    const out = await runDaemonPrelude({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "test-target",
      role: "turn-worker",
    });
    expect(out).toEqual({ action: "stopped", state: "STOPPED" });
    const rows = await readLedgerRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0]?.to_state).toBe("STOPPED");
  });
});
