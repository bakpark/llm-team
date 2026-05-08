import { z } from "zod";

/**
 * RGC-SIGNALS — common envelope for governance / input signals.
 *
 * 사람이 작성하는 raw envelope (drop dir 또는 GitHub Issue comment) 의 schema.
 * Caller 가 본 envelope 을 검증한 뒤 `human` profile 의 `human_approval`
 * contribution 으로 변환해 영속 큐에 enqueue 한다.
 *
 * `signal_id` 는 source 별 결정 — `github_comment` 는 comment.node_id,
 * FS drop 채널은 caller 가 부여하는 ULID.
 */

export const SignalType = z.enum([
  "approve",
  "reject",
  "request_rework",
  "request_recover",
  "pause",
  "resume",
  "amendment_approve",
  "cross_milestone_amendment",
  "acceptance_test_rename",
  "purge_acceptance_tests",
  "stop",
]);
export type SignalType = z.infer<typeof SignalType>;

export const SignalTargetKind = z.enum([
  "milestone",
  "slice",
  "slice_merge",
  "dialogue_session",
  "change_proposal",
  "system",
  "contract",
]);
export type SignalTargetKind = z.infer<typeof SignalTargetKind>;

export const SignalProcessingState = z.enum([
  "pending",
  "applied",
  "stale",
  "invalid",
]);
export type SignalProcessingState = z.infer<typeof SignalProcessingState>;

const SignalExternalRef = z
  .object({
    comment_node_id: z.string().min(1).optional(),
    html_url: z.string().min(1).optional(),
  })
  .strict();

export const HumanSignalEnvelope = z
  .object({
    signal_id: z.string().min(1),
    signal_type: SignalType,
    target_kind: SignalTargetKind,
    target_id: z.string().min(1),
    target_revision_pin: z.string().min(1).nullable().default(null),
    related_object_id: z.string().min(1).nullable().default(null),
    related_object_revision_pin: z.string().min(1).nullable().default(null),
    actor: z.string().min(1),
    created_at: z.string().datetime(),
    rationale: z.string().min(1).nullable().default(null),
    source: z.string().min(1),
    external_ref: SignalExternalRef.nullable().default(null),
  })
  .strict();
export type HumanSignalEnvelope = z.infer<typeof HumanSignalEnvelope>;

/**
 * Caller-side wrapper that records processing state. The raw envelope
 * stays under `envelope`; `processing_state` + `applied_at` + `reason`
 * track Caller's decision.
 */
export const HumanSignalRecord = z
  .object({
    envelope: HumanSignalEnvelope,
    processing_state: SignalProcessingState,
    applied_at: z.string().datetime().nullable().default(null),
    reason: z.string().min(1).nullable().default(null),
    contribution_id: z.string().min(1).nullable().default(null),
  })
  .strict();
export type HumanSignalRecord = z.infer<typeof HumanSignalRecord>;
