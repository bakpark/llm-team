/**
 * Dual-track scheduler — daemons.md §Dual-track scheduler loop (phase 6a).
 *
 * Single entrypoint `runOneDualTrackTurn` that the daemon's
 * `--role dual-track-scheduler` invokes once per cycle. Composition:
 *
 *   1. Snapshot both dual-gate queues (intake + delivery_promotion).
 *   2. Apply cross-slot fairness (`target.dual_track.priority`) to order
 *      candidates.
 *   3. For each candidate in order:
 *        a. Evaluate the promotion guard. Blocked → emit ledger noop +
 *           `result_detail=promotion_guard_blocked:<reason>`, skip.
 *        b. Apply RGC-SLOT-LOCK atomic 4-step under
 *           `withFileLock(milestonePath)`:
 *             i.   Re-read milestone (TOCTOU guard).
 *             ii.  Claim `slot_lock` (short transaction).
 *             iii. Persist new milestone state + ledger
 *                  `slot_promotion` row.
 *             iv.  Release `slot_lock`.
 *           Promote one milestone per call so the scheduler stays a
 *           "short transaction" — multiple promotions happen across
 *           successive cycles.
 *   4. Emit a `swept` outcome describing the action taken.
 *
 * Cross-slot stale detection is a separate side effect — the scheduler
 * runs `detectCrossSlotStaleSessions` AFTER promotion so the latest
 * Delivery N updated_at is reflected before stale-marking N+1 sessions.
 *
 * Hexagonal: the function depends on StorePort / ClockPort / LeasePort /
 * LedgerAppender. No direct fs / git / gh calls.
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  Milestone,
  type Milestone as MilestoneT,
  type MilestoneState,
  SlotKind as SlotKindEnum,
  type SlotKind as SlotKindT,
} from "../domain/schema/milestone.js";
import type { LeaseKind } from "../domain/schema/lease.js";
import type { ClockPort } from "../ports/clock.js";
import type { LeasePort } from "../ports/lease.js";
import type { StorePort } from "../ports/store.js";
import type { DualTrack } from "../config/target-schema.js";
import {
  detectCrossSlotStaleSessions,
  type CrossSlotStaleResult,
} from "./cross-slot-stale.js";
import {
  orderByCrossSlotPriority,
  type LastBalancedSlot,
} from "./cross-slot-fairness.js";
import { LedgerRow } from "../domain/schema/ledger.js";
import { LEDGER_TRANSITIONS_PATH } from "./persistence-layout.js";
import {
  flattenSnapshot,
  snapshotDualGateQueues,
  type QueueCandidate,
} from "./dual-gate-queue.js";
import { idempotencyKey } from "./idempotency.js";
import { assertCanAcquire } from "./lease-acquisition-order.js";
import { resolveLeaseTtl } from "./lease-ttl-resolver.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";
import {
  evaluatePromotionGuard,
  type PromotionGuardResult,
  type PromotionKind,
} from "./promotion-guard.js";
import type { LeaseConfig } from "../config/target-schema.js";

export interface DualTrackSchedulerDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  lease: LeasePort;
  callerId: string;
  targetId: string;
  /** Resolved `target.dual_track` block. */
  dualTrack?: DualTrack;
  leaseConfig?: LeaseConfig;
  /**
   * Snapshot of the RefactorBacklog SCHEDULED count, used by the third
   * promotion guard. Phase 6a defaults to 0 because backlog producer
   * wiring lives in 5c/6b. Caller can pass a real count once available.
   */
  refactorScheduledCount?: number;
}

export type DualTrackSchedulerOutcome =
  | { kind: "noop"; reason: "no_candidates" }
  | {
      kind: "guard_blocked";
      milestone_id: string;
      promotion: PromotionKind;
      reason: string;
    }
  | {
      kind: "promoted";
      milestone_id: string;
      promotion: PromotionKind;
      from_state: MilestoneState;
      to_state: MilestoneState;
      slot_kind: SlotKindT;
      lease_token: string;
      stale_sessions: string[];
    }
  | {
      kind: "lease_unavailable";
      milestone_id: string;
      promotion: PromotionKind;
      detail: string;
    };

export async function runOneDualTrackTurn(
  deps: DualTrackSchedulerDeps,
): Promise<DualTrackSchedulerOutcome> {
  const snapshot = await snapshotDualGateQueues(deps.store);
  const flat = flattenSnapshot(snapshot);
  if (flat.length === 0) {
    // Even with no promotion candidates, run cross-slot stale once so a
    // late Delivery update doesn't leave stale Discovery N+1 sessions
    // hanging until the next promotion fires. Best-effort — a stale-pass
    // failure must not mask the noop outcome (PR #70 P1-1).
    await runStaleBestEffort(deps);
    return { kind: "noop", reason: "no_candidates" };
  }

  const priority = deps.dualTrack?.priority ?? "delivery_first";
  // For `balanced`, look up the last applied slot_promotion row so the
  // alternation persists across cycles (PR #70 P1-3). For other priorities
  // this read is unnecessary and skipped.
  const lastBalancedSlot =
    priority === "balanced" ? await readLastBalancedSlot(deps.store) : null;
  const ordered = orderByCrossSlotPriority({
    intake: flat.filter((c) => c.queue === "intake_queue"),
    delivery: flat.filter((c) => c.queue === "delivery_promotion_queue"),
    priority,
    lastBalancedSlot,
  });

  // Snapshot of all milestones (for promotion guard) — derive from the
  // dual-gate queue snapshot to avoid a second list pass.
  const allMilestones = await readAllMilestones(deps.store);

  for (const candidate of ordered) {
    const promotion: PromotionKind =
      candidate.queue === "intake_queue"
        ? "intake_to_discovery"
        : "spec_approved_to_delivery";
    const guard = evaluatePromotionGuard({
      promotion,
      candidate: candidate.milestone,
      allMilestones,
      refactorScheduledCount: deps.refactorScheduledCount ?? 0,
      refactorScheduledCapacity:
        deps.dualTrack?.refactor_scheduled_capacity ?? null,
    });
    if (!guard.allowed) {
      await emitGuardBlockedRow(deps, candidate, promotion, guard);
      // Run cross-slot stale once, then return — first blocked candidate
      // surfaces in the outcome so the daemon log shows it. Best-effort:
      // stale failure must not mask the guard_blocked outcome (PR #70 P1-1).
      await runStaleBestEffort(deps);
      return {
        kind: "guard_blocked",
        milestone_id: candidate.milestone.milestone_id,
        promotion,
        reason: guardReason(guard),
      };
    }

    // Try to promote this candidate. If lease is unavailable (sibling
    // scheduler raced us), surface that and stop — sibling will continue.
    const result = await promoteCandidate(deps, candidate, promotion);
    if (result.kind === "lease_unavailable") {
      await runStaleBestEffort(deps);
      return result;
    }
    // promoted — run cross-slot stale AFTER persisting the new state so
    // any Discovery N+1 session that read the prior Delivery N gets
    // marked stale immediately. Best-effort: a stale-pass failure must
    // NOT roll back the already-applied promotion ledger row (PR #70
    // P1-1) — caller would otherwise see failure while the ledger holds
    // an applied row.
    const stale = await runStaleBestEffort(deps);
    if (result.kind === "promoted") {
      return { ...result, stale_sessions: stale.staledSessionIds };
    }
    return result;
  }

  // ordered was non-empty but all guarded — covered above by early return.
  // Defensive: still run stale + report noop.
  await runStaleBestEffort(deps);
  return { kind: "noop", reason: "no_candidates" };
}

/**
 * Run cross-slot stale detection without ever propagating exceptions.
 * Stale detection is a side-effect on top of promotion; failing it must not
 * roll back an applied promotion (PR #70 P1-1).
 */
async function runStaleBestEffort(
  deps: DualTrackSchedulerDeps,
): Promise<CrossSlotStaleResult> {
  try {
    return await detectCrossSlotStaleSessions(deps);
  } catch {
    return { staledSessionIds: [] };
  }
}

function guardReason(guard: PromotionGuardResult): string {
  if (guard.allowed) return "ok";
  if (guard.blocking_milestone_id != null)
    return `${guard.reason}:${guard.blocking_milestone_id}`;
  return guard.reason;
}

async function emitGuardBlockedRow(
  deps: DualTrackSchedulerDeps,
  candidate: QueueCandidate,
  promotion: PromotionKind,
  guard: PromotionGuardResult,
): Promise<void> {
  const slotKind: SlotKindT =
    promotion === "intake_to_discovery" ? "discovery" : "delivery";
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: candidate.milestone.milestone_id,
    object_kind: "milestone",
    from_state: candidate.milestone.state,
    to_state: candidate.milestone.state,
    loop_kind: null,
    phase: null,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: slotKind,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slot_promotion",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "slot_promotion",
      parts: {
        kind: "guard_blocked",
        milestone_id: candidate.milestone.milestone_id,
        promotion,
        reason: guardReason(guard),
        updated_at: candidate.milestone.updated_at,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "noop",
    result_detail: `promotion_guard_blocked:${guardReason(guard)}`,
    timestamp: deps.clock.isoNow(),
  });
}

async function promoteCandidate(
  deps: DualTrackSchedulerDeps,
  candidate: QueueCandidate,
  promotion: PromotionKind,
): Promise<DualTrackSchedulerOutcome> {
  const milestonePath = layout.milestone(candidate.milestone.milestone_id);
  const slotKind: SlotKindT =
    promotion === "intake_to_discovery" ? "discovery" : "delivery";
  const fromState: MilestoneState =
    promotion === "intake_to_discovery"
      ? "M_INTAKE_QUEUED"
      : "M_SPEC_APPROVED";
  const toState: MilestoneState =
    promotion === "intake_to_discovery"
      ? "M_DISCOVERY_DRAFT"
      : "M_DELIVERY_PLANNING";

  return deps.store.withFileLock(milestonePath, async () => {
    // (i) Re-read milestone — TOCTOU guard.
    const fresh = await deps.store.readText(milestonePath);
    if (fresh == null) {
      return {
        kind: "lease_unavailable",
        milestone_id: candidate.milestone.milestone_id,
        promotion,
        detail: "milestone_disappeared",
      } as const;
    }
    let live: MilestoneT;
    try {
      live = Milestone.parse(JSON.parse(fresh));
    } catch (e) {
      return {
        kind: "lease_unavailable",
        milestone_id: candidate.milestone.milestone_id,
        promotion,
        detail: `milestone_parse_failed:${(e as Error).message}`,
      } as const;
    }
    if (live.state !== fromState) {
      return {
        kind: "lease_unavailable",
        milestone_id: live.milestone_id,
        promotion,
        detail: `expected_state=${fromState} actual=${live.state}`,
      } as const;
    }

    // (i.b) Re-evaluate promotion guard against a FRESH milestone snapshot
    // (PR #70 P0-2 fix). Two scheduler instances can both observe the same
    // pre-lock `allMilestones` snapshot and pass the outer guard, but only
    // one can hold `withFileLock(milestonePath)` at a time. The OTHER slot's
    // milestone may have been promoted by a sibling scheduler in the
    // meantime, so re-running the guard inside the lock prevents two
    // milestones from co-occupying the same slot.
    const liveAll = await readAllMilestones(deps.store);
    const reGuard = evaluatePromotionGuard({
      promotion,
      candidate: live,
      allMilestones: liveAll,
      refactorScheduledCount: deps.refactorScheduledCount ?? 0,
      refactorScheduledCapacity:
        deps.dualTrack?.refactor_scheduled_capacity ?? null,
    });
    if (!reGuard.allowed) {
      return {
        kind: "lease_unavailable",
        milestone_id: live.milestone_id,
        promotion,
        detail: `promotion_guard_blocked:${guardReason(reGuard)}`,
      } as const;
    }

    // (ii) Claim slot_lock — RGC-SLOT-LOCK short transaction.
    assertCanAcquire([], "slot_lock");
    const ttl = resolveLeaseTtl({
      leaseKind: "slot_lock" satisfies LeaseKind,
      leaseConfig: deps.leaseConfig,
    });
    const slotObjectId = `${live.milestone_id}|${slotKind}`;
    const claim = await deps.lease.claim({
      leaseKind: "slot_lock",
      objectId: slotObjectId,
      workerId: deps.callerId,
      ttlMs: ttl.ttlMs,
      ttlSource: ttl.source,
      targetId: deps.targetId,
      aux: {
        kind: "slot_lock",
        milestone_id: live.milestone_id,
        slot_kind: slotKind,
      },
    });
    if (claim.result === "claim_failed") {
      return {
        kind: "lease_unavailable",
        milestone_id: live.milestone_id,
        promotion,
        detail: `slot_lock held by ${claim.existingHolder} (${claim.existingLeaseId})`,
      } as const;
    }
    const acquiredLease = claim.lease;

    try {
      // (iii) Persist new milestone state.
      const now = deps.clock.isoNow();
      const next: MilestoneT = Milestone.parse({
        ...live,
        state: toState,
        slot_kind: SlotKindEnum.parse(slotKind),
        updated_at: now,
      });
      await deps.store.writeAtomic(milestonePath, JSON.stringify(next, null, 2));

      // ledger row — `slot_promotion` action with the slot_lock token.
      await deps.ledger.appendTransition({
        transition_id: newMonotonicId(deps.clock.now()),
        target_id: deps.targetId,
        object_id: live.milestone_id,
        object_kind: "milestone",
        from_state: fromState,
        to_state: toState,
        loop_kind: null,
        phase: null,
        slice_id: null,
        slice_kind: null,
        dod_revision: null,
        session_id: null,
        turn_index: null,
        slot_kind: slotKind,
        agent_profile_id: null,
        contribution_kind: null,
        action_kind: "slot_promotion",
        final_verdict: null,
        caller_id: deps.callerId,
        manifest_id: null,
        input_revision_pins: [],
        output_hash: null,
        verification_run_id: null,
        metric_run_id: null,
        idempotency_key: idempotencyKey({
          scope: "slot_promotion",
          parts: {
            kind: "promote",
            milestone_id: live.milestone_id,
            from: fromState,
            to: toState,
            slot_kind: slotKind,
          },
        }),
        lease_token: acquiredLease.lease_token,
        lease_kind: "slot_lock",
        result: "applied",
        result_detail: null,
        timestamp: now,
      });

      return {
        kind: "promoted",
        milestone_id: live.milestone_id,
        promotion,
        from_state: fromState,
        to_state: toState,
        slot_kind: slotKind,
        lease_token: acquiredLease.lease_token,
        stale_sessions: [],
      } as const;
    } finally {
      // (iv) Release slot_lock — short transaction guarantee.
      try {
        await deps.lease.release({
          leaseId: acquiredLease.lease_id,
          leaseToken: acquiredLease.lease_token,
        });
      } catch {
        // best-effort; recovery sweep will clear if it lingers
      }
    }
  });
}

/**
 * Walk the ledger from the tail and return the slot_kind of the most recent
 * applied `slot_promotion` row. Returns `null` when no prior promotion has
 * been recorded. Used by the balanced fairness selector so alternation
 * persists across cycles (PR #70 P1-3).
 */
async function readLastBalancedSlot(
  store: StorePort,
): Promise<LastBalancedSlot> {
  const body = await store.readText(LEDGER_TRANSITIONS_PATH);
  if (body == null || body.length === 0) return null;
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line == null || line.length === 0) continue;
    let row: LedgerRow;
    try {
      row = LedgerRow.parse(JSON.parse(line));
    } catch {
      continue;
    }
    if (
      row.action_kind === "slot_promotion" &&
      row.result === "applied" &&
      (row.slot_kind === "discovery" || row.slot_kind === "delivery")
    ) {
      return row.slot_kind;
    }
  }
  return null;
}

async function readAllMilestones(store: StorePort): Promise<MilestoneT[]> {
  let names: string[];
  try {
    names = await store.list("milestones");
  } catch {
    return [];
  }
  const out: MilestoneT[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`milestones/${name}`);
    if (body == null) continue;
    try {
      out.push(Milestone.parse(JSON.parse(body)));
    } catch {
      // skip
    }
  }
  return out;
}

export type { CrossSlotStaleResult };
