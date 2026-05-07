import { newMonotonicId } from "../domain/ids.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
} from "../domain/schema/dialogue-session.js";
import { LedgerRow } from "../domain/schema/ledger.js";
import {
  SliceMerge,
  type SliceMerge as SliceMergeT,
} from "../domain/schema/slice-merge.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import type { ClockPort } from "../ports/clock.js";
import type { LlmRunnerPort } from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import type {
  CommandSpec,
  VerificationPort,
} from "../ports/verification.js";
import type { WorkspacePort } from "../ports/workspace.js";
import { callAgent } from "./agent-io.js";
import type { LedgerAppender } from "./ledger.js";
import { ManifestBuilder, type ManifestEntryDraft, type RevisionPinResolver } from "./manifest-builder.js";
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
 *   4. Invoke + Validate + Pin Recheck (agent-io)
 *   5. SessionTurn Persist
 *   6. Cleanup + Ledger
 *
 * Plus the phase-2 gate: when the turn yields tests_green, this function
 * inlines the caller-dispatch side-effects up to
 * `SLICE_BUILDING → SLICE_REVIEWING + SM_DRAFT → SM_READY_FOR_REVIEW`.
 * The middle review session itself is phase 3.
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
}

export async function runOneInnerTurn(
  deps: TurnWorkerDeps,
): Promise<TurnWorkerOutcome> {
  // Step 1 — Pickup
  const ready = await pickReadyInnerTurn({
    store: deps.store,
    clock: deps.clock,
  });
  if (ready == null) {
    return { kind: "noop", detail: "no SLICE_READY/SLICE_BUILDING internal slices" };
  }
  const { slice, session, turnIndex } = ready;

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
    { llmRunner: deps.llmRunner, manifestBuilder },
  );
  if (!agentOut.ok) {
    return {
      kind: "invalid_envelope",
      sessionId: session.session_id,
      sliceId: slice.slice_id,
      stage: agentOut.stage,
      reason: agentOut.reason,
      detail: agentOut.detail,
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
  const verificationRun = await runInnerVerification(
    {
      targetId: deps.cfg.targetId,
      targetRevision: commit.commit,
      testCommands: deps.cfg.testCommands(prep.agentCwd),
      environmentFingerprint: deps.cfg.environmentFingerprint,
    },
    {
      verification: deps.verification,
      store: deps.store,
      clock: deps.clock,
    },
  );

  // Step 5 — SessionTurn persist (CAS via withFileLock + exists check)
  const { turn, session: sessionAfterTurn } = await persistSessionTurn(
    {
      session,
      envelope: agentOut.envelope,
      callerRoutingDecision: {
        decision: "dropped",
        decision_reason: "single-agent inner session has no next_action_request to route",
        resolved_addressed_to: null,
      },
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

  // Step 6b — phase-2 caller-dispatch inline:
  //   session CONVERGED tests_green
  //   slice SLICE_BUILDING → SLICE_REVIEWING
  //   SliceMerge SM_DRAFT → SM_READY_FOR_REVIEW
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

  const sliceMerge = await openSliceMergeReadyForReview(
    {
      slice,
      session: finalized,
      preMergeRevision: commit.commit,
      verificationRunId: verificationRun.verification_run_id,
    },
    deps,
  );

  const reviewingSlice = Slice.parse({
    ...slice,
    state: "SLICE_REVIEWING",
    current_session_id: null,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.slice(slice.slice_id),
    JSON.stringify(reviewingSlice, null, 2),
  );

  // Ledger rows for the dispatch side-effects
  const sessionFinalizeKey = `per_session_outcome|${finalized.session_id}|tests_green|required_evidence|${commit.commit}`;
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
    idempotency_key: sessionFinalizeKey,
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

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
    idempotency_key: `slice_merge_open|${sliceMerge.slice_merge_id}`,
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
    from_state: "SLICE_BUILDING",
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
    idempotency_key: `slice_state|${slice.slice_id}|SLICE_REVIEWING`,
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });

  void turn;
  void LedgerRow; // imported for type-symmetry; runtime usage above goes through appendTransition's own validator
  return {
    kind: "converged",
    sessionId: finalized.session_id,
    sliceId: slice.slice_id,
    sliceMergeId: sliceMerge.slice_merge_id,
    verificationRunId: verificationRun.verification_run_id,
    workspaceCommit: commit.commit,
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
