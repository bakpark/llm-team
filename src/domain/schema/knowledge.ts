import { z } from "zod";
import { UlidString } from "../ids.js";
import { AgentProfileId, FinalVerdict, ParentLoop } from "./contribution.js";
import { SliceKind, SliceState } from "./slice.js";

/**
 * KAC schemas — knowledge accumulation 1급 객체.
 *
 * - `DecisionEntry`         (KAC-DECISION-LOG)
 * - `ContextSummary`        (KAC-CONTEXT-SUMMARY)
 * - `RefactorBacklogItem`   (KAC-REFACTOR-BACKLOG, 6-state)
 * - `SliceTelemetry`        (KAC-SLICE-TELEMETRY)
 *
 * 모든 객체는 `audit_hash` 를 보유 — KAC-MANIFEST entry 의 revision_pin 으로
 * 사용된다.
 */

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------- Decision Log

export const DecisionKind = z.enum([
  "product_decision",
  "refactor",
  "spike_finding",
  "architectural_debt",
  "cross_milestone_amendment",
  "acceptance_test_amendment",
]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DecisionEntry = z
  .object({
    decision_id: UlidString,
    decision_kind: DecisionKind,
    decision: z.string().min(1),
    alternatives: z.array(z.string().min(1)).default(() => []),
    rationale: z.string().min(1),
    decided_at: z.string().datetime(),
    affected_milestones: z.array(UlidString).default(() => []),
    affected_slices: z.array(UlidString).default(() => []),
    supersedes: UlidString.nullable().default(null),
    audit_hash: Sha256Hex,
  })
  .strict();
export type DecisionEntry = z.infer<typeof DecisionEntry>;

// ----------------------------------------------------------- Context Summary

export const ContextSummarySliceRef = z
  .object({
    slice_id: UlidString,
    slice_kind: SliceKind,
    validated_revision: z.string().min(1),
    ac_ids: z.array(z.string().min(1)).default(() => []),
  })
  .strict();
export type ContextSummarySliceRef = z.infer<typeof ContextSummarySliceRef>;

export const ContextSummary = z
  .object({
    summary_id: UlidString,
    milestone_id: UlidString,
    user_value: z.string().min(1),
    behavior_changes: z.array(z.string().min(1)).default(() => []),
    decisions_to_preserve: z.array(UlidString).default(() => []),
    risks: z.array(z.string().min(1)).default(() => []),
    slices: z.array(ContextSummarySliceRef).default(() => []),
    architectural_debt_indicators: z
      .array(z.string().min(1))
      .default(() => []),
    generated_at: z.string().datetime(),
    audit_hash: Sha256Hex,
  })
  .strict();
export type ContextSummary = z.infer<typeof ContextSummary>;

// -------------------------------------------------------- Refactor Backlog

export const RefactorBacklogState = z.enum([
  "PROPOSED",
  "CURATED",
  "SCHEDULED",
  "DONE",
  "DROPPED",
  "SUPERSEDED",
]);
export type RefactorBacklogState = z.infer<typeof RefactorBacklogState>;

export const RefactorBacklogItem = z
  .object({
    proposal_id: UlidString,
    proposed_at: z.string().datetime(),
    proposed_by: AgentProfileId,
    state: RefactorBacklogState,
    scope: z.string().min(1),
    suggested_refactor: z.string().min(1),
    rationale: z.string().min(1),
    code_location: z.string().min(1),
    metric_target: z.string().min(1).nullable().default(null),
    evidence_refs: z.array(z.string().min(1)).default(() => []),
    spawning_slice_id: UlidString.nullable().default(null),
    superseded_by: UlidString.nullable().default(null),
    updated_at: z.string().datetime(),
    audit_hash: Sha256Hex,
  })
  .strict();
export type RefactorBacklogItem = z.infer<typeof RefactorBacklogItem>;

// -------------------------------------------------------- Slice Telemetry

export const TelemetryInProgressSlice = z
  .object({
    slice_id: UlidString,
    slice_kind: SliceKind,
    state: SliceState,
    current_session_id: UlidString.nullable().default(null),
  })
  .strict();
export type TelemetryInProgressSlice = z.infer<typeof TelemetryInProgressSlice>;

export const TelemetryValidatedSlice = z
  .object({
    slice_id: UlidString,
    slice_kind: SliceKind,
    validated_revision: z.string().min(1),
  })
  .strict();
export type TelemetryValidatedSlice = z.infer<typeof TelemetryValidatedSlice>;

export const TelemetryBlockedSlice = z
  .object({
    slice_id: UlidString,
    slice_kind: SliceKind,
    abandoned_reason: z.string().min(1).nullable().default(null),
  })
  .strict();
export type TelemetryBlockedSlice = z.infer<typeof TelemetryBlockedSlice>;

export const TelemetrySessionOutcome = z
  .object({
    session_id: UlidString,
    parent_loop: ParentLoop,
    final_verdict: FinalVerdict.nullable(),
    finalized_at: z.string().datetime(),
  })
  .strict();
export type TelemetrySessionOutcome = z.infer<typeof TelemetrySessionOutcome>;

export const SliceTelemetry = z
  .object({
    telemetry_id: UlidString,
    milestone_id: UlidString,
    generated_at: z.string().datetime(),
    in_progress_slices: z.array(TelemetryInProgressSlice).default(() => []),
    validated_slices: z.array(TelemetryValidatedSlice).default(() => []),
    blocked_slices: z.array(TelemetryBlockedSlice).default(() => []),
    recent_session_outcomes: z
      .array(TelemetrySessionOutcome)
      .default(() => []),
    edge_cases: z.array(z.string().min(1)).default(() => []),
    recent_metric_runs: z.array(UlidString).default(() => []),
    audit_hash: Sha256Hex,
  })
  .strict();
export type SliceTelemetry = z.infer<typeof SliceTelemetry>;
