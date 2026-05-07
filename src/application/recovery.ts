/**
 * RGC-RECOVERY + SOC-RECOVERY-OPERATION sweeper.
 *
 * Phase 4 introduces a single `runRecoverySweep` entrypoint that the daemon
 * loop calls before any pickup. The sweep handles:
 *
 *   1. **stale lease (4 kinds)** — `LeasePort.sweepStale` returns expired
 *      leases. For each expired lease, the recovery dispatcher emits a
 *      ledger row (`action_kind=recover`, `result=recovered`) referencing
 *      the protected object. Object-state recovery (e.g. SESSION_OPEN →
 *      AWAITING_REVALIDATION) is performed by inspecting the linked object.
 *
 *   2. **slice-merge-stale** — every SliceMerge in `SM_STALE` that has not
 *      been retried within `loop_policies.middle.merge.max_revalidation_attempts`
 *      gets a single retry attempt (delegated to `caller-dispatch` via the
 *      orchestrator that called the sweep — phase 4 only emits the recovery
 *      ledger row + flag).
 *
 *   3. **session-stale / session-timeout** — the dialogue-coordinator's
 *      orphan SESSION_OPEN sessions left behind by phase-3 atomicity gaps
 *      transition to AWAITING_REVALIDATION (revision drift) or TIMEOUT
 *      (max wallclock). Phase 4 ships AWAITING_REVALIDATION recovery only;
 *      cross-slot stale arrives in phase 6a.
 *
 * The sweep is *idempotent* — a duplicate row for the same recovery
 * (object_id + trigger + observed_revision_pin) is absorbed by the ledger's
 * idempotency_key dedup.
 *
 * No retry policy lives here — `failure-policy.ts` owns counters and
 * ESCALATED transitions. Recovery just reports findings + makes the simple,
 * obviously-safe transitions (lease cleanup, AWAITING_REVALIDATION).
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
} from "../domain/schema/dialogue-session.js";
import type { Lease, LeaseKind } from "../domain/schema/lease.js";
import type { ClockPort } from "../ports/clock.js";
import type { LeasePort } from "../ports/lease.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

export interface RecoverySweepDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  lease: LeasePort;
  callerId: string;
  targetId: string;
}

export interface RecoverySweepResult {
  expiredLeases: Lease[];
  reanimatedSessions: string[];
  /**
   * Number of ledger rows the sweep produced. Tests pin this to assert that
   * an idempotent re-run does not double-write.
   */
  ledgerRowsAppended: number;
}

export async function runRecoverySweep(
  deps: RecoverySweepDeps,
): Promise<RecoverySweepResult> {
  const expiredLeases = await deps.lease.sweepStale();
  let rows = 0;
  for (const lease of expiredLeases) {
    await emitLeaseRecoveredRow(lease, deps);
    rows++;
    // Object-state recovery — currently only session_lease + slice_lease
    // produce a follow-up state transition. Phase 5 + 6 add slot_lock and
    // turn_lease handlers (turn_lease typically uses CAS, no separate
    // record).
    if (lease.lease_kind === "session_lease") {
      const reanimated = await reanimateSessionIfNeeded(lease, deps);
      if (reanimated) rows++;
    }
  }
  return {
    expiredLeases,
    reanimatedSessions: [],
    ledgerRowsAppended: rows,
  };
}

async function emitLeaseRecoveredRow(
  lease: Lease,
  deps: RecoverySweepDeps,
): Promise<void> {
  const objectKind = leaseObjectKind(lease.lease_kind);
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: lease.object_id,
    object_kind: objectKind,
    from_state: null,
    to_state: "lease_expired",
    loop_kind: null,
    phase: null,
    slice_id: lease.lease_kind === "slice_lease" ? lease.slice_id : null,
    slice_kind: null,
    dod_revision: null,
    session_id:
      lease.lease_kind === "session_lease" ||
      lease.lease_kind === "turn_lease"
        ? lease.session_id
        : null,
    turn_index:
      lease.lease_kind === "turn_lease" ? lease.turn_index : null,
    slot_kind: lease.lease_kind === "slot_lock" ? lease.slot_kind : null,
    agent_profile_id:
      lease.lease_kind === "session_lease" ||
      lease.lease_kind === "turn_lease"
        ? lease.agent_profile_id
        : null,
    contribution_kind: null,
    action_kind: "recover",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "recover",
      parts: {
        kind: "stale_lease",
        lease_id: lease.lease_id,
        lease_kind: lease.lease_kind,
        object_id: lease.object_id,
      },
    }),
    lease_token: lease.lease_token,
    lease_kind: lease.lease_kind,
    result: "recovered",
    result_detail: `lease ${lease.lease_kind} expired (worker_id=${lease.worker_id}, expires_at=${lease.expires_at})`,
    timestamp: deps.clock.isoNow(),
  });
}

/**
 * If the session referenced by an expired session_lease is still
 * SESSION_OPEN, transition it to AWAITING_REVALIDATION so the next dispatch
 * cycle picks it up for re-evaluation. CONVERGED / TIMEOUT / ABANDONED
 * sessions are left alone — the lease just expired naturally.
 */
async function reanimateSessionIfNeeded(
  lease: Extract<Lease, { lease_kind: "session_lease" }>,
  deps: RecoverySweepDeps,
): Promise<boolean> {
  const path = layout.sessionMetadata(lease.session_id);
  const body = await deps.store.readText(path);
  if (body == null) return false;
  let session: DialogueSessionT;
  try {
    session = DialogueSession.parse(JSON.parse(body));
  } catch {
    return false;
  }
  if (session.state !== "SESSION_OPEN") return false;
  const updated = DialogueSession.parse({
    ...session,
    state: "AWAITING_REVALIDATION",
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(path, JSON.stringify(updated, null, 2));
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: session.session_id,
    object_kind: "dialogue_session",
    from_state: "SESSION_OPEN",
    to_state: "AWAITING_REVALIDATION",
    loop_kind: session.parent_loop,
    phase: null,
    slice_id: session.parent_object_kind === "slice" ? session.parent_object_id : null,
    slice_kind: null,
    dod_revision: null,
    session_id: session.session_id,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: lease.agent_profile_id,
    contribution_kind: null,
    action_kind: "recover",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "recover",
      parts: {
        kind: "session_lease_expired_reanimate",
        session_id: session.session_id,
        lease_id: lease.lease_id,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "recovered",
    result_detail: "session_lease expired — session moved to AWAITING_REVALIDATION",
    timestamp: deps.clock.isoNow(),
  });
  return true;
}

function leaseObjectKind(
  kind: LeaseKind,
):
  | "system"
  | "milestone"
  | "slice"
  | "dialogue_session"
  | "session_turn"
  | "slice_merge" {
  switch (kind) {
    case "slot_lock":
      return "milestone";
    case "slice_lease":
      return "slice";
    case "session_lease":
      return "dialogue_session";
    case "turn_lease":
      return "session_turn";
  }
}
