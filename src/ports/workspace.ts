/**
 * Workspace port (#AGC-WORKSPACE).
 *
 * Phase 2 surface: prepares a slice-local mutable worktree, applies envelope
 * artefacts, commits to the slice-local branch, and reports the current head
 * revision.
 *
 * Phase 3 additions:
 *   - `prepareReadOnlyCheckout` — middle review reviewer's read-only working
 *     copy (worktree-pr-lifecycle.md §3 매트릭스). The reviewer never writes,
 *     so this is a separate handle from `prepareInnerWorkspace`.
 *   - `rebaseOntoTrunk` — SliceMerge integration step (SOC-MERGE-POLICY).
 *     Tries to fast-forward the slice-local branch onto the supplied trunk
 *     revision; clean → returns the new commit, conflict → caller dispatches
 *     SM_STALE.
 */

export interface PreparedWorkspace {
  /** Absolute path to the prepared mutable worktree. */
  agentCwd: string;
  /** Revision pin that the workspace currently points at. */
  headBefore: string;
}

export interface PatchFile {
  /** Repo-relative path. Absolute paths and `..` segments are rejected. */
  path: string;
  /** UTF-8 content. Binary not modelled in phase 2. */
  content: string;
}

export interface CommitInput {
  sliceId: string;
  message: string;
  files: PatchFile[];
}

export interface CommitResult {
  commit: string;
}

export type RebaseOutcome =
  | { result: "clean"; commit: string }
  | { result: "conflict"; reason: string };

export interface WorkspacePort {
  prepareInnerWorkspace(input: {
    sliceId: string;
    trunkBaseRevision: string;
  }): Promise<PreparedWorkspace>;

  /**
   * Atomically applies the file set then commits. Returns the new commit's
   * revision pin. The implementation is responsible for `git add` + `git
   * commit` semantics; callers see only the resulting commit hash.
   */
  commit(input: CommitInput): Promise<CommitResult>;

  /** Current head revision of the slice-local branch. */
  head(sliceId: string): Promise<string>;

  /**
   * Prepare a separate read-only checkout pinned to a specific revision so
   * a reviewer agent can inspect the slice without mutating the slice-local
   * worktree. The implementation may return a different cwd from the inner
   * workspace; callers must NOT pass this cwd to a `commit` invocation.
   */
  prepareReadOnlyCheckout(input: {
    sliceId: string;
    revision: string;
  }): Promise<PreparedWorkspace>;

  /**
   * Try to rebase the slice-local branch onto the supplied trunk revision.
   * Clean → returns the new commit. Conflict → returns a structured failure
   * so the caller can transition the SliceMerge to SM_STALE.
   */
  rebaseOntoTrunk(input: {
    sliceId: string;
    trunkRevision: string;
  }): Promise<RebaseOutcome>;
}
