import { z } from "zod";
import { UlidString } from "../ids.js";
import {
  AgentProfileId,
  AgentRoleInSession,
  ContributionKind,
  OutputKind,
  ParentLoop,
  TddPhase,
} from "./contribution.js";
import { SliceKind } from "./slice.js";

/**
 * AGC-OUTPUT envelope.
 *
 * Two layered shapes:
 *
 * - `AgentAuthoredEnvelope` — the subset Agents are allowed to produce.
 *   Excludes `idempotency_key` and `runtime_metadata` (AGC-OUTPUT-RUNTIME-
 *   ENRICH: those are Caller-only). `.strict()` rejects them at parse time.
 *
 * - `Envelope` — canonical post-enrichment envelope. Adds the two
 *   Caller-injected fields. Schemas are exact-shape; matrix-level
 *   constraints (parent_loop × contribution_kind × output_kind) are checked
 *   by `application/envelope-extended-validator.ts` because they require
 *   cross-field logic.
 */

export const VerdictResult = z.enum([
  "approve",
  "request_changes",
  "tests_green",
  "spec_accept",
  "spec_reject",
  "plan_accept",
  "reject",
  "PASS",
  "FAIL",
  "STALE",
]);
export type VerdictResult = z.infer<typeof VerdictResult>;

export const Verdict = z
  .object({
    result: VerdictResult,
    rationale: z.string().min(1).nullable().default(null),
  })
  .strict();
export type Verdict = z.infer<typeof Verdict>;

export const NextActionAddressedTo = z.union([
  AgentProfileId,
  z.literal("caller"),
]);
export type NextActionAddressedTo = z.infer<typeof NextActionAddressedTo>;

export const NextActionEvidenceRequest = z
  .object({
    kind: z.string().min(1),
    scope: z.string().min(1),
  })
  .strict();
export type NextActionEvidenceRequest = z.infer<
  typeof NextActionEvidenceRequest
>;

export const NextActionRequest = z
  .object({
    addressed_to: NextActionAddressedTo,
    intent: z.string().min(1),
    evidence_request: z.array(NextActionEvidenceRequest).default(() => []),
    proposal_artifact_ref: z.string().min(1).nullable().default(null),
  })
  .strict();
export type NextActionRequest = z.infer<typeof NextActionRequest>;

export const FailureType = z.enum([
  "need_context",
  "invalid_output",
  "no_progress",
  "regression",
  "scope_violation",
]);
export type FailureType = z.infer<typeof FailureType>;

export const FailureBlock = z
  .object({
    type: FailureType,
    rationale: z.string().min(1),
  })
  .strict();
export type FailureBlock = z.infer<typeof FailureBlock>;

const agentAuthoredShape = {
  session_id: UlidString,
  turn_index: z.number().int().nonnegative(),
  parent_loop: ParentLoop,
  phase_or_purpose: z.string().min(1),
  slice_id: UlidString.nullable().default(null),
  slice_kind: SliceKind.nullable().default(null),
  tdd_phase: TddPhase.nullable().default(null),
  agent_profile_id: AgentProfileId,
  agent_role_in_session: AgentRoleInSession,
  contribution_kind: ContributionKind,
  parent_review_verdict_id: UlidString.nullable().default(null),
  output_kind: OutputKind,
  // AGC-OUTPUT: `object_id` 는 주 처리 대상 (slice / milestone / SliceMerge)
  // 식별자. 셋 모두 Caller-issued ULID 이므로 schema 단에서 ULID refinement.
  object_id: UlidString,
  manifest_id: UlidString,
  input_revision_pins: z.array(z.string().min(1)),
  summary: z.string().min(1),
  artifacts: z.record(z.string(), z.unknown()).nullable().default(null),
  verdict: Verdict.nullable().default(null),
  next_action_request: NextActionRequest.nullable().default(null),
  failure: FailureBlock.nullable().default(null),
};

export const AgentAuthoredEnvelope = z.object(agentAuthoredShape).strict();
export type AgentAuthoredEnvelope = z.infer<typeof AgentAuthoredEnvelope>;

/**
 * Canonical post-enrichment envelope. Adds the two Caller-injected fields
 * specified by AGC-OUTPUT-RUNTIME-ENRICH:
 *   - `idempotency_key`: composed by `application/idempotency.ts` (the
 *     SOC-IDEMPOTENCY 3-scope authority). Callers must NOT pass arbitrary
 *     strings — `application/envelope.ts#enrichEnvelope` enforces this by
 *     accepting `IdempotencyParts` rather than a free-form string.
 *   - `runtime_metadata`: Caller-injected key-value bag. `application/
 *     envelope.ts#enrichEnvelope` rejects keys that collide with envelope
 *     fields.
 *
 * The `runtime_metadata` field carries an explicit empty-object default
 * (`.default(() => ({}))`) — overriding the agent-authored shape's lack of
 * default — so `Envelope.parse()` never produces an undefined runtime
 * metadata bag.
 */
export const Envelope = z
  .object({
    ...agentAuthoredShape,
    idempotency_key: z.string().min(1),
    runtime_metadata: z
      .record(z.string(), z.unknown())
      .default(() => ({})),
  })
  .strict();
export type Envelope = z.infer<typeof Envelope>;
