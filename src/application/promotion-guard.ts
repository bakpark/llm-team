/**
 * RGC-PROMOTION-GUARD — intake/delivery promotion gating (phase 6a).
 *
 * Pure function. The dual-track scheduler calls this BEFORE claiming the
 * slot_lock so blocked candidates do not consume the lock seq counter.
 *
 * Three guards from the contract table:
 *
 *   1. **Direct slot empty**: a Discovery promotion is only permitted when
 *      no other milestone holds the Discovery slot (i.e. no milestone is in
 *      M_DISCOVERY_DRAFT / M_DISCOVERY_AWAITING_HUMAN /
 *      M_SPECIFICATION_DRAFT / M_SPECIFICATION_AWAITING_HUMAN). Likewise
 *      Delivery promotion requires no milestone in
 *      M_DELIVERY_PLANNING / M_DELIVERY_BUILDING / M_DELIVERY_VALIDATING.
 *      M_DONE / M_ESCALATED clear the slot. M_SPEC_APPROVED is the
 *      delivery_promotion_queue entry itself — it does NOT yet hold the
 *      delivery slot.
 *
 *   2. **Discovery N+1 manifest coherent with Delivery N**: skipped at
 *      promotion time — the scheduler doesn't yet know N+1's manifest. The
 *      coherence check fires on N+1 session pickup (see
 *      `application/cross-slot-stale.ts`). Recorded here as a `noop` slot
 *      because the scheduler has nothing to enforce in this hop.
 *
 *   3. **RefactorBacklog SCHEDULED capacity**: when
 *      `target.dual_track.refactor_scheduled_capacity` is set and the
 *      number of RefactorBacklogItem in `state="SCHEDULED"` exceeds it,
 *      Delivery promotion is held. Optional — `null` capacity means no
 *      limit (default).
 *
 * The result type carries a structured `reason` so the scheduler ledger
 * row can record `result_detail=promotion_guard_blocked:<reason>`.
 */
import type { Milestone, MilestoneState } from "../domain/schema/milestone.js";

const DISCOVERY_SLOT_HOLDERS: readonly MilestoneState[] = [
  "M_DISCOVERY_DRAFT",
  "M_DISCOVERY_AWAITING_HUMAN",
  "M_SPECIFICATION_DRAFT",
  "M_SPECIFICATION_AWAITING_HUMAN",
];

const DELIVERY_SLOT_HOLDERS: readonly MilestoneState[] = [
  "M_DELIVERY_PLANNING",
  "M_DELIVERY_BUILDING",
  "M_DELIVERY_VALIDATING",
];

export type PromotionKind = "intake_to_discovery" | "spec_approved_to_delivery";

export type PromotionGuardReason =
  | "discovery_slot_busy"
  | "delivery_slot_busy"
  | "refactor_scheduled_capacity_reached";

export type PromotionGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: PromotionGuardReason;
      blocking_milestone_id?: string;
    };

export interface PromotionGuardInput {
  promotion: PromotionKind;
  /**
   * Milestone being considered for promotion. The guard ignores its own
   * record when scanning slot occupancy.
   */
  candidate: Milestone;
  /** All known milestones (e.g. snapshot from store). */
  allMilestones: readonly Milestone[];
  /**
   * Number of RefactorBacklog items currently in SCHEDULED state. Only
   * consulted for `spec_approved_to_delivery`. Caller passes 0 if no
   * scheduling subsystem is wired yet (phase 5c/6b).
   */
  refactorScheduledCount?: number;
  /**
   * `target.dual_track.refactor_scheduled_capacity`. `null` (or undefined)
   * disables the third guard.
   */
  refactorScheduledCapacity?: number | null;
}

export function evaluatePromotionGuard(
  input: PromotionGuardInput,
): PromotionGuardResult {
  const candidateId = input.candidate.milestone_id;
  if (input.promotion === "intake_to_discovery") {
    const blocker = input.allMilestones.find(
      (m) =>
        m.milestone_id !== candidateId &&
        DISCOVERY_SLOT_HOLDERS.includes(m.state),
    );
    if (blocker != null) {
      return {
        allowed: false,
        reason: "discovery_slot_busy",
        blocking_milestone_id: blocker.milestone_id,
      };
    }
    return { allowed: true };
  }

  // spec_approved_to_delivery
  const blocker = input.allMilestones.find(
    (m) =>
      m.milestone_id !== candidateId &&
      DELIVERY_SLOT_HOLDERS.includes(m.state),
  );
  if (blocker != null) {
    return {
      allowed: false,
      reason: "delivery_slot_busy",
      blocking_milestone_id: blocker.milestone_id,
    };
  }
  if (
    input.refactorScheduledCapacity != null &&
    (input.refactorScheduledCount ?? 0) >= input.refactorScheduledCapacity
  ) {
    return {
      allowed: false,
      reason: "refactor_scheduled_capacity_reached",
    };
  }
  return { allowed: true };
}
