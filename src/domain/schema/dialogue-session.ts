import { z } from "zod";
import { UlidString } from "../ids.js";
import {
  AgentProfileId,
  AgentRoleInSession,
  FinalVerdict,
  ParentLoop,
} from "./contribution.js";

/**
 * SOC-SESSION-LIFECYCLE / SOC-SESSION-TERMINATION schemas.
 *
 * `DialogueSession` is the 5-state aggregate. `SessionTermination` (rule
 * + required_evidence + composite_rule) is a sub-block of the schema so
 * the storage layout in `sessions/<id>/metadata.json` can hold the entire
 * session config in one record.
 */

export const SessionState = z.enum([
  "SESSION_OPEN",
  "CONVERGED",
  "TIMEOUT",
  "ABANDONED",
  "AWAITING_REVALIDATION",
]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionPurpose = z.enum([
  "design",
  "build",
  "review",
  "tdd_build",
  "planning_decompose",
  "validation",
]);
export type SessionPurpose = z.infer<typeof SessionPurpose>;

export const FinalizationRule = z.enum([
  "lead_only",
  "unanimous_approve",
  "quorum_then_lead",
  "any_request_changes_blocks",
  "timeout_only",
]);
export type FinalizationRule = z.infer<typeof FinalizationRule>;

const MetricComparator = z.enum(["lte", "lt", "gte", "gt", "eq"]);
const CoverageComparator = z.enum(["gte", "gt"]);

export const RequiredEvidence = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("verification_green"),
      acceptance_tests: z.array(z.string().min(1)).default(() => []),
      deterministic_checks: z.array(z.string().min(1)).default(() => []),
    })
    .strict(),
  z
    .object({
      kind: z.literal("metric_threshold"),
      metric_name: z.string().min(1),
      comparator: MetricComparator,
      value: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interface_diff_clean"),
      protected_apis: z.array(z.string().min(1)).default(() => []),
    })
    .strict(),
  z
    .object({
      kind: z.literal("coverage_threshold"),
      comparator: CoverageComparator,
      value: z.number(),
    })
    .strict(),
]);
export type RequiredEvidence = z.infer<typeof RequiredEvidence>;

export const CompositeRule = z.enum([
  "finalization_AND_evidence",
  "evidence_only",
  "finalization_only",
]);
export type CompositeRule = z.infer<typeof CompositeRule>;

export const SessionTermination = z
  .object({
    finalization_rule: FinalizationRule,
    required_evidence: z.array(RequiredEvidence).default(() => []),
    composite_rule: CompositeRule,
    quorum_min_approvals: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type SessionTermination = z.infer<typeof SessionTermination>;

export const Participant = z
  .object({
    agent_profile_id: AgentProfileId,
    role: AgentRoleInSession,
  })
  .strict();
export type Participant = z.infer<typeof Participant>;

export const SessionParentObjectKind = z.enum(["slice", "milestone"]);
export type SessionParentObjectKind = z.infer<typeof SessionParentObjectKind>;

export const FinalizationDecision = z.enum([
  "finalization_rule",
  "required_evidence",
  "composite",
]);
export type FinalizationDecision = z.infer<typeof FinalizationDecision>;

export const AbandonedReason = z.enum([
  "no_progress",
  "regression",
  "scope_violation",
]);
export type AbandonedReason = z.infer<typeof AbandonedReason>;

export const DialogueSession = z
  .object({
    session_id: UlidString,
    parent_object_kind: SessionParentObjectKind,
    parent_object_id: UlidString,
    parent_loop: ParentLoop,
    purpose: SessionPurpose,
    participants: z.array(Participant).min(1),
    session_termination: SessionTermination,
    workspace_revision_pin: z.string().min(1),
    current_turn_index: z.number().int().nonnegative(),
    state: SessionState,
    final_verdict: FinalVerdict.nullable().default(null),
    abandoned_reason: AbandonedReason.nullable().default(null),
    max_turns: z.number().int().positive(),
    turn_log_ref: z.string().min(1).nullable().default(null),
    spawned_contribution_id: UlidString.nullable().default(null),
    finalization_decision: FinalizationDecision.nullable().default(null),
    lease_token: z.string().min(1).nullable().default(null),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type DialogueSession = z.infer<typeof DialogueSession>;
