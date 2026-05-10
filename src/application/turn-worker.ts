import { newMonotonicId } from "../domain/ids.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
} from "../domain/schema/dialogue-session.js";
import {
  SliceMerge,
  type SliceMerge as SliceMergeT,
} from "../domain/schema/slice-merge.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import type { Envelope } from "../domain/schema/envelope.js";
import type { CallerRoutingDecision } from "../domain/schema/session-turn.js";
import type { ClockPort } from "../ports/clock.js";
import type { LeasePort } from "../ports/lease.js";
import type { LlmRunnerPort } from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import type {
  CommandSpec,
  VerificationPort,
} from "../ports/verification.js";
import type { WorkspacePort } from "../ports/workspace.js";
import type { LeaseConfig } from "../config/target-schema.js";
import { callAgent, type AgentIoOutcome } from "./agent-io.js";
import {
  classifyAgentIoStageFailure,
  countPromptComposeFailuresFromLedger,
  evaluateRetry,
} from "./failure-policy.js";
import { idempotencyKey } from "./idempotency.js";
import { assertCanAcquire } from "./lease-acquisition-order.js";
import { withLeaseHeartbeat } from "./lease-heartbeat.js";
import { resolveLeaseTtl } from "./lease-ttl-resolver.js";
import type { LedgerAppender } from "./ledger.js";
import {
  ManifestBuilder,
  type ManifestEntryDraft,
  type RevisionPinResolver,
} from "./manifest-builder.js";
import { layout } from "./persistence-layout.js";
import { pickReadyInnerTurn } from "./ready-object.js";
import { persistSessionTurn } from "./session-turn-persist.js";
import { runInnerVerification } from "./verification-runner.js";

/**
 * Phase 2 turn worker — single-process, single-agent inner cycle.
 *
 * Runs the 6-step pipeline from `pipeline-end-to-end.md` §Turn Worker Cycle:
 *   1. Pickup ready inner turn (forge / tdd_build / internal slice)
 *   2. Lease (turn_index CAS via session-turn-persist)
 *   3. Manifest + Workspace + Prompt
 *   4. Invoke + Validate + Pin Recheck (agent-io) + stale-pin gate
 *   5. SessionTurn Persist
 *   6. Cleanup + Ledger
 *
 * Plus the phase-2 gate: when the turn yields tests_green, this function
 * inlines the caller-dispatch side-effects up to
 * `SLICE_BUILDING → SLICE_REVIEWING + SM_DRAFT → SM_READY_FOR_REVIEW`.
 * The middle review session itself is phase 3.
 *
 * Crash-recovery posture (PR #61 review feedback):
 *   - Every off-happy-path return emits an `invalid` ledger row so audit
 *     trail is never broken by an early return (callAgent failure,
 *     stale-pin gate, etc.).
 *   - Success path persists the slice transition (current_session_id=null +
 *     SLICE_REVIEWING) BEFORE marking the session CONVERGED — otherwise a
 *     mid-sequence crash would leave a CONVERGED session referenced by a
 *     SLICE_BUILDING slice, which `ready-object` cannot recover from.
 *
 * No retry. A failed verification or invalid envelope ends the cycle —
 * the slice stays SLICE_BUILDING for the next pickup, and the operator (or
 * phase-4 failure-policy) decides next steps.
 */

export type TurnWorkerOutcome =
  | { kind: "noop"; detail: string }
  | {
      kind: "converged";
      sessionId: string;
      sliceId: string;
      sliceMergeId: string;
      verificationRunId: string;
      workspaceCommit: string;
    }
  | {
      kind: "verification_failed";
      sessionId: string;
      sliceId: string;
      verificationRunId: string;
      workspaceCommit: string;
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
       * PR #95 review P0-1 (incident-3): the session has hit the
       * `prompt_compose_truncation` retry cap (default 3 prior failures).
       * The runner has flipped the DialogueSession to ABANDONED and
       * appended the session_finalize ledger row, so the daemon stops
       * picking this session.
       */
      kind: "prompt_compose_escalated";
      sessionId: string;
      sliceId: string;
      detail: string;
    }
  | {
      kind: "stale_pins";
      sessionId: string;
      sliceId: string;
      stalePins: { object_id: string; recorded_pin: string }[];
    }
  | {
      /** Another worker holds the slice_lease. */
      kind: "lease_unavailable";
      sliceId: string;
      detail: string;
    };

export interface TurnWorkerCfg {
  callerId: string;
  targetId: string;
  testCommands: (workspacePath: string) => CommandSpec[];
  environmentFingerprint: string;
  workspacePinSourceLabel?: string;
  agentTimeoutSec?: number;
}

export interface TurnWorkerDeps {
  store: StorePort;
  clock: ClockPort;
  llmRunner: LlmRunnerPort;
  workspace: WorkspacePort;
  verification: VerificationPort;
  ledger: LedgerAppender;
  cfg: TurnWorkerCfg;
  /**
   * When provided, the worker claims a `slice_lease` for the duration of
   * the turn so a killed daemon's SLICE_BUILDING orphan is recoverable
   * by `runRecoverySweep` (slice_lease expires → slice → SLICE_READY).
   *
   * Optional so legacy single-shot tests can run without leases. Daemon
   * deployment passes both.
   */
  lease?: LeasePort;
  leaseConfig?: LeaseConfig;
}

export async function runOneInnerTurn(
  deps: TurnWorkerDeps,
): Promise<TurnWorkerOutcome> {
  // Step 1 — Pickup
  const ready = await pickReadyInnerTurn({
    store: deps.store,
    clock: deps.clock,
    ledger: deps.ledger,
    callerId: deps.cfg.callerId,
    targetId: deps.cfg.targetId,
  });
  if (ready == null) {
    return { kind: "noop", detail: "no SLICE_READY/SLICE_BUILDING internal slices" };
  }
  const { slice, session, turnIndex } = ready;

  // PR #63 review wire-up symmetry: claim slice_lease for the duration of
  // the inner turn so a killed turn-worker's SLICE_BUILDING orphan is
  // recoverable by runRecoverySweep (slice_lease expires → SLICE_READY
  // via the new slice_lease handler).
  let leaseClaim:
    | Awaited<ReturnType<NonNullable<typeof deps.lease>["claim"]>>
    | null = null;
  if (deps.lease != null) {
    assertCanAcquire([], "slice_lease");
    const ttl = resolveLeaseTtl({
      leaseKind: "slice_lease",
      leaseConfig: deps.leaseConfig,
      phase: "tdd_build",
      agentProfileId: "forge",
    });
    leaseClaim = await deps.lease.claim({
      leaseKind: "slice_lease",
      objectId: slice.slice_id,
      workerId: deps.cfg.callerId,
      ttlMs: ttl.ttlMs,
      ttlSource: ttl.source,
      targetId: deps.cfg.targetId,
      aux: { kind: "slice_lease", slice_id: slice.slice_id },
    });
    if (leaseClaim.result === "claim_failed") {
      return {
        kind: "lease_unavailable",
        sliceId: slice.slice_id,
        detail: `slice_lease held by ${leaseClaim.existingHolder} (lease_id=${leaseClaim.existingLeaseId})`,
      };
    }
  }
  try {
    // PR #64 review P0-1 fix: heartbeat keeps the slice_lease alive while
    // the long-running callAgent + verification cycle proceeds. Without
    // renewal the recovery sweep would roll the slice back to SLICE_READY
    // mid-turn (TTL default 60s vs callAgent timeout 120s).
    if (leaseClaim != null && leaseClaim.result === "acquired" && deps.lease != null) {
      const claimed = leaseClaim.lease;
      const wrapped = await withLeaseHeartbeat(
        {
          lease: deps.lease,
          leaseId: claimed.lease_id,
          leaseToken: claimed.lease_token,
          ttlMs: claimed.ttl_ms,
        },
        async () => runOneInnerTurnInner(slice, session, turnIndex, deps),
      );
      return wrapped.value;
    }
    return await runOneInnerTurnInner(slice, session, turnIndex, deps);
  } finally {
    if (leaseClaim != null && leaseClaim.result === "acquired" && deps.lease != null) {
      await deps.lease.release({
        leaseId: leaseClaim.lease.lease_id,
        leaseToken: leaseClaim.lease.lease_token,
      });
    }
  }
}

async function runOneInnerTurnInner(
  slice: SliceT,
  session: DialogueSessionT,
  turnIndex: number,
  deps: TurnWorkerDeps,
): Promise<TurnWorkerOutcome> {

  // Step 3 — Workspace prep
  const prep = await deps.workspace.prepareInnerWorkspace({
    sliceId: slice.slice_id,
    trunkBaseRevision: slice.trunk_base_revision,
  });

  // Step 3 — Manifest build (slice body + dod_revision)
  const drafts: ManifestEntryDraft[] = [
    {
      object_kind: "slice",
      object_id: slice.slice_id,
      fetch_scope: "body",
      required: true,
      purpose: "primary input",
    },
    {
      object_kind: "code_tree",
      object_id: slice.slice_id,
      fetch_scope: "tree",
      required: false,
      purpose: "self-fetch",
    },
  ];
  const pinResolver = new SliceLocalPinResolver(slice, prep.headBefore);
  const manifestBuilder = new ManifestBuilder(pinResolver, deps.clock);
  const manifest = await manifestBuilder.build({
    session_id: session.session_id,
    turn_index: turnIndex,
    purpose: "tdd_build",
    target: { object_kind: "slice", object_id: slice.slice_id },
    drafts,
  });
  await deps.store.writeAtomic(
    layout.manifest(manifest.manifest_id),
    JSON.stringify(manifest, null, 2),
  );

  // Step 4 — Invoke + Validate + Pin Recheck
  const turnIdempotency = idempotencyKey({
    scope: "per_turn",
    parts: {
      session_id: session.session_id,
      turn_index: turnIndex,
      agent_profile_id: "forge",
      manifest_id: manifest.manifest_id,
      input_revision_pins: manifest.entries.map((e) => e.revision_pin),
    },
  });
  const agentOut = await callAgent(
    {
      agentProfileId: "forge",
      agentRoleInSession: "lead",
      parentLoop: "inner",
      phaseOrPurpose: "tdd_build",
      sessionId: session.session_id,
      turnIndex,
      manifest,
      workspaceRevisionPin: prep.headBefore,
      agentCwd: prep.agentCwd,
      timeoutSec: deps.cfg.agentTimeoutSec ?? 120,
      idempotency: {
        scope: "per_turn",
        parts: {
          session_id: session.session_id,
          turn_index: turnIndex,
          agent_profile_id: "forge",
          manifest_id: manifest.manifest_id,
          input_revision_pins: manifest.entries.map((e) => e.revision_pin),
        },
      },
      runtimeMetadata: { workspace_pin_before: prep.headBefore },
    },
    // incident-9: wire StorePort so `callAgent` resolves the
    // `(slice, body)` manifest entry into the prompt's `# Inputs`
    // section. Without this, the inner TDD `forge` agent saw the
    // `BODY NOT INLINED` sentinel and (correctly) refused to author
    // patches, returning `failure: need_context` indefinitely. The
    // resolver gained `(slice, body)` support in this same change.
    { llmRunner: deps.llmRunner, manifestBuilder, store: deps.store },
  );
  if (!agentOut.ok) {
    // P0 fix (PR #61 review): record an invalid ledger row so the audit
    // trail covers envelope/header failures. Phase 4 failure-policy will
    // promote repeat-invalids to ABANDONED; phase-2 just stops.
    await emitInvalidTurn(
      deps,
      slice,
      session,
      turnIndex,
      manifest.manifest_id,
      manifest.entries.map((e) => e.revision_pin),
      turnIdempotency,
      agentOut,
    );
    // PR #95 review P0-1: incident-3 retry cap wiring — see
    // `outer-turn.ts` for the rationale. When prior `prompt_compose`
    // failures for this session reach the cap, mark the session ABANDONED
    // so the inner ready-object selector stops re-picking it.
    const classification = classifyAgentIoStageFailure(agentOut);
    if (classification != null) {
      const totalFailures = await countPromptComposeFailuresFromLedger(
        deps.store,
        session.session_id,
      );
      const decision = evaluateRetry(classification, totalFailures - 1);
      if (decision.decision === "escalate") {
        await abandonInnerSessionForPromptCompose(
          deps,
          slice,
          session,
          turnIndex,
          decision.reason,
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
  // P0 fix (PR #61 review): stalePins gate. Pin recheck after callAgent
  // detected drift in a manifest entry — refuse to commit/verify so a
  // stale-context turn cannot promote to SLICE_REVIEWING.
  if (agentOut.stalePins.length > 0) {
    await emitInvalidTurn(
      deps,
      slice,
      session,
      turnIndex,
      manifest.manifest_id,
      manifest.entries.map((e) => e.revision_pin),
      turnIdempotency,
      {
        ok: false,
        stage: "matrix_validate",
        reason: "missing_revision_pins",
        detail: `stale_pins: ${agentOut.stalePins.map((p) => p.object_id).join(",")}`,
        diagnosticsRef: agentOut.diagnosticsRef,
      },
    );
    return {
      kind: "stale_pins",
      sessionId: session.session_id,
      sliceId: slice.slice_id,
      stalePins: agentOut.stalePins,
    };
  }

  // Step 4b — apply patch artefacts to the worktree, then commit
  const files = extractPatchFiles(agentOut.envelope.artifacts);
  const commitMessage = `[forge] ${truncate(agentOut.envelope.summary, 70)}`;
  const commit = await deps.workspace.commit({
    sliceId: slice.slice_id,
    message: commitMessage,
    files,
  });

  // Verification (#RGC-VERIFICATION inner = synchronous post-commit)
  // Phase 8c (KAC-TRACEABILITY): forward the slice's declared ac_ids so the
  // resulting VerificationRun records exactly which AC-IDs it covers.
  const verificationRun = await runInnerVerification(
    {
      targetId: deps.cfg.targetId,
      targetRevision: commit.commit,
      testCommands: deps.cfg.testCommands(prep.agentCwd),
      environmentFingerprint: deps.cfg.environmentFingerprint,
      coversAcIds: slice.ac_ids,
    },
    {
      verification: deps.verification,
      store: deps.store,
      clock: deps.clock,
    },
  );

  // Step 5 — SessionTurn persist (CAS via withFileLock + exists check)
  const callerRoutingDecision = computeCallerRoutingDecision(agentOut.envelope);
  const { session: sessionAfterTurn } = await persistSessionTurn(
    {
      session,
      envelope: agentOut.envelope,
      callerRoutingDecision,
      workspaceCommit: commit.commit,
      verificationRunId: verificationRun.verification_run_id,
      newWorkspaceRevisionPin: commit.commit,
    },
    { store: deps.store, clock: deps.clock },
  );

  // Step 6a — ledger row for the turn itself (action_kind=session_progress)
  const turnPins = manifest.entries.map((e) => e.revision_pin);
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.cfg.targetId,
    object_id: session.session_id,
    object_kind: "session_turn",
    from_state: null,
    to_state: `turn_index=${turnIndex}`,
    loop_kind: "inner",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: session.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "forge",
    contribution_kind: agentOut.envelope.contribution_kind,
    action_kind: "session_progress",
    final_verdict: null,
    caller_id: deps.cfg.callerId,
    manifest_id: manifest.manifest_id,
    input_revision_pins: turnPins,
    output_hash: null,
    verification_run_id: verificationRun.verification_run_id,
    metric_run_id: null,
    idempotency_key: agentOut.envelope.idempotency_key,
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  // Verification failed → no further dispatch. Session stays SESSION_OPEN.
  if (verificationRun.result !== "pass") {
    return {
      kind: "verification_failed",
      sessionId: session.session_id,
      sliceId: slice.slice_id,
      verificationRunId: verificationRun.verification_run_id,
      workspaceCommit: commit.commit,
    };
  }

  // Step 6b — phase-2 caller-dispatch inline (atomicity-aware ordering):
  //   1. Create SliceMerge (phase-3 reviewer pickup target)
  //   2. Slice → SLICE_REVIEWING + clear current_session_id   ← BEFORE session
  //   3. Session → CONVERGED                                  ← LAST
  // Rationale: if a crash happens between (2) and (3), the slice is no
  // longer pickable (SLICE_REVIEWING) and the leftover SESSION_OPEN session
  // is orphaned but harmless. The opposite ordering would leave a CONVERGED
  // session referenced by SLICE_BUILDING, which `ready-object` rejects with
  // SessionNotOpenError — unrecoverable in phase 2.
  const sliceMerge = await openSliceMergeReadyForReview(
    {
      slice,
      session: sessionAfterTurn,
      preMergeRevision: commit.commit,
      verificationRunId: verificationRun.verification_run_id,
    },
    deps,
  );

  // PR #64 review P0-2 fix: wrap slice write in withFileLock so a
  // concurrent recovery sweep cannot interleave a SLICE_READY rollback
  // between our read and write. Symmetric to recovery.reanimateSliceIfNeeded.
  const slicePath = layout.slice(slice.slice_id);
  await deps.store.withFileLock(slicePath, async () => {
    const reviewingSlice = Slice.parse({
      ...slice,
      state: "SLICE_REVIEWING",
      current_session_id: null,
      updated_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(
      slicePath,
      JSON.stringify(reviewingSlice, null, 2),
    );
  });

  const finalized = DialogueSession.parse({
    ...sessionAfterTurn,
    state: "CONVERGED",
    final_verdict: "tests_green",
    finalization_decision: "required_evidence",
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sessionMetadata(finalized.session_id),
    JSON.stringify(finalized, null, 2),
  );

  // Ledger rows for the dispatch side-effects (canonical idempotency keys)
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.cfg.targetId,
    object_id: sliceMerge.slice_merge_id,
    object_kind: "slice_merge",
    from_state: null,
    to_state: "SM_READY_FOR_REVIEW",
    loop_kind: "inner",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: finalized.session_id,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: null,
    caller_id: deps.cfg.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: verificationRun.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "per_merge",
      parts: {
        slice_merge_id: sliceMerge.slice_merge_id,
        pre_merge_workspace_revision: commit.commit,
        trunk_base_revision_at_merge_attempt: slice.trunk_base_revision,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.cfg.targetId,
    object_id: slice.slice_id,
    object_kind: "slice",
    from_state: slice.state,
    to_state: "SLICE_REVIEWING",
    loop_kind: "inner",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: finalized.session_id,
    turn_index: null,
    slot_kind: "delivery",
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "slice_merge",
    final_verdict: null,
    caller_id: deps.cfg.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: verificationRun.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "slice_state",
        slice_id: slice.slice_id,
        to_state: "SLICE_REVIEWING",
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.cfg.targetId,
    object_id: finalized.session_id,
    object_kind: "dialogue_session",
    from_state: "SESSION_OPEN",
    to_state: "CONVERGED",
    loop_kind: "inner",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: finalized.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "forge",
    contribution_kind: null,
    action_kind: "session_finalize",
    final_verdict: "tests_green",
    caller_id: deps.cfg.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: verificationRun.verification_run_id,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "per_session_outcome",
      parts: {
        session_id: finalized.session_id,
        final_verdict: "tests_green",
        finalization_decision: "required_evidence",
        workspace_revision_pin_at_convergence: commit.commit,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  return {
    kind: "converged",
    sessionId: finalized.session_id,
    sliceId: slice.slice_id,
    sliceMergeId: sliceMerge.slice_merge_id,
    verificationRunId: verificationRun.verification_run_id,
    workspaceCommit: commit.commit,
  };
}

async function emitInvalidTurn(
  deps: TurnWorkerDeps,
  slice: SliceT,
  session: DialogueSessionT,
  turnIndex: number,
  manifestId: string,
  inputPins: string[],
  turnIdempotencyKey: string,
  failure: Extract<AgentIoOutcome, { ok: false }>,
): Promise<void> {
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.cfg.targetId,
    object_id: session.session_id,
    object_kind: "session_turn",
    from_state: null,
    to_state: `turn_index=${turnIndex}`,
    loop_kind: "inner",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: session.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "forge",
    contribution_kind: null,
    action_kind: "session_progress",
    final_verdict: null,
    caller_id: deps.cfg.callerId,
    manifest_id: manifestId,
    input_revision_pins: inputPins,
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: turnIdempotencyKey,
    lease_token: null,
    lease_kind: null,
    result: "invalid",
    result_detail: `${failure.stage}/${failure.reason}: ${truncate(failure.detail, 200)}`,
    timestamp: deps.clock.isoNow(),
  });
}

/**
 * PR #95 review P0-1 (incident-3): flip a SESSION_OPEN inner session to
 * ABANDONED after the `prompt_compose_truncation` retry cap is hit, and
 * record a session_finalize ledger row so the daemon's pickReadyInnerTurn
 * selector (which guards on `state === "SESSION_OPEN"`) stops re-picking
 * it. The session stays attached to its slice; the slice itself is left
 * in its current state — operator/recovery sweep handles the slice-side
 * cleanup, identical to the existing TIMEOUT path. `abandoned_reason` is
 * `no_progress` because `AbandonedReason` does not have a dedicated
 * `prompt_compose_truncation` value and the semantics align (prompt
 * cannot be composed → no progress is achievable).
 */
async function abandonInnerSessionForPromptCompose(
  deps: TurnWorkerDeps,
  slice: SliceT,
  session: DialogueSessionT,
  turnIndex: number,
  reason: string,
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
    target_id: deps.cfg.targetId,
    object_id: finalized.session_id,
    object_kind: "dialogue_session",
    from_state: "SESSION_OPEN",
    to_state: "ABANDONED",
    loop_kind: "inner",
    phase: null,
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    dod_revision: slice.dod_revision_pin,
    session_id: finalized.session_id,
    turn_index: turnIndex,
    slot_kind: "delivery",
    agent_profile_id: "forge",
    contribution_kind: null,
    action_kind: "session_finalize",
    final_verdict: null,
    caller_id: deps.cfg.callerId,
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

function computeCallerRoutingDecision(envelope: Envelope): CallerRoutingDecision {
  const nar = envelope.next_action_request;
  if (nar == null) {
    return {
      decision: "dropped",
      decision_reason:
        "single-agent inner session has no next_action_request to route",
      resolved_addressed_to: null,
    };
  }
  return {
    decision: "accepted",
    decision_reason: `accepted next_action_request from ${envelope.agent_profile_id} (intent="${truncate(nar.intent, 80)}")`,
    resolved_addressed_to: typeof nar.addressed_to === "string" ? nar.addressed_to : null,
  };
}

async function openSliceMergeReadyForReview(
  input: {
    slice: SliceT;
    session: DialogueSessionT;
    preMergeRevision: string;
    verificationRunId: string;
  },
  deps: TurnWorkerDeps,
): Promise<SliceMergeT> {
  const id = newMonotonicId(deps.clock.now());
  const sm = SliceMerge.parse({
    slice_merge_id: id,
    slice_id: input.slice.slice_id,
    target_id: deps.cfg.targetId,
    pre_merge_workspace_revision: input.preMergeRevision,
    merge_revision: null,
    inner_session_id: input.session.session_id,
    review_session_id: null,
    verification_run_id: input.verificationRunId,
    state: "SM_READY_FOR_REVIEW",
    merged_at: null,
    merged_by_caller_id: null,
    lease_token: null,
    audit_chain_predecessor_id: null,
    external_refs: [],
    created_at: deps.clock.isoNow(),
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sliceMerge(id),
    JSON.stringify(sm, null, 2),
  );
  return sm;
}

class SliceLocalPinResolver implements RevisionPinResolver {
  constructor(
    private readonly slice: SliceT,
    private readonly workspaceHead: string,
  ) {}
  async resolve(entry: ManifestEntryDraft): Promise<string> {
    if (entry.object_kind === "slice") return this.slice.dod_revision_pin;
    if (entry.object_kind === "code_tree") return this.workspaceHead;
    return this.workspaceHead;
  }
}

interface PatchArtifacts {
  files?: Array<{ path: string; content: string }>;
}

function extractPatchFiles(
  artifacts: Record<string, unknown> | null,
): { path: string; content: string }[] {
  if (artifacts == null) return [];
  const a = artifacts as PatchArtifacts;
  if (!Array.isArray(a.files)) return [];
  const out: { path: string; content: string }[] = [];
  for (const f of a.files) {
    if (
      f != null &&
      typeof f.path === "string" &&
      typeof f.content === "string"
    ) {
      out.push({ path: f.path, content: f.content });
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
