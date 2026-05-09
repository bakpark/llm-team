/**
 * RGC-SIGNALS — daemon control state machine (Phase 7b).
 *
 * Persists `<workdir>/control/state.json` and provides:
 *   - readControlState  : load the current record (RUNNING default if absent).
 *   - applyControlSignal: apply pause/resume/stop transitions inside a lock,
 *                         idempotent on (signal_id, signal_type).
 *   - runDaemonPrelude  : the single helper every daemon role invokes before
 *                         pickup — drains pending human signals (which feeds
 *                         control transitions back through this module) and
 *                         then reports the gate outcome (proceed / paused /
 *                         stopped). Emits the `paused` noop ledger row when
 *                         the gate blocks pickup.
 *
 * Transition table (RGC-SIGNALS, Inv #4 / #8):
 *   RUNNING --pause--> PAUSED
 *   PAUSED  --resume--> RUNNING
 *   RUNNING|PAUSED --stop--> STOPPED  (terminal)
 *
 *   STOPPED is immutable; subsequent pause/resume/stop signals are accepted
 *   (markProcessed=applied) but produce no further transitions.
 *   pause from PAUSED, resume from RUNNING, and any duplicate signal_id are
 *   no-ops as well.
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  ControlStateRecord,
  type ControlState,
  type ControlStateRecord as ControlStateRecordT,
} from "../domain/schema/control-state.js";
import type { HumanSignalEnvelope } from "../domain/schema/human-signal.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";

export const CONTROL_STATE_PATH = "control/state.json";

/** Sentinel signal_id for the implicit RUNNING default. */
const DEFAULT_SIGNAL_ID = "system:default";
const DEFAULT_ACTOR = "system";

const DEFAULT_RECORD = (isoNow: string): ControlStateRecordT =>
  ControlStateRecord.parse({
    state: "RUNNING",
    changed_at: isoNow,
    changed_by: DEFAULT_ACTOR,
    signal_id: DEFAULT_SIGNAL_ID,
  });

/**
 * Read the current control state. Returns the implicit RUNNING default when
 * the file is absent — daemons must not crash on a fresh workdir.
 */
export async function readControlState(
  store: StorePort,
  clock: ClockPort,
): Promise<ControlStateRecordT> {
  const body = await store.readText(CONTROL_STATE_PATH);
  if (body == null) return DEFAULT_RECORD(clock.isoNow());
  try {
    return ControlStateRecord.parse(JSON.parse(body));
  } catch {
    // Corrupt file — fall back to RUNNING default (operator can inspect the
    // raw file on disk to recover). The next pause/resume/stop signal will
    // overwrite it.
    return DEFAULT_RECORD(clock.isoNow());
  }
}

export type ApplyControlOutcome =
  | { kind: "transitioned"; from: ControlState; to: ControlState }
  | { kind: "noop"; state: ControlState; reason: string };

/**
 * PR #74 codex P1 (gpt5.5): when an audit context is supplied, a successful
 * control transition emits a `pause_resume` ledger row with `result=applied`
 * so PAUSED→RUNNING etc. are visible in the audit trail (the prelude only
 * emits `result=noop` when the gate blocks pickup).
 */
export interface ControlAuditContext {
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

const NEXT_STATE: Record<
  "pause" | "resume" | "stop",
  (from: ControlState) => ControlState | { reason: string }
> = {
  pause: (from) => (from === "RUNNING" ? "PAUSED" : { reason: `cannot pause from ${from}` }),
  resume: (from) => (from === "PAUSED" ? "RUNNING" : { reason: `cannot resume from ${from}` }),
  stop: (from) => (from === "STOPPED" ? { reason: "already STOPPED" } : "STOPPED"),
};

/**
 * Apply a pause/resume/stop signal under the control-state file lock. Any
 * other signal_type is rejected by the type system at the call site.
 *
 * Idempotent on signal_id: re-applying the same envelope is a noop, so the
 * drain caller can safely re-emit if markProcessed lost the previous race.
 */
export async function applyControlSignal(
  store: StorePort,
  clock: ClockPort,
  signal: HumanSignalEnvelope,
  audit?: ControlAuditContext,
): Promise<ApplyControlOutcome> {
  const t = signal.signal_type;
  if (t !== "pause" && t !== "resume" && t !== "stop") {
    return {
      kind: "noop",
      state: "RUNNING",
      reason: `signal_type=${t} is not a control signal`,
    };
  }
  const outcome = await store.withFileLock(CONTROL_STATE_PATH, async () => {
    const current = await readControlState(store, clock);
    if (current.signal_id === signal.signal_id) {
      return {
        kind: "noop",
        state: current.state,
        reason: "duplicate signal_id",
      } as const;
    }
    const candidate = NEXT_STATE[t](current.state);
    if (typeof candidate !== "string") {
      return {
        kind: "noop",
        state: current.state,
        reason: candidate.reason,
      } as const;
    }
    if (candidate === current.state) {
      return {
        kind: "noop",
        state: current.state,
        reason: "no-op transition",
      } as const;
    }
    const record = ControlStateRecord.parse({
      state: candidate,
      changed_at: clock.isoNow(),
      changed_by: signal.actor,
      signal_id: signal.signal_id,
    });
    await store.writeAtomic(CONTROL_STATE_PATH, JSON.stringify(record, null, 2));
    return {
      kind: "transitioned",
      from: current.state,
      to: candidate,
    } as const;
  });
  // PR #74 codex P1: emit an `applied` ledger row for actual transitions
  // so the audit trail captures pause/resume/stop firings (the prelude only
  // emits `noop` rows for non-RUNNING gate hits).
  if (outcome.kind === "transitioned" && audit != null) {
    const idem = idempotencyKey({
      scope: "pause_resume",
      parts: {
        signal_id: signal.signal_id,
        from: outcome.from,
        to: outcome.to,
      },
    });
    await audit.ledger.appendTransition({
      transition_id: newMonotonicId(clock.now()),
      target_id: audit.targetId,
      object_id: "system",
      object_kind: "system",
      from_state: outcome.from,
      to_state: outcome.to,
      loop_kind: null,
      phase: null,
      slice_id: null,
      slice_kind: null,
      dod_revision: null,
      session_id: null,
      turn_index: null,
      slot_kind: null,
      agent_profile_id: null,
      contribution_kind: null,
      action_kind: "pause_resume",
      final_verdict: null,
      caller_id: audit.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: idem,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: `signal_type=${t}:signal_id=${signal.signal_id}`,
      timestamp: clock.isoNow(),
    });
  }
  return outcome;
}

export interface DaemonPreludeDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
  /** Daemon role label (turn-worker / dialogue-coordinator / ...) recorded
   *  in the noop ledger row's result_detail for operator visibility. */
  role: string;
}

export type DaemonPreludeOutcome =
  | { action: "proceed"; state: "RUNNING" }
  | { action: "paused"; state: "PAUSED" }
  | { action: "stopped"; state: "STOPPED" };

/**
 * Daemon pre-pickup gate. Reads the current control state and, when
 * non-RUNNING, emits a `pause_resume` ledger row capturing the noop pickup.
 * The drain itself runs *outside* this helper so callers can supply the
 * binding deps appropriate to the role (5b.2 outer binding etc.).
 */
export async function runDaemonPrelude(
  deps: DaemonPreludeDeps,
): Promise<DaemonPreludeOutcome> {
  const current = await readControlState(deps.store, deps.clock);
  if (current.state === "RUNNING") {
    return { action: "proceed", state: "RUNNING" };
  }
  const action = current.state === "PAUSED" ? "paused" : "stopped";
  // RGC-SIGNALS: emit a noop row so operators see the gate firing. The
  // idempotency key folds together (role, signal_id, state) so a daemon
  // looping while paused does not flood the ledger with duplicates per
  // signal — but a *new* pause signal will produce a new row.
  const idem = idempotencyKey({
    scope: "pause_resume",
    parts: {
      role: deps.role,
      state: current.state,
      signal_id: current.signal_id,
    },
  });
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: "system",
    object_kind: "system",
    from_state: null,
    to_state: current.state,
    loop_kind: null,
    phase: null,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "pause_resume",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idem,
    lease_token: null,
    lease_kind: null,
    result: "noop",
    result_detail: `paused:role=${deps.role}:signal_id=${current.signal_id}`,
    timestamp: deps.clock.isoNow(),
  });
  return action === "paused"
    ? { action: "paused", state: "PAUSED" }
    : { action: "stopped", state: "STOPPED" };
}
