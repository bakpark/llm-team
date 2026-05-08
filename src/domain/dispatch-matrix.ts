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
  | { kind: "reset_slice_for_rebuild" }
  // ---- Phase 5b.1 outer-loop effects ----
  /** Outer Discovery spec_accept → M_DISCOVERY_DRAFT → M_SPECIFICATION_DRAFT. */
  | { kind: "promote_milestone_to_specification" }
  /** Outer Specification spec_accept → M_SPECIFICATION_DRAFT → M_SPEC_APPROVED + Discovery slot release. */
  | { kind: "promote_milestone_to_spec_approved" }
  /** Outer Discovery/Specification spec_reject when human required → M_*_AWAITING_HUMAN. */
  | { kind: "park_milestone_awaiting_human" }
  /** Outer Discovery/Specification TIMEOUT/ABANDONED → keep DRAFT (failure-policy 가 ESCALATED 분리). */
  | { kind: "recover_milestone_to_draft" }
  /** Outer Planning plan_accept → M_DELIVERY_PLANNING → M_DELIVERY_BUILDING + slice DAG persist. */
  | { kind: "persist_slice_dag_and_promote" }
  /** Outer Planning request_changes → keep M_DELIVERY_PLANNING (lead 재호출 trigger은 coordinator). */
  | { kind: "noop_planning_request_changes" }
  /** Outer Validation validation_pass → M_DONE + Context Summary persist. */
  | { kind: "finalize_milestone_done" }
  /** Outer Validation validation_fail → M_DELIVERY_BUILDING 회수 + 책임 slice SLICE_READY. */
  | { kind: "recover_milestone_to_building" }
  /** Outer Validation validation_stale → M_DELIVERY_VALIDATING 회수 (재 trigger 은 coordinator). */
  | { kind: "noop_validation_stale" }
  /** Outer Validation TIMEOUT/ABANDONED → milestone ESCALATED. */
  | { kind: "escalate_milestone" };

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
  // P1-11 fix (PR #62 review): middle review TIMEOUT/ABANDONED → SM_CLOSED +
  // SLICE_BLOCKED. The SOC-DISPATCH-MATRIX row "middle review TIMEOUT (n/a) →
  // slice SLICE_BLOCKED" is the contract authority; reusing the
  // close_slice_merge_blocked effect keeps the SM closure logic in one place.
  {
    parent_loop: "middle",
    phase_or_purpose: "review",
    session_state: "TIMEOUT",
    final_verdict: null,
    effects: [{ kind: "close_slice_merge_blocked" }],
  },
  {
    parent_loop: "middle",
    phase_or_purpose: "review",
    session_state: "ABANDONED",
    final_verdict: null,
    effects: [{ kind: "close_slice_merge_blocked" }],
  },
  // ---- Phase 5b.1 outer-loop entries ----
  // Outer Discovery (purpose="design").
  {
    parent_loop: "outer",
    phase_or_purpose: "design_discovery",
    session_state: "CONVERGED",
    final_verdict: "spec_accept",
    effects: [{ kind: "promote_milestone_to_specification" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "design_discovery",
    session_state: "CONVERGED",
    final_verdict: "spec_reject",
    effects: [{ kind: "park_milestone_awaiting_human" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "design_discovery",
    session_state: "TIMEOUT",
    final_verdict: null,
    effects: [{ kind: "recover_milestone_to_draft" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "design_discovery",
    session_state: "ABANDONED",
    final_verdict: null,
    effects: [{ kind: "recover_milestone_to_draft" }],
  },
  // Outer Specification (purpose="design_specification").
  {
    parent_loop: "outer",
    phase_or_purpose: "design_specification",
    session_state: "CONVERGED",
    final_verdict: "spec_accept",
    effects: [{ kind: "promote_milestone_to_spec_approved" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "design_specification",
    session_state: "CONVERGED",
    final_verdict: "spec_reject",
    effects: [{ kind: "park_milestone_awaiting_human" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "design_specification",
    session_state: "TIMEOUT",
    final_verdict: null,
    effects: [{ kind: "recover_milestone_to_draft" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "design_specification",
    session_state: "ABANDONED",
    final_verdict: null,
    effects: [{ kind: "recover_milestone_to_draft" }],
  },
  // Outer Planning (purpose="planning_decompose").
  {
    parent_loop: "outer",
    phase_or_purpose: "planning_decompose",
    session_state: "CONVERGED",
    final_verdict: "plan_accept",
    effects: [{ kind: "persist_slice_dag_and_promote" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "planning_decompose",
    session_state: "CONVERGED",
    final_verdict: "request_changes",
    effects: [{ kind: "noop_planning_request_changes" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "planning_decompose",
    session_state: "TIMEOUT",
    final_verdict: null,
    effects: [{ kind: "escalate_milestone" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "planning_decompose",
    session_state: "ABANDONED",
    final_verdict: null,
    effects: [{ kind: "escalate_milestone" }],
  },
  // Outer Validation (purpose="validation").
  {
    parent_loop: "outer",
    phase_or_purpose: "validation",
    session_state: "CONVERGED",
    final_verdict: "validation_pass",
    effects: [{ kind: "finalize_milestone_done" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "validation",
    session_state: "CONVERGED",
    final_verdict: "validation_fail",
    effects: [{ kind: "recover_milestone_to_building" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "validation",
    session_state: "CONVERGED",
    final_verdict: "validation_stale",
    effects: [{ kind: "noop_validation_stale" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "validation",
    session_state: "TIMEOUT",
    final_verdict: null,
    effects: [{ kind: "escalate_milestone" }],
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "validation",
    session_state: "ABANDONED",
    final_verdict: null,
    effects: [{ kind: "escalate_milestone" }],
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
