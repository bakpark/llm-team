/**
 * SliceMerge lifecycle helpers (SOC-SLICE-MERGE / SOC-MERGE-POLICY).
 *
 * Single seam for the SliceMerge transitions phase 3 introduces:
 *   - `promoteSliceMergeToApproved`: SM_READY_FOR_REVIEW → SM_APPROVED with
 *     review_session_id linked.
 *   - `integrateSliceMerge`: SM_APPROVED → trunk rebase + verification re-run
 *     → SM_MERGED on clean+green / SM_STALE on conflict-or-fail. Idempotent
 *     per `per_merge` key.
 *   - `closeSliceMergeRequestChanges`: SM → SM_REQUEST_CHANGES → SM_CLOSED.
 *   - `closeSliceMergeBlocked`: SM_DRAFT → SM_CLOSED for inner timeout / abandoned.
 *
 * Each function persists the SliceMerge update via `store.writeAtomic` and
 * appends one ledger row. Caller-dispatch composes them into the dispatch
 * matrix effects.
 */
import { newMonotonicId } from "../domain/ids.js";
import { Slice } from "../domain/schema/slice.js";
import {
  SliceMerge,
  type SliceMerge as SliceMergeT,
  type SliceMergeState,
} from "../domain/schema/slice-merge.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import type { VerificationPort } from "../ports/verification.js";
import type { WorkspacePort } from "../ports/workspace.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";
import { emitSliceTelemetry } from "./slice-telemetry.js";
import { runInnerVerification } from "./verification-runner.js";

export interface SliceMergeOpDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

/**
 * Phase 8b — KAC-SLICE-TELEMETRY emit hook. Each SliceMerge transition
 * pairs with a Slice state transition (caller-dispatch.ts), so emitting
 * here covers SLICE_REVIEWING / SLICE_INTEGRATING / SLICE_VALIDATED /
 * SLICE_BLOCKED / SLICE_BUILDING (rebuild) re-shape moments. The emit is
 * idempotent — a no-op call (no partition change) returns the prior
 * telemetry without writing.
 *
 * Failures are non-fatal: telemetry emit is read-side enrichment for
 * Discovery N+1, and `telemetry_enrichment_missing=warn` (KAC-SLICE-
 * TELEMETRY) keeps it warn-grade. A surfaced error from the emit could
 * abort the SliceMerge transition, leaving the slice in an inconsistent
 * state — far worse than missing telemetry on this cycle.
 */
async function emitTelemetryAfterTransition(
  sliceId: string,
  deps: SliceMergeOpDeps,
): Promise<void> {
  const slicePath = layout.slice(sliceId);
  let body: string | null;
  try {
    body = await deps.store.readText(slicePath);
  } catch {
    return;
  }
  if (body == null) return;
  let milestoneId: string;
  try {
    milestoneId = Slice.parse(JSON.parse(body)).milestone_id;
  } catch {
    return;
  }
  try {
    await emitSliceTelemetry({ milestone_id: milestoneId }, deps);
  } catch {
    // Swallow — see header rationale.
  }
}

/** SM_READY_FOR_REVIEW → SM_APPROVED + records review_session_id. */
export async function promoteSliceMergeToApproved(
  input: {
    sliceMerge: SliceMergeT;
    reviewSessionId: string;
    sliceKind: "feature" | "internal";
  },
  deps: SliceMergeOpDeps,
): Promise<SliceMergeT> {
  if (input.sliceMerge.state !== "SM_READY_FOR_REVIEW")
    throw new Error(
      `promoteSliceMergeToApproved: expected SM_READY_FOR_REVIEW, got ${input.sliceMerge.state}`,
    );
  const updated = SliceMerge.parse({
    ...input.sliceMerge,
    state: "SM_APPROVED",
    review_session_id: input.reviewSessionId,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sliceMerge(updated.slice_merge_id),
    JSON.stringify(updated, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: updated.slice_merge_id,
    object_kind: "slice_merge",
    from_state: "SM_READY_FOR_REVIEW",
    to_state: "SM_APPROVED",
    loop_kind: "middle",
    phase: null,
    slice_id: updated.slice_id,
    slice_kind: input.sliceKind,
    dod_revision: null,
    session_id: input.reviewSessionId,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: "approve",
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: updated.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "slice_merge_state",
        slice_merge_id: updated.slice_merge_id,
        to_state: "SM_APPROVED",
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  await emitTelemetryAfterTransition(updated.slice_id, deps);
  return updated;
}

export interface IntegrateInput {
  sliceMerge: SliceMergeT;
  sliceId: string;
  sliceKind: "feature" | "internal";
  reviewSessionId: string;
  trunkRevision: string;
  testCommands: import("../ports/verification.js").CommandSpec[];
  environmentFingerprint: string;
}

export type IntegrateOutcome =
  | {
      result: "merged";
      sliceMerge: SliceMergeT;
      verificationRunId: string;
      mergeRevision: string;
    }
  | {
      result: "stale";
      sliceMerge: SliceMergeT;
      reason: string;
    };

/**
 * SM_APPROVED → trunk rebase + reverify → SM_MERGED on clean+green.
 * Conflict or reverify fail → SM_STALE.
 *
 * Idempotency: one per_merge key per (slice_merge_id, pre_merge_workspace_revision,
 * trunk_base_revision_at_merge_attempt). The ledger absorbs duplicate calls.
 */
export async function integrateSliceMerge(
  input: IntegrateInput,
  deps: SliceMergeOpDeps & {
    workspace: WorkspacePort;
    verification: VerificationPort;
  },
): Promise<IntegrateOutcome> {
  if (input.sliceMerge.state !== "SM_APPROVED")
    throw new Error(
      `integrateSliceMerge: expected SM_APPROVED, got ${input.sliceMerge.state}`,
    );
  const rebase = await deps.workspace.rebaseOntoTrunk({
    sliceId: input.sliceId,
    trunkRevision: input.trunkRevision,
  });
  if (rebase.result === "conflict") {
    const updated = await markSliceMergeStale(
      input.sliceMerge,
      `rebase conflict: ${rebase.reason}`,
      deps,
      input.sliceKind,
    );
    return { result: "stale", sliceMerge: updated, reason: rebase.reason };
  }
  // Reverify the rebased commit. Inner verification helper covers test commands
  // and persists a VerificationRun row that the ledger references.
  const verification = await runInnerVerification(
    {
      targetId: deps.targetId,
      targetRevision: rebase.commit,
      testCommands: input.testCommands,
      environmentFingerprint: input.environmentFingerprint,
    },
    {
      verification: deps.verification,
      store: deps.store,
      clock: deps.clock,
    },
  );
  if (verification.result !== "pass") {
    const updated = await markSliceMergeStale(
      input.sliceMerge,
      `reverify ${verification.result}`,
      deps,
      input.sliceKind,
    );
    return {
      result: "stale",
      sliceMerge: updated,
      reason: `reverify ${verification.result}`,
    };
  }
  const merged = SliceMerge.parse({
    ...input.sliceMerge,
    state: "SM_MERGED",
    merge_revision: rebase.commit,
    pre_merge_workspace_revision: input.sliceMerge.pre_merge_workspace_revision,
    verification_run_id: verification.verification_run_id,
    merged_at: deps.clock.isoNow(),
    merged_by_caller_id: deps.callerId,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sliceMerge(merged.slice_merge_id),
    JSON.stringify(merged, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: merged.slice_merge_id,
    object_kind: "slice_merge",
    from_state: "SM_APPROVED",
    to_state: "SM_MERGED",
    loop_kind: "middle",
    phase: null,
    slice_id: merged.slice_id,
    slice_kind: input.sliceKind,
    dod_revision: null,
    session_id: input.reviewSessionId,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: verification.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "per_merge",
      parts: {
        slice_merge_id: merged.slice_merge_id,
        pre_merge_workspace_revision:
          input.sliceMerge.pre_merge_workspace_revision ?? "",
        trunk_base_revision_at_merge_attempt: input.trunkRevision,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  await emitTelemetryAfterTransition(merged.slice_id, deps);
  return {
    result: "merged",
    sliceMerge: merged,
    verificationRunId: verification.verification_run_id,
    mergeRevision: rebase.commit,
  };
}

async function markSliceMergeStale(
  sm: SliceMergeT,
  reason: string,
  deps: SliceMergeOpDeps,
  sliceKind: "feature" | "internal",
): Promise<SliceMergeT> {
  const updated = SliceMerge.parse({
    ...sm,
    state: "SM_STALE" as SliceMergeState,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sliceMerge(updated.slice_merge_id),
    JSON.stringify(updated, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: updated.slice_merge_id,
    object_kind: "slice_merge",
    from_state: sm.state,
    to_state: "SM_STALE",
    loop_kind: "middle",
    phase: null,
    slice_id: updated.slice_id,
    slice_kind: sliceKind,
    dod_revision: null,
    session_id: sm.review_session_id,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: updated.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "slice_merge_state",
        slice_merge_id: updated.slice_merge_id,
        to_state: "SM_STALE",
        reason,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "stale",
    result_detail: reason.slice(0, 200),
    timestamp: deps.clock.isoNow(),
  });
  await emitTelemetryAfterTransition(updated.slice_id, deps);
  return updated;
}

/**
 * Middle review request_changes: SM_READY_FOR_REVIEW → SM_REQUEST_CHANGES →
 * SM_CLOSED in a single call. SOC-SLICE-MERGE Flow step 7 documents the
 * single-step contraction.
 */
export async function closeSliceMergeRequestChanges(
  input: {
    sliceMerge: SliceMergeT;
    reviewSessionId: string;
    sliceKind: "feature" | "internal";
  },
  deps: SliceMergeOpDeps,
): Promise<SliceMergeT> {
  if (input.sliceMerge.state !== "SM_READY_FOR_REVIEW")
    throw new Error(
      `closeSliceMergeRequestChanges: expected SM_READY_FOR_REVIEW, got ${input.sliceMerge.state}`,
    );
  const updated = SliceMerge.parse({
    ...input.sliceMerge,
    state: "SM_CLOSED" as SliceMergeState,
    review_session_id: input.reviewSessionId,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sliceMerge(updated.slice_merge_id),
    JSON.stringify(updated, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: updated.slice_merge_id,
    object_kind: "slice_merge",
    from_state: "SM_READY_FOR_REVIEW",
    to_state: "SM_CLOSED",
    loop_kind: "middle",
    phase: null,
    slice_id: updated.slice_id,
    slice_kind: input.sliceKind,
    dod_revision: null,
    session_id: input.reviewSessionId,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: "request_changes",
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: updated.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "slice_merge_state",
        slice_merge_id: updated.slice_merge_id,
        to_state: "SM_CLOSED",
        cause: "request_changes",
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  await emitTelemetryAfterTransition(updated.slice_id, deps);
  return updated;
}

/** Inner TIMEOUT/ABANDONED → SM_DRAFT → SM_CLOSED. */
export async function closeSliceMergeBlocked(
  input: {
    sliceMerge: SliceMergeT;
    sessionId: string;
    sliceKind: "feature" | "internal";
    cause: string;
  },
  deps: SliceMergeOpDeps,
): Promise<SliceMergeT> {
  const updated = SliceMerge.parse({
    ...input.sliceMerge,
    state: "SM_CLOSED" as SliceMergeState,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sliceMerge(updated.slice_merge_id),
    JSON.stringify(updated, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: updated.slice_merge_id,
    object_kind: "slice_merge",
    from_state: input.sliceMerge.state,
    to_state: "SM_CLOSED",
    loop_kind: "inner",
    phase: null,
    slice_id: updated.slice_id,
    slice_kind: input.sliceKind,
    dod_revision: null,
    session_id: input.sessionId,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: updated.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "slice_merge_state",
        slice_merge_id: updated.slice_merge_id,
        to_state: "SM_CLOSED",
        cause: input.cause,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: input.cause.slice(0, 200),
    timestamp: deps.clock.isoNow(),
  });
  await emitTelemetryAfterTransition(updated.slice_id, deps);
  return updated;
}
