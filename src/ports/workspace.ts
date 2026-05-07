/**
 * Workspace port (#AGC-WORKSPACE).
 *
 * Phase 2 inner-only surface: prepares a slice-local mutable worktree,
 * applies envelope artefacts, commits to the slice-local branch, and
 * reports the current head revision (for revision_pin recheck).
 *
 * Read-only checkout (middle review) and trunk rebase (SliceMerge) are
 * deferred to phase 3.
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
}
