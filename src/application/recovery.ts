/**
 * RGC-RECOVERY + SOC-RECOVERY-OPERATION sweeper.
 *
 * Phase 4 ships a single `runRecoverySweep` entrypoint that the daemon
 * loop calls before any pickup. Scope of phase-4 implementation:
 *
 *   - **stale lease (all 4 kinds)** detected via `LeasePort.sweepStale`.
 *     Each expired lease produces an `action_kind=recover, result=recovered`
 *     ledger row (idempotency key `recover|kind=stale_lease|...`).
 *
 *   - **session_lease + SESSION_OPEN** → AWAITING_REVALIDATION. The
 *     dialogue-coordinator's middle-review session_lease wire-up (PR #63
 *     review fix) is the primary producer of recoverable orphans.
 *
 * Out of scope for phase 4 (deferred per plan):
 *
 *   - slice-merge-stale auto-retry (phase 5 — failure-policy + caller-dispatch
 *     wiring)
 *   - cross-slot stale (phase 6a)
 *   - slot_lock recovery (phase 6a — slot_lock is only claimed by the
 *     dual-track scheduler)
 *   - turn_lease recovery (turn_lease is typically replaced by turn_index
 *     CAS — the schema field exists for completeness)
 *
 * Atomicity sequence (PR #63 review P0-2 + P0-4):
 *
 *   1. `lease.sweepStale()` returns expired leases WITHOUT clearing.
 *   2. for each lease: emit ledger `recover` row.
 *   3. for session_lease: read-check-write the session under
 *      `withFileLock(sessionMetadata)` to AWAITING_REVALIDATION + emit a
 *      second ledger row.
 *   4. `lease.clearExpired()` drops the active slot.
 *
 * Crash between any two steps is recoverable on the next sweep — the
 * ledger replay's recover-key dedup absorbs duplicate rows (PR #63 P0-3).
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
  // PR #63 review P0-4: the lease adapter no longer clears the active slot
  // inside sweepStale. The sequence here is:
  //   1. ledger.appendTransition(`recover` row)   ← idempotent via the
  //      recover-key dedup the ledger replay now honors.
  //   2. follow-up object recovery (session reanimate etc.) under file lock.
  //   3. lease.clearExpired                        ← only after the audit
  //      trail is durable. A crash between (1) and (3) means the next
  //      sweep observes the same lease, ledger absorbs the duplicate
  //      recover row, then clearExpired runs again. No permanent loss.
  const expiredLeases = await deps.lease.sweepStale();
  const reanimatedSessions: string[] = [];
  let rows = 0;
  for (const lease of expiredLeases) {
    await emitLeaseRecoveredRow(lease, deps);
    rows++;
    if (lease.lease_kind === "session_lease") {
      const reanimated = await reanimateSessionIfNeeded(lease, deps);
      if (reanimated != null) {
        rows++;
        reanimatedSessions.push(reanimated);
      }
    }
    await deps.lease.clearExpired(lease);
  }
  return {
    expiredLeases,
    reanimatedSessions,
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
 *
 * PR #63 review P0-2: read-check-write under `withFileLock` so a live
 * worker that just persisted a turn cannot be overwritten by a stale
 * SESSION_OPEN snapshot.
 *
 * Returns the session_id when the transition was applied, null otherwise.
 */
async function reanimateSessionIfNeeded(
  lease: Extract<Lease, { lease_kind: "session_lease" }>,
  deps: RecoverySweepDeps,
): Promise<string | null> {
  const path = layout.sessionMetadata(lease.session_id);
  return deps.store.withFileLock(path, async () => {
    const body = await deps.store.readText(path);
    if (body == null) return null;
    let session: DialogueSessionT;
    try {
      session = DialogueSession.parse(JSON.parse(body));
    } catch {
      return null;
    }
    if (session.state !== "SESSION_OPEN") return null;
    const updated = DialogueSession.parse({
      ...session,
      state: "AWAITING_REVALIDATION",
      updated_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(path, JSON.stringify(updated, null, 2));
    await emitReanimateRow(session, lease, deps);
    return session.session_id;
  });
}

async function emitReanimateRow(
  session: DialogueSessionT,
  lease: Extract<Lease, { lease_kind: "session_lease" }>,
  deps: RecoverySweepDeps,
): Promise<void> {
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
