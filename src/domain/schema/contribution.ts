import { z } from "zod";

/**
 * AGC-CONTRIBUTION enums and the related agent identity / output enums
 * referenced by AGC-OUTPUT and AGC-CONTRIBUTION-OUTPUTS.
 *
 * - `ContributionKind`  — the 5-kind enum (legacy `rework_patch` / `evidence`
 *   / `summary` were dropped per AGC-CONTRIBUTION).
 * - `OutputKind`        — `failure` plus the artifact kinds enumerated by
 *   AGC-OUTPUT.
 * - `FinalVerdict`      — (state, final_verdict) tuple used by SOC-DISPATCH.
 *   Includes `inner ABANDONED` reasons (no_progress / regression /
 *   scope_violation) since SOC-SESSION-TERMINATION lists them in the same
 *   table.
 */

export const ContributionKind = z.enum([
  "lead_draft",
  "review_verdict",
  "human_approval",
  "session_outcome",
  "proposal",
]);
export type ContributionKind = z.infer<typeof ContributionKind>;

export const AgentProfileId = z.enum([
  "atlas",
  "forge",
  "sentinel",
  "scout",
  "human",
]);
export type AgentProfileId = z.infer<typeof AgentProfileId>;

export const AgentRoleInSession = z.enum(["lead", "reviewer", "observer"]);
export type AgentRoleInSession = z.infer<typeof AgentRoleInSession>;

export const ParentLoop = z.enum(["outer", "middle", "inner"]);
export type ParentLoop = z.infer<typeof ParentLoop>;

export const TddPhase = z.enum(["red_green", "refactor"]);
export type TddPhase = z.infer<typeof TddPhase>;

export const OutputKind = z.enum([
  "spec_proposal",
  "task_plan",
  "slice_decomposition",
  "patch",
  "verdict",
  "milestone_package",
  "proposal_artifact",
  "failure",
]);
export type OutputKind = z.infer<typeof OutputKind>;

export const FinalVerdict = z.enum([
  "approve",
  "request_changes",
  "tests_green",
  "spec_accept",
  "spec_reject",
  "plan_accept",
  "validation_pass",
  "validation_fail",
  "validation_stale",
  "no_progress",
  "regression",
  "scope_violation",
]);
export type FinalVerdict = z.infer<typeof FinalVerdict>;
