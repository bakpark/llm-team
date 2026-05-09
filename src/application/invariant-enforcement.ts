/**
 * TCC-ENFORCEMENT — invariant enforcement level lookup.
 *
 * Authority: `docs/contracts/target-config-contract.md#TCC-ENFORCEMENT` and
 * `docs/contracts/README.md` (CONTRACT-CONFORMANCE matrix `enforcement` field).
 *
 * Phase 6b reaches Stage 5: `stage_graded` items default to `block` so the
 * legacy / drift code paths stop emitting warn-only signals.
 *
 * The lookup is a pure function over `target.invariant_enforcement` and the
 * declared Stage. Stage transition is operator-driven (TCC-CHANGE-RULES
 * ledger-recorded), but the in-process lookup defaults to Stage 5 so any
 * call site that has not yet been wired through the target config still
 * sees the post-Stage-5 enforcement level.
 *
 * `always_hard` is independent of Stage and always returns `block`.
 */

import type { InvariantEnforcement } from "../config/target-schema.js";

export type EnforcementLevel = "block" | "warn";

export type EnforcementStage = 2 | 3 | 4 | 5;

export const STAGE_5: EnforcementStage = 5;

/**
 * Resolve the enforcement level for an invariant under a given target
 * config + stage.
 *
 * - `always_hard` ⇒ `block`.
 * - `stage_graded[name]` returns its declared mode unless the stage has
 *   reached 5, in which case all stage_graded items are forced to `block`.
 * - Unknown invariants default to `block` (fail-closed). Operators can
 *   downgrade by adding the name to `stage_graded` with `warn`.
 */
export function resolveEnforcementLevel(
  cfg: InvariantEnforcement | null | undefined,
  invariantName: string,
  stage: EnforcementStage = STAGE_5,
): EnforcementLevel {
  if (cfg?.always_hard?.includes(invariantName)) return "block";
  const declared = cfg?.stage_graded?.[invariantName];
  if (declared == null) {
    // Unknown invariants are conservative — block.
    return "block";
  }
  if (stage >= 5) return "block";
  return declared;
}

/**
 * Stage 5 promotion: returns a new `invariant_enforcement` block with every
 * `stage_graded` entry set to `block`. Useful for operators who want to
 * persist the post-Stage-5 view in target.yaml.
 */
export function promoteToStage5(
  cfg: InvariantEnforcement | null | undefined,
): InvariantEnforcement {
  const promoted: Record<string, EnforcementLevel> = {};
  for (const [k] of Object.entries(cfg?.stage_graded ?? {})) {
    promoted[k] = "block";
  }
  return {
    always_hard: cfg?.always_hard ?? [],
    stage_graded: promoted,
  };
}
