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
 *      `evidence_only` rule pulls the scout-aggregated VerificationRun
 *      (phase 5c — `scout-observer.aggregateValidationEvidence`) so the
 *      gate decides on real cross-slice evidence rather than a fabricated
 *      stand-in. The FAIL/STALE bypass below preserves the lead-verdict
 *      authority for explicit FAIL/STALE outcomes.
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
import { createHash } from "node:crypto";
import { newMonotonicId } from "../domain/ids.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
  type Participant,
} from "../domain/schema/dialogue-session.js";
import type { Envelope } from "../domain/schema/envelope.js";
import { Milestone, type Milestone as MilestoneT } from "../domain/schema/milestone.js";
import type { CallerRoutingDecision } from "../domain/schema/session-turn.js";
import type { ClockPort } from "../ports/clock.js";
import type { LlmRunnerPort } from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import { callAgent } from "./agent-io.js";
import {
  classifyAgentIoStageFailure,
  countPromptComposeFailuresFromLedger,
  evaluateRetry,
} from "./failure-policy.js";
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
import {
  aggregateValidationEvidence,
  type AcTraceabilityRow,
  type ScoutEvidenceResult,
} from "./scout-observer.js";
import { loadLatestSliceTelemetry } from "./slice-telemetry.js";
import type { SliceTelemetry as SliceTelemetryT } from "../domain/schema/knowledge.js";

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

  // P0-1 fix (PR #69 review): AWAITING_HUMAN gate. If the milestone is
  // parked at M_*_AWAITING_HUMAN and there is no live SESSION_OPEN session
  // to resume, do NOT open a new session and do NOT call the lead LLM —
  // return `awaiting_human` so the caller defers until the human signal
  // binding (5b.2) appends the synthetic SessionTurn that will resume
  // evaluation on a subsequent runOneOuterTurn cycle.
  if (
    ready.existingSession == null &&
    (milestone.state === "M_DISCOVERY_AWAITING_HUMAN" ||
      milestone.state === "M_SPECIFICATION_AWAITING_HUMAN")
  ) {
    return {
      kind: "awaiting_human",
      sessionId: "",
      milestoneId: milestone.milestone_id,
      phase,
      detail: `milestone parked in ${milestone.state}; awaiting human signal`,
    };
  }

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
  const { summaries: preSummaries, evidence: preEvidence } =
    await loadOuterTurnSummaries(
      session.session_id,
      turnIndex,
      phase,
      deps,
      milestone.milestone_id,
    );
  let preDecision = evaluateTermination({
    termination: session.session_termination,
    turns: preSummaries,
    max_turns: session.max_turns,
    participants: session.participants,
  });
  // P0-4 fix (PR #69 review): Validation FAIL/STALE bypass (pre-eval). See
  // the post-turn branch below for rationale.
  //
  // Phase 8c (KAC-TRACEABILITY): when lead emitted PASS but scout AC-level
  // aggregation derives FAIL (any AC row status=FAIL — slice failed OR
  // partial AC mapping), force convergence on FAIL so the dispatch
  // matrix's `validation_fail` row runs. This is plan §G2-2 검증: a
  // fixture where only some ACs of a slice are PASS converges to FAIL.
  if (
    phase === "Validation" &&
    !preDecision.converged &&
    preDecision.reason === "continue"
  ) {
    const leadVerdict = lastLeadVerdict(preSummaries);
    if (leadVerdict === "FAIL" || leadVerdict === "STALE") {
      preDecision = {
        converged: true,
        final_verdict: leadVerdict,
        finalization_decision: "finalization_rule",
      };
    } else if (
      leadVerdict === "PASS" &&
      preEvidence?.derivedVerdict === "FAIL"
    ) {
      preDecision = {
        converged: true,
        final_verdict: "FAIL",
        finalization_decision: "required_evidence",
      };
    }
  }
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
      preEvidence,
    );
  }
  // P0-5 fix (PR #69 review): pre-evaluation TIMEOUT/ABANDONED also routes
  // through the dispatch matrix.
  if (
    !preDecision.converged &&
    (preDecision.reason === "timeout" || preDecision.reason === "abandoned")
  ) {
    const leadEnv = await lastLeadEnvelope(session, priorTurns, deps.store);
    return finalizeNonConvergedSession(
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

  // Manifest — milestone body + spec doc (when present) + prior session
  // turn summaries.
  //
  // PR #69 P1-3 fix: prior SessionTurn entries (in particular the most
  // recent reviewer `request_changes` rationale) must reach the lead so it
  // can address them in the next draft. Reference each prior turn's
  // session_turn artefact with a `prior turn rationale` purpose; the
  // outer pin resolver pins them to the persisted turn body so any drift
  // (turn body rewritten) trips the stale-pins gate.
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
  for (let i = 0; i < priorTurns.length; i++) {
    const t = priorTurns[i]!;
    const rcSuffix =
      t.verdict?.result === "request_changes" ? " (request_changes)" : "";
    drafts.push({
      object_kind: "session_turn",
      // incident-5: object_id is the session id; the per-entry `turn_index`
      // distinguishes which `sessions/<id>/turns/<n>.json` the resolver
      // reads. Prior to incident-5 this was encoded as
      // `${session_id}#${i}` and parsed by OuterPinResolver — replaced by
      // the schema-level field so resolveManifestEntries can also locate
      // the turn file.
      object_id: session.session_id,
      turn_index: i,
      fetch_scope: "body",
      required: false,
      purpose: `prior turn ${i} (${t.agent_role_in_session})${rcSuffix}`,
    });
  }
  // KAC-SLICE-TELEMETRY (phase 8b) — Discovery N+1 / Specification N+1
  // manifests inject the live SliceTelemetry from the active Delivery N
  // milestone in the same target (read-only). The pin records the
  // telemetry's audit_hash so RGC-CROSS-SLOT-STALE can detect drift.
  const deliveryTelemetry =
    phase === "Discovery" || phase === "Specification"
      ? await loadDeliveryTelemetryForInject(milestone, deps.store)
      : null;
  if (deliveryTelemetry != null) {
    drafts.push({
      object_kind: "slice_telemetry",
      object_id: deliveryTelemetry.telemetry.telemetry_id,
      fetch_scope: "body",
      required: false,
      purpose: `Delivery N=${deliveryTelemetry.deliveryMilestoneId} live slice telemetry (read-only)`,
    });
  }
  const pinResolver = new OuterPinResolver(
    milestone,
    session.session_id,
    deps.store,
    deliveryTelemetry?.telemetry ?? null,
    deliveryTelemetry?.deliveryMilestoneId ?? null,
  );
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
    { llmRunner: deps.llmRunner, manifestBuilder, store: deps.store },
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
    // PR #95 review P0-1: incident-3 retry cap wiring. When the failure was
    // at the `prompt_compose` stage (e.g. `context_budget_truncation`), the
    // LLM was never invoked, so no agent-side streak (no_progress /
    // regression / scope_violation) advances. Without an escalation hook the
    // daemon would re-pick this milestone every tick and burn CPU on the
    // same compose failure. Count prior `prompt_compose/...` invalid rows
    // for this session in the ledger; if `evaluateRetry` says escalate,
    // mark the session ABANDONED via the existing TIMEOUT/ABANDONED finalize
    // path so it stops being picked. `abandoned_reason="no_progress"` is
    // the closest permitted enum value (`AbandonedReason` does not include
    // a `prompt_compose_truncation` bucket — semantics: no progress is
    // achievable while the prompt cannot be composed).
    const classification = classifyAgentIoStageFailure(agentOut);
    if (classification != null) {
      const totalFailures = await countPromptComposeFailuresFromLedger(
        deps.store,
        session.session_id,
      );
      const decision = evaluateRetry(classification, totalFailures - 1);
      if (decision.decision === "escalate") {
        return finalizeNonConvergedSession(
          session,
          milestone,
          phase,
          {
            converged: false,
            reason: "abandoned",
            abandoned_reason: "no_progress",
          },
          null,
          turnIndex,
          deps,
        );
      }
    }
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

  // PR #69 P1-1 fix: stale pin gate. Mirror the inner turn-worker check —
  // if any manifest entry's recorded revision_pin no longer matches the
  // live object, refuse to persist or dispatch this turn so a stale-context
  // outcome cannot promote the milestone or persist a slice DAG.
  if (agentOut.stalePins.length > 0) {
    await emitInvalidOuterTurn(
      deps,
      session,
      turnIndex,
      milestone,
      phase,
      manifest.manifest_id,
      manifest.entries.map((e) => e.revision_pin),
      "matrix_validate",
      "missing_revision_pins",
      `stale_pins: ${agentOut.stalePins.map((p) => p.object_id).join(",")}`,
      agentProfileId,
    );
    return {
      kind: "invalid_envelope",
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      stage: "matrix_validate",
      reason: "missing_revision_pins",
      detail: `stale_pins: ${agentOut.stalePins.map((p) => p.object_id).join(",")}`,
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
  const { summaries: allTurns, evidence: postEvidence } =
    await loadOuterTurnSummaries(
      sessionAfterTurn.session_id,
      sessionAfterTurn.current_turn_index,
      phase,
      deps,
      milestone.milestone_id,
    );
  let decision = evaluateTermination({
    termination: sessionAfterTurn.session_termination,
    turns: allTurns,
    max_turns: sessionAfterTurn.max_turns,
    participants: sessionAfterTurn.participants,
  });

  // P0-4 fix (PR #69 review): Validation FAIL/STALE bypass.
  //
  // Validation uses `evidence_only` + `verification_green`. The synthetic
  // verification record we attach to the lead turn is `pass` for PASS but
  // `fail` for FAIL/STALE — which means the pure evaluator never converges
  // on FAIL/STALE, leaving the session stuck (lead already produced its
  // envelope, no further reviewers to vote). The dispatch matrix expects
  // explicit `validation_fail` / `validation_stale` rows to run.
  //
  // Force convergence on the lead's explicit FAIL/STALE verdict; the
  // dispatch matrix takes over from there. PASS continues through the
  // existing evidence path so the verification_green check stays meaningful.
  if (phase === "Validation" && !decision.converged && decision.reason === "continue") {
    const leadVerdict = lastLeadVerdict(allTurns);
    if (leadVerdict === "FAIL" || leadVerdict === "STALE") {
      decision = {
        converged: true,
        final_verdict: leadVerdict,
        finalization_decision: "finalization_rule",
      };
    } else if (
      // Phase 8c (KAC-TRACEABILITY): post-turn AC-level downgrade. See
      // the pre-eval branch above for rationale — kept symmetric so a
      // session that converges in either window honours scout's AC
      // aggregation FAIL.
      leadVerdict === "PASS" &&
      postEvidence?.derivedVerdict === "FAIL"
    ) {
      decision = {
        converged: true,
        final_verdict: "FAIL",
        finalization_decision: "required_evidence",
      };
    }
  }

  if (!decision.converged) {
    // P0-5 fix (PR #69 review): TIMEOUT/ABANDONED also need dispatch so the
    // outer DISPATCH_MATRIX rows for those session states (e.g. Validation
    // TIMEOUT → escalate_milestone) actually run. Drive them through the
    // same finalize path with the latest lead envelope (or the just-
    // persisted envelope when this turn was the lead's). `continue` keeps
    // the session open as before.
    if (decision.reason === "timeout" || decision.reason === "abandoned") {
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
      return finalizeNonConvergedSession(
        sessionAfterTurn,
        milestone,
        phase,
        decision,
        leadEnv,
        turnIndex,
        deps,
      );
    }
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
    postEvidence,
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
  cachedEvidence: ScoutEvidenceResult | null,
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
  const dispatchInput: OuterDispatchInput = await buildDispatchInput(
    decision,
    session,
    milestone,
    phase,
    leadEnvelope,
    deps,
    cachedEvidence,
  );
  const dispatch = await dispatchOuterOutcome(dispatchInput, {
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    callerId: deps.callerId,
    targetId: deps.targetId,
  });

  // P0-6 fix (PR #69 review): treat `illegal_transition` the same as
  // `no_match` — milestone side-effects were rejected, so the session must
  // NOT be confirmed to CONVERGED. Both paths emit an error ledger row and
  // surface as `dispatch_no_match` so the operator can re-run / escalate.
  if (dispatch.kind === "no_match" || dispatch.kind === "illegal_transition") {
    const dispatchKind = dispatch.kind;
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
          kind: `outer_dispatch_${dispatchKind}`,
          session_id: session.session_id,
          final_verdict: decision.final_verdict,
        },
      }),
      lease_token: null,
      lease_kind: null,
      result: "error",
      result_detail: `${dispatchKind}: ${dispatch.detail.slice(0, 180)}`,
      timestamp: deps.clock.isoNow(),
    });
    return {
      kind: "dispatch_no_match",
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      detail: `${dispatchKind}: ${dispatch.detail}`,
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

/**
 * P0-5 fix (PR #69 review): TIMEOUT/ABANDONED finalize path.
 *
 * Mirrors `finalizeConvergedSession` but for non-convergence terminal
 * outcomes — the dispatch matrix has explicit rows for outer
 * (TIMEOUT|ABANDONED) per phase (final_verdict=null). Persists session
 * state TIMEOUT or ABANDONED accordingly.
 */
async function finalizeNonConvergedSession(
  session: DialogueSessionT,
  milestone: MilestoneT,
  phase: OuterPhase,
  decision:
    | { converged: false; reason: "timeout" }
    | {
        converged: false;
        reason: "abandoned";
        abandoned_reason: "no_progress" | "regression" | "scope_violation";
      },
  leadEnvelope: Envelope | null,
  turnIndex: number,
  deps: OuterTurnDeps,
): Promise<RunOneOuterTurnOutcome> {
  const sessionState = decision.reason === "timeout" ? "TIMEOUT" : "ABANDONED";
  const dispatchInput: OuterDispatchInput = {
    parent_loop: "outer",
    phase_or_purpose: phase,
    session_state: sessionState,
    final_verdict: null,
    milestone,
    sessionId: session.session_id,
  };
  const dispatch = await dispatchOuterOutcome(dispatchInput, {
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    callerId: deps.callerId,
    targetId: deps.targetId,
  });

  if (dispatch.kind === "no_match" || dispatch.kind === "illegal_transition") {
    return {
      kind: "dispatch_no_match",
      sessionId: session.session_id,
      milestoneId: milestone.milestone_id,
      phase,
      detail: dispatch.detail,
    };
  }

  // Persist the session in TIMEOUT / ABANDONED.
  const finalized = DialogueSession.parse({
    ...session,
    state: sessionState,
    final_verdict: null,
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
    to_state: sessionState,
    loop_kind: "outer",
    phase,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: finalized.session_id,
    turn_index: turnIndex,
    slot_kind: null,
    agent_profile_id: leadEnvelope?.agent_profile_id ?? null,
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
        final_verdict: sessionState,
        finalization_decision:
          decision.reason === "abandoned"
            ? `abandoned:${decision.abandoned_reason}`
            : "timeout",
        workspace_revision_pin_at_convergence: finalized.workspace_revision_pin,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  // Reuse the turn_persisted shape (the session terminated, not converged) —
  // the decision discriminator carries reason=timeout|abandoned.
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
  constructor(
    private readonly milestone: MilestoneT,
    private readonly sessionId: string,
    private readonly store: StorePort,
    private readonly deliveryTelemetry: SliceTelemetryT | null,
    private readonly deliveryMilestoneId: string | null,
  ) {}
  async resolve(entry: ManifestEntryDraft): Promise<string> {
    if (entry.object_kind === "milestone") {
      return this.milestone.updated_at;
    }
    if (entry.object_kind === "spec_doc") {
      return this.milestone.spec_revision_pin ?? this.milestone.updated_at;
    }
    if (entry.object_kind === "session_turn") {
      // PR #69 P1-3: prior turn entries are pinned by the persisted body's
      // hash. Turn bodies are append-only so the hash is stable until/unless
      // the turn is rewritten.
      // PR #96 P0-1: full-body sha256 hex (replaces the previous
      // `len=N:<first 32 chars>` fingerprint, which missed mutations in
      // summary / verdict.rationale / failure / next_action_request when the
      // new body happened to be the same length).
      // incident-5: prefer the schema-level `turn_index`; fall back to
      // legacy `${session_id}#${i}` parsing for any in-flight manifests
      // built before the field was introduced.
      // PR #96 P1-D: when neither the schema field nor the legacy `#` suffix
      // supplies a turn index, surface an explicit "no_turn_index" sentinel
      // pin instead of silently defaulting to turn 0 (which would fingerprint
      // an unrelated turn body and either falsely pass or surface a
      // misleading stale-pin diagnostic).
      let idx: number;
      if (entry.turn_index != null) {
        idx = entry.turn_index;
      } else if (entry.object_id.includes("#")) {
        idx = Number.parseInt(entry.object_id.split("#")[1]!, 10);
      } else {
        return `missing:${entry.object_id}:no_turn_index`;
      }
      const body = await this.store.readText(
        layout.sessionTurn(this.sessionId, idx),
      );
      if (body == null) return `missing:${entry.object_id}#${idx}`;
      return createHash("sha256").update(body).digest("hex");
    }
    if (entry.object_kind === "slice_telemetry") {
      // KAC-SLICE-TELEMETRY (phase 8b): pin = telemetry audit_hash. Drift
      // (Delivery emits a new audit_hash) trips the manifest stale-pin
      // gate AND RGC-CROSS-SLOT-STALE in `cross-slot-stale.ts`.
      //
      // PR #77 P0-2 fix: re-read the live latest telemetry pointer for the
      // pinned Delivery milestone. ManifestBuilder.recheckPins() resolves
      // each entry again after callAgent, so without this live re-read a
      // mid-turn Delivery emit (new audit_hash on the same milestone)
      // would not trip the stale gate — the resolver would keep returning
      // the snapshot's audit_hash. We compare by Delivery milestone_id
      // rather than telemetry_id because the telemetry_id rotates on every
      // emit; the milestone is the stable identity for "Delivery N".
      if (this.deliveryMilestoneId == null) {
        return `missing:${entry.object_id}`;
      }
      const live = await loadLatestSliceTelemetry(
        this.store,
        this.deliveryMilestoneId,
      );
      if (live == null) return `missing:${entry.object_id}`;
      return live.audit_hash;
    }
    return this.milestone.updated_at;
  }
}

/**
 * Resolve the live Delivery N SliceTelemetry to inject into a Discovery /
 * Specification N+1 manifest. Returns null when no Delivery family
 * milestone (M_DELIVERY_BUILDING / VALIDATING / DONE) shares the target
 * OR when the latest such milestone has no SliceTelemetry emitted yet
 * (KAC-SLICE-TELEMETRY allows `telemetry_enrichment_missing=warn`).
 */
async function loadDeliveryTelemetryForInject(
  discoveryMilestone: MilestoneT,
  store: StorePort,
): Promise<{
  telemetry: SliceTelemetryT;
  deliveryMilestoneId: string;
} | null> {
  const deliveryFamily: readonly string[] = [
    "M_DELIVERY_BUILDING",
    "M_DELIVERY_VALIDATING",
    "M_DONE",
  ];
  let names: string[];
  try {
    names = await store.list("milestones");
  } catch {
    return null;
  }
  const candidates: MilestoneT[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`milestones/${name}`);
    if (body == null) continue;
    let m: MilestoneT;
    try {
      m = Milestone.parse(JSON.parse(body));
    } catch {
      continue;
    }
    if (m.target_id !== discoveryMilestone.target_id) continue;
    if (m.milestone_id === discoveryMilestone.milestone_id) continue;
    if (!deliveryFamily.includes(m.state)) continue;
    candidates.push(m);
  }
  if (candidates.length === 0) return null;
  // Most-recently-updated Delivery is "Delivery N" for inject purposes.
  candidates.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const deliveryN = candidates[0]!;
  const telemetry = await loadLatestSliceTelemetry(store, deliveryN.milestone_id);
  if (telemetry == null) return null;
  return { telemetry, deliveryMilestoneId: deliveryN.milestone_id };
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
    // PR #69 P0-3 consequence: when the lead's most recent turn carries an
    // explicit verdict (final ruling for quorum_then_lead), the dialogue
    // is closed for further LLM turns — only a human signal can resolve
    // any remaining roster requirement (e.g. registered human reviewer).
    // Without this guard the next-reviewer search would loop the agent
    // reviewers a second time and run the session to TIMEOUT.
    if (last.verdict != null) {
      return {
        kind: "awaiting_human",
        detail: "lead emitted final verdict; awaiting human signal or convergence",
      };
    }
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
 * we attach the scout aggregate VerificationRun (phase 5c —
 * `aggregateValidationEvidence`) so `evidence_only` decides on real
 * cross-slice evidence. Lead-verdict guard (PR #69 P0-4) is preserved by
 * the FAIL/STALE bypass in runOneOuterTurn — scout aggregation only
 * downgrades a PASS lead verdict to STALE when no slice-level evidence
 * exists (defence in depth against the lead claiming PASS without
 * underlying SLICE_VALIDATED + SliceMerge → VerificationRun coverage).
 *
 * PR #72 P0-1 fix: when scout aggregation runs, return the cached
 * `ScoutEvidenceResult` so the dispatch path (`buildDispatchInput`) can
 * reuse it instead of re-aggregating (which would persist a *second*
 * aggregate VerificationRun and break audit-chain traceability — the VR
 * that decided the gate must be the same VR that ContextSummary points
 * at).
 *
 * PR #72 P1-4 fix: Validation phase requires `milestoneId`. Passing null
 * silently degraded scout aggregation to a no-op, leaving the
 * `evidence_only` gate to decide without evidence. We now throw — the
 * caller must always supply a milestone id when phase=Validation.
 *
 * `milestoneId` remains optional for non-Validation phases (Discovery /
 * Specification / Planning) that do not need evidence aggregation.
 */
async function loadOuterTurnSummaries(
  sessionId: string,
  upToTurnIndexExclusive: number,
  phase: OuterPhase,
  deps: Pick<OuterTurnDeps, "store" | "clock" | "targetId">,
  milestoneId?: string,
): Promise<{ summaries: TurnSummary[]; evidence: ScoutEvidenceResult | null }> {
  const summaries: TurnSummary[] = [];
  for (let i = 0; i < upToTurnIndexExclusive; i++) {
    const body = await deps.store.readText(layout.sessionTurn(sessionId, i));
    if (body == null) continue;
    let parsed: {
      output_envelope?: {
        agent_role_in_session?: TurnSummary["agent_role_in_session"];
        verdict?: TurnSummary["verdict"];
        output_kind?: string;
        agent_profile_id?: string;
      };
      agent_profile_id?: string;
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
      // PR #69 P0-2 / P0-3 fix: surface the participant id so the
      // termination evaluator can require unanimous approval from every
      // registered reviewer (and refuse to converge until a `human`
      // reviewer has voted, when applicable).
      agent_profile_id:
        env.agent_profile_id ?? parsed.agent_profile_id ?? undefined,
    });
  }
  if (phase === "Validation" && milestoneId == null) {
    throw new Error(
      "loadOuterTurnSummaries: Validation phase requires milestoneId",
    );
  }
  let evidence: ScoutEvidenceResult | null = null;
  if (phase === "Validation" && summaries.length > 0 && milestoneId != null) {
    // Phase 5c: scout aggregation. The `verification_green` evidence
    // attached to the lead summary is the real scout-aggregated
    // VerificationRun (not a fabricated stand-in). When the aggregation
    // returns STALE (no SLICE_VALIDATED slices, or any missing
    // SliceMerge → VerificationRun hop), the synthesised VR is `fail` so
    // `evidence_only` keeps the session in `continue` until the underlying
    // slice state catches up — at which point the FAIL/STALE bypass
    // (P0-4) finalizes via the lead's explicit verdict.
    const lastLead = lastBy(summaries, (t) => t.agent_role_in_session === "lead");
    if (lastLead?.verdict?.result != null) {
      evidence = await aggregateValidationEvidence(
        { milestoneId },
        { store: deps.store, clock: deps.clock, targetId: deps.targetId },
      );
      const idx = summaries.length - 1;
      summaries[idx] = { ...summaries[idx]!, verification: evidence.aggregate };
    }
  }
  return { summaries, evidence };
}

function lastLeadVerdict(turns: readonly TurnSummary[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.agent_role_in_session === "lead") {
      return t.verdict?.result ?? null;
    }
  }
  return null;
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
async function buildDispatchInput(
  decision: TerminationDecision & { converged: true },
  session: DialogueSessionT,
  milestone: MilestoneT,
  phase: OuterPhase,
  leadEnvelope: Envelope,
  deps: Pick<OuterTurnDeps, "store" | "clock" | "targetId">,
  cachedEvidence: ScoutEvidenceResult | null,
): Promise<OuterDispatchInput> {
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
        if (summary == null) return base;
        // PR #72 P0-1 fix: reuse the scout aggregation captured during
        // pre/post termination evaluation. Calling
        // `aggregateValidationEvidence` again here would persist a *second*
        // aggregate VerificationRun for the same Validation outcome —
        // breaking audit chain ("which VR decided the gate" no longer
        // matches "which VR ContextSummary points at"). Fall back to a
        // fresh aggregation only if the evaluator path didn't capture one
        // (defensive — should not happen for the PASS path because the
        // lead verdict triggers aggregation).
        const evidence =
          cachedEvidence ??
          (await aggregateValidationEvidence(
            { milestoneId: milestone.milestone_id },
            deps,
          ));
        return {
          ...base,
          contextSummaryInput: {
            ...summary,
            slices: [...evidence.slicesCovered],
          },
        };
      }
      if (normalized === "validation_fail") {
        const fromArtifacts = parseStringArray(artifacts, "responsible_slice_ids");
        // Phase 8c (KAC-TRACEABILITY): when a PASS lead is downgraded to FAIL
        // by scout's AC-level aggregation (`derivedVerdict === "FAIL"`), the
        // lead envelope is itself PASS so it does not carry
        // `responsible_slice_ids`. Without a fallback, `recover_milestone_to_
        // building` would revert only the milestone state and leave the
        // failing slices stuck in SLICE_VALIDATED. Derive responsible slice
        // ids from the cached AcTraceabilityRow set (slices that have at
        // least one FAIL/MISSING AC row) so the dispatch effect can revert
        // them to SLICE_READY for re-work.
        const fromAcTraceability =
          fromArtifacts.length === 0 && cachedEvidence != null
            ? collectAcFailureSliceIds(cachedEvidence.acTraceability)
            : [];
        const ids =
          fromArtifacts.length > 0 ? fromArtifacts : fromAcTraceability;
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

/**
 * Phase 8c (KAC-TRACEABILITY): collect distinct slice ids whose AC-level
 * traceability rows show FAIL or MISSING. Used when a PASS lead envelope
 * is downgraded to validation_fail by scout aggregation — the dispatch
 * matrix's `recover_milestone_to_building` row reverts these slices to
 * SLICE_READY for re-work. Order is preserved (sorted by slice_id from
 * `aggregateAcTraceability`) and duplicates collapsed.
 */
function collectAcFailureSliceIds(
  rows: readonly AcTraceabilityRow[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (r.status === "PASS") continue;
    if (seen.has(r.slice_id)) continue;
    seen.add(r.slice_id);
    out.push(r.slice_id);
  }
  return out;
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
