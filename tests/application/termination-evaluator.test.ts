import { describe, expect, it } from "vitest";
import type { SessionTermination } from "../../src/domain/schema/dialogue-session.js";
import {
  evaluateTermination,
  type TurnSummary,
} from "../../src/application/termination-evaluator.js";

const ISO = "2026-05-08T00:00:00.000Z";

function passVerification() {
  return {
    verification_run_id: "01HZV00000000000000000000A",
    target_id: "x",
    target_revision: "x",
    commands_or_checks: [],
    environment_fingerprint: "x",
    started_at: ISO,
    finished_at: ISO,
    result: "pass" as const,
    failed_tests: [],
    log_ref: null,
  };
}

function failVerification() {
  return { ...passVerification(), result: "fail" as const };
}

const innerTermination: SessionTermination = {
  finalization_rule: "lead_only",
  required_evidence: [
    {
      kind: "verification_green",
      acceptance_tests: ["t.test.ts:add"],
      deterministic_checks: [],
    },
  ],
  composite_rule: "evidence_only",
  quorum_min_approvals: null,
};

const middleTermination: SessionTermination = {
  finalization_rule: "any_request_changes_blocks",
  required_evidence: [
    {
      kind: "verification_green",
      acceptance_tests: ["t.test.ts:add"],
      deterministic_checks: [],
    },
  ],
  composite_rule: "finalization_AND_evidence",
  quorum_min_approvals: null,
};

describe("evaluateTermination", () => {
  it("returns continue when no turns recorded", () => {
    const out = evaluateTermination({
      termination: innerTermination,
      turns: [],
      max_turns: 5,
    });
    expect(out).toEqual({ converged: false, reason: "continue" });
  });

  it("inner: derives tests_green from passed verification (evidence_only)", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: null,
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: innerTermination,
      turns,
      max_turns: 5,
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "tests_green",
      finalization_decision: "required_evidence",
    });
  });

  it("inner: continues when verification fails", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: null,
        verification: failVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: innerTermination,
      turns,
      max_turns: 5,
    });
    expect(out).toEqual({ converged: false, reason: "continue" });
  });

  it("middle review approve: verdict + verification both required (composite AND)", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: { result: "approve", rationale: null },
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: middleTermination,
      turns,
      max_turns: 5,
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "approve",
      finalization_decision: "composite",
    });
  });

  it("middle review request_changes: any_request_changes_blocks routes verdict", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: { result: "request_changes", rationale: null },
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: middleTermination,
      turns,
      max_turns: 5,
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "request_changes",
      finalization_decision: "composite",
    });
  });

  it("middle review: blocks on failed verification even with approve verdict", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: { result: "approve", rationale: null },
        verification: failVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: middleTermination,
      turns,
      max_turns: 5,
    });
    expect(out).toEqual({ converged: false, reason: "continue" });
  });

  it("trips timeout when turn count reaches max_turns", () => {
    const turns: TurnSummary[] = Array.from({ length: 5 }, () => ({
      agent_role_in_session: "lead" as const,
      verdict: null,
      verification: failVerification(),
    }));
    const out = evaluateTermination({
      termination: innerTermination,
      turns,
      max_turns: 5,
    });
    expect(out).toEqual({ converged: false, reason: "timeout" });
  });

  it("trips abandoned on no_progress hint limit", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: null,
        verification: failVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: innerTermination,
      turns,
      max_turns: 10,
      hints: { no_progress_count: 3, no_progress_limit: 3 },
    });
    expect(out).toEqual({
      converged: false,
      reason: "abandoned",
      abandoned_reason: "no_progress",
    });
  });
});

// ----------------------------------------------------------------------
// Phase 4 PR-6 — PR-first review union (pr_reviews input)
// ----------------------------------------------------------------------

describe("evaluateTermination · Phase 4 pr_reviews union", () => {
  it("PR-first request_changes followed by approve in the next round → converges on approve (same-PR continuation)", () => {
    // PR #123 P1-1 fix: prior-round PR reviews must NOT keep
    // `any_request_changes_blocks` stuck after a follow-up commit + approve
    // on the same surface. With `current_review_round=1` the evaluator
    // considers only the round-1 approve; the round-0 RC remains in the
    // persisted history but does not contribute to the decision.
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: { result: "tests_green", rationale: null },
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: middleTermination,
      turns,
      max_turns: 10,
      current_review_round: 1,
      pr_reviews: [
        {
          agent_role_in_session: "reviewer",
          verdict: { result: "request_changes", rationale: null },
          agent_profile_id: "sentinel",
          review_round: 0,
        },
        {
          agent_role_in_session: "reviewer",
          verdict: { result: "approve", rationale: null },
          agent_profile_id: "sentinel",
          review_round: 1,
        },
      ],
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "approve",
      finalization_decision: "composite",
    });
  });

  it("PR-first round-N PR reviews are kept; prior-round reviews dropped from evaluator input (default = max round)", () => {
    // No `current_review_round` supplied → evaluator picks the highest
    // round present in pr_reviews. Round-0 request_changes must NOT block
    // when round-1 approve exists.
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: { result: "tests_green", rationale: null },
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: middleTermination,
      turns,
      max_turns: 10,
      pr_reviews: [
        {
          agent_role_in_session: "reviewer",
          verdict: { result: "request_changes", rationale: null },
          agent_profile_id: "sentinel",
          review_round: 0,
        },
        {
          agent_role_in_session: "reviewer",
          verdict: { result: "approve", rationale: null },
          agent_profile_id: "sentinel",
          review_round: 1,
        },
      ],
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "approve",
      finalization_decision: "composite",
    });
  });

  it("PR-first current_review_round explicitly pinned to round 0 → round-0 request_changes blocks even when round-1 approve is also present", () => {
    // Symmetry check for P1-1: when the caller pins to an earlier round,
    // the evaluator must honour it and ignore later-round signals.
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: { result: "tests_green", rationale: null },
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: middleTermination,
      turns,
      max_turns: 10,
      current_review_round: 0,
      pr_reviews: [
        {
          agent_role_in_session: "reviewer",
          verdict: { result: "request_changes", rationale: null },
          agent_profile_id: "sentinel",
          review_round: 0,
        },
        {
          agent_role_in_session: "reviewer",
          verdict: { result: "approve", rationale: null },
          agent_profile_id: "sentinel",
          review_round: 1,
        },
      ],
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "request_changes",
      finalization_decision: "composite",
    });
  });

  it("PR-first single approve review + passed verification → converges on approve", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: { result: "tests_green", rationale: null },
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: middleTermination,
      turns,
      max_turns: 10,
      pr_reviews: [
        {
          agent_role_in_session: "reviewer",
          verdict: { result: "approve", rationale: null },
          agent_profile_id: "sentinel",
          review_round: 0,
        },
      ],
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "approve",
      finalization_decision: "composite",
    });
  });

  it("PR-first empty pr_reviews input → behaves identically to legacy turn-only evaluator (zero regression)", () => {
    const turns: TurnSummary[] = [
      {
        agent_role_in_session: "lead",
        verdict: null,
        verification: passVerification(),
      },
    ];
    const out = evaluateTermination({
      termination: innerTermination,
      turns,
      max_turns: 5,
      pr_reviews: [],
    });
    expect(out).toEqual({
      converged: true,
      final_verdict: "tests_green",
      finalization_decision: "required_evidence",
    });
  });
});
