/**
 * Phase 3 reviewer-invoker — PR-first orchestrator for a single reviewer
 * agent invocation (sentinel / scout middle review).
 *
 * Authority: `cli-spicy-anchor.md` §1 (capability — reviewer read=scoped,
 * edit=deny, bash=deny, network=deny), §2 (ReviewSurface), §5
 * (ReviewerIntent + AgentRunReceipt), §7 (outbox 2-phase + submit_review_op
 * dedup probe), §8 (reviewer boundary), §11 (review body machine block +
 * sanitize + nonce).
 *
 * Pipeline (one invocation):
 *   1. WorkspacePort.prepareReadOnlyCheckout(slice, headBefore)
 *   2. Sanitize incoming diff (GitHostPort.getPullRequestDiff) + prior
 *      reviews of the current round (last 3, sanitized)
 *   3. callAgent (read-only manifest pre-built by caller) — retryCap=3
 *      attempts on parse / lr_invoke failure
 *   4. Derive ReviewerIntent from envelope.verdict + envelope.summary +
 *      envelope.artifacts.file_comments, then validate via the schema
 *   5. L4 post-call diff allowlist (reviewerReadOnly=true):
 *      WorkspacePort.getReadOnlyWorktreeChanges must be empty. Any tracked
 *      diff = capability_violation_l4_reviewer_modified → abandon
 *   6. sanitizeMarkdown over body + file_comments[].body so an agent-injected
 *      `<!-- llm-team:review-machine ... -->` cannot survive past the
 *      Caller-appended last-match block
 *   7. outbox.begin(submit_review_op,k) → GitHostPort.submitPullRequestReview
 *      with body tail = `<!-- llm-team:review-machine ... -->` 9 fields +
 *      nonce → outbox.complete (probe: findReviewByMachineKey)
 *   8. AgentRunReceipt persist (external_review_id captured) +
 *      ReviewerIntent persist + ledger row append
 *
 * Reviewer is read-only — no commit/push/PR-body update. dirty-worktree
 * retry recovery (resetHard + cleanForce) is unnecessary because the
 * checkout never mutates; on retry the same revision is re-pinned.
 */

import { newId } from "../domain/ids.js";
import {
  AgentRunReceipt,
  type AgentRunReceipt as AgentRunReceiptT,
} from "../domain/schema/agent-run-receipt.js";
import {
  ReviewerIntent as ReviewerIntentSchema,
  type ReviewerIntent,
  type ReviewerFileComment,
} from "../domain/schema/reviewer-intent.js";
import {
  ReviewSurface,
  type ReviewSurface as ReviewSurfaceT,
} from "../domain/schema/review-surface.js";
import type { Envelope } from "../domain/schema/envelope.js";
import type { ContextManifest } from "../domain/schema/manifest.js";
import type { ClockPort } from "../ports/clock.js";
import type {
  GitHostPort,
  ReviewFileComment as PortReviewFileComment,
  ReviewIntent as PortReviewIntent,
} from "../ports/git-host.js";
import type { ExternalRefHandle } from "../ports/issue-tracker.js";
import type {
  AgentRole,
  LlmAgentProfileId,
  LlmRunnerPort,
  ParentLoop,
} from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import type { WorkspacePort } from "../ports/workspace.js";
import { callAgent, type AgentIoOutcome } from "./agent-io.js";
import {
  buildCanonicalString,
  computeNonce,
  renderBlock,
  type ReviewCanonicalFields,
  sanitizeMarkdown,
} from "./machine-block.js";
import type { ManifestBuilder } from "./manifest-builder.js";
import { Outbox } from "./outbox.js";
import { layout } from "./persistence-layout.js";
import {
  checkPostCallDiffAllowlist,
  type DiffAllowlistViolation,
} from "./post-call-diff-allowlist.js";
import type { LedgerAppender } from "./ledger.js";
import type { IdempotencyParts } from "./idempotency.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface ReviewerInvokerCfg {
  callerId: string;
  targetId: string;
  /** parse / lr_invoke retry cap (cli-spicy-anchor.md §8). */
  retryCap?: number;
  /** Optional fixed agent timeout. */
  agentTimeoutSec?: number;
}

export interface ReviewerInvokerDeps {
  store: StorePort;
  clock: ClockPort;
  llmRunner: LlmRunnerPort;
  workspace: WorkspacePort;
  gitHost: GitHostPort;
  ledger: LedgerAppender;
  /** HMAC secret for review-machine block (cli-spicy-anchor.md §11-3). */
  machineBlockSecret: string;
  /** Optional workdir root for predictable prompt persistence. */
  workdirRoot?: string;
  /** Outbox dependency (constructed externally so tests can inspect). */
  outbox: Outbox;
}

export interface ReviewerInvokerInput {
  /** Agent identity. */
  agentProfileId: LlmAgentProfileId;
  agentRoleInSession: AgentRole;
  parentLoop: ParentLoop;
  /** Phase or purpose label (e.g. "review"). */
  phaseOrPurpose: string;
  sessionId: string;
  turnIndex: number;
  /** Slice id used for the read-only checkout. */
  sliceId: string;
  /** Revision the reviewer's read-only checkout pins to. */
  workspaceRevision: string;
  /** The active ReviewSurface — required (PR must already exist for reviewer). */
  reviewSurface: ReviewSurfaceT;
  /** Pre-built context manifest (caller threads ManifestBuilder + drafts). */
  manifest: ContextManifest;
  manifestBuilder: ManifestBuilder;
  /** Idempotency parts for the agent envelope (legacy contract). */
  envelopeIdempotency: IdempotencyParts;
  /** Optional metadata bag for AGC-OUTPUT-RUNTIME-ENRICH. */
  runtimeMetadata?: Record<string, unknown>;
}

export type ReviewerInvokerOutcome =
  | {
      kind: "succeeded";
      receipt: AgentRunReceiptT;
      reviewerIntent: ReviewerIntent;
      externalReviewId: string;
      envelope: Envelope;
      receiptPath: string;
      intentPath: string;
    }
  | {
      kind: "abandoned";
      reason:
        | "agent_call_failed"
        | "reviewer_intent_invalid"
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

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

export class ReviewerInvoker {
  constructor(
    private readonly cfg: ReviewerInvokerCfg,
    private readonly deps: ReviewerInvokerDeps,
  ) {}

  async invoke(input: ReviewerInvokerInput): Promise<ReviewerInvokerOutcome> {
    const retryCap = this.cfg.retryCap ?? DEFAULT_RETRY_CAP;
    const prHandle = handleFromSurface(input.reviewSurface);

    // ---- Step 1: read-only checkout ---------------------------------------
    const prep = await this.deps.workspace.prepareReadOnlyCheckout({
      sliceId: input.sliceId,
      revision: input.workspaceRevision,
    });

    // ---- Step 2/3: callAgent loop with retry cap --------------------------
    let attempt = 0;
    let agentOut: AgentIoOutcome | null = null;
    let reviewerIntent: ReviewerIntent | null = null;
    let lastFailure: { reason: string; detail: string } | null = null;

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
          workspaceRevisionPin: input.workspaceRevision,
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
        const derived = deriveReviewerIntent(agentOut.envelope);
        const parsed = ReviewerIntentSchema.safeParse(derived);
        if (parsed.success) {
          reviewerIntent = parsed.data;
          break;
        }
        lastFailure = {
          reason: "reviewer_intent_invalid",
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
      // Reviewer is read-only — no dirty-worktree recovery between retries.
    }

    if (reviewerIntent == null || agentOut == null || !agentOut.ok) {
      return {
        kind: "abandoned",
        reason:
          lastFailure?.reason === "reviewer_intent_invalid"
            ? "reviewer_intent_invalid"
            : "agent_call_failed",
        detail: lastFailure?.detail ?? "unknown",
        attempts: attempt,
      };
    }

    // ---- Step 5: L4 post-call diff allowlist (reviewer read-only) ---------
    const trackedChanges = await this.deps.workspace.getReadOnlyWorktreeChanges(
      { sliceId: input.sliceId },
    );
    const allow = checkPostCallDiffAllowlist({
      declaredChangedFiles: [],
      trackedChangedFiles: trackedChanges,
      reviewerReadOnly: true,
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

    // ---- Step 6/7: outbox submit_review_op --------------------------------
    const k = newId(this.deps.clock.now());
    const surfaceId = input.reviewSurface.review_surface_id;
    const reviewRound = input.reviewSurface.review_round;
    const canonicalFields: ReviewCanonicalFields = {
      review_surface_id: surfaceId,
      parent_kind: input.reviewSurface.parent_kind,
      parent_id: input.reviewSurface.parent_id,
      parent_phase: input.reviewSurface.parent_phase ?? "n/a",
      review_round: String(reviewRound),
      session_id: input.sessionId,
      turn_index: String(input.turnIndex),
      agent_profile_id: input.agentProfileId,
      idempotency_key: k,
    };
    // Sanity: canonical_string must build cleanly so the nonce lookup is
    // deterministic at parse-side.
    buildCanonicalString("review", canonicalFields);

    const reviewBody = composeReviewBody({
      intent: reviewerIntent,
      canonicalFields,
      machineBlockSecret: this.deps.machineBlockSecret,
    });

    await this.deps.outbox.begin({
      opKind: "submit_review_op",
      idempotencyKey: k,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId: surfaceId,
      manifestId: input.manifest.manifest_id,
      surfaceRef: surfaceId,
      // PR-123 P0-1: receipt tuple → outbox_pending → recovery backfill.
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      agentProfileId: input.agentProfileId,
      loopKind: input.parentLoop,
    });
    let externalReviewId: string;
    try {
      const submitted = await this.deps.gitHost.submitPullRequestReview({
        prRef: prHandle,
        intent: toPortIntent(reviewerIntent.intent),
        body: reviewBody,
        fileComments: reviewerIntent.file_comments.map(toPortFileComment),
        idempotencyKey: k,
      });
      externalReviewId = submitted.externalReviewId;
    } catch (e) {
      await this.deps.outbox.complete({
        opKind: "submit_review_op",
        idempotencyKey: k,
        status: "failed",
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        objectId: surfaceId,
        manifestId: input.manifest.manifest_id,
        surfaceRef: surfaceId,
      });
      return {
        kind: "abandoned",
        reason: "outbox_failed",
        detail: `submit_review_op: ${(e as Error).message}`,
        attempts: attempt,
      };
    }
    await this.deps.outbox.complete({
      opKind: "submit_review_op",
      idempotencyKey: k,
      status: "posted",
      externalId: externalReviewId,
      externalReviewId,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId: surfaceId,
      manifestId: input.manifest.manifest_id,
      surfaceRef: surfaceId,
    });

    // ---- Step 8: AgentRunReceipt + ReviewerIntent persist + ledger row ----
    const now = this.deps.clock.isoNow();
    const receipt: AgentRunReceiptT = AgentRunReceipt.parse({
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      parent_loop: input.parentLoop,
      agent_profile_id: input.agentProfileId,
      agent_role_in_session: input.agentRoleInSession,
      idempotency_key: k,
      diagnostics_ref: agentOut.diagnosticsRef,
      external_review_id: externalReviewId,
      external_pr_id: prHandle.id,
      commit_sha: null,
      exit_status: "ok",
      recorded_at: now,
    });
    const receiptPath = layout.agentRunReceipt(input.sessionId, input.turnIndex);
    const intentPath = layout.reviewerIntent(input.sessionId, input.turnIndex);
    await this.deps.store.writeAtomic(
      receiptPath,
      JSON.stringify(receipt, null, 2),
    );
    await this.deps.store.writeAtomic(
      intentPath,
      JSON.stringify(reviewerIntent, null, 2),
    );

    await this.deps.ledger.appendTransition({
      transition_id: newId(this.deps.clock.now()),
      target_id: this.cfg.targetId,
      object_id: surfaceId,
      object_kind: "system",
      from_state: null,
      to_state: "reviewer_invocation_succeeded",
      loop_kind: input.parentLoop,
      phase: null,
      slice_id:
        input.reviewSurface.parent_kind === "slice"
          ? input.reviewSurface.parent_id
          : null,
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
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: `reviewer_invoker/${k}`,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: `review=${externalReviewId} pr=${prHandle.id} surface=${surfaceId}`,
      timestamp: now,
      surface_ref: surfaceId,
      external_review_id: externalReviewId,
    });

    return {
      kind: "succeeded",
      receipt,
      reviewerIntent,
      externalReviewId,
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
 * PR #119 review P1a (gpt5.5) parallel — resolve the active ReviewSurface
 * for a reviewer invocation. Returns null when no surface is reachable
 * (caller short-circuits to envelope path or abandons).
 *
 *   - slice path: `SliceMerge.review_surface_id` falls through `Slice
 *     .review_surface_id` when SliceMerge lacks the link.
 *   - milestone path: outer phase reviewer reuses `Milestone
 *     .review_surface_ids[<phase_key>]` (same map as
 *     `loadExistingReviewSurfaceForLead`).
 */
export async function loadReviewSurfaceForReviewer(
  reviewSurfaceId: string | undefined | null,
  deps: { store: StorePort },
): Promise<ReviewSurfaceT | null> {
  if (reviewSurfaceId == null || reviewSurfaceId.length === 0) return null;
  const body = await deps.store.readText(layout.reviewSurface(reviewSurfaceId));
  if (body == null) return null;
  return ReviewSurface.parse(JSON.parse(body));
}

function toPortIntent(intent: ReviewerIntent["intent"]): PortReviewIntent {
  return intent === "approve" ? "approve" : "request_changes";
}

function toPortFileComment(c: ReviewerFileComment): PortReviewFileComment {
  return {
    path: c.path,
    line: c.line,
    startLine: c.start_line,
    body: sanitizeMarkdown(c.body),
  };
}

interface ReviewerEnvelopeArtifacts {
  body?: string;
  file_comments?: Array<{
    path?: string;
    line?: number;
    start_line?: number | null;
    body?: string;
  }>;
}

function deriveReviewerIntent(envelope: Envelope): unknown {
  const a = envelope.artifacts as ReviewerEnvelopeArtifacts | null;
  // Map envelope.verdict.result → ReviewerIntent.intent. The reviewer's
  // envelope contract narrows verdict.result to "approve" / "request_changes"
  // for middle review; anything else is rejected by the schema.
  const verdictResult = envelope.verdict?.result;
  const fallbackBody =
    typeof a?.body === "string" && a.body.length > 0
      ? a.body
      : envelope.summary;
  // file_comments pass through unfiltered so the strict ReviewerIntent
  // schema surfaces structural errors (path/line/body shape) as
  // `reviewer_intent_invalid` instead of silently dropping malformed
  // comments. Caller defaults the array when artifacts omit it.
  const fileComments = Array.isArray(a?.file_comments)
    ? a!.file_comments
    : [];
  return {
    intent: verdictResult,
    body: fallbackBody,
    file_comments: fileComments,
  };
}

interface ComposeReviewBodyInput {
  intent: ReviewerIntent;
  canonicalFields: ReviewCanonicalFields;
  machineBlockSecret: string;
}

/**
 * Build the review body: sanitized agent-authored prose followed by the
 * canonical `<!-- llm-team:review-machine ... -->` block. last-match
 * semantics ensure any agent-injected machine block earlier in `body` is
 * shadowed by the Caller-appended block.
 */
function composeReviewBody(input: ComposeReviewBodyInput): string {
  const sanitized = sanitizeMarkdown(input.intent.body).trim();
  const nonce = computeNonce(
    input.machineBlockSecret,
    "review",
    input.canonicalFields,
  );
  const block = renderBlock("review", input.canonicalFields, nonce);
  return sanitized.length > 0 ? `${sanitized}\n\n${block}\n` : `${block}\n`;
}

function handleFromSurface(surface: ReviewSurfaceT): ExternalRefHandle {
  return {
    provider: surface.pr_ref.provider,
    id: surface.pr_ref.id,
    url: surface.pr_ref.url,
  };
}

// --------------------------------------------------------------------------
// Phase 4 (#122 P1-B) — reviewer receipt backfill exported helper.
//
// Mirrors `backfillLeadReceiptFromRecovery`. `recovery-coordinator` invokes
// this after `outbox.recover` succeeds for a reviewer-side op
// (submit_review_op / dismiss_review_op). The persisted receipt restores
// gate ② full-tuple correlation in the PR-watcher 5-gate.
// --------------------------------------------------------------------------

export interface BackfillReviewerReceiptInput {
  sessionId: string;
  turnIndex: number;
  parentLoop: ParentLoop;
  agentProfileId: LlmAgentProfileId;
  agentRoleInSession: AgentRole;
  idempotencyKey: string;
  /** Provider-local review id captured via `findReviewByMachineKey`. */
  externalReviewId: string;
  externalPrId?: string | null;
  surfaceRef?: string | null;
}

export interface BackfillReviewerReceiptDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export async function backfillReviewerReceiptFromRecovery(
  input: BackfillReviewerReceiptInput,
  deps: BackfillReviewerReceiptDeps,
): Promise<{ result: "applied" | "duplicate"; receiptPath: string }> {
  const receiptPath = layout.agentRunReceipt(input.sessionId, input.turnIndex);
  const existing = await deps.store.readText(receiptPath);
  if (existing != null && existing.length > 0) {
    await appendReviewerBackfillLedger(input, deps, "duplicate");
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
    external_review_id: input.externalReviewId,
    external_pr_id: input.externalPrId ?? null,
    commit_sha: null,
    exit_status: "ok",
    recorded_at: now,
  });
  await deps.store.writeAtomic(receiptPath, JSON.stringify(receipt, null, 2));
  await appendReviewerBackfillLedger(input, deps, "applied");
  return { result: "applied", receiptPath };
}

async function appendReviewerBackfillLedger(
  input: BackfillReviewerReceiptInput,
  deps: BackfillReviewerReceiptDeps,
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
    idempotency_key: `reviewer_invoker/recovery_backfill/${input.idempotencyKey}`,
    lease_token: null,
    lease_kind: null,
    result: result === "applied" ? "recovered" : "duplicate",
    result_detail: input.externalReviewId,
    timestamp: deps.clock.isoNow(),
    ...(input.surfaceRef ? { surface_ref: input.surfaceRef } : {}),
    external_review_id: input.externalReviewId,
  });
}
