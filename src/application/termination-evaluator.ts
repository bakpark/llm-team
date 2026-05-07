/**
 * SOC-SESSION-TERMINATION evaluator (pure function).
 *
 * Decides whether a session has CONVERGED / TIMEOUT / ABANDONED based on
 * `(finalization_rule, required_evidence, composite_rule)` plus the
 * accumulated turn outcomes (verdicts) and the latest evidence (verification
 * + metric runs). Pure function — no I/O, no clock, no store. Deterministic
 * for the same inputs so it can be replayed during recovery.
 *
 * Caller usage:
 *   1. After a turn worker persists a SessionTurn + verification result, the
 *      caller (dialogue-coordinator or turn-worker phase 2 inline path)
 *      passes the session, its termination block, and the latest turn /
 *      verification snapshot into `evaluateTermination`.
 *   2. The decision is consumed by `caller-dispatch` (CONVERGED) or by
 *      session bookkeeping (timeout/abandoned).
 *
 * Phase 3 scope: covers the rules used by inner tdd_build (`lead_only` +
 * `verification_green` + `evidence_only`) and middle review
 * (`any_request_changes_blocks` + `verification_green` +
 * `finalization_AND_evidence`). Outer loop rules and richer evidence kinds
 * (metric_threshold etc.) extend the same shape in later phases.
 */
import type {
  CompositeRule,
  FinalizationDecision,
  FinalizationRule,
  RequiredEvidence,
  SessionTermination,
} from "../domain/schema/dialogue-session.js";
import type { Verdict } from "../domain/schema/envelope.js";
import type { VerificationRun } from "../domain/schema/verification.js";

export interface TurnSummary {
  agent_role_in_session: "lead" | "reviewer" | "observer";
  /** From the agent envelope. Null if no verdict was emitted on that turn. */
  verdict: Verdict | null;
  /** Verification result attached to that turn (inner / middle reverify). */
  verification: VerificationRun | null;
}

export interface TerminationInputs {
  termination: SessionTermination;
  /** All turns persisted so far, oldest → newest. */
  turns: readonly TurnSummary[];
  /** Hard cap: SOC-SESSION-LIFECYCLE TIMEOUT trigger. */
  max_turns: number;
  /**
   * Optional runtime hints. Phase 3 ignores these; reserved for phase 4
   * recovery (no_progress / regression / scope_violation hints).
   */
  hints?: {
    no_progress_count?: number;
    regression_count?: number;
    scope_violation_count?: number;
    no_progress_limit?: number;
    regression_limit?: number;
    scope_violation_limit?: number;
  };
}

export type TerminationDecision =
  | {
      converged: true;
      final_verdict: string;
      finalization_decision: FinalizationDecision;
    }
  | {
      converged: false;
      reason: "continue";
    }
  | {
      converged: false;
      reason: "timeout";
    }
  | {
      converged: false;
      reason: "abandoned";
      abandoned_reason: "no_progress" | "regression" | "scope_violation";
    };

export function evaluateTermination(
  input: TerminationInputs,
): TerminationDecision {
  const turnCount = input.turns.length;

  // Hard caps before convergence rules so a stuck session always exits.
  if (turnCount >= input.max_turns)
    return { converged: false, reason: "timeout" };

  const hints = input.hints ?? {};
  if (
    hints.no_progress_limit != null &&
    (hints.no_progress_count ?? 0) >= hints.no_progress_limit
  )
    return {
      converged: false,
      reason: "abandoned",
      abandoned_reason: "no_progress",
    };
  if (
    hints.regression_limit != null &&
    (hints.regression_count ?? 0) >= hints.regression_limit
  )
    return {
      converged: false,
      reason: "abandoned",
      abandoned_reason: "regression",
    };
  if (
    hints.scope_violation_limit != null &&
    (hints.scope_violation_count ?? 0) >= hints.scope_violation_limit
  )
    return {
      converged: false,
      reason: "abandoned",
      abandoned_reason: "scope_violation",
    };

  if (turnCount === 0) return { converged: false, reason: "continue" };

  const finalizationOk = checkFinalization(
    input.termination.finalization_rule,
    input.turns,
    input.termination.quorum_min_approvals,
  );
  const evidenceOk = checkEvidence(
    input.termination.required_evidence,
    input.turns,
  );

  switch (input.termination.composite_rule) {
    case "evidence_only":
      if (evidenceOk.ok)
        return {
          converged: true,
          final_verdict: evidenceOk.derivedVerdict ?? deriveLeadVerdict(input.turns),
          finalization_decision: "required_evidence",
        };
      return { converged: false, reason: "continue" };
    case "finalization_only":
      if (finalizationOk.ok)
        return {
          converged: true,
          final_verdict: finalizationOk.verdict,
          finalization_decision: "finalization_rule",
        };
      return { converged: false, reason: "continue" };
    case "finalization_AND_evidence":
      if (finalizationOk.ok && evidenceOk.ok)
        return {
          converged: true,
          final_verdict: finalizationOk.verdict,
          finalization_decision: "composite",
        };
      return { converged: false, reason: "continue" };
  }
}

interface FinalizationOutcome {
  ok: boolean;
  /** When ok, the verdict to attach to the session. */
  verdict: string;
}

function checkFinalization(
  rule: FinalizationRule,
  turns: readonly TurnSummary[],
  quorumMin: number | null,
): FinalizationOutcome {
  switch (rule) {
    case "lead_only": {
      const leadTurn = lastBy(turns, (t) => t.agent_role_in_session === "lead");
      const v = leadTurn?.verdict?.result ?? null;
      if (v == null) return { ok: false, verdict: "" };
      return { ok: true, verdict: v };
    }
    case "any_request_changes_blocks": {
      const reviewer = lastBy(
        turns,
        (t) =>
          t.agent_role_in_session === "lead" ||
          t.agent_role_in_session === "reviewer",
      );
      const v = reviewer?.verdict?.result ?? null;
      if (v == null) return { ok: false, verdict: "" };
      const anyRC = turns.some((t) => t.verdict?.result === "request_changes");
      if (anyRC) return { ok: true, verdict: "request_changes" };
      return { ok: true, verdict: v };
    }
    case "unanimous_approve": {
      const reviewers = turns.filter(
        (t) => t.agent_role_in_session === "reviewer",
      );
      if (reviewers.length === 0) return { ok: false, verdict: "" };
      if (reviewers.every((t) => t.verdict?.result === "approve"))
        return { ok: true, verdict: "approve" };
      return { ok: false, verdict: "" };
    }
    case "quorum_then_lead": {
      const approvals = turns.filter(
        (t) => t.verdict?.result === "approve",
      ).length;
      const min = quorumMin ?? 1;
      if (approvals < min) return { ok: false, verdict: "" };
      const leadTurn = lastBy(turns, (t) => t.agent_role_in_session === "lead");
      const v = leadTurn?.verdict?.result ?? null;
      if (v == null) return { ok: false, verdict: "" };
      return { ok: true, verdict: v };
    }
    case "timeout_only":
      // observation-only sessions never converge by finalization rule alone.
      return { ok: false, verdict: "" };
  }
}

interface EvidenceOutcome {
  ok: boolean;
  /**
   * Some evidence kinds determine the verdict directly (e.g. inner tdd_build's
   * `verification_green` → `tests_green`). Phase 3 only models that case;
   * other evidence kinds leave the verdict for the finalization rule.
   */
  derivedVerdict?: string;
}

function checkEvidence(
  required: readonly RequiredEvidence[],
  turns: readonly TurnSummary[],
): EvidenceOutcome {
  if (required.length === 0) return { ok: true };
  const latest = lastBy(turns, (t) => t.verification != null);
  for (const r of required) {
    switch (r.kind) {
      case "verification_green":
        if (latest?.verification?.result !== "pass")
          return { ok: false };
        break;
      // P1-7 fix (PR #62 review): unimplemented evidence kinds must NOT
      // silently pass. Returning `{ ok: false }` keeps the session in
      // `continue` until a future phase wires the actual evaluator. This
      // prevents a misconfigured `required_evidence` block from converging
      // a session with no real evidence.
      case "metric_threshold":
      case "interface_diff_clean":
      case "coverage_threshold":
        return { ok: false };
    }
  }
  // Inner tdd_build: a passed verification implies tests_green.
  const innerLike = required.some((r) => r.kind === "verification_green");
  if (innerLike && latest?.verification?.result === "pass")
    return { ok: true, derivedVerdict: "tests_green" };
  return { ok: true };
}

function deriveLeadVerdict(turns: readonly TurnSummary[]): string {
  const lead = lastBy(turns, (t) => t.agent_role_in_session === "lead");
  return lead?.verdict?.result ?? "tests_green";
}

function lastBy<T>(
  arr: readonly T[],
  predicate: (t: T) => boolean,
): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]!;
    if (predicate(v)) return v;
  }
  return null;
}

// avoid unused-import warnings while keeping the type re-exported in JSDoc
void (null as unknown as CompositeRule);
