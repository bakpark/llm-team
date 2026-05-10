import { describe, expect, it } from "vitest";
import {
  DISPATCH_MATRIX,
  lookupDispatch,
} from "../../src/domain/dispatch-matrix.js";

describe("DISPATCH_MATRIX", () => {
  it("includes all phase-3 (state, final_verdict) tuples", () => {
    const cases: Array<{
      parent_loop: "inner" | "middle";
      phase_or_purpose: string;
      session_state: "CONVERGED" | "TIMEOUT" | "ABANDONED";
      final_verdict: string | null;
      expected: string;
    }> = [
      {
        parent_loop: "inner",
        phase_or_purpose: "tdd_build",
        session_state: "CONVERGED",
        final_verdict: "tests_green",
        expected: "open_slice_merge_for_review",
      },
      {
        parent_loop: "inner",
        phase_or_purpose: "tdd_build",
        session_state: "TIMEOUT",
        final_verdict: null,
        expected: "close_slice_merge_blocked",
      },
      {
        parent_loop: "inner",
        phase_or_purpose: "tdd_build",
        session_state: "ABANDONED",
        final_verdict: null,
        expected: "close_slice_merge_blocked",
      },
      {
        parent_loop: "middle",
        phase_or_purpose: "review",
        session_state: "CONVERGED",
        final_verdict: "approve",
        expected: "promote_slice_merge_to_approved_then_integrate",
      },
      {
        parent_loop: "middle",
        phase_or_purpose: "review",
        session_state: "CONVERGED",
        final_verdict: "request_changes",
        expected: "reset_slice_for_rebuild",
      },
    ];
    for (const c of cases) {
      const entry = lookupDispatch(c);
      expect(entry, JSON.stringify(c)).not.toBeNull();
      expect(entry?.effects.map((e) => e.kind)).toContain(c.expected);
    }
  });

  it("incident-12: middle review TIMEOUT/ABANDONED with prior request_changes → reset_slice_for_rebuild", () => {
    for (const state of ["TIMEOUT", "ABANDONED"] as const) {
      const entry = lookupDispatch({
        parent_loop: "middle",
        phase_or_purpose: "review",
        session_state: state,
        final_verdict: "request_changes",
      });
      expect(entry, state).not.toBeNull();
      expect(entry?.effects.map((e) => e.kind)).toContain(
        "reset_slice_for_rebuild",
      );
    }
    // The verdict-null fallback (no prior RC) still routes to
    // close_slice_merge_blocked → SLICE_BLOCKED.
    for (const state of ["TIMEOUT", "ABANDONED"] as const) {
      const entry = lookupDispatch({
        parent_loop: "middle",
        phase_or_purpose: "review",
        session_state: state,
        final_verdict: null,
      });
      expect(entry?.effects.map((e) => e.kind)).toContain(
        "close_slice_merge_blocked",
      );
    }
  });

  it("returns null for unknown tuples", () => {
    // inner tdd_build doesn't accept spec_accept verdict.
    expect(
      lookupDispatch({
        parent_loop: "inner",
        phase_or_purpose: "tdd_build",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
      }),
    ).toBeNull();
  });

  it("includes all Phase 5b.1 outer-loop tuples", () => {
    const cases: Array<{
      phase_or_purpose:
        | "Discovery"
        | "Specification"
        | "Planning"
        | "Validation";
      session_state: "CONVERGED" | "TIMEOUT" | "ABANDONED";
      final_verdict: string | null;
      expected: string;
    }> = [
      // Discovery
      {
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
        expected: "promote_milestone_to_specification",
      },
      {
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_reject",
        expected: "park_milestone_awaiting_human",
      },
      {
        phase_or_purpose: "Discovery",
        session_state: "TIMEOUT",
        final_verdict: null,
        expected: "recover_milestone_to_draft",
      },
      // Specification
      {
        phase_or_purpose: "Specification",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
        expected: "promote_milestone_to_spec_approved",
      },
      {
        phase_or_purpose: "Specification",
        session_state: "CONVERGED",
        final_verdict: "spec_reject",
        expected: "park_milestone_awaiting_human",
      },
      // Planning
      {
        phase_or_purpose: "Planning",
        session_state: "CONVERGED",
        final_verdict: "plan_accept",
        expected: "persist_slice_dag_and_promote",
      },
      {
        phase_or_purpose: "Planning",
        session_state: "CONVERGED",
        final_verdict: "request_changes",
        expected: "noop_planning_request_changes",
      },
      {
        phase_or_purpose: "Planning",
        session_state: "TIMEOUT",
        final_verdict: null,
        expected: "escalate_milestone",
      },
      // Validation
      {
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_pass",
        expected: "finalize_milestone_done",
      },
      {
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_fail",
        expected: "recover_milestone_to_building",
      },
      {
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_stale",
        expected: "noop_validation_stale",
      },
      {
        phase_or_purpose: "Validation",
        session_state: "ABANDONED",
        final_verdict: null,
        expected: "escalate_milestone",
      },
    ];
    for (const c of cases) {
      const entry = lookupDispatch({
        parent_loop: "outer",
        phase_or_purpose: c.phase_or_purpose,
        session_state: c.session_state,
        final_verdict: c.final_verdict,
      });
      expect(entry, JSON.stringify(c)).not.toBeNull();
      expect(entry?.effects.map((e) => e.kind)).toContain(c.expected);
    }
  });

  it("each entry has at least one effect", () => {
    for (const e of DISPATCH_MATRIX) {
      expect(e.effects.length, JSON.stringify(e)).toBeGreaterThan(0);
    }
  });
});
