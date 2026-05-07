import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_CONFIG,
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
});
