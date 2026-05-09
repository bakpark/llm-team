/**
 * RGC-DUAL-GATE-QUEUE — intake_queue + delivery_promotion_queue (phase 6a).
 *
 * Pure FS-backed enumeration helpers. No state of its own — the milestone
 * file IS the queue entry; queue head is determined by oldest-by-updated_at
 * within the relevant state. FIFO + idempotency are enforced by:
 *
 *   - **Ordering**: `updated_at` ascending. Two milestones with identical
 *     updated_at fall back to `created_at` then `milestone_id` (lexical) so
 *     the head is deterministic across processes.
 *   - **Idempotency**: a milestone enqueued twice (e.g. the same
 *     M_INTAKE_QUEUED record observed by two scheduler cycles) yields the
 *     same head. The scheduler's atomic promotion (slot_lock → state
 *     write → ledger row → release) absorbs duplicate dequeues via the
 *     ledger `slot_promotion` idempotency_key.
 *
 * Caller: `application/dual-track-scheduler.ts`. The scheduler walks the
 * head of each queue, applies cross-slot fairness, then applies the
 * promotion guard.
 */
import {
  Milestone,
  type Milestone as MilestoneT,
  type MilestoneState,
} from "../domain/schema/milestone.js";
import type { StorePort } from "../ports/store.js";

export type DualGateQueueKind = "intake_queue" | "delivery_promotion_queue";

export interface QueueCandidate {
  /** Source queue. */
  queue: DualGateQueueKind;
  /** Milestone payload as persisted on disk. */
  milestone: MilestoneT;
}

const INTAKE_STATE: MilestoneState = "M_INTAKE_QUEUED";
const DELIVERY_PROMOTE_STATE: MilestoneState = "M_SPEC_APPROVED";

function compareCandidates(a: MilestoneT, b: MilestoneT): number {
  if (a.updated_at !== b.updated_at)
    return a.updated_at.localeCompare(b.updated_at);
  if (a.created_at !== b.created_at)
    return a.created_at.localeCompare(b.created_at);
  return a.milestone_id.localeCompare(b.milestone_id);
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
      // skip corrupt — next cycle re-evaluates
    }
  }
  return out;
}

/**
 * Enumerate the intake queue: M_INTAKE_QUEUED milestones, oldest first.
 * Head element (if any) is `result[0]`.
 */
export async function enumerateIntakeQueue(
  store: StorePort,
): Promise<MilestoneT[]> {
  const all = await readAllMilestones(store);
  const filtered = all.filter((m) => m.state === INTAKE_STATE);
  filtered.sort(compareCandidates);
  return filtered;
}

/**
 * Enumerate the delivery promotion queue: M_SPEC_APPROVED milestones, oldest
 * first. Head element (if any) is `result[0]`.
 */
export async function enumerateDeliveryPromotionQueue(
  store: StorePort,
): Promise<MilestoneT[]> {
  const all = await readAllMilestones(store);
  const filtered = all.filter((m) => m.state === DELIVERY_PROMOTE_STATE);
  filtered.sort(compareCandidates);
  return filtered;
}

export interface DualGateQueueSnapshot {
  intake: MilestoneT[];
  deliveryPromotion: MilestoneT[];
}

/** Single-pass snapshot of both queues — avoids two milestone scans. */
export async function snapshotDualGateQueues(
  store: StorePort,
): Promise<DualGateQueueSnapshot> {
  const all = await readAllMilestones(store);
  const intake = all.filter((m) => m.state === INTAKE_STATE);
  const deliveryPromotion = all.filter(
    (m) => m.state === DELIVERY_PROMOTE_STATE,
  );
  intake.sort(compareCandidates);
  deliveryPromotion.sort(compareCandidates);
  return { intake, deliveryPromotion };
}

/**
 * Build a `QueueCandidate[]` snapshot in queue-priority order. The caller
 * then applies cross-slot fairness to interleave / reorder.
 */
export function flattenSnapshot(
  snapshot: DualGateQueueSnapshot,
): QueueCandidate[] {
  return [
    ...snapshot.intake.map(
      (m): QueueCandidate => ({ queue: "intake_queue", milestone: m }),
    ),
    ...snapshot.deliveryPromotion.map(
      (m): QueueCandidate => ({
        queue: "delivery_promotion_queue",
        milestone: m,
      }),
    ),
  ];
}
