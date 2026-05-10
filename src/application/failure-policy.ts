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
  /**
   * Maximum consecutive `prompt_compose` AGC-INVALID outcomes before
   * escalation (incident-3). The stage runs before any LLM invocation, so
   * an unbounded retry burns no model tokens but does loop the daemon —
   * tighter than agent-side streaks. Default 3.
   */
  promptComposeTruncationLimit?: number;
  /**
   * incident-10: maximum consecutive `lr_invoke/lr_exit_status` failures
   * whose detail string indicates a runner-level timeout
   * (`exitStatus=timeout`) before an inner session is ABANDONED. Distinct
   * from agent-side `no_progress` because no envelope is ever produced —
   * the streak counter has no agent signal to advance, and the daemon
   * would otherwise re-pick the session indefinitely. Default 5.
   */
  innerLrInvokeTimeoutLimit?: number;
}

export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  innerNoProgressLimit: 3,
  innerRegressionLimit: 1,
  innerScopeViolationLimit: 3,
  middleReviewAttemptsLimit: 3,
  sliceMergeRevalidationLimit: 1,
  promptComposeTruncationLimit: 3,
  innerLrInvokeTimeoutLimit: 5,
};

export type FailureClassification =
  | "no_progress"
  | "regression"
  | "scope_violation"
  | "middle_review_attempt"
  | "slice_merge_revalidation"
  | "prompt_compose_truncation"
  | "inner_lr_invoke_timeout";

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
    case "prompt_compose_truncation":
      return cfg.promptComposeTruncationLimit;
    case "inner_lr_invoke_timeout":
      return cfg.innerLrInvokeTimeoutLimit;
  }
}

/**
 * Pure classifier — maps an `agent-io.callAgent` outcome to a
 * `FailureClassification` bucket suitable for `evaluateRetry`. Returns null
 * for outcomes that do not contribute to a retry counter (success, or
 * stages handled by other failure paths such as
 * inner/middle no_progress / regression streaks).
 *
 * incident-3: `prompt_compose` failures short-circuit before the LLM is
 * invoked, so they would otherwise loop indefinitely with no agent-side
 * streak ever advancing. Mapping them to `prompt_compose_truncation` gives
 * the caller a counter that escalates after `promptComposeTruncationLimit`
 * consecutive failures.
 */
export function classifyAgentIoStageFailure(outcome: {
  ok: boolean;
  stage?: string;
  detail?: string;
}): FailureClassification | null {
  if (outcome.ok) return null;
  if (outcome.stage === "prompt_compose") return "prompt_compose_truncation";
  // incident-10: only the runner-level timeout flavor of `lr_invoke` failures
  // contributes to the inner abandon counter. Other `lr_invoke` failures
  // (e.g. spawn errors, non-zero exit) are surfaced as invalid envelopes
  // but do not advance this streak — they are typically environmental and
  // operator-recoverable, distinct from the "model is hanging" signal.
  if (
    outcome.stage === "lr_invoke" &&
    typeof outcome.detail === "string" &&
    outcome.detail.includes("exitStatus=timeout")
  ) {
    return "inner_lr_invoke_timeout";
  }
  return null;
}

/**
 * Count prior `prompt_compose/...` invalid ledger rows for a given session
 * (incident-3 retry counter source). Walks `ledger/transitions.ndjson`
 * directly via the StorePort — there is no persisted `failure_counters`
 * advisory slot for this classification, and the ledger is the only durable
 * record that survives daemon restarts.
 *
 * The returned count is the number of `result="invalid"` rows whose
 * `result_detail` begins with `prompt_compose/` and whose `session_id`
 * matches. Callers use it as `currentCount` for `evaluateRetry`.
 */
export async function countPromptComposeFailuresFromLedger(
  store: { readText(relPath: string): Promise<string | null> },
  sessionId: string,
): Promise<number> {
  const body = await store.readText("ledger/transitions.ndjson");
  if (body == null || body.length === 0) return 0;
  let count = 0;
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    let row: { session_id?: unknown; result?: unknown; result_detail?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.session_id !== sessionId) continue;
    if (row.result !== "invalid") continue;
    if (
      typeof row.result_detail === "string" &&
      row.result_detail.startsWith("prompt_compose/")
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * incident-10: count prior `lr_invoke/lr_exit_status` invalid ledger rows
 * for a given session whose detail string indicates a runner-level timeout
 * (`exitStatus=timeout`). Mirrors `countPromptComposeFailuresFromLedger` —
 * the ledger is the only durable record that survives daemon restarts, and
 * timeouts produce no envelope so no agent-side streak counter advances.
 *
 * Format produced by `turn-worker.emitInvalidTurn`:
 *   `result_detail = "lr_invoke/lr_exit_status: LlmRunner exitStatus=timeout; envelopeRef=..."`
 *
 * Callers use the returned count as `currentCount` for `evaluateRetry`.
 */
export async function countLrInvokeTimeoutsFromLedger(
  store: { readText(relPath: string): Promise<string | null> },
  sessionId: string,
): Promise<number> {
  const body = await store.readText("ledger/transitions.ndjson");
  if (body == null || body.length === 0) return 0;
  let count = 0;
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    let row: { session_id?: unknown; result?: unknown; result_detail?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.session_id !== sessionId) continue;
    if (row.result !== "invalid") continue;
    if (
      typeof row.result_detail === "string" &&
      row.result_detail.startsWith("lr_invoke/lr_exit_status") &&
      row.result_detail.includes("exitStatus=timeout")
    ) {
      count += 1;
    }
  }
  return count;
}
