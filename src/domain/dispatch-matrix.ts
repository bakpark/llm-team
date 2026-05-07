/**
 * SOC-DISPATCH-MATRIX (data-driven).
 *
 * Each entry maps a `(parent_loop, phase_or_purpose, final_verdict)` triple
 * to an ordered list of side-effect descriptors. `application/caller-dispatch`
 * is the executor that reads this table and runs each effect against the
 * stores/ports. New (loop, purpose, verdict) combinations should be added
 * here — caller-dispatch only grows by adding handlers for new effect kinds.
 *
 * Phase 3 scope: the inner tdd_build (tests_green / TIMEOUT / ABANDONED) and
 * middle review (approve / request_changes) branches plus the
 * SLICE_INTEGRATING handoff. Outer loops arrive in phase 5.
 */
import type { ParentLoop } from "./schema/contribution.js";

export type DispatchEffect =
  /** Inner tests_green path: SM_DRAFT → SM_READY_FOR_REVIEW + SLICE → SLICE_REVIEWING. */
  | { kind: "open_slice_merge_for_review" }
  /** Inner TIMEOUT/ABANDONED: SM_DRAFT → SM_CLOSED + SLICE → SLICE_BLOCKED. */
  | { kind: "close_slice_merge_blocked" }
  /** Middle approve: SM → SM_APPROVED + SLICE → SLICE_INTEGRATING + integrate trunk. */
  | { kind: "promote_slice_merge_to_approved_then_integrate" }
  /** Middle request_changes: SM → SM_REQUEST_CHANGES → SM_CLOSED + SLICE → SLICE_BUILDING. */
  | { kind: "reset_slice_for_rebuild" };

export interface DispatchEntry {
  parent_loop: ParentLoop;
  phase_or_purpose: string;
  /** Either CONVERGED or one of the terminal-but-not-converged states. */
  session_state: "CONVERGED" | "TIMEOUT" | "ABANDONED";
  /**
   * For CONVERGED, must match the session's `final_verdict`. For TIMEOUT /
   * ABANDONED this is null (the abandoned_reason is recorded on the session
   * itself and is not part of the dispatch key).
   */
  final_verdict: string | null;
  effects: DispatchEffect[];
}

export const DISPATCH_MATRIX: readonly DispatchEntry[] = [
  // Inner tdd_build CONVERGED tests_green → SLICE_REVIEWING + SM_READY_FOR_REVIEW.
  {
    parent_loop: "inner",
    phase_or_purpose: "tdd_build",
    session_state: "CONVERGED",
    final_verdict: "tests_green",
    effects: [{ kind: "open_slice_merge_for_review" }],
  },
  // Inner TIMEOUT → SLICE_BLOCKED + SM_CLOSED.
  {
    parent_loop: "inner",
    phase_or_purpose: "tdd_build",
    session_state: "TIMEOUT",
    final_verdict: null,
    effects: [{ kind: "close_slice_merge_blocked" }],
  },
  // Inner ABANDONED → SLICE_BLOCKED + SM_CLOSED.
  {
    parent_loop: "inner",
    phase_or_purpose: "tdd_build",
    session_state: "ABANDONED",
    final_verdict: null,
    effects: [{ kind: "close_slice_merge_blocked" }],
  },
  // Middle review CONVERGED approve → SM_APPROVED + SLICE_INTEGRATING + integrate trunk.
  {
    parent_loop: "middle",
    phase_or_purpose: "review",
    session_state: "CONVERGED",
    final_verdict: "approve",
    effects: [{ kind: "promote_slice_merge_to_approved_then_integrate" }],
  },
  // Middle review CONVERGED request_changes → SM_REQUEST_CHANGES → SM_CLOSED + SLICE_BUILDING.
  {
    parent_loop: "middle",
    phase_or_purpose: "review",
    session_state: "CONVERGED",
    final_verdict: "request_changes",
    effects: [{ kind: "reset_slice_for_rebuild" }],
  },
];

export function lookupDispatch(input: {
  parent_loop: ParentLoop;
  phase_or_purpose: string;
  session_state: "CONVERGED" | "TIMEOUT" | "ABANDONED";
  final_verdict: string | null;
}): DispatchEntry | null {
  for (const e of DISPATCH_MATRIX) {
    if (e.parent_loop !== input.parent_loop) continue;
    if (e.phase_or_purpose !== input.phase_or_purpose) continue;
    if (e.session_state !== input.session_state) continue;
    if (e.final_verdict !== input.final_verdict) continue;
    return e;
  }
  return null;
}
