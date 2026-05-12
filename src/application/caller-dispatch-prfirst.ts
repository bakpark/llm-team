/**
 * Phase 4 caller-dispatch (PR-first) — parent_kind-aware terminal dispatcher.
 *
 * Authority: `cli-spicy-anchor.md` §10 (dispatch matrix per parent_kind),
 * §9 (follow-up commit recovery transition), §6 (PR review signal), §11
 * (machine-block last-match + same-PR continuation).
 *
 * Why a second module: the legacy `caller-dispatch.ts` is keyed on
 * `(parent_loop, phase_or_purpose, final_verdict)` and executes
 * slice-merge effects. PR-first dispatch must additionally:
 *
 *   1. Mutate the active `ReviewSurface` (lifecycle / review_state /
 *      build_state / review_round) per the §10 table.
 *   2. Distinguish Discovery (PR merge X) from Specification / Planning /
 *      Validation (PR merge O via outbox merge_op).
 *   3. Honour same-PR continuation on `request_changes`: review_round++,
 *      review_state=changes_requested, build_state=rebuilding. PR **never
 *      closes**.
 *
 * Slice approve / request_changes still delegate the slice-merge plumbing
 * to the legacy `dispatchOutcome` so the existing SliceMerge transitions
 * and slice DAG progression remain a single source of truth (Surgical
 * Changes principle). The PR-first wrapper merely sits in front to update
 * the ReviewSurface in-place and (for approve) trigger the outbox merge_op.
 */

import { newId, newMonotonicId } from "../domain/ids.js";
import {
  Milestone,
  type Milestone as MilestoneT,
} from "../domain/schema/milestone.js";
import {
  ReviewSurface,
  type ReviewSurface as ReviewSurfaceT,
  type ReviewSurfaceLifecycleState,
  type ReviewSurfaceReviewState,
  type ReviewSurfaceBuildState,
  type ReviewSurfaceParentPhase,
} from "../domain/schema/review-surface.js";
import type { Slice as SliceT } from "../domain/schema/slice.js";
import type { SliceMerge as SliceMergeT } from "../domain/schema/slice-merge.js";
import type { ClockPort } from "../ports/clock.js";
import type { GitHostPort } from "../ports/git-host.js";
import type { ExternalRefHandle } from "../ports/issue-tracker.js";
import type { StorePort } from "../ports/store.js";
import type { CommandSpec, VerificationPort } from "../ports/verification.js";
import type { WorkspacePort } from "../ports/workspace.js";
import {
  dispatchOutcome,
  type DispatchDeps,
  type DispatchResult,
} from "./caller-dispatch.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { Outbox } from "./outbox.js";
import { layout } from "./persistence-layout.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export type PrFirstVerdict = "approve" | "request_changes";

export interface PrFirstDispatchSliceInput {
  parent_kind: "slice";
  /** The active ReviewSurface backing the slice's PR. */
  reviewSurface: ReviewSurfaceT;
  slice: SliceT;
  sliceMerge: SliceMergeT;
  sessionId: string;
  verdict: PrFirstVerdict;
  verificationRunId: string | null;
  trunkRevision: string;
  testCommandsForReverify: (workspaceCwd: string) => CommandSpec[];
  environmentFingerprint: string;
}

export interface PrFirstDispatchMilestoneInput {
  parent_kind: "milestone";
  reviewSurface: ReviewSurfaceT;
  milestone: MilestoneT;
  sessionId: string;
  verdict: PrFirstVerdict;
  /** Current parent_phase (Discovery / Specification / Planning / Validation). */
  parentPhase: ReviewSurfaceParentPhase;
}

export type PrFirstDispatchInput =
  | PrFirstDispatchSliceInput
  | PrFirstDispatchMilestoneInput;

export interface PrFirstDispatchCfg {
  callerId: string;
  targetId: string;
}

export interface PrFirstDispatchDeps {
  store: StorePort;
  clock: ClockPort;
  gitHost: GitHostPort;
  ledger: LedgerAppender;
  outbox: Outbox;
  workspace: WorkspacePort;
  verification: VerificationPort;
}

export type PrFirstDispatchResult =
  | {
      kind: "slice_approved";
      reviewSurface: ReviewSurfaceT;
      slice: DispatchResult;
    }
  | {
      kind: "slice_request_changes";
      reviewSurface: ReviewSurfaceT;
      slice: DispatchResult;
    }
  | {
      kind: "milestone_approved_promote";
      reviewSurface: ReviewSurfaceT;
      milestone: MilestoneT;
      mergedPr: boolean;
      mergeCommitSha: string | null;
    }
  | {
      kind: "milestone_request_changes";
      reviewSurface: ReviewSurfaceT;
      milestone: MilestoneT;
    };

// --------------------------------------------------------------------------
// Dispatcher
// --------------------------------------------------------------------------

export class PrFirstDispatcher {
  constructor(
    private readonly cfg: PrFirstDispatchCfg,
    private readonly deps: PrFirstDispatchDeps,
  ) {}

  async dispatch(input: PrFirstDispatchInput): Promise<PrFirstDispatchResult> {
    if (input.parent_kind === "slice") {
      return await this.dispatchSlice(input);
    }
    return await this.dispatchMilestone(input);
  }

  // ----------------------------------------------------------------
  // Slice — approve / request_changes
  // ----------------------------------------------------------------

  private async dispatchSlice(
    input: PrFirstDispatchSliceInput,
  ): Promise<PrFirstDispatchResult> {
    if (input.verdict === "approve") {
      // ReviewSurface: review_state=approved, lifecycle=merged, build=not_applicable
      const updatedSurface = await this.transitionSurface(
        input.reviewSurface,
        {
          lifecycle_state: "merged",
          review_state: "approved",
          // build_state intentionally unchanged for slice (still ready).
        },
      );

      // Plumb existing slice-merge promote→integrate via legacy dispatcher.
      const sliceResult = await this.runLegacySliceDispatch(input, "approve");

      // Outbox merge_op for the slice PR. cli-spicy-anchor.md §10 — slice
      // approve always merges the PR (squash). The legacy dispatch already
      // recorded slice + slice_merge transitions; we add merge_op here so
      // the PR-surface mirror reflects merged.
      await this.outboxMergePr(input.reviewSurface);

      return {
        kind: "slice_approved",
        reviewSurface: updatedSurface,
        slice: sliceResult,
      };
    }
    // request_changes — same-PR continuation: review_round++ + rebuilding.
    const updatedSurface = await this.transitionSurface(input.reviewSurface, {
      review_state: "changes_requested",
      build_state: "rebuilding",
      review_round_inc: 1,
    });
    const sliceResult = await this.runLegacySliceDispatch(
      input,
      "request_changes",
    );
    // §5 same-PR continuation explicit guarantee — we do NOT call
    // gitHost.updatePullRequest({state:"closed"}). The next lead pass will
    // commit a follow-up onto the same branch.
    return {
      kind: "slice_request_changes",
      reviewSurface: updatedSurface,
      slice: sliceResult,
    };
  }

  // ----------------------------------------------------------------
  // Milestone — Discovery / Specification / Planning / Validation
  // ----------------------------------------------------------------

  private async dispatchMilestone(
    input: PrFirstDispatchMilestoneInput,
  ): Promise<PrFirstDispatchResult> {
    if (input.verdict === "request_changes") {
      // All four milestone phases share the same shape: round++ +
      // changes_requested + rebuilding (build_state may be n/a for
      // Discovery/Specification — see ReviewSurfaceBuildState invariants).
      const updatedSurface = await this.transitionSurface(input.reviewSurface, {
        review_state: "changes_requested",
        build_state:
          input.reviewSurface.build_state === "not_applicable"
            ? "not_applicable"
            : "rebuilding",
        review_round_inc: 1,
      });
      return {
        kind: "milestone_request_changes",
        reviewSurface: updatedSurface,
        milestone: input.milestone,
      };
    }

    // approve — phase-specific transitions per §10 table.
    switch (input.parentPhase) {
      case "Discovery":
        return await this.handleDiscoveryApprove(input);
      case "Specification":
        return await this.handleSpecificationApprove(input);
      case "Planning":
        return await this.handlePlanningApprove(input);
      case "Validation":
        return await this.handleValidationApprove(input);
    }
  }

  private async handleDiscoveryApprove(
    input: PrFirstDispatchMilestoneInput,
  ): Promise<PrFirstDispatchResult> {
    // §10: PR merge X. milestone M_DISCOVERY_DRAFT → M_SPECIFICATION_DRAFT.
    // ReviewSurface parent_phase Discovery → Specification, review_state
    // approved → pending_review, review_round unchanged (monotonic).
    if (input.milestone.state !== "M_DISCOVERY_DRAFT") {
      // Idempotency: re-run after crash sees the already-promoted state and
      // becomes a no-op. We still update the surface mirror in case the
      // ReviewSurface write crashed mid-dispatch.
    }
    const milestone = await this.advanceMilestoneState(
      input.milestone,
      "M_DISCOVERY_DRAFT",
      "M_SPECIFICATION_DRAFT",
      "Discovery",
    );
    const updatedSurface = await this.transitionSurface(input.reviewSurface, {
      parent_phase: "Specification",
      review_state: "pending_review",
      // build_state stays n/a for spec_doc / milestone surfaces.
    });
    return {
      kind: "milestone_approved_promote",
      reviewSurface: updatedSurface,
      milestone,
      mergedPr: false,
      mergeCommitSha: null,
    };
  }

  private async handleSpecificationApprove(
    input: PrFirstDispatchMilestoneInput,
  ): Promise<PrFirstDispatchResult> {
    // §10: Specification approve → merge PR (squash) → M_SPECIFICATION_DRAFT
    // → M_SPEC_APPROVED. The follow-up `planning_pr_open_op` (separate
    // atlas Planning PR on `plan/<milestone>`) is deferred to the caller's
    // outer coordinator — we record the readiness only.
    const merge = await this.outboxMergePr(input.reviewSurface);
    const milestone = await this.advanceMilestoneState(
      input.milestone,
      "M_SPECIFICATION_DRAFT",
      "M_SPEC_APPROVED",
      "Specification",
    );
    const updatedSurface = await this.transitionSurface(input.reviewSurface, {
      lifecycle_state: "merged",
      review_state: "approved",
    });
    return {
      kind: "milestone_approved_promote",
      reviewSurface: updatedSurface,
      milestone,
      mergedPr: merge.merged,
      mergeCommitSha: merge.mergeCommitSha,
    };
  }

  private async handlePlanningApprove(
    input: PrFirstDispatchMilestoneInput,
  ): Promise<PrFirstDispatchResult> {
    // §10: Planning approve → merge plan/<milestone> PR → M_DELIVERY_PLANNING
    // → M_DELIVERY_BUILDING. Slice DAG persist + slice PR fan-out is
    // executed by the outer-loop dispatcher (legacy `persist_slice_dag_and_promote`
    // effect). PR-first wrapper only updates ReviewSurface + Milestone +
    // triggers merge_op.
    const merge = await this.outboxMergePr(input.reviewSurface);
    const milestone = await this.advanceMilestoneState(
      input.milestone,
      "M_DELIVERY_PLANNING",
      "M_DELIVERY_BUILDING",
      "Planning",
    );
    const updatedSurface = await this.transitionSurface(input.reviewSurface, {
      lifecycle_state: "merged",
      review_state: "approved",
    });
    return {
      kind: "milestone_approved_promote",
      reviewSurface: updatedSurface,
      milestone,
      mergedPr: merge.merged,
      mergeCommitSha: merge.mergeCommitSha,
    };
  }

  private async handleValidationApprove(
    input: PrFirstDispatchMilestoneInput,
  ): Promise<PrFirstDispatchResult> {
    // §10: Validation approve → merge_op → M_DELIVERY_VALIDATING →
    // M_DONE + (옵션) Release stub. validation_fail is handled outside
    // PR-first wrapper (legacy `recover_milestone_to_building`).
    const merge = await this.outboxMergePr(input.reviewSurface);
    const milestone = await this.advanceMilestoneState(
      input.milestone,
      "M_DELIVERY_VALIDATING",
      "M_DONE",
      "Validation",
    );
    const updatedSurface = await this.transitionSurface(input.reviewSurface, {
      lifecycle_state: "merged",
      review_state: "approved",
    });
    return {
      kind: "milestone_approved_promote",
      reviewSurface: updatedSurface,
      milestone,
      mergedPr: merge.merged,
      mergeCommitSha: merge.mergeCommitSha,
    };
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  /**
   * Outbox merge_op — wraps gitHost.mergePullRequest in the 2-phase outbox
   * dance so crash recovery works via `getPullRequestMergeState` probe.
   */
  private async outboxMergePr(
    surface: ReviewSurfaceT,
  ): Promise<{ merged: boolean; mergeCommitSha: string | null }> {
    const k = newId(this.deps.clock.now());
    const prHandle = handleFromSurface(surface);
    await this.deps.outbox.begin({
      opKind: "merge_op",
      idempotencyKey: k,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
      objectId: surface.review_surface_id,
      manifestId: null,
      surfaceRef: surface.review_surface_id,
    });
    try {
      const res = await this.deps.gitHost.mergePullRequest({
        prRef: prHandle,
        strategy: "squash",
      });
      await this.deps.outbox.complete({
        opKind: "merge_op",
        idempotencyKey: k,
        status: "posted",
        externalId: res.mergeCommitSha,
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        objectId: surface.review_surface_id,
        manifestId: null,
        surfaceRef: surface.review_surface_id,
      });
      return { merged: true, mergeCommitSha: res.mergeCommitSha };
    } catch (e) {
      await this.deps.outbox.complete({
        opKind: "merge_op",
        idempotencyKey: k,
        status: "failed",
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        objectId: surface.review_surface_id,
        manifestId: null,
        surfaceRef: surface.review_surface_id,
      });
      throw new Error(
        `outbox merge_op failed for surface=${surface.review_surface_id}: ${(e as Error).message}`,
      );
    }
  }

  private async runLegacySliceDispatch(
    input: PrFirstDispatchSliceInput,
    verdict: PrFirstVerdict,
  ): Promise<DispatchResult> {
    const dispatchDeps: DispatchDeps = {
      store: this.deps.store,
      clock: this.deps.clock,
      ledger: this.deps.ledger,
      workspace: this.deps.workspace,
      verification: this.deps.verification,
      callerId: this.cfg.callerId,
      targetId: this.cfg.targetId,
    };
    return await dispatchOutcome(
      {
        parent_loop: "middle",
        phase_or_purpose: "review",
        session_state: "CONVERGED",
        final_verdict: verdict,
        slice: input.slice,
        sliceMerge: input.sliceMerge,
        sessionId: input.sessionId,
        verificationRunId: input.verificationRunId,
        trunkRevision: input.trunkRevision,
        testCommandsForReverify: input.testCommandsForReverify,
        environmentFingerprint: input.environmentFingerprint,
      },
      dispatchDeps,
    );
  }

  private async transitionSurface(
    surface: ReviewSurfaceT,
    patch: {
      lifecycle_state?: ReviewSurfaceLifecycleState;
      review_state?: ReviewSurfaceReviewState;
      build_state?: ReviewSurfaceBuildState;
      parent_phase?: ReviewSurfaceParentPhase;
      review_round_inc?: number;
    },
  ): Promise<ReviewSurfaceT> {
    const path = layout.reviewSurface(surface.review_surface_id);
    return this.deps.store.withFileLock(path, async () => {
      const raw = await this.deps.store.readText(path);
      if (raw == null) {
        // Re-create from in-memory copy. Should not happen — ReviewSurface
        // is created earlier in the lead/reviewer-invoker — but we tolerate
        // it for test seeds that craft a surface but skip the write.
        const next = ReviewSurface.parse({
          ...surface,
          ...applyPatch(surface, patch),
          updated_at: this.deps.clock.isoNow(),
        });
        await this.deps.store.writeAtomic(path, JSON.stringify(next, null, 2));
        return next;
      }
      const live = ReviewSurface.parse(JSON.parse(raw));
      const updated = ReviewSurface.parse({
        ...live,
        ...applyPatch(live, patch),
        updated_at: this.deps.clock.isoNow(),
      });
      await this.deps.store.writeAtomic(
        path,
        JSON.stringify(updated, null, 2),
      );
      return updated;
    });
  }

  private async advanceMilestoneState(
    milestone: MilestoneT,
    expectedFrom: MilestoneT["state"],
    to: MilestoneT["state"],
    phaseLabel: ReviewSurfaceParentPhase,
  ): Promise<MilestoneT> {
    const path = layout.milestone(milestone.milestone_id);
    return this.deps.store.withFileLock(path, async () => {
      const raw = await this.deps.store.readText(path);
      if (raw == null) {
        // No on-disk milestone — write through the in-memory copy. Mirrors
        // the slice transition handler's tolerant branch.
        const next = Milestone.parse({
          ...milestone,
          state: to,
          updated_at: this.deps.clock.isoNow(),
        });
        await this.deps.store.writeAtomic(path, JSON.stringify(next, null, 2));
        await this.appendMilestonePhaseTransition(milestone, expectedFrom, to, phaseLabel);
        return next;
      }
      const live = Milestone.parse(JSON.parse(raw));
      if (live.state === to) {
        // Idempotent re-run.
        return live;
      }
      // Tolerate `live.state !== expectedFrom` — a recovery path may have
      // already progressed the milestone. We log the actual `from` in the
      // ledger row for audit and write through `to`.
      const next = Milestone.parse({
        ...live,
        state: to,
        updated_at: this.deps.clock.isoNow(),
      });
      await this.deps.store.writeAtomic(path, JSON.stringify(next, null, 2));
      await this.appendMilestonePhaseTransition(live, live.state, to, phaseLabel);
      return next;
    });
  }

  private async appendMilestonePhaseTransition(
    milestone: MilestoneT,
    from: MilestoneT["state"],
    to: MilestoneT["state"],
    phaseLabel: ReviewSurfaceParentPhase,
  ): Promise<void> {
    await this.deps.ledger.appendTransition({
      transition_id: newMonotonicId(this.deps.clock.now()),
      target_id: this.cfg.targetId,
      object_id: milestone.milestone_id,
      object_kind: "milestone",
      from_state: from,
      to_state: to,
      loop_kind: "outer",
      phase: phaseLabel,
      slice_id: null,
      slice_kind: null,
      dod_revision: null,
      session_id: null,
      turn_index: null,
      slot_kind: milestone.slot_kind,
      agent_profile_id: null,
      contribution_kind: null,
      action_kind: "session_finalize",
      final_verdict: "approve",
      caller_id: this.cfg.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: idempotencyKey({
        scope: "external_observation",
        parts: {
          kind: "milestone_phase_transition_prfirst",
          milestone_id: milestone.milestone_id,
          from,
          to,
        },
      }),
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: `phase=${phaseLabel}`,
      timestamp: this.deps.clock.isoNow(),
    });
  }
}

// --------------------------------------------------------------------------
// Free helpers
// --------------------------------------------------------------------------

function applyPatch(
  surface: ReviewSurfaceT,
  patch: {
    lifecycle_state?: ReviewSurfaceLifecycleState;
    review_state?: ReviewSurfaceReviewState;
    build_state?: ReviewSurfaceBuildState;
    parent_phase?: ReviewSurfaceParentPhase;
    review_round_inc?: number;
  },
): Partial<ReviewSurfaceT> {
  const out: Partial<ReviewSurfaceT> = {};
  if (patch.lifecycle_state != null) out.lifecycle_state = patch.lifecycle_state;
  if (patch.review_state != null) out.review_state = patch.review_state;
  if (patch.build_state != null) out.build_state = patch.build_state;
  if (patch.parent_phase != null) out.parent_phase = patch.parent_phase;
  if (patch.review_round_inc != null) {
    out.review_round = surface.review_round + patch.review_round_inc;
  }
  return out;
}

function handleFromSurface(surface: ReviewSurfaceT): ExternalRefHandle {
  return {
    provider: surface.pr_ref.provider,
    id: surface.pr_ref.id,
    url: surface.pr_ref.url,
  };
}
