/**
 * Git host port — Pull Request / review surface mirror.
 *
 * Mirrors the SliceMerge ↔ PR mapping from
 * `external-tracking-mapping.md` §4. The middle review session shares the
 * PR surface (`worktree-pr-lifecycle.md` §2) but `review_verdict` is mirrored
 * via comments / native review — this port only exposes the bare-bones PR
 * lifecycle (open/draft toggle/close/merge + label/body update).
 */

import type { ExternalRefHandle } from "./issue-tracker.js";

export interface OpenPullRequestInput {
  title: string;
  body: string;
  /** Source branch (slice-local). */
  headBranch: string;
  /** Target branch (trunk). */
  baseBranch: string;
  /** Open as draft (SM_DRAFT). */
  draft: boolean;
  labels: string[];
  /** Optional linked issue ref (Slice issue) to back-reference. */
  linkedIssueRef?: ExternalRefHandle;
}

export interface UpdatePullRequestInput {
  prRef: ExternalRefHandle;
  draft?: boolean;
  state?: "open" | "closed" | "merged";
  labels?: string[];
  title?: string;
  body?: string;
}

export interface PostPullRequestCommentInput {
  prRef: ExternalRefHandle;
  body: string;
}

/**
 * Phase 1 PR-first additive extensions (cli-spicy-anchor.md §1 step 2).
 *
 * The new methods are GitHub-specific PR / review / merge / label ops that
 * the lead-invoker / reviewer-invoker (Phase 2/3) and outbox dedup probes
 * (`cli-spicy-anchor.md §7-2`) call into. local/remote git state stays on
 * `WorkspacePort`.
 *
 * Adapters that have not yet implemented a method may throw
 * `NotImplementedError` — callers are gated on Phase 2/3 wiring. The
 * fs-mirror adapter implements the full surface for tests.
 */

export type ReviewIntent = "approve" | "request_changes" | "comment";

export interface ReviewFileComment {
  path: string;
  line: number;
  startLine?: number | null;
  body: string;
}

export interface SubmitPullRequestReviewInput {
  prRef: ExternalRefHandle;
  intent: ReviewIntent;
  body: string;
  fileComments?: ReviewFileComment[];
  /** Caller-issued ULID — mirrored into review-machine block. */
  idempotencyKey: string;
}

export interface SubmittedReview {
  /** Provider-local review id (GitHub: review id). */
  externalReviewId: string;
}

export interface ListedReview {
  externalReviewId: string;
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body: string;
  submittedAt: string | null;
}

export interface UpdatePullRequestBodyInput {
  prRef: ExternalRefHandle;
  body: string;
}

export interface MergePullRequestInput {
  prRef: ExternalRefHandle;
  /** Squash | merge | rebase. fs-mirror ignores this. */
  strategy: "squash" | "merge" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}

export interface MergePullRequestResult {
  mergeCommitSha: string;
}

export interface PullRequestMergeState {
  state: "merged" | "open" | "closed";
  mergeCommitSha: string | null;
}

export interface DismissReviewInput {
  prRef: ExternalRefHandle;
  externalReviewId: string;
  message?: string;
}

export interface GitHostPort {
  openPullRequest(input: OpenPullRequestInput): Promise<ExternalRefHandle>;
  updatePullRequest(
    input: UpdatePullRequestInput,
  ): Promise<ExternalRefHandle>;
  postPullRequestComment(
    input: PostPullRequestCommentInput,
  ): Promise<{ commentId: string }>;
  fetchPullRequest(
    prRef: ExternalRefHandle,
  ): Promise<{
    state: "open" | "closed" | "merged";
    draft: boolean;
    labels: string[];
    title: string;
    body: string;
    revision: string;
  } | null>;

  // ---------- Phase 1 additive surface (§ above) ----------

  /** Submit a review (approve / request_changes / comment). */
  submitPullRequestReview(
    input: SubmitPullRequestReviewInput,
  ): Promise<SubmittedReview>;

  listPullRequestReviews(prRef: ExternalRefHandle): Promise<ListedReview[]>;

  updatePullRequestBody(
    input: UpdatePullRequestBodyInput,
  ): Promise<ExternalRefHandle>;

  /** Returns unified diff for the PR head against base (UTF-8 text). */
  getPullRequestDiff(prRef: ExternalRefHandle): Promise<string>;

  mergePullRequest(
    input: MergePullRequestInput,
  ): Promise<MergePullRequestResult>;

  addLabel(
    prRef: ExternalRefHandle,
    label: string,
  ): Promise<ExternalRefHandle>;

  removeLabel(
    prRef: ExternalRefHandle,
    label: string,
  ): Promise<ExternalRefHandle>;

  dismissReview(input: DismissReviewInput): Promise<void>;

  // ---------- Phase 1 dedup probes (cli-spicy-anchor.md §7-2) ----------

  /**
   * Find an open PR whose body machine-block carries the given
   * idempotency_key. Used by `pr_open_op` recovery probe.
   */
  findOpenPullRequestByMachineKey(
    headBranch: string,
    idempotencyKey: string,
  ): Promise<ExternalRefHandle | null>;

  /**
   * Verify the PR's current body machine-block idempotency_key matches.
   * Used by `pr_update_op` recovery probe.
   */
  findPullRequestByBodyMachineKey(
    prRef: ExternalRefHandle,
    idempotencyKey: string,
  ): Promise<ExternalRefHandle | null>;

  /**
   * Find a review on the PR whose body machine-block carries the given
   * idempotency_key. Used by `submit_review_op` recovery probe.
   */
  findReviewByMachineKey(
    prRef: ExternalRefHandle,
    idempotencyKey: string,
  ): Promise<ListedReview | null>;

  /** Used by `merge_op` recovery probe. */
  getPullRequestMergeState(
    prRef: ExternalRefHandle,
  ): Promise<PullRequestMergeState>;

  /** Used by `add_label_op` / `remove_label_op` recovery probes. */
  listLabels(prRef: ExternalRefHandle): Promise<string[]>;

  /** Used by `dismiss_review_op` recovery probe. */
  getReview(
    prRef: ExternalRefHandle,
    externalReviewId: string,
  ): Promise<ListedReview | null>;
}
