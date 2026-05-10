/**
 * L4 post-call tracked-diff allowlist (cli-spicy-anchor.md §1).
 *
 * After the agent process exits, lead-invoker / reviewer-invoker compare
 * the worktree's git-tracked diff (`git status --porcelain` +
 * `git diff --name-only`) with the agent's declared `LeadIntent.changed_files`.
 * Mismatches are surfaced as a `capability_violation_l4_*` reason for
 * ledger logging.
 *
 * Phase 1 ships only the pure helper. Actual call-sites land in Phase 2/3.
 */

export interface DiffAllowlistInput {
  /** Repo-relative paths the agent declared via LeadIntent.changed_files. */
  declaredChangedFiles: readonly string[];
  /**
   * Repo-relative paths surfaced by `git status --porcelain` as modified
   * (M / A / D / R). The caller is responsible for parsing `git status`
   * and feeding this list — keeps the helper port-free for testability.
   */
  trackedChangedFiles: readonly string[];
  /**
   * When true (reviewer role), any tracked diff is treated as a violation
   * even if it appears in `declaredChangedFiles` (reviewers must not
   * modify the worktree at all).
   */
  reviewerReadOnly?: boolean;
}

export type DiffAllowlistViolationKind =
  | "capability_violation_l4_undeclared"
  | "capability_violation_l4_missing_declared"
  | "capability_violation_l4_reviewer_modified";

export interface DiffAllowlistViolation {
  kind: DiffAllowlistViolationKind;
  paths: string[];
}

export interface DiffAllowlistOutcome {
  ok: boolean;
  violations: DiffAllowlistViolation[];
}

/**
 * Validate the worktree's tracked diff against the agent's declared file
 * set. Returns `{ ok: true, violations: [] }` when:
 *
 *   - lead role: tracked diff ⊆ declared (every modified path was declared).
 *     Declared-but-not-modified is allowed (agent may declare files it
 *     intended to but skipped — caller decides whether that's an issue
 *     elsewhere); we surface it as a separate `missing_declared` violation
 *     so callers can choose strictness.
 *   - reviewer role: tracked diff is empty.
 */
export function checkPostCallDiffAllowlist(
  input: DiffAllowlistInput,
): DiffAllowlistOutcome {
  const violations: DiffAllowlistViolation[] = [];
  const declared = new Set(input.declaredChangedFiles);
  const tracked = new Set(input.trackedChangedFiles);

  if (input.reviewerReadOnly) {
    if (tracked.size > 0) {
      violations.push({
        kind: "capability_violation_l4_reviewer_modified",
        paths: [...tracked].sort(),
      });
    }
    return { ok: violations.length === 0, violations };
  }

  const undeclared: string[] = [];
  for (const p of tracked) {
    if (!declared.has(p)) undeclared.push(p);
  }
  if (undeclared.length > 0) {
    violations.push({
      kind: "capability_violation_l4_undeclared",
      paths: undeclared.sort(),
    });
  }

  const missing: string[] = [];
  for (const p of declared) {
    if (!tracked.has(p)) missing.push(p);
  }
  if (missing.length > 0) {
    violations.push({
      kind: "capability_violation_l4_missing_declared",
      paths: missing.sort(),
    });
  }

  return { ok: violations.length === 0, violations };
}
