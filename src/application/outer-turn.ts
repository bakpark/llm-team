/**
 * Phase 5b.3 — outer-loop turn orchestrator.
 *
 * Runs a single LLM turn against the next ready outer DialogueSession.
 * Mirrors `dialogue-coordinator.runOneMiddleReviewTurn` but for milestone-
 * anchored sessions (Discovery / Specification / Planning / Validation).
 *
 * Pipeline:
 *   1. `pickReadyOuterSession` (5b.2)
 *   2. Open new session if none exists for the milestone, OR re-use the
 *      existing SESSION_OPEN session.
 *   3. AWAITING_HUMAN gate — if the milestone is parked and the next
 *      participant is `human`, return `awaiting_human` so the caller can
 *      defer. The signal binding (5b.2) appends a SessionTurn out-of-band;
 *      a subsequent `runOneOuterTurn` call resumes evaluation.
 *   4. Pick the next non-human, non-observer participant whose turn it is:
 *        - turn 0 → lead.
 *        - last turn was lead → next reviewer who has not yet voted in the
 *          current round.
 *        - last turn was reviewer with `request_changes` → lead re-engages.
 *        - last turn was reviewer approve/reject and reviewers remain →
 *          next reviewer.
 *      Validation only runs the lead (sentinel) — observers (scout) are
 *      deferred to 5c.
 *   5. Build manifest (milestone body + spec doc when present), invoke
 *      AgentRunner, validate envelope, persist SessionTurn (lock + read-
 *      check-write inside `persistSessionTurn`).
 *   6. Re-load all persisted turns, evaluate finalization. Validation's
 *      `evidence_only` rule pulls a synthetic VerificationRun from the
 *      lead's `milestone_package` verdict (PASS → result=pass).
 *   7. CONVERGED → dispatch via `caller-dispatch-outer.dispatchOuterOutcome`,
 *      then persist `state=CONVERGED + final_verdict + finalization_decision`.
 *      No dispatch happens for `continue` / `timeout` / `awaiting_human`.
 *
 * Caller-only operational write (Inv #4): every persisted side-effect — the
 * SessionTurn, the milestone transition, the slice writes from
 * `persist_slice_dag_and_promote` — is performed by this Caller-side
 * application function. Agents only emit envelopes.
 *
 * Atomicity (Inv #1): SessionTurn persistence runs under
 * `withFileLock(sessionMetadata)` (via `persistSessionTurn`). The dispatch
 * step takes its own `withFileLock(milestonePath)` inside
 * `dispatchOuterOutcome`.
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
  type Participant,
} from "../domain/schema/dialogue-session.js";
import type { Envelope } from "../domain/schema/envelope.js";
import type { Milestone as MilestoneT } from "../domain/schema/milestone.js";
import type { CallerRoutingDecision } from "../domain/schema/session-turn.js";
import type { VerificationRun } from "../domain/schema/verification.js";
import type { ClockPort } from "../ports/clock.js";
import type { LlmRunnerPort } from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import { callAgent } from "./agent-io.js";
import {
  dispatchOuterOutcome,
  type OuterDispatchInput,
  type OuterDispatchResult,
} from "./caller-dispatch-outer.js";
import type { LedgerAppender } from "./ledger.js";
import {
  ManifestBuilder,
  type ManifestEntryDraft,
  type RevisionPinResolver,
} from "./manifest-builder.js";
import {
  openOuterSession,
  pickReadyOuterSession,
  type OuterPhase,
} from "./outer-session.js";
import { layout } from "./persistence-layout.js";
import { persistSessionTurn } from "./session-turn-persist.js";
import {
  evaluateTermination,
  type TerminationDecision,
  type TurnSummary,
} from "./termination-evaluator.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import type { LlmAgentProfileId, AgentRole } from "../ports/llm-runner.js";
import { idempotencyKey } from "./idempotency.js";

export interface OuterTurnDeps {
  store: StorePort;
  clock: ClockPort;
  llmRunner: LlmRunnerPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
  agentTimeoutSec?: number;
  maxOuterTurns?: number;
  /**
   * Working directory passed to the LLM runner as `agentCwd`. Outer agents
   * are read-only at the workspace layer; the caller supplies a stable path
   * (typically the workdir root). Defaults to `process.cwd()` so single-
   * shot CLI invocations work without explicit configuration.
   */
  agentCwd?: string;
}

export type RunOneOuterTurnOutcome =
  | { kind: "noop"; detail: string }
  | {
      kind: "awaiting_human";
      sessionId: string;
      milestoneId: string;
      phase: OuterPhase;
      detail: string;
    }
  | {
      kind: "turn_persisted";
      sessionId: string;
      milestoneId: string;
      phase: OuterPhase;
      decision: TerminationDecision;
      dispatch: OuterDispatchResult | null;
    }
  | {
      kind: "invalid_envelope";
      sessionId: string;
      milestoneId: string;
      phase: OuterPhase;
      stage: string;
      reason: string;
      detail: string;
    }
  | {
      kind: "dispatch_no_match";
      sessionId: string;
      milestoneId: string;
      phase: OuterPhase;
      detail: string;
    };

export async function runOneOuterTurn(
  deps: OuterTurnDeps,
): Promise<RunOneOuterTurnOutcome> {
  const ready = await pickReadyOuterSession(deps);
  if (ready == null) {
    return { kind: "noop", detail: "no outer-pickable milestone" };
  }
  const { milestone, phase } = ready;

  // Open or reuse the SESSION_OPEN outer session for this milestone.
  let session: DialogueSessionT;
  if (ready.existingSession != null) {
    session = ready.existingSession;
  } else {
    session = await openOuterSession(
      {
        milestone,
        phase,
        workspaceRevisionPin:
          milestone.spec_revision_pin ?? "outer-trunk-base",
      },
      {
        store: deps.store,
        clock: deps.clock,
        ledger: deps.ledger,
        callerId: deps.callerId,
        targetId: deps.targetId,
        maxOuterTurns: deps.maxOuterTurns,
      },
    );
  }

  const turnIndex = session.current_turn_index;

  // Load existing turns to decide who acts next.
  const priorTurns = await loadOuterTurns(session, turnIndex, deps.store);

  // Pre-evaluate termination on already-persisted turns. If convergence is
  // already reached (e.g. all reviewers approved on a prior cycle but the
  // dispatch+CONVERGED-persist did not run because the previous turn was
  // the closer), finalize without running another LLM turn. This also
  // covers `unanimous_approve` where no lead verdict is required after the
  // reviewers have all voted.
  const preSummaries = await loadOuterTurnSummaries(
    session.session_id,
    turnIndex,
    phase,
    deps,
  );
  const preDecision = evaluateTermination({
    termination: session.session_termination,
    turns: preSummaries,
    max_turns: session.max_turns,
  });
  if (preDecision.converged) {
    const leadEnv = await lastLeadEnvelope(session, priorTurns, deps.store);
    return finalizeConvergedSession(
      session,
      milestone,
      phase,
      preDecision,
      leadEnv,
      turnIndex,
      deps,
    );
  }

  const nextRole = pickNextRole(
    session.participants,
    priorTurns,
    phase,
    session.session_termination,
  );
  if (nextRole.kind === "awaiting_human") {
    return {
      kind: "awaiting_human",
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      detail: nextRole.detail,
    };
  }
  if (nextRole.kind === "no_progress") {
    return {
      kind: "awaiting_human",
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      detail: nextRole.detail,
    };
  }
  const { agentProfileId, agentRoleInSession } = nextRole;

  // Manifest — milestone body + spec doc (when present).
  const drafts: ManifestEntryDraft[] = [
    {
      object_kind: "milestone",
      object_id: milestone.milestone_id,
      fetch_scope: "body",
      required: true,
      purpose: "primary input",
    },
  ];
  if (milestone.spec_revision_pin != null) {
    drafts.push({
      object_kind: "spec_doc",
      object_id: milestone.milestone_id,
      fetch_scope: "body",
      required: false,
      purpose: "spec carry-over",
    });
  }
  const pinResolver = new OuterPinResolver(milestone);
  const manifestBuilder = new ManifestBuilder(pinResolver, deps.clock);
  const manifest = await manifestBuilder.build({
    session_id: session.session_id,
    turn_index: turnIndex,
    purpose: manifestPurposeFor(phase),
    target: { object_kind: "milestone", object_id: milestone.milestone_id },
    drafts,
  });
  await deps.store.writeAtomic(
    layout.manifest(manifest.manifest_id),
    JSON.stringify(manifest, null, 2),
  );

  const agentOut = await callAgent(
    {
      agentProfileId,
      agentRoleInSession,
      parentLoop: "outer",
      phaseOrPurpose: phase,
      sessionId: session.session_id,
      turnIndex,
      manifest,
      workspaceRevisionPin: session.workspace_revision_pin,
      agentCwd: deps.agentCwd ?? process.cwd(),
      timeoutSec: deps.agentTimeoutSec ?? 120,
      idempotency: {
        scope: "per_turn",
        parts: {
          session_id: session.session_id,
          turn_index: turnIndex,
          agent_profile_id: agentProfileId,
          manifest_id: manifest.manifest_id,
          input_revision_pins: manifest.entries.map((e) => e.revision_pin),
        },
      },
      runtimeMetadata: { milestone_id: milestone.milestone_id, phase },
    },
    { llmRunner: deps.llmRunner, manifestBuilder },
  );

  if (!agentOut.ok) {
    await emitInvalidOuterTurn(
      deps,
      session,
      turnIndex,
      milestone,
      phase,
      manifest.manifest_id,
      manifest.entries.map((e) => e.revision_pin),
      agentOut.stage,
      agentOut.reason,
      agentOut.detail,
      agentProfileId,
    );
    return {
      kind: "invalid_envelope",
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      stage: agentOut.stage,
      reason: agentOut.reason,
      detail: agentOut.detail,
    };
  }

  const callerRoutingDecision = decideRouting(agentOut.envelope);
  const { session: sessionAfterTurn } = await persistSessionTurn(
    {
      session,
      envelope: agentOut.envelope,
      callerRoutingDecision,
      workspaceCommit: null,
      verificationRunId: null,
      newWorkspaceRevisionPin: null,
    },
    { store: deps.store, clock: deps.clock },
  );

  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: session.session_id,
    object_kind: "session_turn",
    from_state: null,
    to_state: `turn_index=${turnIndex}`,
    loop_kind: "outer",
    phase,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: session.session_id,
    turn_index: turnIndex,
    slot_kind: null,
    agent_profile_id: agentProfileId,
    contribution_kind: agentOut.envelope.contribution_kind,
    action_kind: "session_progress",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: manifest.manifest_id,
    input_revision_pins: manifest.entries.map((e) => e.revision_pin),
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: agentOut.envelope.idempotency_key,
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  // Re-load turns for termination evaluation. Validation's `evidence_only`
  // rule requires a `verification_green` evidence record — we synthesize
  // one from the lead's milestone_package verdict (PASS → pass) so the
  // pure-function evaluator can decide without a dedicated scout LLM
  // invocation (deferred to 5c).
  const allTurns = await loadOuterTurnSummaries(
    sessionAfterTurn.session_id,
    sessionAfterTurn.current_turn_index,
    phase,
    deps,
  );
  const decision = evaluateTermination({
    termination: sessionAfterTurn.session_termination,
    turns: allTurns,
    max_turns: sessionAfterTurn.max_turns,
  });

  if (!decision.converged) {
    return {
      kind: "turn_persisted",
      sessionId: sessionAfterTurn.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      decision,
      dispatch: null,
    };
  }

  // Convergence may be triggered by a reviewer's verdict — but the
  // dispatch artefacts (spec body, slice DAG, ContextSummary) live on the
  // lead's envelope. Resolve the most recent lead envelope, falling back
  // to the just-persisted envelope when this turn was itself the lead's.
  const leadEnv =
    agentRoleInSession === "lead"
      ? agentOut.envelope
      : (await lastLeadEnvelope(
          sessionAfterTurn,
          await loadOuterTurns(
            sessionAfterTurn,
            sessionAfterTurn.current_turn_index,
            deps.store,
          ),
          deps.store,
        )) ?? agentOut.envelope;

  return finalizeConvergedSession(
    sessionAfterTurn,
    milestone,
    phase,
    decision,
    leadEnv,
    turnIndex,
    deps,
  );
}

async function finalizeConvergedSession(
  session: DialogueSessionT,
  milestone: MilestoneT,
  phase: OuterPhase,
  decision: TerminationDecision & { converged: true },
  leadEnvelope: Envelope | null,
  turnIndex: number,
  deps: OuterTurnDeps,
): Promise<RunOneOuterTurnOutcome> {
  if (leadEnvelope == null) {
    // No lead envelope to extract dispatch artefacts from — surface as a
    // dispatch_no_match so the operator can investigate. Convergence
    // without a lead turn should never happen in practice.
    return {
      kind: "dispatch_no_match",
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      detail: "convergence reached but no lead envelope available for dispatch",
    };
  }
  const dispatchInput: OuterDispatchInput = buildDispatchInput(
    decision,
    session,
    milestone,
    phase,
    leadEnvelope,
  );
  const dispatch = await dispatchOuterOutcome(dispatchInput, {
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    callerId: deps.callerId,
    targetId: deps.targetId,
  });

  if (dispatch.kind === "no_match") {
    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: session.session_id,
      object_kind: "dialogue_session",
      from_state: "SESSION_OPEN",
      to_state: "SESSION_OPEN",
      loop_kind: "outer",
      phase,
      slice_id: null,
      slice_kind: null,
      dod_revision: null,
      session_id: session.session_id,
      turn_index: turnIndex,
      slot_kind: null,
      agent_profile_id: leadEnvelope.agent_profile_id,
      contribution_kind: null,
      action_kind: "session_finalize",
      final_verdict: decision.final_verdict,
      caller_id: deps.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: idempotencyKey({
        scope: "external_observation",
        parts: {
          kind: "outer_dispatch_no_match",
          session_id: session.session_id,
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
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      detail: dispatch.detail,
    };
  }

  // Persist the canonical final_verdict — Validation translates raw
  // PASS/FAIL/STALE into the SOC-OPERATIONS enum (validation_pass etc.).
  const persistedVerdict = normalizeFinalVerdict(phase, decision.final_verdict);
  const finalized = DialogueSession.parse({
    ...session,
    state: "CONVERGED",
    final_verdict: persistedVerdict,
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
    loop_kind: "outer",
    phase,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: finalized.session_id,
    turn_index: turnIndex,
    slot_kind: null,
    agent_profile_id: leadEnvelope.agent_profile_id,
    contribution_kind: null,
    action_kind: "session_finalize",
    final_verdict: decision.final_verdict,
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
        final_verdict: decision.final_verdict,
        finalization_decision: decision.finalization_decision,
        workspace_revision_pin_at_convergence:
          finalized.workspace_revision_pin,
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
    milestoneId: milestone.milestone_id,
    phase,
    decision,
    dispatch,
  };
}

async function lastLeadEnvelope(
  session: DialogueSessionT,
  priorTurns: readonly PersistedTurnLike[],
  store: StorePort,
): Promise<Envelope | null> {
  for (let i = priorTurns.length - 1; i >= 0; i--) {
    if (priorTurns[i]!.agent_role_in_session !== "lead") continue;
    const body = await store.readText(
      layout.sessionTurn(session.session_id, i),
    );
    if (body == null) continue;
    try {
      const parsed = JSON.parse(body) as {
        output_envelope?: Envelope;
      };
      if (parsed.output_envelope != null) return parsed.output_envelope;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------- helpers

function manifestPurposeFor(
  phase: OuterPhase,
): "design" | "planning_decompose" | "validation" {
  switch (phase) {
    case "Discovery":
    case "Specification":
      return "design";
    case "Planning":
      return "planning_decompose";
    case "Validation":
      return "validation";
  }
}

class OuterPinResolver implements RevisionPinResolver {
  constructor(private readonly milestone: MilestoneT) {}
  async resolve(entry: ManifestEntryDraft): Promise<string> {
    if (entry.object_kind === "milestone") {
      return this.milestone.updated_at;
    }
    if (entry.object_kind === "spec_doc") {
      return this.milestone.spec_revision_pin ?? this.milestone.updated_at;
    }
    return this.milestone.updated_at;
  }
}

function decideRouting(envelope: Envelope): CallerRoutingDecision {
  const nar = envelope.next_action_request;
  if (nar == null) {
    return {
      decision: "dropped",
      decision_reason: "outer turn has no next_action_request to route",
      resolved_addressed_to: null,
    };
  }
  return {
    decision: "accepted",
    decision_reason: `accepted next_action_request from ${envelope.agent_profile_id}`,
    resolved_addressed_to:
      typeof nar.addressed_to === "string" ? nar.addressed_to : null,
  };
}

interface PersistedTurnLike {
  agent_profile_id: string;
  agent_role_in_session: TurnSummary["agent_role_in_session"];
  verdict: TurnSummary["verdict"];
}

async function loadOuterTurns(
  session: DialogueSessionT,
  upToTurnIndexExclusive: number,
  store: StorePort,
): Promise<PersistedTurnLike[]> {
  const out: PersistedTurnLike[] = [];
  for (let i = 0; i < upToTurnIndexExclusive; i++) {
    const body = await store.readText(
      layout.sessionTurn(session.session_id, i),
    );
    if (body == null) continue;
    let parsed: {
      output_envelope?: {
        agent_profile_id?: string;
        agent_role_in_session?: TurnSummary["agent_role_in_session"];
        verdict?: TurnSummary["verdict"];
      };
      agent_profile_id?: string;
    };
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const env = parsed.output_envelope ?? {};
    out.push({
      agent_profile_id: env.agent_profile_id ?? parsed.agent_profile_id ?? "",
      agent_role_in_session: env.agent_role_in_session ?? "lead",
      verdict: env.verdict ?? null,
    });
  }
  return out;
}

/**
 * Decide which (agent_profile_id, role) acts on the next turn. Skips the
 * `human` participant — humans contribute via the signal binding pipeline,
 * not via the LLM runner. Skips `observer` participants (5b.3 punts on
 * scout); they re-enter in 5c.
 */
type NextRole =
  | { kind: "agent"; agentProfileId: LlmAgentProfileId; agentRoleInSession: AgentRole }
  | { kind: "awaiting_human"; detail: string }
  | { kind: "no_progress"; detail: string };

function pickNextRole(
  participants: readonly Participant[],
  priorTurns: readonly PersistedTurnLike[],
  phase: OuterPhase,
  termination: DialogueSessionT["session_termination"],
): NextRole {
  const lead = participants.find((p) => p.role === "lead");
  if (lead == null || lead.agent_profile_id === "human") {
    return { kind: "no_progress", detail: "no non-human lead participant" };
  }
  // Validation: lead-only orchestration in 5b.3.
  if (phase === "Validation") {
    if (priorTurns.length === 0) {
      return asAgent(lead.agent_profile_id, "lead");
    }
    return {
      kind: "no_progress",
      detail: "Validation lead already produced its envelope; awaiting evidence aggregation",
    };
  }

  if (priorTurns.length === 0) {
    return asAgent(lead.agent_profile_id, "lead");
  }
  const last = priorTurns[priorTurns.length - 1]!;
  // Lead just spoke → next reviewer who hasn't voted in the current round.
  if (last.agent_role_in_session === "lead") {
    const reviewer = nextReviewer(participants, priorTurns);
    if (reviewer != null) return reviewer;
    // No non-human reviewer remains. For quorum_then_lead the lead is
    // expected to issue a final verdict once quorum is met — re-engage if
    // the lead's prior turn did not carry one (lead drafts have verdict=null).
    if (
      termination.finalization_rule === "quorum_then_lead" &&
      last.verdict == null &&
      reviewerApprovals(participants, priorTurns) >=
        (termination.quorum_min_approvals ?? 1)
    ) {
      return asAgent(lead.agent_profile_id, "lead");
    }
    return {
      kind: "awaiting_human",
      detail: "all non-human reviewers voted; awaiting human signal",
    };
  }
  // Reviewer just spoke.
  if (last.verdict?.result === "request_changes") {
    return asAgent(lead.agent_profile_id, "lead");
  }
  // For quorum_then_lead, after reviewers vote the lead reissues with a
  // final verdict once quorum is met.
  if (
    termination.finalization_rule === "quorum_then_lead" &&
    reviewerApprovals(participants, priorTurns) >=
      (termination.quorum_min_approvals ?? 1) &&
    !leadGaveVerdictInCurrentRound(priorTurns)
  ) {
    return asAgent(lead.agent_profile_id, "lead");
  }
  // For quorum_then_lead with a non-approve reviewer verdict (spec_reject /
  // reject), the lead also issues the final verdict to record the rejection.
  if (
    termination.finalization_rule === "quorum_then_lead" &&
    !leadGaveVerdictInCurrentRound(priorTurns) &&
    !canAnyMoreReviewerVote(participants, priorTurns)
  ) {
    return asAgent(lead.agent_profile_id, "lead");
  }
  // continue through remaining reviewers.
  const reviewer = nextReviewer(participants, priorTurns);
  if (reviewer != null) return reviewer;
  return {
    kind: "awaiting_human",
    detail: "all non-human reviewers voted; awaiting human signal or convergence",
  };
}

function reviewerApprovals(
  _participants: readonly Participant[],
  priorTurns: readonly PersistedTurnLike[],
): number {
  let count = 0;
  for (let i = priorTurns.length - 1; i >= 0; i--) {
    const t = priorTurns[i]!;
    if (t.agent_role_in_session === "lead") break;
    if (
      t.agent_role_in_session === "reviewer" &&
      (t.verdict?.result === "approve" ||
        t.verdict?.result === "spec_accept" ||
        t.verdict?.result === "plan_accept")
    ) {
      count++;
    }
  }
  return count;
}

function leadGaveVerdictInCurrentRound(
  priorTurns: readonly PersistedTurnLike[],
): boolean {
  // Walk back to the most recent lead turn; if that turn has a verdict,
  // the lead already issued the final decision for this round.
  for (let i = priorTurns.length - 1; i >= 0; i--) {
    const t = priorTurns[i]!;
    if (t.agent_role_in_session === "lead") {
      return t.verdict != null;
    }
  }
  return false;
}

function canAnyMoreReviewerVote(
  participants: readonly Participant[],
  priorTurns: readonly PersistedTurnLike[],
): boolean {
  const r = nextReviewer(participants, priorTurns);
  return r != null;
}

function asAgent(profile: string, role: AgentRole): NextRole {
  if (profile === "human") {
    return { kind: "awaiting_human", detail: `participant=${profile}` };
  }
  if (
    profile !== "atlas" &&
    profile !== "forge" &&
    profile !== "sentinel" &&
    profile !== "scout"
  ) {
    return { kind: "no_progress", detail: `unknown agent profile ${profile}` };
  }
  return { kind: "agent", agentProfileId: profile, agentRoleInSession: role };
}

/**
 * Pick the first reviewer (in declaration order) who has not yet submitted
 * a verdict in the current "round". A round resets each time the lead
 * speaks, since lead drafts re-engage the reviewers.
 */
function nextReviewer(
  participants: readonly Participant[],
  priorTurns: readonly PersistedTurnLike[],
): NextRole | null {
  // Find the index of the most recent lead turn — reviewers AFTER that
  // index are the current round.
  let lastLeadIdx = -1;
  for (let i = priorTurns.length - 1; i >= 0; i--) {
    if (priorTurns[i]!.agent_role_in_session === "lead") {
      lastLeadIdx = i;
      break;
    }
  }
  const currentRound = priorTurns.slice(lastLeadIdx + 1);
  const votedProfiles = new Set(
    currentRound
      .filter((t) => t.agent_role_in_session === "reviewer")
      .map((t) => t.agent_profile_id),
  );
  for (const p of participants) {
    if (p.role !== "reviewer") continue;
    if (p.agent_profile_id === "human") continue;
    if (votedProfiles.has(p.agent_profile_id)) continue;
    const v = asAgent(p.agent_profile_id, "reviewer");
    if (v.kind === "agent") return v;
  }
  return null;
}

/**
 * Build the TurnSummary[] termination-evaluator consumes. For Validation
 * we synthesize a `verification_green` VerificationRun from the lead's
 * milestone_package verdict so `evidence_only` can decide without a real
 * scout aggregation pass (deferred to 5c).
 */
async function loadOuterTurnSummaries(
  sessionId: string,
  upToTurnIndexExclusive: number,
  phase: OuterPhase,
  deps: Pick<OuterTurnDeps, "store" | "clock" | "targetId">,
): Promise<TurnSummary[]> {
  const summaries: TurnSummary[] = [];
  for (let i = 0; i < upToTurnIndexExclusive; i++) {
    const body = await deps.store.readText(layout.sessionTurn(sessionId, i));
    if (body == null) continue;
    let parsed: {
      output_envelope?: {
        agent_role_in_session?: TurnSummary["agent_role_in_session"];
        verdict?: TurnSummary["verdict"];
        output_kind?: string;
      };
    };
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const env = parsed.output_envelope ?? {};
    summaries.push({
      agent_role_in_session: env.agent_role_in_session ?? "lead",
      verdict: env.verdict ?? null,
      verification: null,
    });
  }
  if (phase === "Validation" && summaries.length > 0) {
    // Synthesize a verification_green record from the latest lead's
    // milestone_package verdict. PASS → pass; FAIL/STALE → fail.
    const lastLead = lastBy(summaries, (t) => t.agent_role_in_session === "lead");
    if (lastLead?.verdict?.result != null) {
      const result =
        lastLead.verdict.result === "PASS" ? "pass" : "fail";
      const synthetic: VerificationRun = {
        verification_run_id: newMonotonicId(deps.clock.now()),
        target_id: deps.targetId,
        target_revision: "outer-validation",
        commands_or_checks: ["outer.validation.aggregate"],
        environment_fingerprint: "outer-aggregate",
        started_at: deps.clock.isoNow(),
        finished_at: deps.clock.isoNow(),
        result,
        failed_tests: [],
        log_ref: null,
      };
      // attach to the last summary entry (corresponding to the lead turn).
      const idx = summaries.length - 1;
      summaries[idx] = { ...summaries[idx]!, verification: synthetic };
    }
  }
  return summaries;
}

function lastBy<T>(arr: readonly T[], pred: (t: T) => boolean): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]!;
    if (pred(v)) return v;
  }
  return null;
}

/**
 * Translate (decision, lead envelope) into the OuterDispatchInput shape.
 * Lead drafts carry the actionable artefacts (spec body, slice DAG, slice
 * IDs to revert, ContextSummary inputs) in `envelope.artifacts`. We extract
 * them defensively — missing fields surface as dispatch errors downstream
 * rather than silently dropping side-effects.
 */
function buildDispatchInput(
  decision: TerminationDecision & { converged: true },
  session: DialogueSessionT,
  milestone: MilestoneT,
  phase: OuterPhase,
  leadEnvelope: Envelope,
): OuterDispatchInput {
  const artifacts = (leadEnvelope.artifacts ?? {}) as Record<string, unknown>;
  // Validation finalization rule (`lead_only`) propagates the raw verdict
  // result (`PASS` / `FAIL` / `STALE`) as the session's final_verdict, but
  // the dispatch matrix keys on the SOC-OPERATIONS verdict labels
  // (`validation_pass` / `validation_fail` / `validation_stale`). Translate
  // here so the dispatch lookup matches.
  const normalized = normalizeFinalVerdict(phase, decision.final_verdict);
  const base: OuterDispatchInput = {
    parent_loop: "outer",
    phase_or_purpose: phase,
    session_state: "CONVERGED",
    final_verdict: normalized,
    milestone,
    sessionId: session.session_id,
  };
  switch (phase) {
    case "Discovery":
    case "Specification": {
      const body = readString(artifacts, "spec_proposal_body");
      return body == null ? base : { ...base, specProposalBody: body };
    }
    case "Planning": {
      const slices = parseSlices(artifacts, milestone.milestone_id);
      return slices.length > 0 ? { ...base, slicesToPersist: slices } : base;
    }
    case "Validation": {
      if (normalized === "validation_pass") {
        const summary = parseContextSummary(artifacts, milestone.milestone_id);
        return summary != null
          ? { ...base, contextSummaryInput: summary }
          : base;
      }
      if (normalized === "validation_fail") {
        const ids = parseStringArray(artifacts, "responsible_slice_ids");
        return ids.length > 0 ? { ...base, responsibleSliceIds: ids } : base;
      }
      return base;
    }
  }
}

function normalizeFinalVerdict(phase: OuterPhase, raw: string): string {
  if (phase !== "Validation") return raw;
  switch (raw) {
    case "PASS":
      return "validation_pass";
    case "FAIL":
      return "validation_fail";
    case "STALE":
      return "validation_stale";
    default:
      return raw;
  }
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseStringArray(
  rec: Record<string, unknown>,
  key: string,
): string[] {
  const v = rec[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function parseSlices(
  artifacts: Record<string, unknown>,
  milestoneId: string,
): SliceT[] {
  const raw = artifacts.slices;
  if (!Array.isArray(raw)) return [];
  const out: SliceT[] = [];
  for (const r of raw) {
    if (r == null || typeof r !== "object") continue;
    try {
      const obj = r as Record<string, unknown>;
      out.push(
        Slice.parse({
          ...obj,
          // milestone_id is overridden by dispatch but Slice.parse needs it
          // present.
          milestone_id: (obj.milestone_id as string | undefined) ?? milestoneId,
          state: (obj.state as string | undefined) ?? "SLICE_PENDING",
        }),
      );
    } catch {
      // Skip malformed entries — caller-dispatch-outer will reject if the
      // resulting list is empty / invalid.
    }
  }
  return out;
}

function parseContextSummary(
  artifacts: Record<string, unknown>,
  milestoneId: string,
): {
  milestone_id: string;
  user_value: string;
  behavior_changes?: string[];
  decisions_to_preserve?: string[];
  risks?: string[];
  architectural_debt_indicators?: string[];
} | null {
  const summary = artifacts.context_summary;
  if (summary == null || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  const userValue = readString(s, "user_value");
  if (userValue == null) return null;
  return {
    milestone_id: milestoneId,
    user_value: userValue,
    behavior_changes: parseStringArray(s, "behavior_changes"),
    decisions_to_preserve: parseStringArray(s, "decisions_to_preserve"),
    risks: parseStringArray(s, "risks"),
    architectural_debt_indicators: parseStringArray(
      s,
      "architectural_debt_indicators",
    ),
  };
}

async function emitInvalidOuterTurn(
  deps: Pick<OuterTurnDeps, "ledger" | "clock" | "callerId" | "targetId">,
  session: DialogueSessionT,
  turnIndex: number,
  milestone: MilestoneT,
  phase: OuterPhase,
  manifestId: string,
  inputPins: string[],
  stage: string,
  reason: string,
  detail: string,
  agentProfileId: LlmAgentProfileId,
): Promise<void> {
  const turnIdempotencyKey = idempotencyKey({
    scope: "per_turn",
    parts: {
      session_id: session.session_id,
      turn_index: turnIndex,
      agent_profile_id: agentProfileId,
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
    loop_kind: "outer",
    phase,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: session.session_id,
    turn_index: turnIndex,
    slot_kind: null,
    agent_profile_id: agentProfileId,
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
    result_detail: `${stage}/${reason}: ${detail.slice(0, 200)} (milestone=${milestone.milestone_id})`,
    timestamp: deps.clock.isoNow(),
  });
}
