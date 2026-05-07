/**
 * RGC-FAILURE retry / escalation policy.
 *
 * Pure helpers — no I/O. The caller (turn-worker / dialogue-coordinator)
 * supplies a counter that it has been keeping per (session_id, classification)
 * and asks the policy whether to continue or to escalate.
 *
 * Phase-4 scope:
 *   - inner tdd_build no_progress / regression / scope_violation streaks
 *   - middle review max_attempts (request_changes loops)
 *   - SliceMerge revalidation attempts (SM_STALE → reattempt → SM_STALE)
 *
 * Counter persistence (where the streaks live in workdir) is the caller's
 * concern; phase-4 stores them inside the `DialogueSession` advisory slot
 * `advisory.failure_counters` (added below in a follow-up commit) or — for
 * the SliceMerge case — derives them from the ledger by counting
 * (object_id=slice_merge_id, to_state=SM_STALE) rows.
 */

export interface RetryConfig {
  /** loop_policies.inner.tdd_build.no_progress_streak */
  innerNoProgressLimit?: number;
  /** loop_policies.inner.tdd_build.regression_streak */
  innerRegressionLimit?: number;
  /** loop_policies.inner.tdd_build.max_attempts_per_turn */
  innerScopeViolationLimit?: number;
  /** loop_policies.middle.review.max_attempts */
  middleReviewAttemptsLimit?: number;
  /** loop_policies.middle.merge.max_revalidation_attempts */
  sliceMergeRevalidationLimit?: number;
}

export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  innerNoProgressLimit: 3,
  innerRegressionLimit: 1,
  innerScopeViolationLimit: 3,
  middleReviewAttemptsLimit: 3,
  sliceMergeRevalidationLimit: 1,
};

export type FailureClassification =
  | "no_progress"
  | "regression"
  | "scope_violation"
  | "middle_review_attempt"
  | "slice_merge_revalidation";

export type RetryDecision =
  | { decision: "continue"; remaining: number }
  | { decision: "escalate"; reason: string };

export function evaluateRetry(
  classification: FailureClassification,
  currentCount: number,
  cfg: RetryConfig = {},
): RetryDecision {
  const merged: Required<RetryConfig> = { ...DEFAULT_RETRY_CONFIG, ...cfg };
  const limit = limitFor(classification, merged);
  if (currentCount >= limit)
    return {
      decision: "escalate",
      reason: `${classification} count=${currentCount} >= limit=${limit}`,
    };
  return { decision: "continue", remaining: limit - currentCount };
}

function limitFor(
  c: FailureClassification,
  cfg: Required<RetryConfig>,
): number {
  switch (c) {
    case "no_progress":
      return cfg.innerNoProgressLimit;
    case "regression":
      return cfg.innerRegressionLimit;
    case "scope_violation":
      return cfg.innerScopeViolationLimit;
    case "middle_review_attempt":
      return cfg.middleReviewAttemptsLimit;
    case "slice_merge_revalidation":
      return cfg.sliceMergeRevalidationLimit;
  }
}
