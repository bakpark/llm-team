import type { Envelope } from "../domain/schema/envelope.js";

/**
 * AGC-CONTRIBUTION-OUTPUTS matrix (data-driven so phase 3+ extensions are
 * lookup additions rather than code changes).
 *
 * Two-axis layout:
 * - `LOOP_PURPOSE_ROWS`: parent_loop × phase_or_purpose × contribution_kind
 * - `ANY_LOOP_ROWS`: contribution_kind only (matches across any loop).
 *   Includes `human_approval`, `proposal`, and `session_outcome`. The latter
 *   is Caller-only at the AGC-OUTPUT layer (Inv #4) — `application/
 *   envelope.ts#parseAgentAuthored` rejects it before this matrix runs, so
 *   only Caller-built canonical envelopes reach the row.
 *
 * `failure` output_kind is allowed in any combination provided the
 * `failure` block is present — but the loop-conditional fields
 * (`slice_id`, `slice_kind`, `tdd_phase`) are still validated first, since
 * AGC-OUTPUT lists them as conditional on `parent_loop` alone (independent
 * of `output_kind`).
 */

export type ExtendedValidationResult =
  | { ok: true }
  | { ok: false; reason: ExtendedInvalidReason; detail: string };

export type ExtendedInvalidReason =
  | "matrix_violation"
  | "missing_required_envelope_field"
  | "phase_or_purpose_outside_loop";

interface MatrixRow {
  parent_loop: "outer" | "middle" | "inner";
  phase_or_purpose: string;
  contribution_kind:
    | "lead_draft"
    | "review_verdict"
    | "human_approval"
    | "session_outcome"
    | "proposal";
  allowed_output_kinds: string[];
  /**
   * `null` means a verdict is forbidden in this combination.
   * Otherwise verdict.result must be one of the listed values.
   */
  allowed_verdict_results: string[] | null;
}

const LOOP_PURPOSE_ROWS: MatrixRow[] = [
  {
    parent_loop: "outer",
    phase_or_purpose: "Discovery",
    contribution_kind: "lead_draft",
    allowed_output_kinds: ["spec_proposal"],
    allowed_verdict_results: null,
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "Specification",
    contribution_kind: "lead_draft",
    allowed_output_kinds: ["spec_proposal"],
    allowed_verdict_results: null,
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "Planning",
    contribution_kind: "lead_draft",
    allowed_output_kinds: ["slice_decomposition"],
    allowed_verdict_results: null,
  },
  {
    parent_loop: "outer",
    phase_or_purpose: "Validation",
    contribution_kind: "lead_draft",
    allowed_output_kinds: ["milestone_package"],
    allowed_verdict_results: ["PASS", "FAIL", "STALE"],
  },
  {
    parent_loop: "middle",
    phase_or_purpose: "review",
    contribution_kind: "review_verdict",
    allowed_output_kinds: ["verdict"],
    allowed_verdict_results: ["approve", "request_changes"],
  },
  {
    parent_loop: "inner",
    phase_or_purpose: "tdd_build",
    contribution_kind: "lead_draft",
    allowed_output_kinds: ["patch"],
    allowed_verdict_results: null,
  },
];

const ANY_LOOP_ROWS: Pick<
  MatrixRow,
  "contribution_kind" | "allowed_output_kinds" | "allowed_verdict_results"
>[] = [
  {
    contribution_kind: "human_approval",
    allowed_output_kinds: ["verdict"],
    allowed_verdict_results: ["approve", "reject"],
  },
  {
    contribution_kind: "proposal",
    allowed_output_kinds: ["proposal_artifact"],
    allowed_verdict_results: null,
  },
  {
    contribution_kind: "session_outcome",
    allowed_output_kinds: ["verdict", "milestone_package"],
    allowed_verdict_results: null,
  },
];

const VALID_PHASE_BY_LOOP: Record<Envelope["parent_loop"], string[]> = {
  outer: ["Discovery", "Specification", "Planning", "Validation"],
  middle: ["review", "merge"],
  inner: ["tdd_build"],
};

export function extendedValidate(env: Envelope): ExtendedValidationResult {
  if (!VALID_PHASE_BY_LOOP[env.parent_loop].includes(env.phase_or_purpose)) {
    return {
      ok: false,
      reason: "phase_or_purpose_outside_loop",
      detail: `phase_or_purpose=${env.phase_or_purpose} not allowed for parent_loop=${env.parent_loop}`,
    };
  }

  // AGC-OUTPUT slice_id / slice_kind / tdd_phase invariants apply regardless
  // of output_kind — including `failure`. A failure envelope still has to
  // identify the caller / session context it failed in. The failure
  // short-circuit comes AFTER conditional-field validation, not before.
  if (env.parent_loop === "middle" || env.parent_loop === "inner") {
    if (env.slice_id == null) {
      return {
        ok: false,
        reason: "missing_required_envelope_field",
        detail: `slice_id required for parent_loop=${env.parent_loop}`,
      };
    }
    if (env.slice_kind == null) {
      return {
        ok: false,
        reason: "missing_required_envelope_field",
        detail: `slice_kind required for parent_loop=${env.parent_loop}`,
      };
    }
  }
  if (env.parent_loop === "inner" && env.tdd_phase == null) {
    return {
      ok: false,
      reason: "missing_required_envelope_field",
      detail: "tdd_phase required for parent_loop=inner",
    };
  }

  if (env.output_kind === "failure") {
    if (env.failure == null) {
      return {
        ok: false,
        reason: "missing_required_envelope_field",
        detail: "output_kind=failure requires the `failure` block",
      };
    }
    return { ok: true };
  }

  const anyRow = ANY_LOOP_ROWS.find(
    (r) => r.contribution_kind === env.contribution_kind,
  );
  if (anyRow) {
    return checkOutputAndVerdict(env, anyRow);
  }

  const row = LOOP_PURPOSE_ROWS.find(
    (r) =>
      r.parent_loop === env.parent_loop &&
      r.phase_or_purpose === env.phase_or_purpose &&
      r.contribution_kind === env.contribution_kind,
  );
  if (!row) {
    return {
      ok: false,
      reason: "matrix_violation",
      detail: `(parent_loop=${env.parent_loop}, phase_or_purpose=${env.phase_or_purpose}, contribution_kind=${env.contribution_kind}) is not an AGC-CONTRIBUTION-OUTPUTS row`,
    };
  }
  return checkOutputAndVerdict(env, row);
}

function checkOutputAndVerdict(
  env: Envelope,
  row: Pick<
    MatrixRow,
    "contribution_kind" | "allowed_output_kinds" | "allowed_verdict_results"
  >,
): ExtendedValidationResult {
  if (!row.allowed_output_kinds.includes(env.output_kind)) {
    return {
      ok: false,
      reason: "matrix_violation",
      detail: `(${row.contribution_kind}, output_kind=${env.output_kind}) not allowed; expected one of [${row.allowed_output_kinds.join(", ")}]`,
    };
  }
  if (row.allowed_verdict_results == null) {
    if (env.verdict != null) {
      return {
        ok: false,
        reason: "matrix_violation",
        detail: `verdict not allowed for contribution_kind=${row.contribution_kind}`,
      };
    }
    return { ok: true };
  }
  if (
    env.verdict == null ||
    !row.allowed_verdict_results.includes(env.verdict.result)
  ) {
    return {
      ok: false,
      reason: "matrix_violation",
      detail: `verdict.result must be one of [${row.allowed_verdict_results.join(", ")}]`,
    };
  }
  return { ok: true };
}
