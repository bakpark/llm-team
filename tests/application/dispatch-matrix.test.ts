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

  it("returns null for unknown tuples", () => {
    expect(
      lookupDispatch({
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
      }),
    ).toBeNull();
  });

  it("each entry has at least one effect", () => {
    for (const e of DISPATCH_MATRIX) {
      expect(e.effects.length, JSON.stringify(e)).toBeGreaterThan(0);
    }
  });
});
