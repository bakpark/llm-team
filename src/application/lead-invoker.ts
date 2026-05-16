/**
 * Phase 2 lead-invoker — PR-first orchestrator for a single lead agent
 * invocation (forge / atlas).
 *
 * Authority: `cli-spicy-anchor.md` §1 (capability), §2 (ReviewSurface),
 * §5 (LeadIntent + AgentRunReceipt), §7 (outbox 2-phase + dedup probes),
 * §8 (Lead boundary), §9 (follow-up commit recovery transition),
 * §11 (PR body machine block + sanitize + nonce).
 *
 * Pipeline (one invocation):
 *   1. WorkspacePort.prepareInnerWorkspace
 *   2. callAgent (legacy agent-io path; legacy envelope still arrives)
 *      └ on parse / lr_invoke failure: WorkspacePort.resetHard + cleanForce,
 *        retry up to retryCap (default 3), then abandon
 *   3. derive LeadIntent from envelope.artifacts + envelope.summary
 *   4. L4 post-call diff allowlist (declared `changed_files` ⊆ tracked diff)
 *   5. outbox.begin(commit_op,k1) → WorkspacePort.commit (Idempotency-Key
 *      trailer) → outbox.complete (probe: findCommitByTrailer)
 *   6. outbox.begin(push_op,k2) → WorkspacePort.push → outbox.complete
 *      (probe: getRemoteHeadSha)
 *   7. outbox.begin(pr_open_op | pr_update_op,k3) → GitHostPort.openPullRequest
 *      | updatePullRequestBody (sanitized body + pr-machine block + nonce)
 *      → outbox.complete (probe: findPullRequestByBodyMachineKey)
 *   8. ReviewSurface upsert + §9 follow-up recovery transition (when prior
 *      review_state=changes_requested, build_state=rebuilding)
 *   9. AgentRunReceipt persist + SessionTurn additive refs (output_receipt_ref
 *      / output_intent_ref) + ledger row append
 *
 * Phase 2 leaves legacy envelope path as default — only callers that opt in
 * (turn-worker / outer-turn `lead_path: "pr_first"`) reach this module.
 *
 * IMPORTANT: WorkspacePort.commit currently does not accept a custom message
 * trailer in its public type — Phase 2 piggybacks the idempotency key by
 * embedding `Idempotency-Key: <k1>` as a literal trailer in the commit
 * message; the matching probe `findCommitByTrailer` reads that trailer.
 */

import { newId } from "../domain/ids.js";
import {
  AgentRunReceipt,
  type AgentRunReceipt as AgentRunReceiptT,
} from "../domain/schema/agent-run-receipt.js";
import { LeadIntent as LeadIntentSchema } from "../domain/schema/lead-intent.js";
import type { LeadIntent } from "../domain/schema/lead-intent.js";
import {
  ReviewSurface,
  type ReviewSurface as ReviewSurfaceT,
  type ReviewSurfaceParentKind,
  type ReviewSurfaceParentPhase,
} from "../domain/schema/review-surface.js";
import type { Envelope } from "../domain/schema/envelope.js";
import type { ContextManifest } from "../domain/schema/manifest.js";
import type { ClockPort } from "../ports/clock.js";
import type { ExternalRefHandle } from "../ports/issue-tracker.js";
import type { GitHostPort } from "../ports/git-host.js";
import type {
  LlmAgentProfileId,
  AgentRole,
  ParentLoop,
  LlmRunnerPort,
} from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import type { WorkspacePort } from "../ports/workspace.js";
import { callAgent, type AgentIoOutcome } from "./agent-io.js";
import {
  buildCanonicalString,
  type PrCanonicalFields,
  sanitizeMarkdown,
} from "./machine-block.js";
import type { ManifestBuilder } from "./manifest-builder.js";
import { Outbox } from "./outbox.js";
import { layout } from "./persistence-layout.js";
import {
  checkPostCallDiffAllowlist,
  type DiffAllowlistViolation,
} from "./post-call-diff-allowlist.js";
import { composePrBody } from "./pr-body-compose.js";
import type { LedgerAppender } from "./ledger.js";
import type { IdempotencyParts } from "./idempotency.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export type LeadInvokerParentKind = ReviewSurfaceParentKind;
export type LeadInvokerParentPhase = ReviewSurfaceParentPhase | null;

export interface LeadInvokerCfg {
  callerId: string;
  targetId: string;
  /** dirty-worktree retry cap (cli-spicy-anchor.md §8). */
  retryCap?: number;
  /** Used in the `Idempotency-Key` commit trailer + probe lookup. */
  trailerKey?: string;
  /** Remote name passed to push_op probe `getRemoteHeadSha`. Defaults to "origin". */
  remoteName?: string;
  /** PR base branch (trunk). */
  baseBranch: string;
  /** Open as draft? */
  draft?: boolean;
  /** Squash strategy for any later merge_op (placeholder; merge is Phase 4). */
  /** Optional fixed agent timeout. */
  agentTimeoutSec?: number;
  /** Last verification result label embedded in pr-machine block. */
  lastVerificationResult?: "pass" | "fail" | "pending";
  /** When set, sanitizeMarkdown noop disabled (defensive default: always strip). */
  /** Profile-defaults are written into AgentRunReceipt unchanged. */
}

export interface LeadInvokerDeps {
  store: StorePort;
  clock: ClockPort;
  llmRunner: LlmRunnerPort;
  workspace: WorkspacePort;
  gitHost: GitHostPort;
  ledger: LedgerAppender;
  /** HMAC secret for pr-machine block (cli-spicy-anchor.md §11-3). */
  machineBlockSecret: string;
  /** Optional workdir root for predictable prompt persistence. */
  workdirRoot?: string;
  /** Outbox dependency (constructed externally so tests can inspect). */
  outbox: Outbox;
}

export interface LeadInvokerInput {
  /** Agent identity. */
  agentProfileId: LlmAgentProfileId;
  agentRoleInSession: AgentRole;
  parentLoop: ParentLoop;
  /** Phase or purpose label (e.g. "tdd_build", "Discovery", "Specification"). */
  phaseOrPurpose: string;
  sessionId: string;
  turnIndex: number;
  /** Worktree slice id used by WorkspacePort. For outer phases callers reuse a
   *  stable slice id (e.g. `slice/<milestone>` synthetic). */
  sliceId: string;
  trunkBaseRevision: string;
  /** Branch to commit/push to (slice-local or milestone-local). */
  branch: string;
  /** parent identity (for ReviewSurface). */
  parentKind: LeadInvokerParentKind;
  parentId: string;
  parentPhase: LeadInvokerParentPhase;
  /** When non-null: the existing ReviewSurface (follow-up commit). When null:
   *  brand-new surface (open new PR). */
  existingSurface: ReviewSurfaceT | null;
  /** Pre-built context manifest (caller threads ManifestBuilder + drafts). */
  manifest: ContextManifest;
  manifestBuilder: ManifestBuilder;
  /** Idempotency parts for the agent envelope (legacy contract). */
  envelopeIdempotency: IdempotencyParts;
  /** Optional metadata bag for AGC-OUTPUT-RUNTIME-ENRICH. */
  runtimeMetadata?: Record<string, unknown>;
  /** Title used for pr_open_op. Ignored on pr_update_op. */
  prTitle: string;
  /** Optional latest verification run id to embed in ReviewSurface. */
  latestVerificationRunId?: string | null;
  /** Optional opaque labels passed to GitHostPort.openPullRequest. */
  labels?: string[];
}

export type LeadInvokerOutcome =
  | {
      kind: "succeeded";
      receipt: AgentRunReceiptT;
      reviewSurface: ReviewSurfaceT;
      commitSha: string;
      pushSha: string;
      prRef: ExternalRefHandle;
      leadIntent: LeadIntent;
      /**
       * PR #119 review P0a (qwen+gpt5.5): the agent's canonical envelope.
       * Returned so callers (turn-worker, outer-turn) can persist a
       * `SessionTurn` and advance `current_turn_index`, mirroring the
       * legacy path's contract.
       */
      envelope: Envelope;
      /** Receipt persistence path — used by callers to populate
       *  `SessionTurn.output_receipt_ref`. */
      receiptPath: string;
      /** LeadIntent persistence path — used by callers to populate
       *  `SessionTurn.output_intent_ref`. */
      intentPath: string;
    }
  | {
      kind: "abandoned";
      reason:
        | "agent_call_failed"
        | "lead_intent_invalid"
        | "capability_violation_l4"
        | "outbox_failed";
      detail: string;
      attempts: number;
      violations?: DiffAllowlistViolation[];
    };

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const DEFAULT_RETRY_CAP = 3;
const DEFAULT_TRAILER_KEY = "Idempotency-Key";
const DEFAULT_REMOTE = "origin";

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

export class LeadInvoker {
  constructor(
    private readonly cfg: LeadInvokerCfg,
    private readonly deps: LeadInvokerDeps,
  ) {}

  async invoke(input: LeadInvokerInput): Promise<LeadInvokerOutcome> {
    const retryCap = this.cfg.retryCap ?? DEFAULT_RETRY_CAP;

    let attempt = 0;
    let lastFailure: { reason: string; detail: string } | null = null;
    let agentOut: AgentIoOutcome | null = null;
    let leadIntent: LeadIntent | null = null;

    // --- Step 1+2: workspace prepare + callAgent with dirty-worktree retry --
    // Phase 6.0c: pass `input.branch` through so the worktree is created on
    // the same ref that the eventual `push_op` targets (outer phases use
    // `spec/<m>/discovery` etc., not the default `slice/<m>`).
    const prep = await this.deps.workspace.prepareInnerWorkspace({
      sliceId: input.sliceId,
      trunkBaseRevision: input.trunkBaseRevision,
      branch: input.branch,
    });

    while (attempt < retryCap) {
      attempt += 1;
      agentOut = await callAgent(
        {
          agentProfileId: input.agentProfileId,
          agentRoleInSession: input.agentRoleInSession,
          parentLoop: input.parentLoop,
          phaseOrPurpose: input.phaseOrPurpose,
          sessionId: input.sessionId,
          turnIndex: input.turnIndex,
          manifest: input.manifest,
          workspaceRevisionPin: prep.headBefore,
          agentCwd: prep.agentCwd,
          timeoutSec: this.cfg.agentTimeoutSec ?? 120,
          idempotency: input.envelopeIdempotency,
          runtimeMetadata: input.runtimeMetadata ?? {},
        },
        {
          llmRunner: this.deps.llmRunner,
          manifestBuilder: input.manifestBuilder,
          store: this.deps.store,
          workdirRoot: this.deps.workdirRoot,
        },
      );

      if (agentOut.ok) {
        const derived = deriveLeadIntent(agentOut.envelope);
        const parsed = LeadIntentSchema.safeParse(derived);
        if (parsed.success) {
          leadIntent = parsed.data;
          break;
        }
        lastFailure = {
          reason: "lead_intent_invalid",
          detail: parsed.error.errors
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join("; "),
        };
      } else {
        lastFailure = {
          reason: "agent_call_failed",
          detail: `${agentOut.stage}/${agentOut.reason}: ${agentOut.detail}`,
        };
      }

      // dirty-worktree recovery before retry (cli-spicy-anchor.md §8)
      try {
        await this.deps.workspace.resetHard({
          sliceId: input.sliceId,
          sha: prep.headBefore,
        });
        await this.deps.workspace.cleanForce({ sliceId: input.sliceId });
      } catch {
        // best-effort; loop will retry callAgent regardless
      }
    }

    if (leadIntent == null || agentOut == null || !agentOut.ok) {
      return {
        kind: "abandoned",
        reason:
          lastFailure?.reason === "lead_intent_invalid"
            ? "lead_intent_invalid"
            : "agent_call_failed",
        detail: lastFailure?.detail ?? "unknown",
        attempts: attempt,
      };
    }

    // ---- Step 3.5: Phase 6.0d — outer phase synthetic spec file ---------
    // Outer phases (parent_kind=milestone) produce LeadIntent envelopes
    // that describe a spec proposal in `artifacts.problem_framing`,
    // `scope_boundary`, etc., but rarely declare `artifacts.files`. With
    // a real `WorkspacePort` (i.e. `git-worktree`) an empty `files` ⇒
    // empty commit ⇒ `git push` of an unchanged branch fails the refspec
    // match. We synthesize `docs/specs/<milestone_id>/<phase>.md` from
    // the envelope/LeadIntent so every outer turn produces a real diff
    // and the PR has reviewable content. Inner slice paths
    // (parent_kind=slice) keep the legacy "agent must declare files"
    // contract — code changes can't be safely synthesized.
    if (
      input.parentKind === "milestone" &&
      extractTrackedFilesFromEnvelope(agentOut.envelope).length === 0
    ) {
      injectOuterPhaseSpecFile(agentOut.envelope, {
        milestoneId: input.parentId,
        phase: input.parentPhase ?? input.phaseOrPurpose,
        leadIntent,
      });
      leadIntent = {
        ...leadIntent,
        changed_files: extractTrackedFilesFromEnvelope(agentOut.envelope),
      };
    }

    // ---- Step 4: L4 post-call diff allowlist -----------------------------
    // Tracked diff is derived from agent-emitted envelope.artifacts.files —
    // the legacy WorkspacePort.commit applies these as a tracked diff, so
    // the set the agent declared via LeadIntent.changed_files MUST be the
    // same set of paths the patch applies. Phase 5 will replace this with
    // an actual `git status --porcelain` probe; Phase 2 keeps the contract
    // tight by deriving tracked from envelope.artifacts (single source of
    // truth in the legacy bridge).
    const tracked = extractTrackedFilesFromEnvelope(agentOut.envelope);
    const allow = checkPostCallDiffAllowlist({
      declaredChangedFiles: leadIntent.changed_files,
      trackedChangedFiles: tracked,
    });
    if (!allow.ok) {
      return {
        kind: "abandoned",
        reason: "capability_violation_l4",
        detail: allow.violations
          .map((v) => `${v.kind}: ${v.paths.join(",")}`)
          .join("; "),
        attempts: attempt,
        violations: allow.violations,
      };
    }

    // ---- Step 5: outbox commit_op -----------------------------------------
    const k1 = newId(this.deps.clock.now());
    const k2 = newId(this.deps.clock.now());
    const k3 = newId(this.deps.clock.now());
    const surfaceId =
      input.existingSurface?.review_surface_id ?? newId(this.deps.clock.now());
    const objectId = surfaceId;
    const trailerKey = this.cfg.trailerKey ?? DEFAULT_TRAILER_KEY;

    await this.deps.outbox.begin({
      opKind: "commit_op",
      idempotencyKey: k1,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId,
      manifestId: input.manifest.manifest_id,
      // PR-123 P0-1: receipt tuple → outbox_pending row → recovery backfill.
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      agentProfileId: input.agentProfileId,
      loopKind: input.parentLoop,
      // PR #127 review P1-1 (gpt5.5): persist routing hints so the
      // recovery probe builder can recover the Case A crash window
      // between this `outbox.begin` and the Step 8 ReviewSurface write.
      // Without these the probe builder fell back to `no_probe`.
      payload: { branch: input.branch, trailerKey },
    });
    let commitSha: string;
    try {
      const res = await this.deps.workspace.commit({
        sliceId: input.sliceId,
        message: buildCommitMessage(leadIntent.summary, trailerKey, k1),
        files: extractPatchFiles(agentOut.envelope),
      });
      commitSha = res.commit;
    } catch (e) {
      await this.deps.outbox.complete({
        opKind: "commit_op",
        idempotencyKey: k1,
        status: "failed",
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        objectId,
        manifestId: input.manifest.manifest_id,
      });
      return {
        kind: "abandoned",
        reason: "outbox_failed",
        detail: `commit_op: ${(e as Error).message}`,
        attempts: attempt,
      };
    }
    await this.deps.outbox.complete({
      opKind: "commit_op",
      idempotencyKey: k1,
      status: "posted",
      externalId: commitSha,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId,
      manifestId: input.manifest.manifest_id,
    });

    // ---- Step 6: outbox push_op -------------------------------------------
    // PR #119 review P0b (gpt5.5): actually invoke `WorkspacePort.push`
    // before the probe. Previously this relied on the adapter pre-seeding
    // the remote head, so PR-first never reached PR open/update on a real
    // workspace. Failures from `push` propagate to `outbox_failed` so the
    // outbox retry/recovery path still applies.
    const remoteName = this.cfg.remoteName ?? DEFAULT_REMOTE;
    await this.deps.outbox.begin({
      opKind: "push_op",
      idempotencyKey: k2,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId,
      manifestId: input.manifest.manifest_id,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      agentProfileId: input.agentProfileId,
      loopKind: input.parentLoop,
      // PR #127 review P1-1: surface-less probe hints.
      payload: { branch: input.branch, headSha: commitSha, remote: remoteName },
    });
    try {
      await this.deps.workspace.push({
        sliceId: input.sliceId,
        remote: remoteName,
        branch: input.branch,
      });
    } catch (e) {
      await this.deps.outbox.complete({
        opKind: "push_op",
        idempotencyKey: k2,
        status: "failed",
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        objectId,
        manifestId: input.manifest.manifest_id,
      });
      return {
        kind: "abandoned",
        reason: "outbox_failed",
        detail: `push_op: ${(e as Error).message}`,
        attempts: attempt,
      };
    }
    const remoteSha = await this.deps.workspace.getRemoteHeadSha({
      remote: remoteName,
      branch: input.branch,
    });
    if (remoteSha !== commitSha) {
      await this.deps.outbox.complete({
        opKind: "push_op",
        idempotencyKey: k2,
        status: "failed",
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        objectId,
        manifestId: input.manifest.manifest_id,
      });
      return {
        kind: "abandoned",
        reason: "outbox_failed",
        detail: `push_op: remote sha=${remoteSha ?? "<null>"} expected=${commitSha}`,
        attempts: attempt,
      };
    }
    await this.deps.outbox.complete({
      opKind: "push_op",
      idempotencyKey: k2,
      status: "posted",
      externalId: commitSha,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId,
      manifestId: input.manifest.manifest_id,
    });

    // ---- Step 7: outbox pr_open_op | pr_update_op --------------------------
    const reviewRound = input.existingSurface?.review_round ?? 0;
    const canonicalFields: PrCanonicalFields = {
      review_surface_id: surfaceId,
      parent_kind: input.parentKind,
      parent_id: input.parentId,
      parent_phase: input.parentPhase ?? "n/a",
      head_sha: commitSha,
      review_round: String(reviewRound),
      last_verification_result: this.cfg.lastVerificationResult ?? "pending",
      idempotency_key: k3,
    };
    // sanity: the canonical_string must build cleanly so the nonce lookup is
    // deterministic at parse-side.
    buildCanonicalString("pr", canonicalFields);
    const prBody = composePrBody({
      intent: leadIntent,
      canonicalFields,
      machineBlockSecret: this.deps.machineBlockSecret,
    });

    const opKind = input.existingSurface == null ? "pr_open_op" : "pr_update_op";
    await this.deps.outbox.begin({
      opKind,
      idempotencyKey: k3,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId,
      manifestId: input.manifest.manifest_id,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      agentProfileId: input.agentProfileId,
      loopKind: input.parentLoop,
      // PR #127 review P1-1: surface-less probe hints for the initial
      // pr_open_op crash window (Case A). pr_update_op already has a
      // persisted surface via input.existingSurface so the branch hint is
      // harmless redundancy there.
      payload: { branch: input.branch, headSha: commitSha },
    });
    let prRef: ExternalRefHandle;
    try {
      if (input.existingSurface == null) {
        prRef = await this.deps.gitHost.openPullRequest({
          title: sanitizeMarkdown(input.prTitle),
          body: prBody,
          headBranch: input.branch,
          baseBranch: this.cfg.baseBranch,
          draft: this.cfg.draft ?? false,
          labels: input.labels ?? [],
        });
      } else {
        const existing = handleFromSurface(input.existingSurface);
        prRef = await this.deps.gitHost.updatePullRequestBody({
          prRef: existing,
          body: prBody,
        });
      }
    } catch (e) {
      await this.deps.outbox.complete({
        opKind,
        idempotencyKey: k3,
        status: "failed",
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        objectId,
        manifestId: input.manifest.manifest_id,
      });
      return {
        kind: "abandoned",
        reason: "outbox_failed",
        detail: `${opKind}: ${(e as Error).message}`,
        attempts: attempt,
      };
    }
    await this.deps.outbox.complete({
      opKind,
      idempotencyKey: k3,
      status: "posted",
      externalId: prRef.id,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId,
      manifestId: input.manifest.manifest_id,
    });

    // ---- Step 8: ReviewSurface upsert + §9 transition ---------------------
    const isFollowUp =
      input.existingSurface != null &&
      input.existingSurface.review_state === "changes_requested" &&
      input.existingSurface.build_state === "rebuilding";

    const now = this.deps.clock.isoNow();
    let reviewState: ReviewSurfaceT["review_state"];
    let buildState: ReviewSurfaceT["build_state"];
    if (input.existingSurface == null) {
      reviewState = "pending_review";
      buildState =
        input.parentKind === "slice" ? "ready" : "not_applicable";
    } else if (isFollowUp) {
      // §9: forge new commit push directly after request_changes →
      // head_sha=new, review_round 그대로 (round++ 는 다음 request_changes
      // 시점에서). post-commit verification 결과로 review_state/build_state
      // 가 결정되는데, Phase 2 의 lead-invoker 는 verification을 직접
      // 수행하지 않으므로 caller 가 cfg.lastVerificationResult 로 알린다.
      const v = this.cfg.lastVerificationResult ?? "pending";
      if (v === "pass") {
        reviewState = "pending_review";
        buildState =
          input.parentKind === "slice" ? "ready" : "not_applicable";
      } else if (v === "fail") {
        // build verification 실패: build_state=stale, review_state 그대로
        // changes_requested. slice 는 SLICE_BUILDING 유지 (caller 책임).
        reviewState = input.existingSurface.review_state;
        buildState =
          input.parentKind === "slice" ? "stale" : "not_applicable";
      } else {
        // pending: 아직 verification 결과 없음 → rebuilding 유지
        reviewState = input.existingSurface.review_state;
        buildState = input.existingSurface.build_state;
      }
    } else {
      // 일반 update (예: same-round 보정): 기존 상태 유지
      reviewState = input.existingSurface.review_state;
      buildState = input.existingSurface.build_state;
    }

    const surface: ReviewSurfaceT = ReviewSurface.parse({
      review_surface_id: surfaceId,
      parent_kind: input.parentKind,
      parent_id: input.parentId,
      parent_phase: input.parentPhase,
      pr_ref: {
        provider: prRef.provider === "github" ? "github" : "fs_mirror",
        id: prRef.id,
        node_id: null,
        url: prRef.url ?? `${prRef.provider}://${prRef.id}`,
      },
      branch: input.branch,
      base_ref: this.cfg.baseBranch,
      head_sha: commitSha,
      review_round: reviewRound,
      lifecycle_state: "open",
      review_state: reviewState,
      build_state: buildState,
      latest_verification_run_id: input.latestVerificationRunId ?? null,
      last_synced_external_revision: null,
      created_at: input.existingSurface?.created_at ?? now,
      updated_at: now,
    });
    await this.deps.store.writeAtomic(
      layout.reviewSurface(surfaceId),
      JSON.stringify(surface, null, 2),
    );

    // ---- Step 9: AgentRunReceipt + LeadIntent persist + ledger row --------
    const receipt: AgentRunReceiptT = AgentRunReceipt.parse({
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      parent_loop: input.parentLoop,
      agent_profile_id: input.agentProfileId,
      agent_role_in_session: input.agentRoleInSession,
      idempotency_key: k3,
      diagnostics_ref: agentOut.diagnosticsRef,
      external_review_id: null,
      external_pr_id: prRef.id,
      commit_sha: commitSha,
      exit_status: "ok",
      recorded_at: now,
    });
    const receiptPath = layout.agentRunReceipt(input.sessionId, input.turnIndex);
    const intentPath = layout.leadIntent(input.sessionId, input.turnIndex);
    await this.deps.store.writeAtomic(
      receiptPath,
      JSON.stringify(receipt, null, 2),
    );
    await this.deps.store.writeAtomic(
      intentPath,
      JSON.stringify(leadIntent, null, 2),
    );

    await this.deps.ledger.appendTransition({
      transition_id: newId(this.deps.clock.now()),
      target_id: this.cfg.targetId,
      object_id: surfaceId,
      object_kind: "system",
      from_state: null,
      to_state: "lead_invocation_succeeded",
      loop_kind: input.parentLoop,
      phase: input.parentPhase ?? null,
      slice_id: input.parentKind === "slice" ? input.parentId : null,
      slice_kind: null,
      dod_revision: null,
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      slot_kind: null,
      agent_profile_id: input.agentProfileId,
      contribution_kind: null,
      action_kind: "session_progress",
      final_verdict: null,
      caller_id: this.cfg.callerId,
      manifest_id: input.manifest.manifest_id,
      input_revision_pins: input.manifest.entries.map((e) => e.revision_pin),
      output_hash: null,
      verification_run_id: input.latestVerificationRunId ?? null,
      metric_run_id: null,
      idempotency_key: `lead_invoker/${k3}`,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: `pr=${prRef.id} commit=${commitSha} surface=${surfaceId}`,
      timestamp: now,
      surface_ref: surfaceId,
    });

    return {
      kind: "succeeded",
      receipt,
      reviewSurface: surface,
      commitSha,
      pushSha: commitSha,
      prRef,
      leadIntent,
      envelope: agentOut.envelope,
      receiptPath,
      intentPath,
    };
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * PR #119 review P1a (gpt5.5): resolve the active ReviewSurface for a
 * lead invocation when one already exists. Returns `null` for brand-new
 * surfaces. Inputs:
 *
 *   - slice path: `Slice.review_surface_id` (Phase 2 inner).
 *   - milestone path: `Milestone.review_surface_ids[<phase_key>]` (outer).
 *
 * Without this loader, callers passed `existingSurface: null` unconditionally
 * so a reviewer's `request_changes` always opened a brand-new PR on the next
 * lead pass — the §9 follow-up commit recovery transition was unreachable.
 */
export async function loadExistingReviewSurfaceForLead(
  input:
    | { parentKind: "slice"; reviewSurfaceId: string | undefined }
    | {
        parentKind: "milestone";
        phase: ReviewSurfaceParentPhase | null;
        reviewSurfaceIds:
          | {
              discovery?: string;
              specification?: string;
              planning?: string;
              validation?: string;
            }
          | undefined;
      },
  deps: { store: StorePort },
): Promise<ReviewSurfaceT | null> {
  let surfaceId: string | undefined;
  if (input.parentKind === "slice") {
    surfaceId = input.reviewSurfaceId;
  } else {
    const map = input.reviewSurfaceIds;
    if (map == null || input.phase == null) return null;
    switch (input.phase) {
      case "Discovery":
        surfaceId = map.discovery;
        break;
      case "Specification":
        surfaceId = map.specification;
        break;
      case "Planning":
        surfaceId = map.planning;
        break;
      case "Validation":
        surfaceId = map.validation;
        break;
      default:
        surfaceId = undefined;
    }
  }
  if (surfaceId == null || surfaceId.length === 0) return null;
  const body = await deps.store.readText(layout.reviewSurface(surfaceId));
  if (body == null) return null;
  return ReviewSurface.parse(JSON.parse(body));
}

function buildCommitMessage(
  summary: string,
  trailerKey: string,
  idempotencyKey: string,
): string {
  // 70-char first-line summary + blank line + trailer block. Mirrors the
  // turn-worker legacy commit format ("[forge] <summary>") but we keep it
  // generic since outer phases use atlas / sentinel as the lead author.
  const head = `[lead] ${truncate(summary, 70)}`;
  return `${head}\n\n${trailerKey}: ${idempotencyKey}\n`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

interface EnvelopePatchArtifacts {
  files?: Array<{ path: string; content: string }>;
  /** Optional richer LeadIntent shadow — agents that emit the new schema can
   *  surface decision_needed / verification_notes / open_questions here. */
  decision_needed?: string;
  verification_notes?: string;
  open_questions?: string;
}

/**
 * Phase 6.0d — synthesize `docs/specs/<milestone_id>/<phase>.md` from the
 * envelope's narrative artifacts when an outer-phase atlas turn produces
 * no `artifacts.files`. Mutates `envelope.artifacts.files` in place so the
 * downstream `extractPatchFiles` / `extractTrackedFilesFromEnvelope`
 * helpers stay the single source of truth for the commit payload.
 *
 * The synthesized markdown serializes LeadIntent.summary +
 * envelope.artifacts narrative fields. Mirrors the
 * `outer Discovery → docs/specs/<milestone>/discovery.md` mapping in
 * `cli-spicy-anchor.md §12 PR surface table` — the plan documented this
 * convention but the lead-invoker bridge never enforced it, so real-GH
 * outer cycles produced empty commits and `git push` rejected the
 * refspec as unmatched.
 */
function injectOuterPhaseSpecFile(
  envelope: Envelope,
  input: {
    milestoneId: string;
    phase: string;
    leadIntent: LeadIntent;
  },
): void {
  const slug = (input.phase ?? "draft").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const path = `docs/specs/${input.milestoneId}/${slug}.md`;
  const content = renderOuterPhaseMarkdown({
    milestoneId: input.milestoneId,
    phase: input.phase,
    leadIntent: input.leadIntent,
    artifacts: envelope.artifacts,
  });
  // Defensive: build/extend `artifacts.files` without trampling other
  // fields the agent emitted (problem_framing, scope_boundary, etc.).
  const artifacts =
    envelope.artifacts != null && typeof envelope.artifacts === "object"
      ? { ...(envelope.artifacts as Record<string, unknown>) }
      : ({} as Record<string, unknown>);
  const existing = Array.isArray((artifacts as { files?: unknown }).files)
    ? ((artifacts as { files?: unknown }).files as unknown[])
    : [];
  artifacts.files = [...existing, { path, content }];
  envelope.artifacts = artifacts as Envelope["artifacts"];
}

function renderOuterPhaseMarkdown(input: {
  milestoneId: string;
  phase: string;
  leadIntent: LeadIntent;
  artifacts: unknown;
}): string {
  const a =
    input.artifacts != null && typeof input.artifacts === "object"
      ? (input.artifacts as Record<string, unknown>)
      : {};
  const lines: string[] = [];
  lines.push(`# ${input.phase} — ${input.milestoneId}`);
  lines.push("");
  if (input.leadIntent.summary.length > 0) {
    lines.push("## Summary");
    lines.push("");
    lines.push(input.leadIntent.summary);
    lines.push("");
  }
  const sections: Array<[string, unknown]> = [
    ["Problem framing", a.problem_framing],
    ["User value", a.user_value],
    ["Scope boundary", a.scope_boundary],
    ["Assumptions", a.assumptions],
    ["Open questions", a.open_questions],
    ["Review notes", a.review_notes],
    ["Review history", a.review_history],
  ];
  for (const [title, value] of sections) {
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value.length === 0) continue;
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(
      typeof value === "string" ? value : "```json\n" + JSON.stringify(value, null, 2) + "\n```",
    );
    lines.push("");
  }
  if (
    input.leadIntent.decision_needed != null &&
    input.leadIntent.decision_needed.length > 0
  ) {
    lines.push("## Decision needed");
    lines.push("");
    lines.push(input.leadIntent.decision_needed);
    lines.push("");
  }
  if (
    input.leadIntent.open_questions != null &&
    input.leadIntent.open_questions.length > 0
  ) {
    lines.push("## Open questions (LeadIntent)");
    lines.push("");
    lines.push(input.leadIntent.open_questions);
    lines.push("");
  }
  return lines.join("\n");
}

function extractPatchFiles(
  envelope: Envelope,
): { path: string; content: string }[] {
  const a = envelope.artifacts as EnvelopePatchArtifacts | null;
  if (a == null || !Array.isArray(a.files)) return [];
  const out: { path: string; content: string }[] = [];
  for (const f of a.files) {
    if (f != null && typeof f.path === "string" && typeof f.content === "string") {
      out.push({ path: f.path, content: f.content });
    }
  }
  return out;
}

function extractTrackedFilesFromEnvelope(envelope: Envelope): string[] {
  const a = envelope.artifacts as EnvelopePatchArtifacts | null;
  if (a == null || !Array.isArray(a.files)) return [];
  const out: string[] = [];
  for (const f of a.files) {
    if (f != null && typeof f.path === "string") out.push(f.path);
  }
  return out;
}

function deriveLeadIntent(envelope: Envelope): unknown {
  const a = envelope.artifacts as EnvelopePatchArtifacts | null;
  const files = Array.isArray(a?.files)
    ? (a!.files
        .map((f) => (f != null && typeof f.path === "string" ? f.path : null))
        .filter((p): p is string => p != null && p.length > 0))
    : [];
  return {
    summary: envelope.summary && envelope.summary.length > 0
      ? envelope.summary
      : "(no summary)",
    changed_files: files,
    decision_needed:
      typeof a?.decision_needed === "string" ? a!.decision_needed : "",
    verification_notes:
      typeof a?.verification_notes === "string" ? a!.verification_notes : "",
    open_questions:
      typeof a?.open_questions === "string" ? a!.open_questions : "",
  };
}

function handleFromSurface(surface: ReviewSurfaceT): ExternalRefHandle {
  return {
    provider: surface.pr_ref.provider,
    id: surface.pr_ref.id,
    url: surface.pr_ref.url,
  };
}

// --------------------------------------------------------------------------
// Phase 4 (#122 P1-B) — receipt backfill exported helper.
//
// `recovery-coordinator` invokes this after `outbox.recover` succeeds for a
// lead-side op (commit_op / push_op / pr_open_op / pr_update_op). The outbox
// already emitted the ledger rows that make 5-gate ② full-tuple correlation
// consistent for caller-side reads; the missing piece is the
// `intents/<session>-<turn>.receipt.json` blob — without it the next PR-watcher
// pass sees `tuple_mismatch` because gate ② cannot find the receipt.
//
// The helper writes a minimal `AgentRunReceipt` (exit_status=ok,
// diagnostics_ref="recovery_backfill") so subsequent reads do not have to
// distinguish backfilled from live receipts. The caller-supplied
// `(sessionId, turnIndex, agentProfileId, parentLoop, role)` tuple identifies
// the receipt slot; subsequent fields are written from the probe payload.
//
// A `recover` ledger row is appended for audit so an operator can list every
// receipt that was reconstructed without a live agent run.
// --------------------------------------------------------------------------

export interface BackfillLeadReceiptInput {
  sessionId: string;
  turnIndex: number;
  parentLoop: ParentLoop;
  agentProfileId: LlmAgentProfileId;
  agentRoleInSession: AgentRole;
  idempotencyKey: string;
  /** Provider-local commit sha / pr id / push sha — opaque to the helper. */
  externalId: string;
  /** Optional pr id to record on the receipt's `external_pr_id`. */
  externalPrId?: string | null;
  /** Optional commit sha — distinct from externalId for pr_open_op recovery. */
  commitSha?: string | null;
  surfaceRef?: string | null;
}

export interface BackfillLeadReceiptDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export async function backfillLeadReceiptFromRecovery(
  input: BackfillLeadReceiptInput,
  deps: BackfillLeadReceiptDeps,
): Promise<{ result: "applied" | "duplicate"; receiptPath: string }> {
  const receiptPath = layout.agentRunReceipt(input.sessionId, input.turnIndex);
  const existing = await deps.store.readText(receiptPath);
  if (existing != null && existing.length > 0) {
    // The live invoker already persisted the receipt — recovery is a no-op
    // for the file but we still append a `recover` ledger row so duplicate
    // recoveries are auditable.
    await appendLeadBackfillLedger(input, deps, "duplicate");
    return { result: "duplicate", receiptPath };
  }
  const now = deps.clock.isoNow();
  const receipt: AgentRunReceiptT = AgentRunReceipt.parse({
    session_id: input.sessionId,
    turn_index: input.turnIndex,
    parent_loop: input.parentLoop,
    agent_profile_id: input.agentProfileId,
    agent_role_in_session: input.agentRoleInSession,
    idempotency_key: input.idempotencyKey,
    diagnostics_ref: "recovery_backfill",
    external_review_id: null,
    external_pr_id: input.externalPrId ?? null,
    commit_sha: input.commitSha ?? null,
    exit_status: "ok",
    recorded_at: now,
  });
  await deps.store.writeAtomic(receiptPath, JSON.stringify(receipt, null, 2));
  await appendLeadBackfillLedger(input, deps, "applied");
  return { result: "applied", receiptPath };
}

async function appendLeadBackfillLedger(
  input: BackfillLeadReceiptInput,
  deps: BackfillLeadReceiptDeps,
  result: "applied" | "duplicate",
): Promise<void> {
  await deps.ledger.appendTransition({
    transition_id: newId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: input.sessionId,
    object_kind: "session_turn",
    from_state: null,
    to_state: "receipt_backfilled",
    loop_kind: input.parentLoop,
    phase: null,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: input.sessionId,
    turn_index: input.turnIndex,
    slot_kind: null,
    agent_profile_id: input.agentProfileId,
    contribution_kind: null,
    action_kind: "recover",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: `lead_invoker/recovery_backfill/${input.idempotencyKey}`,
    lease_token: null,
    lease_kind: null,
    result: result === "applied" ? "recovered" : "duplicate",
    result_detail: input.externalId,
    timestamp: deps.clock.isoNow(),
    ...(input.surfaceRef ? { surface_ref: input.surfaceRef } : {}),
  });
}
