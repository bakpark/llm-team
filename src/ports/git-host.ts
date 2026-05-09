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
}
