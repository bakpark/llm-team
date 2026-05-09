/**
 * RGC-CROSS-SLOT-FAIRNESS — cross-slot fairness selector (phase 6a).
 *
 * Pure function. The dual-track scheduler enumerates both queue heads
 * (intake → Discovery, delivery_promotion → Delivery), and this module
 * orders them per `target.dual_track.priority`:
 *
 *   - **delivery_first** (default, RGC-CROSS-SLOT-FAIRNESS) — Delivery
 *     promotion candidates evaluate first; intake follows.
 *   - **discovery_first** — symmetric inverse.
 *   - **balanced** — alternate by candidate, starting with Delivery
 *     (deterministic tie-break: even index = Delivery, odd = Discovery).
 *     A trailing tail (longer queue) is appended after the alternation
 *     exhausts the shorter one. The starting side is fixed so two
 *     scheduler instances reading the same FS state agree on order.
 *
 * Within each queue the input list MUST already be FIFO sorted (caller
 * passes the output of `enumerateIntakeQueue` / etc.). Within-queue
 * fairness is `application/fairness.ts` (RGC-FAIRNESS); this module is
 * strictly cross-queue.
 *
 * The selector returns a flat `QueueCandidate[]` so the scheduler can
 * iterate and apply the promotion guard to each in order.
 */
import type { DualTrackPriority } from "../config/target-schema.js";
import type { QueueCandidate } from "./dual-gate-queue.js";

/**
 * Slot kind that was promoted on the previous balanced cycle. The
 * scheduler reads this from the ledger (last applied `slot_promotion`
 * row) so balanced alternates across cycles, not just within a single
 * snapshot. PR #70 P1-3.
 */
export type LastBalancedSlot = "discovery" | "delivery" | null;

export interface CrossSlotFairnessInput {
  intake: readonly QueueCandidate[];
  delivery: readonly QueueCandidate[];
  priority: DualTrackPriority;
  /**
   * When `priority="balanced"`, the slot promoted on the previous cycle.
   * Balanced flips the leading side every cycle so the queues alternate
   * over time even when each cycle promotes only one milestone. `null`
   * (no prior history) defaults to leading with Delivery — preserving
   * the deterministic single-cycle behaviour previously documented.
   */
  lastBalancedSlot?: LastBalancedSlot;
}

export function orderByCrossSlotPriority(
  input: CrossSlotFairnessInput,
): QueueCandidate[] {
  switch (input.priority) {
    case "delivery_first":
      return [...input.delivery, ...input.intake];
    case "discovery_first":
      return [...input.intake, ...input.delivery];
    case "balanced": {
      const out: QueueCandidate[] = [];
      const max = Math.max(input.intake.length, input.delivery.length);
      // Flip the leading side based on the last balanced promotion so
      // alternation persists across cycles. Default (no history) leads
      // with Delivery — preserves previous deterministic behaviour and
      // keeps two scheduler instances reading the same FS state in
      // agreement.
      const deliveryLeads = input.lastBalancedSlot !== "delivery";
      for (let i = 0; i < max; i++) {
        if (deliveryLeads) {
          if (i < input.delivery.length) out.push(input.delivery[i]!);
          if (i < input.intake.length) out.push(input.intake[i]!);
        } else {
          if (i < input.intake.length) out.push(input.intake[i]!);
          if (i < input.delivery.length) out.push(input.delivery[i]!);
        }
      }
      return out;
    }
  }
}
