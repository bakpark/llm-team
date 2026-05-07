/**
 * Workspace dispatch helper (worktree-pr-lifecycle.md §3 매트릭스).
 *
 * Picks the right workspace handle for a given (parent_loop, agent_role)
 * combination so dialogue-coordinator / turn-worker do not need to know
 * the AGC-WORKSPACE rules:
 *
 *   - inner forge `lead_draft` → mutable slice-local worktree
 *     (`prepareInnerWorkspace`).
 *   - middle review reviewer / lead → read-only checkout pinned to the
 *     SliceMerge's pre_merge_workspace_revision (`prepareReadOnlyCheckout`).
 *   - any other combination is currently unsupported (phase 5 introduces
 *     outer loops).
 *
 * Returning a `mutable: false` flag forces callers to route through the
 * read-only path so they cannot accidentally hand a reviewer a writable
 * worktree.
 */
import type { ParentLoop } from "../domain/schema/contribution.js";
import type { PreparedWorkspace, WorkspacePort } from "../ports/workspace.js";

export type AgentWorkspaceRole = "lead" | "reviewer" | "observer";

export interface AgentWorkspaceRequest {
  parentLoop: ParentLoop;
  phaseOrPurpose: string;
  agentRoleInSession: AgentWorkspaceRole;
  agentProfileId: string;
  sliceId: string;
  /**
   * For inner mutable workspaces, the trunk base (carried on the slice).
   * For middle review read-only checkouts, the SliceMerge's
   * pre_merge_workspace_revision.
   */
  revision: string;
}

export interface AgentWorkspaceHandle extends PreparedWorkspace {
  mutable: boolean;
}

/**
 * P1-8 fix (PR #62 review): explicit allow-list of (parent_loop,
 * phase_or_purpose, role, profile) tuples. Anything not in this table is
 * rejected. Inv #4 (Caller-only operational write) requires the mutable
 * workspace path to be reachable only by inner forge `lead_draft`; any
 * other tuple must route through the read-only checkout, but only the
 * tuples that actually appear in the AGC-CONTRIBUTION-OUTPUTS matrix are
 * legal. Phase 5 extends this list when outer loops arrive.
 */
const ALLOWED_TUPLES: readonly {
  parentLoop: ParentLoop;
  phaseOrPurpose: string;
  agentRoleInSession: AgentWorkspaceRole;
  agentProfileId: string;
  mutable: boolean;
}[] = [
  // Inner TDD build: forge lead receives mutable slice-local worktree.
  {
    parentLoop: "inner",
    phaseOrPurpose: "tdd_build",
    agentRoleInSession: "lead",
    agentProfileId: "forge",
    mutable: true,
  },
  // Middle review: sentinel lead, atlas / forge reviewers (worktree-pr-
  // lifecycle.md §3 매트릭스). Each gets the same read-only checkout.
  {
    parentLoop: "middle",
    phaseOrPurpose: "review",
    agentRoleInSession: "lead",
    agentProfileId: "sentinel",
    mutable: false,
  },
  {
    parentLoop: "middle",
    phaseOrPurpose: "review",
    agentRoleInSession: "reviewer",
    agentProfileId: "atlas",
    mutable: false,
  },
  {
    parentLoop: "middle",
    phaseOrPurpose: "review",
    agentRoleInSession: "reviewer",
    agentProfileId: "forge",
    mutable: false,
  },
];

export async function prepareAgentWorkspace(
  req: AgentWorkspaceRequest,
  workspace: WorkspacePort,
): Promise<AgentWorkspaceHandle> {
  const allowed = ALLOWED_TUPLES.find(
    (t) =>
      t.parentLoop === req.parentLoop &&
      t.phaseOrPurpose === req.phaseOrPurpose &&
      t.agentRoleInSession === req.agentRoleInSession &&
      t.agentProfileId === req.agentProfileId,
  );
  if (allowed == null) {
    throw new Error(
      `prepareAgentWorkspace: unsupported combination (parent_loop=${req.parentLoop}, phase_or_purpose=${req.phaseOrPurpose}, role=${req.agentRoleInSession}, profile=${req.agentProfileId})`,
    );
  }
  if (allowed.mutable) {
    const prep = await workspace.prepareInnerWorkspace({
      sliceId: req.sliceId,
      trunkBaseRevision: req.revision,
    });
    return { ...prep, mutable: true };
  }
  const prep = await workspace.prepareReadOnlyCheckout({
    sliceId: req.sliceId,
    revision: req.revision,
  });
  return { ...prep, mutable: false };
}

/** Test / introspection — phase-3 conformance asserts dispatch-matrix coverage. */
export const ALLOWED_AGENT_WORKSPACE_TUPLES = ALLOWED_TUPLES;
