import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_CONFIG,
  classifyAgentIoStageFailure,
  countPromptComposeFailuresFromLedger,
  evaluateRetry,
} from "../../src/application/failure-policy.js";

describe("evaluateRetry (RGC-FAILURE)", () => {
  it("default config — no_progress escalates at 3", () => {
    expect(evaluateRetry("no_progress", 0)).toEqual({
      decision: "continue",
      remaining: DEFAULT_RETRY_CONFIG.innerNoProgressLimit,
    });
    expect(evaluateRetry("no_progress", 2)).toEqual({
      decision: "continue",
      remaining: 1,
    });
    expect(evaluateRetry("no_progress", 3)).toEqual({
      decision: "escalate",
      reason: "no_progress count=3 >= limit=3",
    });
  });

  it("regression escalates at 1 (refactor turn revert exhausts immediately)", () => {
    expect(evaluateRetry("regression", 1)).toEqual({
      decision: "escalate",
      reason: "regression count=1 >= limit=1",
    });
  });

  it("middle_review_attempt + slice_merge_revalidation honor cfg overrides", () => {
    expect(
      evaluateRetry("middle_review_attempt", 5, { middleReviewAttemptsLimit: 10 }),
    ).toEqual({ decision: "continue", remaining: 5 });
    expect(
      evaluateRetry("slice_merge_revalidation", 0, {
        sliceMergeRevalidationLimit: 0,
      }),
    ).toEqual({ decision: "escalate", reason: "slice_merge_revalidation count=0 >= limit=0" });
  });

  it("prompt_compose_truncation default — escalates at 3 (incident-3)", () => {
    expect(
      DEFAULT_RETRY_CONFIG.promptComposeTruncationLimit,
    ).toBe(3);
    expect(evaluateRetry("prompt_compose_truncation", 0)).toEqual({
      decision: "continue",
      remaining: 3,
    });
    expect(evaluateRetry("prompt_compose_truncation", 2)).toEqual({
      decision: "continue",
      remaining: 1,
    });
    expect(evaluateRetry("prompt_compose_truncation", 3)).toEqual({
      decision: "escalate",
      reason: "prompt_compose_truncation count=3 >= limit=3",
    });
  });
});

describe("classifyAgentIoStageFailure (incident-3)", () => {
  it("returns null for ok outcomes", () => {
    expect(classifyAgentIoStageFailure({ ok: true })).toBeNull();
  });

  it("maps prompt_compose stage failures to prompt_compose_truncation", () => {
    expect(
      classifyAgentIoStageFailure({ ok: false, stage: "prompt_compose" }),
    ).toBe("prompt_compose_truncation");
  });

  it("returns null for non-prompt_compose stage failures (handled elsewhere)", () => {
    for (const stage of [
      "lr_invoke",
      "envelope_parse",
      "envelope_enrich",
      "matrix_validate",
    ] as const) {
      expect(classifyAgentIoStageFailure({ ok: false, stage })).toBeNull();
    }
  });

  it("countPromptComposeFailuresFromLedger counts only prompt_compose/* invalid rows for the session", async () => {
    const sessionId = "01HZS00000000000000000000A";
    const otherSession = "01HZS00000000000000000000B";
    const rows = [
      { session_id: sessionId, result: "invalid", result_detail: "prompt_compose/context_budget_truncation: foo" },
      { session_id: sessionId, result: "applied", result_detail: null },
      { session_id: sessionId, result: "invalid", result_detail: "envelope_parse/schema_violation: bar" },
      { session_id: otherSession, result: "invalid", result_detail: "prompt_compose/context_budget_truncation: baz" },
      { session_id: sessionId, result: "invalid", result_detail: "prompt_compose/prompt_layout_violation: qux" },
    ];
    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
    const fakeStore = {
      readText: async (relPath: string) => {
        expect(relPath).toBe("ledger/transitions.ndjson");
        return ndjson;
      },
    };
    expect(
      await countPromptComposeFailuresFromLedger(fakeStore, sessionId),
    ).toBe(2);
    expect(
      await countPromptComposeFailuresFromLedger(fakeStore, otherSession),
    ).toBe(1);
    // Empty / missing ledger short-circuits to 0.
    expect(
      await countPromptComposeFailuresFromLedger(
        { readText: async () => null },
        sessionId,
      ),
    ).toBe(0);
    expect(
      await countPromptComposeFailuresFromLedger(
        { readText: async () => "" },
        sessionId,
      ),
    ).toBe(0);
  });

  it("integration: 4 consecutive prompt_compose failures exhaust the retry budget", () => {
    // Simulate a daemon re-invoking runOneOuterTurn 4 times where every turn
    // produces an `agent-io` outcome with stage=prompt_compose. The caller
    // would maintain a per-(session, classification) counter; we model that
    // counter directly. Attempts 1..3 continue, attempt 4 escalates.
    const outcomes = [
      { ok: false as const, stage: "prompt_compose" as const, detail: "first" },
      { ok: false as const, stage: "prompt_compose" as const, detail: "second" },
      { ok: false as const, stage: "prompt_compose" as const, detail: "third" },
      { ok: false as const, stage: "prompt_compose" as const, detail: "fourth" },
    ];
    let counter = 0;
    const decisions = outcomes.map((o) => {
      const cls = classifyAgentIoStageFailure(o);
      expect(cls).toBe("prompt_compose_truncation");
      const decision = evaluateRetry(cls!, counter);
      counter += 1;
      return decision;
    });
    expect(decisions[0]).toEqual({ decision: "continue", remaining: 3 });
    expect(decisions[1]).toEqual({ decision: "continue", remaining: 2 });
    expect(decisions[2]).toEqual({ decision: "continue", remaining: 1 });
    expect(decisions[3]).toEqual({
      decision: "escalate",
      reason: "prompt_compose_truncation count=3 >= limit=3",
    });
  });
});
