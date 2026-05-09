/**
 * SOC-DISPATCH-MATRIX executor.
 *
 * Reads the data table in `domain/dispatch-matrix.ts` and runs the side-
 * effects for a (parent_loop, phase_or_purpose, session_state, final_verdict)
 * tuple. Each effect is a thin call into the existing modules — slice-merge
 * ops, the slice store, the ledger. The matrix table contains no logic; it
 * just names which effect lists belong to which session outcome.
 *
 * Phase 3 effects:
 *   - `open_slice_merge_for_review` (inner tests_green)
 *   - `close_slice_merge_blocked` (inner timeout / abandoned)
 *   - `promote_slice_merge_to_approved_then_integrate` (middle approve)
 *   - `reset_slice_for_rebuild` (middle request_changes)
 *
 * Each handler is idempotent on its underlying ledger row's idempotency key
 * — see `application/slice-merge.ts` and the slice-state ledger key
 * compositions below. Re-running dispatch after a partial crash absorbs as
 * `duplicate` in the ledger.
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  lookupDispatch,
  type DispatchEffect,
  type DispatchEntry,
} from "../domain/dispatch-matrix.js";
import type { ParentLoop } from "../domain/schema/contribution.js";
import {
  Slice,
  type Slice as SliceT,
  type SliceState,
} from "../domain/schema/slice.js";
import {
  SliceMerge,
  type SliceMerge as SliceMergeT,
} from "../domain/schema/slice-merge.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import type { CommandSpec, VerificationPort } from "../ports/verification.js";
import type { WorkspacePort } from "../ports/workspace.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";
import {
  closeSliceMergeBlocked,
  closeSliceMergeRequestChanges,
  integrateSliceMerge,
  promoteSliceMergeToApproved,
  type SliceMergeOpDeps,
} from "./slice-merge.js";
import { emitSliceTelemetry } from "./slice-telemetry.js";

export interface DispatchInput {
  parent_loop: ParentLoop;
  phase_or_purpose: string;
  session_state: "CONVERGED" | "TIMEOUT" | "ABANDONED";
  final_verdict: string | null;
  /** The slice this session is anchored on (slice loop). */
  slice: SliceT;
  /**
   * The active SliceMerge for the slice. For inner outcomes this is the
   * SM_DRAFT created when the slice entered SLICE_BUILDING. For middle
   * outcomes this is the SM_READY_FOR_REVIEW created at inner CONVERGED.
   */
  sliceMerge: SliceMergeT;
  /** Required when the dispatch creates or transitions a session-bound state. */
  sessionId: string;
  /** Inner CONVERGED needs the verification result attached to the SM_READY_FOR_REVIEW row. */
  verificationRunId: string | null;
  /**
   * Pre-merge workspace revision for inner CONVERGED so SM_READY_FOR_REVIEW
   * pins the freezing reference. Optional for middle outcomes.
   */
  preMergeRevision?: string;
  /**
   * Trunk revision used to attempt the rebase for SLICE_INTEGRATING.
   * Required when the dispatched effect is `promote_..._then_integrate`.
   */
  trunkRevision?: string;
  /**
   * Test commands for the SM_APPROVED → SM_MERGED reverify pass. Receives
   * the slice's mutable workspace cwd (post-rebase). Ignored for non-
   * integrate dispatches.
   */
  testCommandsForReverify?: (workspaceCwd: string) => CommandSpec[];
  environmentFingerprint: string;
}

export interface DispatchDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  workspace: WorkspacePort;
  verification: VerificationPort;
  callerId: string;
  targetId: string;
}

export type DispatchResult =
  | { kind: "no_match"; detail: string }
  | { kind: "applied"; effects: DispatchEffect[]; details: DispatchDetail[] };

export type DispatchDetail =
  | {
      effect: "open_slice_merge_for_review";
      sliceMergeId: string;
      sliceState: "SLICE_REVIEWING";
    }
  | {
      effect: "close_slice_merge_blocked";
      sliceMergeId: string;
      sliceState: "SLICE_BLOCKED";
    }
  | {
      effect: "promote_slice_merge_to_approved_then_integrate";
      integrate:
        | {
            result: "merged";
            sliceMergeId: string;
            mergeRevision: string;
            verificationRunId: string;
          }
        | { result: "stale"; sliceMergeId: string; reason: string };
      sliceState: "SLICE_VALIDATED" | "SLICE_BLOCKED";
    }
  | {
      effect: "reset_slice_for_rebuild";
      sliceMergeId: string;
      sliceState: "SLICE_BUILDING";
    };

export async function dispatchOutcome(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const entry: DispatchEntry | null = lookupDispatch({
    parent_loop: input.parent_loop,
    phase_or_purpose: input.phase_or_purpose,
    session_state: input.session_state,
    final_verdict: input.final_verdict,
  });
  if (entry == null)
    return {
      kind: "no_match",
      detail: `no DISPATCH_MATRIX entry for (loop=${input.parent_loop}, purpose=${input.phase_or_purpose}, state=${input.session_state}, verdict=${input.final_verdict ?? "<null>"})`,
    };
  const details: DispatchDetail[] = [];
  for (const effect of entry.effects) {
    details.push(await runEffect(effect, input, deps));
  }
  return { kind: "applied", effects: entry.effects, details };
}

/**
 * Phase 8b — KAC-SLICE-TELEMETRY emit hook. Invoked AFTER the terminal
 * Slice state transition for each dispatch effect so the partition snapshot
 * reflects the post-transition state (Inv #3: Discovery N+1 manifest pin
 * sees the live Delivery slice partition). Failures are non-fatal — the
 * telemetry is read-side enrichment with warn-grade enforcement.
 */
async function emitTelemetryAfterTransition(
  milestoneId: string,
  smOpDeps: SliceMergeOpDeps,
): Promise<void> {
  try {
    await emitSliceTelemetry({ milestone_id: milestoneId }, smOpDeps);
  } catch {
    // Swallow — telemetry emit is read-side enrichment; surfacing here
    // would abort the dispatch after the slice transition has already
    // committed.
  }
}

async function runEffect(
  effect: DispatchEffect,
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<DispatchDetail> {
  const smOpDeps: SliceMergeOpDeps = {
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    callerId: deps.callerId,
    targetId: deps.targetId,
  };
  switch (effect.kind) {
    case "open_slice_merge_for_review": {
      const sm = await transitionSliceMergeReadyForReview(
        input,
        deps,
      );
      await transitionSliceState(input.slice, "SLICE_REVIEWING", deps, {
        loop_kind: "inner",
        session_id: input.sessionId,
      });
      await emitTelemetryAfterTransition(input.slice.milestone_id, smOpDeps);
      return {
        effect: "open_slice_merge_for_review",
        sliceMergeId: sm.slice_merge_id,
        sliceState: "SLICE_REVIEWING",
      };
    }
    case "close_slice_merge_blocked": {
      await closeSliceMergeBlocked(
        {
          sliceMerge: input.sliceMerge,
          sessionId: input.sessionId,
          sliceKind: input.slice.slice_kind,
          cause: input.session_state.toLowerCase(),
        },
        smOpDeps,
      );
      await transitionSliceState(input.slice, "SLICE_BLOCKED", deps, {
        loop_kind: "inner",
        session_id: input.sessionId,
      });
      await emitTelemetryAfterTransition(input.slice.milestone_id, smOpDeps);
      return {
        effect: "close_slice_merge_blocked",
        sliceMergeId: input.sliceMerge.slice_merge_id,
        sliceState: "SLICE_BLOCKED",
      };
    }
    case "promote_slice_merge_to_approved_then_integrate": {
      if (input.trunkRevision == null)
        throw new Error(
          "promote_slice_merge_to_approved_then_integrate requires trunkRevision",
        );
      // P0-1 fix (PR #62 review): resolve the actual mutable worktree path
      // before invoking the reverify test commands. Previously this passed
      // the literal string `slice-<id>` which would point ShellVerification
      // at a non-existent cwd and report SM_STALE for every clean rebase.
      // Re-running prepareInnerWorkspace is idempotent in both adapters.
      const innerPrep = await deps.workspace.prepareInnerWorkspace({
        sliceId: input.slice.slice_id,
        trunkBaseRevision: input.slice.trunk_base_revision,
      });
      const approved = await promoteSliceMergeToApproved(
        {
          sliceMerge: input.sliceMerge,
          reviewSessionId: input.sessionId,
          sliceKind: input.slice.slice_kind,
        },
        smOpDeps,
      );
      // Slice → SLICE_INTEGRATING (intermediate state per gpt5.5 review).
      await transitionSliceState(input.slice, "SLICE_INTEGRATING", deps, {
        loop_kind: "middle",
        session_id: input.sessionId,
      });
      const integrate = await integrateSliceMerge(
        {
          sliceMerge: approved,
          sliceId: input.slice.slice_id,
          sliceKind: input.slice.slice_kind,
          reviewSessionId: input.sessionId,
          trunkRevision: input.trunkRevision,
          testCommands:
            input.testCommandsForReverify?.(innerPrep.agentCwd) ?? [],
          environmentFingerprint: input.environmentFingerprint,
          // Phase 8c (KAC-TRACEABILITY): forward the slice's declared
          // ac_ids so the canonical SliceMerge VerificationRun records AC
          // coverage that scout-observer's AC-level aggregation can join on.
          coversAcIds: input.slice.ac_ids,
        },
        { ...smOpDeps, workspace: deps.workspace, verification: deps.verification },
      );
      if (integrate.result === "merged") {
        await transitionSliceState(input.slice, "SLICE_VALIDATED", deps, {
          loop_kind: "middle",
          session_id: input.sessionId,
        });
        await emitTelemetryAfterTransition(input.slice.milestone_id, smOpDeps);
        return {
          effect: "promote_slice_merge_to_approved_then_integrate",
          integrate: {
            result: "merged",
            sliceMergeId: integrate.sliceMerge.slice_merge_id,
            mergeRevision: integrate.mergeRevision,
            verificationRunId: integrate.verificationRunId,
          },
          sliceState: "SLICE_VALIDATED",
        };
      }
      // P0-4 fix (PR #62 review): on SM_STALE, transition slice to
      // SLICE_BLOCKED rather than rolling back to SLICE_REVIEWING. The
      // contract (SOC-MERGE-POLICY) routes "한도 초과" to SLICE_BLOCKED;
      // phase-3 has zero retry budget, so the limit is immediately
      // exhausted. This breaks the previous orphan state where SLICE_REVIEWING
      // + SM_STALE was un-pickable (pickReadyMiddleReview only finds
      // SM_READY_FOR_REVIEW). Phase 4 will introduce bounded retry that
      // resets SM_STALE → SM_READY_FOR_REVIEW with slice held at
      // SLICE_REVIEWING until the budget is exhausted.
      await transitionSliceState(input.slice, "SLICE_BLOCKED", deps, {
        loop_kind: "middle",
        session_id: input.sessionId,
      });
      await emitTelemetryAfterTransition(input.slice.milestone_id, smOpDeps);
      return {
        effect: "promote_slice_merge_to_approved_then_integrate",
        integrate: {
          result: "stale",
          sliceMergeId: integrate.sliceMerge.slice_merge_id,
          reason: integrate.reason,
        },
        sliceState: "SLICE_BLOCKED",
      };
    }
    case "reset_slice_for_rebuild": {
      await closeSliceMergeRequestChanges(
        {
          sliceMerge: input.sliceMerge,
          reviewSessionId: input.sessionId,
          sliceKind: input.slice.slice_kind,
        },
        smOpDeps,
      );
      // Slice → SLICE_BUILDING + clear current_session_id so the next pickup
      // creates a new inner session + new SliceMerge instance.
      await transitionSliceState(input.slice, "SLICE_BUILDING", deps, {
        loop_kind: "middle",
        session_id: input.sessionId,
        clear_current_session: true,
      });
      await emitTelemetryAfterTransition(input.slice.milestone_id, smOpDeps);
      return {
        effect: "reset_slice_for_rebuild",
        sliceMergeId: input.sliceMerge.slice_merge_id,
        sliceState: "SLICE_BUILDING",
      };
    }
    default:
      // Outer-loop effects flow through `caller-dispatch-outer.ts`; if one
      // shows up here the coordinator routed an outer outcome through the
      // wrong dispatcher. Fail loud rather than silently no-op.
      throw new Error(
        `caller-dispatch: unsupported effect kind=${(effect as { kind: string }).kind}; outer effects must use dispatchOuterOutcome`,
      );
  }
}

async function transitionSliceMergeReadyForReview(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<SliceMergeT> {
  // Inner CONVERGED tests_green is currently still inlined by turn-worker
  // (it creates SM_READY_FOR_REVIEW directly). When turn-worker delegates
  // this dispatch to caller-dispatch (phase 4 cleanup), this branch will
  // synthesise the SM record from input.preMergeRevision. For now, the
  // SliceMerge passed in is already SM_READY_FOR_REVIEW (created by
  // turn-worker); the effect simply records the no-op transition for audit.
  if (input.sliceMerge.state === "SM_READY_FOR_REVIEW") {
    return input.sliceMerge;
  }
  if (input.sliceMerge.state !== "SM_DRAFT")
    throw new Error(
      `open_slice_merge_for_review: SM ${input.sliceMerge.slice_merge_id} state=${input.sliceMerge.state}`,
    );
  if (input.preMergeRevision == null)
    throw new Error("open_slice_merge_for_review requires preMergeRevision");
  const updated = SliceMerge.parse({
    ...input.sliceMerge,
    state: "SM_READY_FOR_REVIEW",
    pre_merge_workspace_revision: input.preMergeRevision,
    verification_run_id: input.verificationRunId,
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
    from_state: "SM_DRAFT",
    to_state: "SM_READY_FOR_REVIEW",
    loop_kind: "inner",
    phase: null,
    slice_id: updated.slice_id,
    slice_kind: input.slice.slice_kind,
    dod_revision: null,
    session_id: input.sessionId,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: "tests_green",
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: input.verificationRunId,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "slice_merge_state",
        slice_merge_id: updated.slice_merge_id,
        to_state: "SM_READY_FOR_REVIEW",
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  return updated;
}

async function transitionSliceState(
  slice: SliceT,
  toState: SliceState,
  deps: DispatchDeps,
  context: {
    loop_kind: ParentLoop;
    session_id: string;
    clear_current_session?: boolean;
  },
): Promise<SliceT> {
  // PR #64 review P0-2 fix: wrap the read-check-write in withFileLock so
  // recovery.reanimateSliceIfNeeded (which already holds the same lock)
  // and this transition cannot interleave. Without symmetric locking, a
  // recovery that observed SLICE_BUILDING could overwrite the live
  // worker's SLICE_REVIEWING write.
  const slicePath = layout.slice(slice.slice_id);
  return deps.store.withFileLock(slicePath, async () => {
    return doTransitionSliceState(slicePath, slice, toState, deps, context);
  });
}

async function doTransitionSliceState(
  slicePath: string,
  slice: SliceT,
  toState: SliceState,
  deps: DispatchDeps,
  context: {
    loop_kind: ParentLoop;
    session_id: string;
    clear_current_session?: boolean;
  },
): Promise<SliceT> {
  // Re-read for freshness so concurrent reviewers can't overwrite the slice.
  const body = await deps.store.readText(slicePath);
  if (body == null)
    throw new Error(`slice ${slice.slice_id} disappeared mid-dispatch`);
  const live = Slice.parse(JSON.parse(body));
  // Idempotent: if already at the target state, skip the rewrite.
  if (live.state === toState && !context.clear_current_session) {
    return live;
  }
  const updated = Slice.parse({
    ...live,
    state: toState,
    current_session_id: context.clear_current_session
      ? null
      : live.current_session_id,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.slice(updated.slice_id),
    JSON.stringify(updated, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: updated.slice_id,
    object_kind: "slice",
    from_state: live.state,
    to_state: toState,
    loop_kind: context.loop_kind,
    phase: null,
    slice_id: updated.slice_id,
    slice_kind: updated.slice_kind,
    dod_revision: updated.dod_revision_pin,
    session_id: context.session_id,
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
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "slice_state",
        slice_id: updated.slice_id,
        to_state: toState,
        session_id: context.session_id,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  return updated;
}
