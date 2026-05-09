/**
 * GitHub TeamMembershipPort adapter — `gh api` wrapper.
 *
 * Endpoint:
 *   GET /orgs/{org}/teams/{team_slug}/memberships/{username}
 *   - 200 → state: "active"|"pending" → member when "active"
 *   - 404 → non-member
 *   - 5xx / auth / transport → unreachable
 *
 * The team identifier is split on "/" (org/slug). Single-segment values are
 * rejected as an unreachable result — operators MUST configure
 * `governance.human_team` as `<org>/<team_slug>` for the GitHub adapter.
 *
 * In-process TTL cache: positive (`member`) results cache for `ttlMs`,
 * negative (`non_member`) cache for a much shorter window so role flips
 * propagate quickly. `unreachable` is never cached.
 */

import type {
  MembershipResult,
  TeamMembershipPort,
} from "../../ports/team-membership.js";
import type { ClockPort } from "../../ports/clock.js";
import type { GhExec } from "../issue-tracker/github.js";

const PROVIDER = "github";

/** Default short TTL for non-member results so role removals propagate. */
const NON_MEMBER_TTL_MS = 30_000;

interface CacheEntry {
  kind: "member" | "non_member";
  expiresAtMs: number;
}

export interface GitHubTeamMembershipOptions {
  exec: GhExec;
  clock: ClockPort;
  /** Member-result TTL in ms. Mirrors `governance.human_team_cache_ttl_seconds`. */
  ttlMs: number;
}

export class GitHubTeamMembership implements TeamMembershipPort {
  static readonly provider = PROVIDER;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: GitHubTeamMembershipOptions) {
    if (opts.ttlMs <= 0) {
      throw new Error("GitHubTeamMembership: ttlMs must be positive");
    }
  }

  async isMember(team: string, actor: string): Promise<MembershipResult> {
    if (team.length === 0 || actor.length === 0) {
      throw new Error("GitHubTeamMembership.isMember: team/actor required");
    }
    const slash = team.indexOf("/");
    if (slash <= 0 || slash === team.length - 1) {
      return {
        kind: "unreachable",
        detail: `team=${team} not in <org>/<slug> form`,
      };
    }
    const org = team.slice(0, slash);
    const slug = team.slice(slash + 1);

    const key = `${org}/${slug}::${actor}`;
    const now = this.opts.clock.now();
    // PR #79 review (P1): sweep expired entries on every call so the Map
    // does not grow unbounded over a long-running daemon. The cost is O(n)
    // per call but `n` is bounded by active (team, actor) pairs in the TTL
    // window; a bounded LRU could be substituted later if profiling shows
    // hot-path overhead.
    for (const [k, v] of this.cache) {
      if (v.expiresAtMs <= now) this.cache.delete(k);
    }
    const cached = this.cache.get(key);
    if (cached != null && cached.expiresAtMs > now) {
      return { kind: cached.kind };
    }

    const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
      slug,
    )}/memberships/${encodeURIComponent(actor)}`;

    let stdout: string;
    try {
      const res = await this.opts.exec.run(["api", path]);
      stdout = res.stdout;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // gh api returns non-zero on 404 — distinguish 404 from real failure.
      if (/HTTP 404/i.test(msg) || /Not Found/i.test(msg)) {
        this.cache.set(key, {
          kind: "non_member",
          expiresAtMs: now + NON_MEMBER_TTL_MS,
        });
        return { kind: "non_member" };
      }
      return { kind: "unreachable", detail: msg };
    }

    let parsed: { state?: string };
    try {
      parsed = JSON.parse(stdout) as { state?: string };
    } catch (err) {
      return {
        kind: "unreachable",
        detail: `JSON parse failed: ${(err as Error).message}`,
      };
    }
    if (parsed.state === "active") {
      this.cache.set(key, {
        kind: "member",
        expiresAtMs: now + this.opts.ttlMs,
      });
      return { kind: "member" };
    }
    // `pending` (invitation not accepted) is treated as non-member — the
    // user has not yet joined the team in any operational sense.
    this.cache.set(key, {
      kind: "non_member",
      expiresAtMs: now + NON_MEMBER_TTL_MS,
    });
    return { kind: "non_member" };
  }
}
