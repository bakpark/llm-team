/**
 * KAC-TURN-LOG-COMPACTION (turn count trigger).
 *
 * Phase 3 covers only the turn-count trigger. Size and wallclock triggers
 * land in phase 5 alongside richer KAC accumulation. The function is a
 * pure decision: given a session and the latest turn snapshot, should the
 * coordinator emit a compaction snapshot? Persistence (writing the snapshot
 * to `sessions/<id>/snapshots/`) is left to a future phase — we expose the
 * decision so dialogue-coordinator can record an external_observation
 * ledger row when it fires, ready to swap in the storage layer.
 */
import type { DialogueSession } from "../domain/schema/dialogue-session.js";

export interface CompactionPolicy {
  /**
   * Emit a compaction snapshot every N turns (e.g. 10).
   * 0 disables compaction.
   */
  every_n_turns: number;
}

export interface CompactionDecision {
  /** True when the coordinator should emit a snapshot before the next turn. */
  fire: boolean;
  /** Boundary turn index that triggered the decision (for ledger detail). */
  triggered_at_turn_index: number | null;
}

export function shouldCompactTurnLog(
  session: Pick<DialogueSession, "current_turn_index" | "state">,
  policy: CompactionPolicy,
): CompactionDecision {
  if (policy.every_n_turns <= 0)
    return { fire: false, triggered_at_turn_index: null };
  // P2-13 fix (PR #62 review): only fire on SESSION_OPEN. If the session
  // is already CONVERGED / TIMEOUT / ABANDONED / AWAITING_REVALIDATION,
  // any compaction snapshot would include the finalized turn — that snapshot
  // is the responsibility of the dispatch path, not the in-loop compactor.
  if (session.state !== "SESSION_OPEN")
    return { fire: false, triggered_at_turn_index: null };
  // current_turn_index reflects the index of the NEXT turn to be persisted
  // (post-increment). The most recent persisted turn is therefore
  // current_turn_index - 1; trigger when that count is a positive multiple
  // of `every_n_turns`.
  const persistedTurns = session.current_turn_index;
  if (persistedTurns <= 0)
    return { fire: false, triggered_at_turn_index: null };
  if (persistedTurns % policy.every_n_turns !== 0)
    return { fire: false, triggered_at_turn_index: null };
  return { fire: true, triggered_at_turn_index: persistedTurns - 1 };
}
