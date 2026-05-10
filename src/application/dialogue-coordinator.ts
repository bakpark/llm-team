/**
 * DialogueSession coordinator (daemons.md §Dialogue coordinator loop).
 *
 * Phase 3 scope: middle review session lifecycle. Three primitives:
 *
 *   - `pickReadyMiddleReview(deps)` — find a slice in SLICE_REVIEWING with
 *     a SM_READY_FOR_REVIEW SliceMerge that has no `review_session_id`,
 *     open a new middle review DialogueSession (sentinel lead), and return
 *     the (slice, sliceMerge, session) tuple.
 *   - `runMiddleReviewTurn(input, deps)` — invoke the sentinel reviewer,
 *     persist the SessionTurn, evaluate termination.
 *   - `dispatchOutcomeIfConverged(...)` — convenience wrapper over
 *     `caller-dispatch.dispatchOutcome`.
 *
 * Higher-level entry point `runOneMiddleReviewTurn` chains all three.
 *
 * Inner CONVERGED dispatch is still inlined by `turn-worker` (phase 2
 * shortcut) — phase 4 will fold that into this coordinator. For phase 3 we
 * focus on the *new* middle review pickup that lets a SM_READY_FOR_REVIEW
 * slice progress past phase-2's stopping point.
 */
import { DialogueSession, type DialogueSession as DialogueSessionT } from "../domain/schema/dialogue-session.js";
import type { Envelope } from "../domain/schema/envelope.js";
import { ContextManifest, type ContextManifest as ContextManifestT } from "../domain/schema/manifest.js";
import { SliceMerge, type SliceMerge as SliceMergeT } from "../domain/schema/slice-merge.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import type { CallerRoutingDecision } from "../domain/schema/session-turn.js";
import { newMonotonicId } from "../domain/ids.js";
import type { ClockPort } from "../ports/clock.js";
import type { LlmRunnerPort } from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import type { CommandSpec, VerificationPort } from "../ports/verification.js";
import type { WorkspacePort } from "../ports/workspace.js";
import { callAgent } from "./agent-io.js";
import {
  classifyAgentIoStageFailure,
  countPromptComposeFailuresFromLedger,
  evaluateRetry,
} from "./failure-policy.js";
import { prepareAgentWorkspace } from "./agent-workspace.js";
import {
  dispatchOutcome,
  type DispatchDeps,
  type DispatchResult,
} from "./caller-dispatch.js";
import { assertCanAcquire } from "./lease-acquisition-order.js";
import { withLeaseHeartbeat } from "./lease-heartbeat.js";
import { resolveLeaseTtl } from "./lease-ttl-resolver.js";
import type { LeasePort } from "../ports/lease.js";
import {
  resolveAgentTimeoutSec,
  type ContextBudget,
  type LeaseConfig,
} from "../config/target-schema.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import {
  ManifestBuilder,
  type ManifestEntryDraft,
  type RevisionPinResolver,
} from "./manifest-builder.js";
import { layout } from "./persistence-layout.js";
import { persistSessionTurn } from "./session-turn-persist.js";
import {
  evaluateTermination,
  type TerminationDecision,
  type TurnSummary,
} from "./termination-evaluator.js";

export interface MiddleReviewPickup {
  slice: SliceT;
  sliceMerge: SliceMergeT;
  session: DialogueSessionT;
  newSession: boolean;
}

export interface CoordinatorDeps {
  store: StorePort;
  clock: ClockPort;
  llmRunner: LlmRunnerPort;
  workspace: WorkspacePort;
  verification: VerificationPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
  /** Test commands for SM_APPROVED → SM_MERGED reverify. */
  reverifyTestCommands: (workspaceCwd: string) => CommandSpec[];
  environmentFingerprint: string;
  agentTimeoutSec?: number;
  /**
   * incident-10: TCC-CONTEXT-BUDGET map. When provided, `middle.review`
   * `timeout_sec` overrides resolve via `resolveAgentTimeoutSec`. Falls
   * back to `agentTimeoutSec ?? 120` for legacy callers.
   */
  contextBudget?: ContextBudget;
  maxReviewTurns?: number;
  /**
   * PR #63 review fix: phase-4 wire-up. When provided, the coordinator
   * claims a `session_lease` for the duration of the middle review turn.
   * Killed-daemon scenarios are then recoverable by `runRecoverySweep`
   * (the lease expires → SESSION_OPEN → AWAITING_REVALIDATION).
   *
   * Optional so phase-2 / older tests can keep using the coordinator
   * without leases, but operational deployment passes both.
   */
  lease?: LeasePort;
  leaseConfig?: LeaseConfig;
  /**
   * phase-0-stabilization C — absolute workdir root. Threaded into
   * `callAgent` so the composed middle-review prompt persists to
   * `<workdir>/prompts/<sessionId>/<turnIndex>.md` instead of OS-tmp.
   * Optional for backward compatibility with existing tests.
   */
  workdirRoot?: string;
}

export type RunMiddleReviewOutcome =
  | { kind: "noop"; detail: string }
  | {
      kind: "turn_persisted";
      sessionId: string;
      sliceId: string;
      sliceMergeId: string;
      decision: TerminationDecision;
      dispatch: DispatchResult | null;
    }
  | {
      kind: "invalid_envelope";
      sessionId: string;
      sliceId: string;
      stage: string;
      reason: string;
      detail: string;
    }
  | {
      /**
       * PR #95 review P0-1 (incident-3): mirror of the inner outcome —
       * the middle review session has hit the
       * `prompt_compose_truncation` retry cap. The session is ABANDONED
       * and the daemon stops re-picking it.
       */
      kind: "prompt_compose_escalated";
      sessionId: string;
      sliceId: string;
      detail: string;
    }
  | {
      kind: "dispatch_no_match";
      sessionId: string;
      sliceId: string;
      sliceMergeId: string;
      detail: string;
    }
  | {
      /** PR #63 review wire-up: another worker holds the session_lease. */
      kind: "lease_unavailable";
      sessionId: string;
      sliceId: string;
      detail: string;
    };

/**
 * One iteration of the dialogue coordinator's middle-review pickup. Mirrors
 * `runOneInnerTurn` in turn-worker for the middle loop:
 *   pickup → manifest → invoke sentinel → persist turn → evaluate → dispatch.
 */
export async function runOneMiddleReviewTurn(
  deps: CoordinatorDeps,
): Promise<RunMiddleReviewOutcome> {
  const ready = await pickReadyMiddleReview(deps);
  if (ready == null)
    return {
      kind: "noop",
      detail:
        "no SLICE_REVIEWING slice with SM_READY_FOR_REVIEW awaiting middle review",
    };
  const { slice, sliceMerge, session } = ready;
  const turnIndex = session.current_turn_index;

  // PR #63 review fix: claim a session_lease for the entire middle review
  // turn so a killed daemon's orphan SESSION_OPEN session is recoverable
  // by `runRecoverySweep` (lease expires → AWAITING_REVALIDATION). Without
  // this wire-up the phase-4 sweep sees zero phase-3-style orphans.
  let leaseClaim: Awaited<ReturnType<NonNullable<typeof deps.lease>["claim"]>> | null = null;
  if (deps.lease != null) {
    assertCanAcquire([], "session_lease");
    const ttl = resolveLeaseTtl({
      leaseKind: "session_lease",
      leaseConfig: deps.leaseConfig,
      phase: "review",
      agentProfileId: "sentinel",
    });
    leaseClaim = await deps.lease.claim({
      leaseKind: "session_lease",
      objectId: session.session_id,
      workerId: deps.callerId,
      ttlMs: ttl.ttlMs,
      ttlSource: ttl.source,
      targetId: deps.targetId,
      aux: {
        kind: "session_lease",
        session_id: session.session_id,
        agent_profile_id: "sentinel",
      },
    });
    if (leaseClaim.result === "claim_failed") {
      return {
        kind: "lease_unavailable",
        sessionId: session.session_id,
        sliceId: slice.slice_id,
        detail: `session_lease held by ${leaseClaim.existingHolder} (lease_id=${leaseClaim.existingLeaseId})`,
      };
    }
  }
  try {
    // PR #64 review P0-1 fix: heartbeat keeps the session_lease alive
    // through the long-running review turn (sentinel callAgent + middle
    // review's per_merge dispatch effects).
    if (leaseClaim != null && leaseClaim.result === "acquired" && deps.lease != null) {
      const claimed = leaseClaim.lease;
      const wrapped = await withLeaseHeartbeat(
        {
          lease: deps.lease,
          leaseId: claimed.lease_id,
          leaseToken: claimed.lease_token,
          ttlMs: claimed.ttl_ms,
        },
        async () =>
          runMiddleReviewTurnInner(slice, sliceMerge, session, turnIndex, deps),
      );
      return wrapped.value;
    }
    return await runMiddleReviewTurnInner(slice, sliceMerge, session, turnIndex, deps);
  } finally {
    if (leaseClaim != null && leaseClaim.result === "acquired" && deps.lease != null) {
      await deps.lease.release({
        leaseId: leaseClaim.lease.lease_id,
        leaseToken: leaseClaim.lease.lease_token,
      });
    }
  }
}

async function runMiddleReviewTurnInner(
  slice: SliceT,
  sliceMerge: SliceMergeT,
  session: DialogueSessionT,
  turnIndex: number,
  deps: CoordinatorDeps,
): Promise<RunMiddleReviewOutcome> {

  // P0-5 fix (PR #62 review): resume branch — if the SliceMerge is already
  // SM_APPROVED + slice is SLICE_INTEGRATING, the previous run crashed
  // mid-dispatch. Re-invoke integrateSliceMerge directly (idempotent via
  // per_merge ledger key) and skip a redundant sentinel turn.
  if (sliceMerge.state === "SM_APPROVED" && slice.state === "SLICE_INTEGRATING") {
    return await resumeIntegration(slice, sliceMerge, session, deps);
  }

  // Read-only checkout (worktree-pr-lifecycle.md §3) — reviewer never writes.
  const prep = await prepareAgentWorkspace(
    {
      parentLoop: "middle",
      phaseOrPurpose: "review",
      agentRoleInSession: "lead",
      agentProfileId: "sentinel",
      sliceId: slice.slice_id,
      revision: sliceMerge.pre_merge_workspace_revision ?? slice.trunk_base_revision,
    },
    deps.workspace,
  );

  // Manifest: slice body + slice_merge + verification (read inputs).
  const drafts: ManifestEntryDraft[] = [
    {
      object_kind: "slice",
      object_id: slice.slice_id,
      fetch_scope: "body",
      required: true,
      purpose: "primary input",
    },
    {
      object_kind: "slice_merge",
      object_id: sliceMerge.slice_merge_id,
      fetch_scope: "body",
      required: true,
      purpose: "review subject",
    },
  ];
  if (sliceMerge.verification_run_id) {
    drafts.push({
      object_kind: "verification_run",
      object_id: sliceMerge.verification_run_id,
      fetch_scope: "body",
      required: true,
      purpose: "evidence",
    });
  }

  const pinResolver = new MiddleReviewPinResolver(slice, sliceMerge);
  const manifestBuilder = new ManifestBuilder(pinResolver, deps.clock);
  const manifest = await manifestBuilder.build({
    session_id: session.session_id,
    turn_index: turnIndex,
    purpose: "review",
    target: { object_kind: "slice_merge", object_id: sliceMerge.slice_merge_id },
    drafts,
  });
  await deps.store.writeAtomic(
    layout.manifest(manifest.manifest_id),
    JSON.stringify(manifest, null, 2),
  );

  const agentOut = await callAgent(
    {
      agentProfileId: "sentinel",
      agentRoleInSession: "lead",
      parentLoop: "middle",
      phaseOrPurpose: "review",
      sessionId: session.session_id,
      turnIndex,
      manifest,
      workspaceRevisionPin: prep.headBefore,
      agentCwd: prep.agentCwd,
      timeoutSec: resolveAgentTimeoutSec(
        deps.contextBudget,
        "middle",
        "review",
        deps.agentTimeoutSec,
      ),
      idempotency: {
        scope: "per_turn",
        parts: {
          session_id: session.session_id,
          turn_index: turnIndex,
          agent_profile_id: "sentinel",
          manifest_id: manifest.manifest_id,
          input_revision_pins: manifest.entries.map((e) => e.revision_pin),
        },
      },
      runtimeMetadata: {
        slice_merge_id: sliceMerge.slice_merge_id,
        pre_merge_workspace_revision:
          sliceMerge.pre_merge_workspace_revision ?? "",
      },
      // PR #110 review P1-b (gpt5.5): forward operator
      // `context_budget` so per-phase `token_hard_cap` reaches
      // `composePromptWithBudget`. Previously this only fed the
      // timeout resolver, leaving prompt-budget overrides silent.
      contextBudget: deps.contextBudget,
    },
    // PR #112 review P0-1 (gpt5.5): incident-11 wired the
    // `(slice_merge, body)` and `(verification_run, body)` resolvers in
    // `manifest-resolve.ts`, but the middle review `callAgent` was still
    // missing the StorePort dependency. Without `store`, `callAgent`
    // skips body inlining and `# Inputs` falls back to
    // `[BODY NOT INLINED]` — the very regression incident-11 set out to
    // fix. Mirror the inner-cycle wiring at `turn-worker.ts:361`.
    //
    // phase-0-stabilization C: forward `workdirRoot` so the composed
    // prompt persists under `<workdir>/prompts/<session>/<turn>.md`.
    {
      llmRunner: deps.llmRunner,
      manifestBuilder,
      store: deps.store,
      workdirRoot: deps.workdirRoot,
    },
  );

  if (!agentOut.ok) {
    await emitInvalidReviewTurn(
      slice,
      session,
      turnIndex,
      manifest.manifest_id,
      manifest.entries.map((e) => e.revision_pin),
      agentOut,
      deps,
    );
    // PR #95 review P0-1: incident-3 retry cap wiring. See `outer-turn.ts`
    // for the rationale. Abandon the middle review session when the
    // `prompt_compose` failure count for this session reaches the cap so
    // the daemon's pickReadyMiddleReview selector stops re-picking it.
    const classification = classifyAgentIoStageFailure(agentOut);
    if (classification != null) {
      const totalFailures = await countPromptComposeFailuresFromLedger(
        deps.store,
        session.session_id,
      );
      const decision = evaluateRetry(classification, totalFailures - 1);
      if (decision.decision === "escalate") {
        await abandonMiddleSessionForPromptCompose(
          slice,
          session,
          turnIndex,
          decision.reason,
          deps,
        );
        return {
          kind: "prompt_compose_escalated",
          sessionId: session.session_id,
          sliceId: slice.slice_id,
          detail: decision.reason,
        };
      }
    }
    return {
      kind: "invalid_envelope",
      sessionId: session.session_id,
      sliceId: slice.slice_id,
      stage: agentOut.stage,
      reason: agentOut.reason,
      detail: agentOut.detail,
    };
  }

  // Persist SessionTurn.
  const callerRoutingDecision = decideRouting(agentOut.envelope);
  const { session: sessionAfterTurn } = await persistSessionTurn(
    {
      session,
      envelope: agentOut.envelope,
      callerRoutingDecision,
      workspaceCommit: null,
      verificationRunId: sliceMerge.verification_run_id,
      newWorkspaceRevisionPin: null,
    },
    { store: deps.store, clock: deps.clock },
  );

  // session_progress ledger row.
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: session.session_id,
    object_kind: "session_turn",
    from_state: null,
    to_state: `turn_index=${turnIndex}`,
    loop_kind: "middle",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: session.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "sentinel",
    contribution_kind: agentOut.envelope.contribution_kind,
    action_kind: "session_progress",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: manifest.manifest_id,
    input_revision_pins: manifest.entries.map((e) => e.revision_pin),
    output_hash: null,
    verification_run_id: sliceMerge.verification_run_id,
    metric_run_id: null,
    idempotency_key: agentOut.envelope.idempotency_key,
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  // P1-6 fix (PR #62 review): load all persisted turns for the session
  // so evaluateTermination sees every prior verdict (any_request_changes_blocks
  // tracks accumulated request_changes) and the max_turns TIMEOUT trigger
  // works once daemon mode permits multi-turn sessions.
  const allTurns = await loadAllTurnSummaries(
    sessionAfterTurn.session_id,
    sessionAfterTurn.current_turn_index,
    sliceMerge.verification_run_id,
    deps,
  );
  const decision = evaluateTermination({
    termination: sessionAfterTurn.session_termination,
    turns: allTurns,
    max_turns: sessionAfterTurn.max_turns,
  });

  if (!decision.converged) {
    // incident-12: previously this branch silently dropped TIMEOUT /
    // ABANDONED decisions and returned `dispatch: null`, leaving the session
    // SESSION_OPEN. The next pickup re-ran the same session, and once
    // `evaluateTermination` started returning timeout (turnCount >=
    // max_turns) every subsequent turn produced an identical sentinel
    // request_changes envelope, looping indefinitely. Honor timeout /
    // abandoned terminal reasons here and drive them through dispatch +
    // session-finalize, mirroring the converged branch below.
    if (decision.reason === "timeout" || decision.reason === "abandoned") {
      return finalizeNonConvergedReview(
        slice,
        sliceMerge,
        sessionAfterTurn,
        decision,
        allTurns,
        turnIndex,
        deps,
      );
    }
    return {
      kind: "turn_persisted",
      sessionId: sessionAfterTurn.session_id,
      sliceId: slice.slice_id,
      sliceMergeId: sliceMerge.slice_merge_id,
      decision,
      dispatch: null,
    };
  }

  // P0-3 fix (PR #62 review): dispatch FIRST, persist CONVERGED LAST.
  // Effects in caller-dispatch are idempotent (per_merge ledger keys +
  // exists-checks on slice writes). If we crash mid-dispatch, the next
  // pickReadyMiddleReview iteration resumes via the SM_APPROVED +
  // SLICE_INTEGRATING resume branch (P0-5). If we crash between dispatch
  // and CONVERGED-persist, the slice/SM are already at the target state;
  // the session is left as SESSION_OPEN and reaped by the phase-4 sweep.
  // Persisting CONVERGED first risked the previous gap where the session
  // was finalized but no dispatch ran — pickup couldn't find the slice
  // (SM_READY_FOR_REVIEW.review_session_id pointed at a CONVERGED session).
  const dispatchDeps: DispatchDeps = {
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    workspace: deps.workspace,
    verification: deps.verification,
    callerId: deps.callerId,
    targetId: deps.targetId,
  };
  const dispatch = await dispatchOutcome(
    {
      parent_loop: "middle",
      phase_or_purpose: "review",
      session_state: "CONVERGED",
      final_verdict: decision.final_verdict,
      slice,
      sliceMerge,
      sessionId: sessionAfterTurn.session_id,
      verificationRunId: sliceMerge.verification_run_id,
      trunkRevision: slice.trunk_base_revision,
      testCommandsForReverify: deps.reverifyTestCommands,
      environmentFingerprint: deps.environmentFingerprint,
    },
    dispatchDeps,
  );

  // P0-2 fix (PR #62 review): explicit guard for unmatched dispatch
  // tuples. Previously the coordinator silently CONVERGED with no
  // side-effects; now it records an error row and returns a distinct
  // outcome so the CLI can exit non-zero.
  if (dispatch.kind === "no_match") {
    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: sessionAfterTurn.session_id,
      object_kind: "dialogue_session",
      from_state: "SESSION_OPEN",
      to_state: "SESSION_OPEN",
      loop_kind: "middle",
      phase: null,
      slice_id: slice.slice_id,
      slice_kind: slice.slice_kind,
      dod_revision: slice.dod_revision_pin,
      session_id: sessionAfterTurn.session_id,
      turn_index: turnIndex,
      slot_kind: "delivery",
      agent_profile_id: "sentinel",
      contribution_kind: null,
      action_kind: "session_finalize",
      final_verdict: decision.final_verdict,
      caller_id: deps.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: sliceMerge.verification_run_id,
      metric_run_id: null,
      idempotency_key: idempotencyKey({
        scope: "external_observation",
        parts: {
          kind: "dispatch_no_match",
          session_id: sessionAfterTurn.session_id,
          final_verdict: decision.final_verdict,
        },
      }),
      lease_token: null,
      lease_kind: null,
      result: "error",
      result_detail: dispatch.detail.slice(0, 200),
      timestamp: deps.clock.isoNow(),
    });
    return {
      kind: "dispatch_no_match",
      sessionId: sessionAfterTurn.session_id,
      sliceId: slice.slice_id,
      sliceMergeId: sliceMerge.slice_merge_id,
      detail: dispatch.detail,
    };
  }

  // Persist CONVERGED + final_verdict last (atomicity — see comment above).
  const finalized = DialogueSession.parse({
    ...sessionAfterTurn,
    state: "CONVERGED",
    final_verdict: decision.final_verdict,
    finalization_decision: decision.finalization_decision,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sessionMetadata(finalized.session_id),
    JSON.stringify(finalized, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: finalized.session_id,
    object_kind: "dialogue_session",
    from_state: "SESSION_OPEN",
    to_state: "CONVERGED",
    loop_kind: "middle",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: finalized.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "sentinel",
    contribution_kind: null,
    action_kind: "session_finalize",
    final_verdict: decision.final_verdict,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: sliceMerge.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "per_session_outcome",
      parts: {
        session_id: finalized.session_id,
        final_verdict: decision.final_verdict,
        finalization_decision: decision.finalization_decision,
        workspace_revision_pin_at_convergence:
          sliceMerge.pre_merge_workspace_revision,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  return {
    kind: "turn_persisted",
    sessionId: finalized.session_id,
    sliceId: slice.slice_id,
    sliceMergeId: sliceMerge.slice_merge_id,
    decision,
    dispatch,
  };
}

export async function pickReadyMiddleReview(
  deps: Pick<
    CoordinatorDeps,
    "store" | "clock" | "ledger" | "callerId" | "targetId" | "maxReviewTurns"
  >,
): Promise<MiddleReviewPickup | null> {
  // Find a SM_READY_FOR_REVIEW SliceMerge whose slice is SLICE_REVIEWING.
  const sliceMergeNames = await deps.store.list("slice_merges");
  for (const name of sliceMergeNames) {
    if (!name.endsWith(".json")) continue;
    const body = await deps.store.readText(`slice_merges/${name}`);
    if (body == null) continue;
    let sm: SliceMergeT;
    try {
      sm = SliceMerge.parse(JSON.parse(body));
    } catch {
      continue;
    }
    // P0-5 fix (PR #62 review): also pick up SM_APPROVED + SLICE_INTEGRATING
    // for the resume branch (mid-dispatch crash recovery).
    if (sm.state !== "SM_READY_FOR_REVIEW" && sm.state !== "SM_APPROVED") continue;
    const sliceBody = await deps.store.readText(layout.slice(sm.slice_id));
    if (sliceBody == null) continue;
    const slice = Slice.parse(JSON.parse(sliceBody));
    if (sm.state === "SM_READY_FOR_REVIEW" && slice.state !== "SLICE_REVIEWING")
      continue;
    if (sm.state === "SM_APPROVED" && slice.state !== "SLICE_INTEGRATING")
      continue;
    if (sm.review_session_id == null) {
      const session = await openMiddleReviewSession(slice, sm, deps);
      // Persist the link from sliceMerge → review_session_id so concurrent
      // pickups see the assignment and don't open a second review session.
      const updatedSm = SliceMerge.parse({
        ...sm,
        review_session_id: session.session_id,
        updated_at: deps.clock.isoNow(),
      });
      await deps.store.writeAtomic(
        layout.sliceMerge(updatedSm.slice_merge_id),
        JSON.stringify(updatedSm, null, 2),
      );
      // Mark slice.current_session_id so concurrent inner-cycle pickups can't
      // claim it. PR #64 review P0-2 fix: wrap in withFileLock for symmetry
      // with recovery.reanimateSliceIfNeeded.
      const slicePath = layout.slice(slice.slice_id);
      const updatedSlice = await deps.store.withFileLock(slicePath, async () => {
        const fresh = await deps.store.readText(slicePath);
        const live = fresh != null ? Slice.parse(JSON.parse(fresh)) : slice;
        const updated = Slice.parse({
          ...live,
          current_session_id: session.session_id,
          updated_at: deps.clock.isoNow(),
        });
        await deps.store.writeAtomic(slicePath, JSON.stringify(updated, null, 2));
        return updated;
      });
      return {
        slice: updatedSlice,
        sliceMerge: updatedSm,
        session,
        newSession: true,
      };
    }
    // Existing review session — resume.
    const sBody = await deps.store.readText(
      layout.sessionMetadata(sm.review_session_id),
    );
    if (sBody == null) continue;
    const existing = DialogueSession.parse(JSON.parse(sBody));
    if (existing.state === "SESSION_OPEN") {
      return {
        slice,
        sliceMerge: sm,
        session: existing,
        newSession: false,
      };
    }
    // phase-0-stabilization A: AWAITING_REVALIDATION reanimator.
    //
    // Background: a session_lease that expired during a long-running
    // sentinel turn drives the session to AWAITING_REVALIDATION (see
    // recovery.ts §reanimateSessionIfNeeded). The previous pickup filter
    // (`if (existing.state !== "SESSION_OPEN") continue;`) then permanently
    // skipped the session — and because `sm.review_session_id` is already
    // populated, the new-session branch above is also skipped. The slice
    // wedges in SLICE_REVIEWING with no progress path.
    //
    // Resolution: when a middle-review session is AWAITING_REVALIDATION,
    // recompute the canonical input revision pins from the current slice +
    // sliceMerge state and compare against the pins recorded in the most
    // recent SessionTurn's manifest. If equivalent (no drift), transition
    // the session back to SESSION_OPEN under a file lock + ledger row and
    // resume the review. If drift is present, leave the session alone — the
    // cross-slot-stale policy or operator action handles re-base.
    if (existing.state === "AWAITING_REVALIDATION") {
      const reanimated = await reanimateAwaitingRevalidationReviewSession(
        slice,
        sm,
        existing,
        deps,
      );
      if (reanimated != null) {
        return {
          slice,
          sliceMerge: sm,
          session: reanimated,
          newSession: false,
        };
      }
      continue;
    }
    // CONVERGED / TIMEOUT / ABANDONED — terminal, do not re-pick.
    continue;
  }
  return null;
}

/**
 * phase-0-stabilization A — recompute the middle-review input revision pins
 * for an AWAITING_REVALIDATION session and, if they match the pins recorded
 * in the latest persisted SessionTurn, transition the session back to
 * SESSION_OPEN so the daemon's pickReadyMiddleReview can resume it.
 *
 * Pin equivalence is the conservative criterion: middle-review pins are
 * derived purely from `slice.dod_revision_pin`, `sliceMerge
 * .pre_merge_workspace_revision`, and `verification_run.id` (see
 * `MiddleReviewPinResolver`). When the recomputed values match the prior
 * manifest entry-by-entry, no input has drifted relative to the session's
 * last turn, and resuming is safe.
 *
 * Edge cases:
 *   - `current_turn_index === 0` (no turns yet): no manifest exists to
 *     compare against, and no work has been pinned to anything that could
 *     drift. Re-open directly.
 *   - latest SessionTurn or manifest unreadable: bail (return null) — the
 *     session stays AWAITING_REVALIDATION and an operator decides next.
 *   - any pin differs: bail. Drift is handled by the existing cross-slot-
 *     stale / abandon paths; this helper is only for the "lease expired,
 *     nothing else changed" case.
 *
 * Atomicity: the state transition runs inside `withFileLock(sessionMetadata)`
 * with a re-read so a concurrent recovery sweep cannot interleave. A second
 * call after success is a noop (the live state is already SESSION_OPEN).
 *
 * Returns the live session record (post-transition) on success, null
 * otherwise.
 */
async function reanimateAwaitingRevalidationReviewSession(
  slice: SliceT,
  sliceMerge: SliceMergeT,
  session: DialogueSessionT,
  deps: Pick<CoordinatorDeps, "store" | "clock" | "ledger" | "callerId" | "targetId">,
): Promise<DialogueSessionT | null> {
  if (session.current_turn_index > 0) {
    const lastIdx = session.current_turn_index - 1;
    const turnBody = await deps.store.readText(
      layout.sessionTurn(session.session_id, lastIdx),
    );
    if (turnBody == null) return null;
    let priorManifestId: string;
    try {
      const turn = JSON.parse(turnBody) as { input_manifest_id?: unknown };
      if (typeof turn.input_manifest_id !== "string") return null;
      priorManifestId = turn.input_manifest_id;
    } catch {
      return null;
    }
    const manifestBody = await deps.store.readText(
      layout.manifest(priorManifestId),
    );
    if (manifestBody == null) return null;
    let priorManifest: ContextManifestT;
    try {
      priorManifest = ContextManifest.parse(JSON.parse(manifestBody));
    } catch {
      return null;
    }
    const resolver = new MiddleReviewPinResolver(slice, sliceMerge);
    for (const entry of priorManifest.entries) {
      const livePin = await resolver.resolve({
        object_kind: entry.object_kind,
        object_id: entry.object_id,
        fetch_scope: entry.fetch_scope,
        required: entry.required,
        purpose: entry.purpose,
      });
      if (livePin !== entry.revision_pin) return null;
    }
  }
  // Pins matched (or no turns yet) → flip back to SESSION_OPEN under lock.
  const sessionPath = layout.sessionMetadata(session.session_id);
  const transitioned = await deps.store.withFileLock(sessionPath, async () => {
    const fresh = await deps.store.readText(sessionPath);
    if (fresh == null) return null;
    let live: DialogueSessionT;
    try {
      live = DialogueSession.parse(JSON.parse(fresh));
    } catch {
      return null;
    }
    if (live.state !== "AWAITING_REVALIDATION") return null;
    const next = DialogueSession.parse({
      ...live,
      state: "SESSION_OPEN",
      updated_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(sessionPath, JSON.stringify(next, null, 2));
    return next;
  });
  if (transitioned == null) return null;
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: session.session_id,
    object_kind: "dialogue_session",
    from_state: "AWAITING_REVALIDATION",
    to_state: "SESSION_OPEN",
    loop_kind: "middle",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: session.session_id,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: "sentinel",
    contribution_kind: null,
    action_kind: "recover",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: sliceMerge.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "recover",
      parts: {
        kind: "awaiting_revalidation_reanimate",
        session_id: session.session_id,
        // Tie idempotency to the live updated_at so a re-stale → re-resume
        // cycle produces a distinct ledger row each time. The previous
        // session's updated_at (before this transition) is the natural key.
        from_updated_at: session.updated_at,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "recovered",
    result_detail:
      "AWAITING_REVALIDATION pins match live slice/slice_merge — resumed SESSION_OPEN",
    timestamp: deps.clock.isoNow(),
  });
  return transitioned;
}

async function openMiddleReviewSession(
  slice: SliceT,
  sm: SliceMergeT,
  deps: Pick<
    CoordinatorDeps,
    "store" | "clock" | "ledger" | "callerId" | "targetId" | "maxReviewTurns"
  >,
): Promise<DialogueSessionT> {
  const sessionId = newMonotonicId(deps.clock.now());
  const session = DialogueSession.parse({
    session_id: sessionId,
    parent_object_kind: "slice",
    parent_object_id: slice.slice_id,
    parent_loop: "middle",
    purpose: "review",
    participants: [{ agent_profile_id: "sentinel", role: "lead" }],
    session_termination: {
      finalization_rule: "any_request_changes_blocks",
      required_evidence: [
        {
          kind: "verification_green",
          acceptance_tests: slice.acceptance_tests.map(
            (a) => `${a.path}:${a.name}`,
          ),
          deterministic_checks: [],
        },
      ],
      composite_rule: "finalization_AND_evidence",
    },
    workspace_revision_pin:
      sm.pre_merge_workspace_revision ?? slice.trunk_base_revision,
    current_turn_index: 0,
    state: "SESSION_OPEN",
    max_turns: deps.maxReviewTurns ?? 5,
    created_at: deps.clock.isoNow(),
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sessionMetadata(sessionId),
    JSON.stringify(session, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: sessionId,
    object_kind: "dialogue_session",
    from_state: null,
    to_state: "SESSION_OPEN",
    loop_kind: "middle",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: sessionId,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: "sentinel",
    contribution_kind: null,
    action_kind: "session_progress",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: sm.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "session_open",
        session_id: sessionId,
        slice_merge_id: sm.slice_merge_id,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  return session;
}

class MiddleReviewPinResolver implements RevisionPinResolver {
  constructor(
    private readonly slice: SliceT,
    private readonly sliceMerge: SliceMergeT,
  ) {}
  async resolve(entry: ManifestEntryDraft): Promise<string> {
    if (entry.object_kind === "slice")
      return this.slice.dod_revision_pin;
    if (entry.object_kind === "slice_merge")
      return this.sliceMerge.pre_merge_workspace_revision ?? this.sliceMerge.slice_merge_id;
    if (entry.object_kind === "verification_run")
      return entry.object_id;
    return entry.object_id;
  }
}

function decideRouting(envelope: Envelope): CallerRoutingDecision {
  const nar = envelope.next_action_request;
  if (nar == null)
    return {
      decision: "dropped",
      decision_reason: "single-agent middle review has no next_action_request",
      resolved_addressed_to: null,
    };
  return {
    decision: "accepted",
    decision_reason: `accepted next_action_request from ${envelope.agent_profile_id}`,
    resolved_addressed_to:
      typeof nar.addressed_to === "string" ? nar.addressed_to : null,
  };
}

async function loadVerificationSummary(
  verificationRunId: string,
  deps: Pick<CoordinatorDeps, "store">,
): Promise<TurnSummary["verification"]> {
  const body = await deps.store.readText(layout.verification(verificationRunId));
  if (body == null) return null;
  try {
    const parsed = JSON.parse(body) as TurnSummary["verification"];
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load every persisted SessionTurn for a session and synthesise the
 * TurnSummary[] termination-evaluator consumes. The verification run is
 * the SliceMerge's frozen evidence (one per session for middle review);
 * we attach it to the latest turn only so evidence_only / AND_evidence
 * paths see a single conclusive verification record.
 */
async function loadAllTurnSummaries(
  sessionId: string,
  upToTurnIndexExclusive: number,
  verificationRunId: string | null,
  deps: Pick<CoordinatorDeps, "store">,
): Promise<TurnSummary[]> {
  const summaries: TurnSummary[] = [];
  for (let i = 0; i < upToTurnIndexExclusive; i++) {
    const body = await deps.store.readText(layout.sessionTurn(sessionId, i));
    if (body == null) continue;
    let parsed: { agent_role_in_session?: string; output_envelope?: { verdict?: TurnSummary["verdict"] } };
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const role = (parsed.agent_role_in_session ?? "lead") as TurnSummary["agent_role_in_session"];
    summaries.push({
      agent_role_in_session: role,
      verdict: parsed.output_envelope?.verdict ?? null,
      verification: null,
    });
  }
  // Attach the frozen verification to the latest turn only.
  if (summaries.length > 0 && verificationRunId != null) {
    const v = await loadVerificationSummary(verificationRunId, deps);
    summaries[summaries.length - 1] = {
      ...summaries[summaries.length - 1]!,
      verification: v,
    };
  }
  return summaries;
}

/**
 * P0-5 fix (PR #62 review): resume the integrate step when a previous
 * dispatch crashed between SM_APPROVED and SM_MERGED. We re-enter
 * `caller-dispatch.dispatchOutcome` which calls `integrateSliceMerge`;
 * its per_merge ledger key absorbs the prior SM_APPROVED row so we don't
 * double-write it, and rebase + reverify are themselves idempotent.
 *
 * Also persists the CONVERGED finalization that the original run never
 * got to write — without it the session would stay SESSION_OPEN forever.
 */
async function resumeIntegration(
  slice: SliceT,
  sliceMerge: SliceMergeT,
  session: DialogueSessionT,
  deps: CoordinatorDeps,
): Promise<RunMiddleReviewOutcome> {
  // Synthesise the CONVERGED+approve decision we know already happened
  // (otherwise the SM would not be SM_APPROVED).
  const decision: TerminationDecision = {
    converged: true,
    final_verdict: "approve",
    finalization_decision: "composite",
  };
  const dispatchDeps: DispatchDeps = {
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    workspace: deps.workspace,
    verification: deps.verification,
    callerId: deps.callerId,
    targetId: deps.targetId,
  };
  // Roll the SM "back" to SM_READY_FOR_REVIEW in-memory so the dispatch
  // executor's promote step succeeds. The on-disk row is already SM_APPROVED;
  // promoteSliceMergeToApproved is a no-op via the ledger duplicate guard
  // (external_observation key with to_state=SM_APPROVED).
  const dispatch = await dispatchOutcome(
    {
      parent_loop: "middle",
      phase_or_purpose: "review",
      session_state: "CONVERGED",
      final_verdict: "approve",
      slice,
      sliceMerge: SliceMerge.parse({
        ...sliceMerge,
        state: "SM_READY_FOR_REVIEW",
      }),
      sessionId: session.session_id,
      verificationRunId: sliceMerge.verification_run_id,
      trunkRevision: slice.trunk_base_revision,
      testCommandsForReverify: deps.reverifyTestCommands,
      environmentFingerprint: deps.environmentFingerprint,
    },
    dispatchDeps,
  );

  // Persist CONVERGED if not already done. Idempotent via per_session_outcome key.
  if (session.state === "SESSION_OPEN") {
    const finalized = DialogueSession.parse({
      ...session,
      state: "CONVERGED",
      final_verdict: decision.final_verdict,
      finalization_decision: decision.finalization_decision,
      updated_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(
      layout.sessionMetadata(finalized.session_id),
      JSON.stringify(finalized, null, 2),
    );
    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: finalized.session_id,
      object_kind: "dialogue_session",
      from_state: "SESSION_OPEN",
      to_state: "CONVERGED",
      loop_kind: "middle",
      phase: null,
      slice_id: slice.slice_id,
      slice_kind: slice.slice_kind,
      dod_revision: slice.dod_revision_pin,
      session_id: finalized.session_id,
      turn_index: session.current_turn_index - 1,
      slot_kind: "delivery",
      agent_profile_id: "sentinel",
      contribution_kind: null,
      action_kind: "session_finalize",
      final_verdict: decision.final_verdict,
      caller_id: deps.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: sliceMerge.verification_run_id,
      metric_run_id: null,
      idempotency_key: idempotencyKey({
        scope: "per_session_outcome",
        parts: {
          session_id: finalized.session_id,
          final_verdict: decision.final_verdict,
          finalization_decision: decision.finalization_decision,
          workspace_revision_pin_at_convergence:
            sliceMerge.pre_merge_workspace_revision,
        },
      }),
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: "resumed_after_crash",
      timestamp: deps.clock.isoNow(),
    });
  }

  return {
    kind: "turn_persisted",
    sessionId: session.session_id,
    sliceId: slice.slice_id,
    sliceMergeId: sliceMerge.slice_merge_id,
    decision,
    dispatch,
  };
}

/**
 * incident-12: middle review session terminated as TIMEOUT or ABANDONED.
 *
 * Mirrors the CONVERGED branch above (dispatch FIRST, persist terminal
 * session state LAST) so a mid-dispatch crash leaves SM/Slice at the target
 * state and the orphan SESSION_OPEN row is reaped by the phase-4 sweep.
 *
 * Final-verdict carry-over: when prior turns recorded a `request_changes`
 * verdict the session was destined to converge as `request_changes` (per
 * `any_request_changes_blocks`); honor that intent and dispatch
 * `reset_slice_for_rebuild` so the forge gets another build budget. With no
 * prior RC, dispatch the existing `close_slice_merge_blocked` path
 * (SLICE_BLOCKED).
 */
async function finalizeNonConvergedReview(
  slice: SliceT,
  sliceMerge: SliceMergeT,
  session: DialogueSessionT,
  decision:
    | { converged: false; reason: "timeout" }
    | {
        converged: false;
        reason: "abandoned";
        abandoned_reason: "no_progress" | "regression" | "scope_violation";
      },
  allTurns: readonly TurnSummary[],
  turnIndex: number,
  deps: CoordinatorDeps,
): Promise<RunMiddleReviewOutcome> {
  const sessionState = decision.reason === "timeout" ? "TIMEOUT" : "ABANDONED";
  const anyRC = allTurns.some((t) => t.verdict?.result === "request_changes");
  const finalVerdict = anyRC ? "request_changes" : null;

  const dispatchDeps: DispatchDeps = {
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    workspace: deps.workspace,
    verification: deps.verification,
    callerId: deps.callerId,
    targetId: deps.targetId,
  };
  const dispatch = await dispatchOutcome(
    {
      parent_loop: "middle",
      phase_or_purpose: "review",
      session_state: sessionState,
      final_verdict: finalVerdict,
      slice,
      sliceMerge,
      sessionId: session.session_id,
      verificationRunId: sliceMerge.verification_run_id,
      trunkRevision: slice.trunk_base_revision,
      testCommandsForReverify: deps.reverifyTestCommands,
      environmentFingerprint: deps.environmentFingerprint,
    },
    dispatchDeps,
  );

  if (dispatch.kind === "no_match") {
    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: session.session_id,
      object_kind: "dialogue_session",
      from_state: "SESSION_OPEN",
      to_state: "SESSION_OPEN",
      loop_kind: "middle",
      phase: null,
      slice_id: slice.slice_id,
      slice_kind: slice.slice_kind,
      dod_revision: slice.dod_revision_pin,
      session_id: session.session_id,
      turn_index: turnIndex,
      slot_kind: "delivery",
      agent_profile_id: "sentinel",
      contribution_kind: null,
      action_kind: "session_finalize",
      final_verdict: finalVerdict,
      caller_id: deps.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: sliceMerge.verification_run_id,
      metric_run_id: null,
      idempotency_key: idempotencyKey({
        scope: "external_observation",
        parts: {
          kind: "dispatch_no_match",
          session_id: session.session_id,
          session_state: sessionState,
          final_verdict: finalVerdict,
        },
      }),
      lease_token: null,
      lease_kind: null,
      result: "error",
      result_detail: dispatch.detail.slice(0, 200),
      timestamp: deps.clock.isoNow(),
    });
    return {
      kind: "dispatch_no_match",
      sessionId: session.session_id,
      sliceId: slice.slice_id,
      sliceMergeId: sliceMerge.slice_merge_id,
      detail: dispatch.detail,
    };
  }

  // Persist terminal session state LAST (atomicity — see CONVERGED comment).
  // Idempotent: if the session was already persisted as TIMEOUT/ABANDONED on a
  // prior crashed run, pickReadyMiddleReview won't return it (the SM is
  // already SM_CLOSED), so this branch only fires the first time.
  // PR #114 review (gpt5.5 [심각도:중간]): record abandoned_reason on the
  // session record itself, not just in the idempotency key. Operations /
  // recovery / audit paths that read the session metadata previously lost
  // the distinction between `no_progress`, `regression`, and
  // `scope_violation` because `decision.abandoned_reason` was only encoded
  // into the per_session_outcome ledger key below.
  const finalizedSession = DialogueSession.parse({
    ...session,
    state: sessionState,
    final_verdict: finalVerdict,
    abandoned_reason:
      decision.reason === "abandoned" ? decision.abandoned_reason : null,
    finalization_decision: null,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sessionMetadata(finalizedSession.session_id),
    JSON.stringify(finalizedSession, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: finalizedSession.session_id,
    object_kind: "dialogue_session",
    from_state: "SESSION_OPEN",
    to_state: sessionState,
    loop_kind: "middle",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: finalizedSession.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "sentinel",
    contribution_kind: null,
    action_kind: "session_finalize",
    final_verdict: finalVerdict,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: sliceMerge.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "per_session_outcome",
      parts: {
        session_id: finalizedSession.session_id,
        // Carry the carry-over verdict (request_changes) when present;
        // otherwise the terminal session state is the dispatch key.
        final_verdict: finalVerdict ?? sessionState,
        finalization_decision:
          decision.reason === "abandoned"
            ? `abandoned:${decision.abandoned_reason}`
            : "timeout",
        workspace_revision_pin_at_convergence:
          sliceMerge.pre_merge_workspace_revision,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  return {
    kind: "turn_persisted",
    sessionId: finalizedSession.session_id,
    sliceId: slice.slice_id,
    sliceMergeId: sliceMerge.slice_merge_id,
    decision,
    dispatch,
  };
}

async function emitInvalidReviewTurn(
  slice: SliceT,
  session: DialogueSessionT,
  turnIndex: number,
  manifestId: string,
  inputPins: string[],
  failure: { stage: string; reason: string; detail: string },
  deps: CoordinatorDeps,
): Promise<void> {
  const turnIdempotencyKey = idempotencyKey({
    scope: "per_turn",
    parts: {
      session_id: session.session_id,
      turn_index: turnIndex,
      agent_profile_id: "sentinel",
      manifest_id: manifestId,
      input_revision_pins: inputPins,
    },
  });
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: session.session_id,
    object_kind: "session_turn",
    from_state: null,
    to_state: `turn_index=${turnIndex}`,
    loop_kind: "middle",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: session.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "sentinel",
    contribution_kind: null,
    action_kind: "session_progress",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: manifestId,
    input_revision_pins: inputPins,
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: turnIdempotencyKey,
    lease_token: null,
    lease_kind: null,
    result: "invalid",
    result_detail: `${failure.stage}/${failure.reason}: ${failure.detail.slice(0, 200)}`,
    timestamp: deps.clock.isoNow(),
  });
}

/**
 * PR #95 review P0-1 (incident-3): mirror of
 * `turn-worker.abandonInnerSessionForPromptCompose` for the middle review
 * loop. Flips the SESSION_OPEN middle session to ABANDONED and records a
 * session_finalize ledger row so `pickReadyMiddleReview` (which guards on
 * `state === "SESSION_OPEN"`) stops re-picking it. The slice itself is
 * left in SLICE_REVIEWING — the recovery sweep / operator handles
 * downstream cleanup, identical to other terminal middle outcomes.
 */
async function abandonMiddleSessionForPromptCompose(
  slice: SliceT,
  session: DialogueSessionT,
  turnIndex: number,
  reason: string,
  deps: CoordinatorDeps,
): Promise<void> {
  const finalized = DialogueSession.parse({
    ...session,
    state: "ABANDONED",
    final_verdict: null,
    abandoned_reason: "no_progress",
    finalization_decision: null,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sessionMetadata(finalized.session_id),
    JSON.stringify(finalized, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: finalized.session_id,
    object_kind: "dialogue_session",
    from_state: "SESSION_OPEN",
    to_state: "ABANDONED",
    loop_kind: "middle",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: finalized.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "sentinel",
    contribution_kind: null,
    action_kind: "session_finalize",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "per_session_outcome",
      parts: {
        session_id: finalized.session_id,
        final_verdict: "ABANDONED",
        finalization_decision: "abandoned:prompt_compose_truncation",
        workspace_revision_pin_at_convergence: finalized.workspace_revision_pin,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: reason,
    timestamp: deps.clock.isoNow(),
  });
}
