import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_CONFIG,
  classifyAgentIoStageFailure,
  countLrInvokeTimeoutsFromLedger,
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

describe("incident-10 — inner_lr_invoke_timeout retry cap", () => {
  it("DEFAULT_RETRY_CONFIG.innerLrInvokeTimeoutLimit defaults to 5", () => {
    expect(DEFAULT_RETRY_CONFIG.innerLrInvokeTimeoutLimit).toBe(5);
  });

  it("evaluateRetry escalates inner_lr_invoke_timeout at the default cap", () => {
    expect(evaluateRetry("inner_lr_invoke_timeout", 0)).toEqual({
      decision: "continue",
      remaining: 5,
    });
    expect(evaluateRetry("inner_lr_invoke_timeout", 4)).toEqual({
      decision: "continue",
      remaining: 1,
    });
    expect(evaluateRetry("inner_lr_invoke_timeout", 5)).toEqual({
      decision: "escalate",
      reason: "inner_lr_invoke_timeout count=5 >= limit=5",
    });
  });

  it("evaluateRetry honors operator override (target failure_policy.inner_lr_timeout_cap)", () => {
    expect(
      evaluateRetry("inner_lr_invoke_timeout", 2, {
        innerLrInvokeTimeoutLimit: 3,
      }),
    ).toEqual({ decision: "continue", remaining: 1 });
    expect(
      evaluateRetry("inner_lr_invoke_timeout", 3, {
        innerLrInvokeTimeoutLimit: 3,
      }),
    ).toEqual({
      decision: "escalate",
      reason: "inner_lr_invoke_timeout count=3 >= limit=3",
    });
  });

  it("classifyAgentIoStageFailure maps lr_invoke + exitStatus=timeout detail to inner_lr_invoke_timeout", () => {
    expect(
      classifyAgentIoStageFailure({
        ok: false,
        stage: "lr_invoke",
        detail:
          "LlmRunner exitStatus=timeout; envelopeRef=/tmp/foo/envelope.json",
      }),
    ).toBe("inner_lr_invoke_timeout");
  });

  it("classifyAgentIoStageFailure maps every non-ok ExitStatus to inner_lr_invoke_timeout (phase-0-stabilization B)", () => {
    // All non-ok ExitStatus values now contribute to the cap. Previously
    // only `exitStatus=timeout` did, allowing transport_error /
    // adapter_unavailable / malformed_output loops to spawn unbounded
    // invocations (self-host evidence E5: 416 transport_error spawns / 11min).
    // qwen review P0-2: include `timeout` (the original incident-10 case)
    // explicitly so the backward-compatible mapping is asserted alongside
    // the generalized non-ok ExitStatus values.
    for (const status of [
      "timeout",
      "transport_error",
      "adapter_unavailable",
      "malformed_output",
    ]) {
      expect(
        classifyAgentIoStageFailure({
          ok: false,
          stage: "lr_invoke",
          detail: `LlmRunner exitStatus=${status}; envelopeRef=/tmp/x`,
        }),
      ).toBe("inner_lr_invoke_timeout");
    }
    // Synthetic `=ok` should not be classified — a successful run never
    // surfaces as ok=false in practice, but the predicate is conservative.
    expect(
      classifyAgentIoStageFailure({
        ok: false,
        stage: "lr_invoke",
        detail: "LlmRunner exitStatus=ok; envelopeRef=/tmp/x",
      }),
    ).toBeNull();
    // A non-`LlmRunner exitStatus=` detail shape is unmatched (defensive
    // — protects against an unrelated `lr_invoke` extension surfacing here).
    expect(
      classifyAgentIoStageFailure({
        ok: false,
        stage: "lr_invoke",
        detail: "spawn ENOENT",
      }),
    ).toBeNull();
    // Bare lr_invoke without detail does not contribute to the streak.
    expect(
      classifyAgentIoStageFailure({ ok: false, stage: "lr_invoke" }),
    ).toBeNull();
  });

  it("countLrInvokeTimeoutsFromLedger counts every non-ok ExitStatus row for the session (phase-0-stabilization B)", async () => {
    const sessionId = "01HZS00000000000000000000C";
    const otherSession = "01HZS00000000000000000000D";
    const rows = [
      // matching: every non-ok ExitStatus contributes
      {
        session_id: sessionId,
        result: "invalid",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=timeout; envelopeRef=/tmp/a",
      },
      {
        session_id: sessionId,
        result: "invalid",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=transport_error; envelopeRef=/tmp/b",
      },
      {
        session_id: sessionId,
        result: "invalid",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=adapter_unavailable; envelopeRef=/tmp/c",
      },
      {
        session_id: sessionId,
        result: "invalid",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=malformed_output; envelopeRef=/tmp/d",
      },
      // non-matching: not invalid
      {
        session_id: sessionId,
        result: "applied",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=timeout; envelopeRef=/tmp/e",
      },
      // non-matching: unrelated lr_invoke extension shape
      {
        session_id: sessionId,
        result: "invalid",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=unknown_future; envelopeRef=",
      },
      // non-matching: prompt_compose
      {
        session_id: sessionId,
        result: "invalid",
        result_detail: "prompt_compose/context_budget_truncation: foo",
      },
      // non-matching: different session
      {
        session_id: otherSession,
        result: "invalid",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=transport_error; envelopeRef=/tmp/f",
      },
    ];
    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
    const fakeStore = {
      readText: async (relPath: string) => {
        expect(relPath).toBe("ledger/transitions.ndjson");
        return ndjson;
      },
    };
    expect(
      await countLrInvokeTimeoutsFromLedger(fakeStore, sessionId),
    ).toBe(4);
    expect(
      await countLrInvokeTimeoutsFromLedger(fakeStore, otherSession),
    ).toBe(1);
    expect(
      await countLrInvokeTimeoutsFromLedger(
        { readText: async () => null },
        sessionId,
      ),
    ).toBe(0);
    expect(
      await countLrInvokeTimeoutsFromLedger(
        { readText: async () => "" },
        sessionId,
      ),
    ).toBe(0);
  });

  it("regression (phase-0-stabilization B): 6 consecutive transport_error invocations exhaust the cap=5", () => {
    // Self-host evidence E5: a single outer session spawned 416
    // transport_error invocations in 11 minutes because the previous
    // classifier matched only `exitStatus=timeout`. The generalized
    // classifier caps every non-ok ExitStatus, so a transport_error storm
    // ABANDONs the session at the same default cap as a timeout storm.
    let counter = 0;
    const decisions: ReturnType<typeof evaluateRetry>[] = [];
    for (let i = 0; i < 6; i++) {
      const cls = classifyAgentIoStageFailure({
        ok: false,
        stage: "lr_invoke",
        detail:
          "LlmRunner exitStatus=transport_error; envelopeRef=/tmp/x.envelope",
      });
      expect(cls).toBe("inner_lr_invoke_timeout");
      decisions.push(evaluateRetry(cls!, counter));
      counter += 1;
    }
    expect(decisions[5]).toEqual({
      decision: "escalate",
      reason: "inner_lr_invoke_timeout count=5 >= limit=5",
    });
  });

  it("regression (phase-0-stabilization B): malformed_output and adapter_unavailable share the same cap", () => {
    for (const status of ["malformed_output", "adapter_unavailable"]) {
      const cls = classifyAgentIoStageFailure({
        ok: false,
        stage: "lr_invoke",
        detail: `LlmRunner exitStatus=${status}; envelopeRef=/tmp/x`,
      });
      expect(cls).toBe("inner_lr_invoke_timeout");
      expect(evaluateRetry(cls!, 5)).toEqual({
        decision: "escalate",
        reason: "inner_lr_invoke_timeout count=5 >= limit=5",
      });
    }
  });

  it("integration: 6 consecutive lr_invoke timeouts exhaust the default cap=5", () => {
    let counter = 0;
    const decisions: ReturnType<typeof evaluateRetry>[] = [];
    for (let i = 0; i < 6; i++) {
      const cls = classifyAgentIoStageFailure({
        ok: false,
        stage: "lr_invoke",
        detail: "LlmRunner exitStatus=timeout; envelopeRef=",
      });
      expect(cls).toBe("inner_lr_invoke_timeout");
      decisions.push(evaluateRetry(cls!, counter));
      counter += 1;
    }
    expect(decisions[0]).toEqual({ decision: "continue", remaining: 5 });
    expect(decisions[4]).toEqual({ decision: "continue", remaining: 1 });
    expect(decisions[5]).toEqual({
      decision: "escalate",
      reason: "inner_lr_invoke_timeout count=5 >= limit=5",
    });
  });
});
