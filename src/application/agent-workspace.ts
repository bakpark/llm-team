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

export async function prepareAgentWorkspace(
  req: AgentWorkspaceRequest,
  workspace: WorkspacePort,
): Promise<AgentWorkspaceHandle> {
  if (
    req.parentLoop === "inner" &&
    req.phaseOrPurpose === "tdd_build" &&
    req.agentRoleInSession === "lead" &&
    req.agentProfileId === "forge"
  ) {
    const prep = await workspace.prepareInnerWorkspace({
      sliceId: req.sliceId,
      trunkBaseRevision: req.revision,
    });
    return { ...prep, mutable: true };
  }
  if (req.parentLoop === "middle" && req.phaseOrPurpose === "review") {
    const prep = await workspace.prepareReadOnlyCheckout({
      sliceId: req.sliceId,
      revision: req.revision,
    });
    return { ...prep, mutable: false };
  }
  throw new Error(
    `prepareAgentWorkspace: unsupported combination (parent_loop=${req.parentLoop}, phase_or_purpose=${req.phaseOrPurpose}, role=${req.agentRoleInSession}, profile=${req.agentProfileId})`,
  );
}
