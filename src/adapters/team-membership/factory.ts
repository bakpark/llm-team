/**
 * Phase 9d — `TeamMembershipPort` factory.
 *
 * The daemon previously hardcoded `FsMirrorTeamMembership` regardless of
 * `cfg.governance.human_team_provider`. This module routes to the right
 * adapter based on the schema field:
 *
 *   provider="fs-mirror" (default) → FsMirrorTeamMembership(store)
 *   provider="github"             → GitHubTeamMembership({exec, clock, ttlMs})
 *
 * The default preserves backward compatibility: deployments that never set
 * the field stay on the fs-mirror adapter. Self-hosting / GitHub-Teams-less
 * targets are unaffected.
 *
 * `GhExec` is injected (defaults to `ProcessGhExec`) so integration tests
 * can substitute a deterministic stub instead of spawning the real `gh`
 * CLI — the planning constraint mandates that real GitHub Teams API calls
 * stay confined to the adapter module.
 */

import type { ClockPort } from "../../ports/clock.js";
import type { StorePort } from "../../ports/store.js";
import type { TeamMembershipPort } from "../../ports/team-membership.js";
import type { Governance } from "../../config/target-schema.js";
import type { GhExec } from "../issue-tracker/github.js";
import { FsMirrorTeamMembership } from "./fs-mirror.js";
import { GitHubTeamMembership, ProcessGhExec } from "./github.js";

export interface BuildTeamMembershipDeps {
  store: StorePort;
  clock: ClockPort;
  /** Test-only override; production callers omit and use `ProcessGhExec`. */
  ghExec?: GhExec;
}

export function buildTeamMembership(
  governance: Governance | undefined,
  deps: BuildTeamMembershipDeps,
): TeamMembershipPort {
  // Governance block is optional in v1 (see TCC-GOVERNANCE block-optionality
  // note). When absent, fall back to fs-mirror so the call site remains
  // safe to invoke unconditionally.
  const provider = governance?.human_team_provider ?? "fs-mirror";
  switch (provider) {
    case "fs-mirror":
      return new FsMirrorTeamMembership(deps.store);
    case "github": {
      const ttlSeconds = governance?.human_team_cache_ttl_seconds ?? 300;
      return new GitHubTeamMembership({
        exec: deps.ghExec ?? new ProcessGhExec(),
        clock: deps.clock,
        ttlMs: ttlSeconds * 1_000,
      });
    }
  }
}
