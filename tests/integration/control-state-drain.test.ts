/**
 * Phase 7b — drain wiring for the control-state machine.
 *
 * Validates RGC-SIGNALS pause/resume/stop envelopes pulled by the FS adapter
 * drive `<workdir>/control/state.json` only when `applyControlState: true`.
 * Phase-5a callers (no opt-in) still see envelope-only persistence — the
 * legacy contract.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsHumanSignal } from "../../src/adapters/human-signal/fs.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import {
  CONTROL_STATE_PATH,
  readControlState,
} from "../../src/application/control-state.js";
import {
  dropSignal,
  runHumanSignalDrain,
} from "../../src/application/human-signal-drain.js";
import {
  HumanSignalEnvelope,
  type HumanSignalEnvelope as HumanSignalEnvelopeT,
} from "../../src/domain/schema/human-signal.js";
import { FixedClock } from "../../src/ports/clock.js";

function workdir() {
  return mkdtempSync(join(tmpdir(), "control-drain-"));
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

describe("drain — control-state apply (Phase 7b)", () => {
  it("pause envelope drives RUNNING → PAUSED when applyControlState=true", async () => {
    const w = workdir();
    const store = new FsStore({ workdir: w });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));

    await dropSignal(
      store,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    const out = await runHumanSignalDrain({
      store,
      signal: sig,
      clock,
      applyControlState: true,
    });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("applied");
    if (out[0]?.kind === "applied") {
      expect(out[0].control?.kind).toBe("transitioned");
    }
    expect((await readControlState(store, clock)).state).toBe("PAUSED");
  });

  it("legacy callers (applyControlState omitted) leave control state untouched", async () => {
    const w = workdir();
    const store = new FsStore({ workdir: w });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));

    await dropSignal(
      store,
      controlSignal({ signal_id: "sig-pause", signal_type: "pause" }),
    );
    const out = await runHumanSignalDrain({ store, signal: sig, clock });
    expect(out.length).toBe(1);
    if (out[0]?.kind === "applied") {
      expect(out[0].control).toBeUndefined();
    }
    // No state.json written.
    expect(await store.exists(CONTROL_STATE_PATH)).toBe(false);
  });

  it("stop envelope drives RUNNING → STOPPED", async () => {
    const w = workdir();
    const store = new FsStore({ workdir: w });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));

    await dropSignal(
      store,
      controlSignal({ signal_id: "sig-stop", signal_type: "stop" }),
    );
    await runHumanSignalDrain({
      store,
      signal: sig,
      clock,
      applyControlState: true,
    });
    expect((await readControlState(store, clock)).state).toBe("STOPPED");
  });

  it("stop with non-system target is invalid (envelope validation rejects)", async () => {
    const w = workdir();
    const store = new FsStore({ workdir: w });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));

    await dropSignal(
      store,
      controlSignal({
        signal_id: "sig-stop",
        signal_type: "stop",
        target_kind: "milestone",
        target_id: "01HZM00000000000000000000A",
      }),
    );
    const out = await runHumanSignalDrain({
      store,
      signal: sig,
      clock,
      applyControlState: true,
    });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("invalid");
    // Control state stays at RUNNING (default).
    expect((await readControlState(store, clock)).state).toBe("RUNNING");
  });

  it("pause then resume in one drain restores RUNNING", async () => {
    const w = workdir();
    const store = new FsStore({ workdir: w });
    const sig = new FsHumanSignal(store);
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));

    await dropSignal(
      store,
      controlSignal({
        signal_id: "sig-pause",
        signal_type: "pause",
        created_at: "2026-05-09T00:01:00.000Z",
      }),
    );
    await dropSignal(
      store,
      controlSignal({
        signal_id: "sig-resume",
        signal_type: "resume",
        created_at: "2026-05-09T00:02:00.000Z",
      }),
    );
    const out = await runHumanSignalDrain({
      store,
      signal: sig,
      clock,
      applyControlState: true,
    });
    expect(out.length).toBe(2);
    expect((await readControlState(store, clock)).state).toBe("RUNNING");
  });
});
