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
import { prepareAgentWorkspace } from "./agent-workspace.js";
import {
  dispatchOutcome,
  type DispatchDeps,
  type DispatchResult,
} from "./caller-dispatch.js";
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
  maxReviewTurns?: number;
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
      timeoutSec: deps.agentTimeoutSec ?? 120,
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
    },
    { llmRunner: deps.llmRunner, manifestBuilder },
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

  // Evaluate termination (middle review default: any_request_changes_blocks +
  // verification_green + finalization_AND_evidence).
  const turnSummary: TurnSummary = {
    agent_role_in_session: "lead",
    verdict: agentOut.envelope.verdict,
    verification:
      sliceMerge.verification_run_id != null
        ? await loadVerificationSummary(
            sliceMerge.verification_run_id,
            deps,
          )
        : null,
  };
  const decision = evaluateTermination({
    termination: sessionAfterTurn.session_termination,
    turns: [turnSummary],
    max_turns: sessionAfterTurn.max_turns,
  });

  if (!decision.converged) {
    return {
      kind: "turn_persisted",
      sessionId: sessionAfterTurn.session_id,
      sliceId: slice.slice_id,
      sliceMergeId: sliceMerge.slice_merge_id,
      decision,
      dispatch: null,
    };
  }

  // Persist CONVERGED + final_verdict.
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

  // Dispatch via caller-dispatch.
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
      sessionId: finalized.session_id,
      verificationRunId: sliceMerge.verification_run_id,
      trunkRevision: slice.trunk_base_revision,
      testCommandsForReverify: deps.reverifyTestCommands,
      environmentFingerprint: deps.environmentFingerprint,
    },
    dispatchDeps,
  );

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
    if (sm.state !== "SM_READY_FOR_REVIEW") continue;
    const sliceBody = await deps.store.readText(layout.slice(sm.slice_id));
    if (sliceBody == null) continue;
    const slice = Slice.parse(JSON.parse(sliceBody));
    if (slice.state !== "SLICE_REVIEWING") continue;
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
      // claim it.
      const updatedSlice = Slice.parse({
        ...slice,
        current_session_id: session.session_id,
        updated_at: deps.clock.isoNow(),
      });
      await deps.store.writeAtomic(
        layout.slice(updatedSlice.slice_id),
        JSON.stringify(updatedSlice, null, 2),
      );
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
    if (existing.state !== "SESSION_OPEN") continue;
    return {
      slice,
      sliceMerge: sm,
      session: existing,
      newSession: false,
    };
  }
  return null;
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
