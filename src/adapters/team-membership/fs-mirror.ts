/**
 * FS-mirror TeamMembershipPort — deterministic team allowlist used by tests
 * and self-hosting targets without GitHub Teams API access.
 *
 * Layout: `external_mirror/teams/<team>.json` containing
 *   { "members": ["alice", "bob"] }       (allowlist)
 *
 * Or `external_mirror/teams/<team>.unreachable` (empty file) to simulate the
 * unreachable branch for policy tests. Team string is sanitized into the
 * filename via `safeTeamFile` (replaces `/` with `__`).
 */

import type { StorePort } from "../../ports/store.js";
import type {
  MembershipResult,
  TeamMembershipPort,
} from "../../ports/team-membership.js";

const PROVIDER = "fs-mirror";
const ROOT = "external_mirror/teams";

function safeTeamFile(team: string): string {
  return team.replace(/\//g, "__");
}

function teamPath(team: string): string {
  return `${ROOT}/${safeTeamFile(team)}.json`;
}

function unreachableMarker(team: string): string {
  return `${ROOT}/${safeTeamFile(team)}.unreachable`;
}

export class FsMirrorTeamMembership implements TeamMembershipPort {
  static readonly provider = PROVIDER;

  constructor(private readonly store: StorePort) {}

  async isMember(team: string, actor: string): Promise<MembershipResult> {
    if (team.length === 0 || actor.length === 0) {
      throw new Error("FsMirrorTeamMembership.isMember: team/actor required");
    }
    const marker = await this.store.readText(unreachableMarker(team));
    if (marker != null) {
      return {
        kind: "unreachable",
        detail: `fs-mirror: simulated unreachable for ${team}`,
      };
    }
    const raw = await this.store.readText(teamPath(team));
    if (raw == null) {
      return {
        kind: "unreachable",
        detail: `fs-mirror: team file missing (${teamPath(team)})`,
      };
    }
    let parsed: { members?: unknown };
    try {
      parsed = JSON.parse(raw) as { members?: unknown };
    } catch (err) {
      return {
        kind: "unreachable",
        detail: `fs-mirror: JSON parse failed: ${(err as Error).message}`,
      };
    }
    if (!Array.isArray(parsed.members)) {
      return {
        kind: "unreachable",
        detail: `fs-mirror: members not an array in ${teamPath(team)}`,
      };
    }
    const ok = parsed.members.some((m) => m === actor);
    return ok ? { kind: "member" } : { kind: "non_member" };
  }
}

/**
 * Test helper — write an allowlist for a team. Production callers should
 * never use this; signal-source operators populate the mirror via their
 * normal mirror-sync pipeline.
 */
export async function writeFsMirrorTeam(
  store: StorePort,
  team: string,
  members: readonly string[],
): Promise<void> {
  await store.writeAtomic(
    teamPath(team),
    JSON.stringify({ members: [...members] }, null, 2),
  );
}

/** Test helper — simulate an unreachable team lookup. */
export async function writeFsMirrorTeamUnreachable(
  store: StorePort,
  team: string,
): Promise<void> {
  await store.writeAtomic(unreachableMarker(team), "");
}
