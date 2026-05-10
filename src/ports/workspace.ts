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

  /**
   * incident-8: returns the current trunk HEAD revision (the SHA the inner
   * agent will branch from when `prepareInnerWorkspace` is invoked next).
   * Used by outer-loop callers to capture a real revision pin instead of
   * propagating placeholder strings into Slice.trunk_base_revision /
   * DialogueSession.workspace_revision_pin.
   */
  getTrunkHead(): Promise<string>;

  /**
   * incident-8: verify that the supplied string resolves to a real git
   * commit object. Returns true when the ref exists, false otherwise.
   * Used to gate `persist_slice_dag_and_promote` — slice DAG envelopes
   * carrying a placeholder `trunk_base_revision` are rejected before any
   * slice is persisted.
   */
  verifyRef(ref: string): Promise<boolean>;

  // ---------- Phase 1 additive surface (cli-spicy-anchor.md §7-2) ----------

  /**
   * Walk back at most `depth` commits on `branch` looking for a commit whose
   * message contains a trailer line `<trailerKey>: <value>`. Returns the
   * commit SHA if found, null otherwise. Used by `commit_op` outbox probe.
   */
  findCommitByTrailer(input: {
    branch: string;
    trailerKey: string;
    value: string;
    depth?: number;
  }): Promise<string | null>;

  /**
   * Returns the SHA at `<remote>/<branch>` (best-effort). Used by `push_op`
   * outbox probe to confirm a push that may have succeeded server-side
   * before the daemon crashed.
   */
  getRemoteHeadSha(input: { remote: string; branch: string }): Promise<string | null>;

  /**
   * Push the slice-local branch to `<remote>/<branch>`. Used by `push_op`
   * in the PR-first lead-invoker flow. The implementation MUST be a no-op
   * when the remote already matches the local branch head (re-runs after
   * outbox crash). Throws on real push failure so the caller can record
   * `outbox_failed` and bail out.
   */
  push(input: { sliceId: string; remote: string; branch: string }): Promise<void>;

  /**
   * Reset the slice worktree to `sha` (`git reset --hard <sha>`). Used by
   * lead-invoker to recover a dirty worktree before retrying parse/call.
   * The supplied sha must already be reachable from the worktree.
   */
  resetHard(input: { sliceId: string; sha: string }): Promise<void>;

  /**
   * `git clean -fdx` inside the slice worktree. Pairs with `resetHard` for
   * dirty-worktree retry recovery (cli-spicy-anchor.md §8 retry cap).
   */
  cleanForce(input: { sliceId: string }): Promise<void>;
}
