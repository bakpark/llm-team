import { describe, expect, it } from "vitest";
import { GitHubTeamMembership } from "../../src/adapters/team-membership/github.js";
import type { GhExec } from "../../src/adapters/issue-tracker/github.js";
import { FixedClock } from "../../src/ports/clock.js";

class MockExec implements GhExec {
  calls: string[][] = [];
  constructor(
    private readonly handler: (args: string[]) => Promise<{ stdout: string }>,
  ) {}
  async run(args: string[]): Promise<{ stdout: string }> {
    this.calls.push(args);
    return this.handler(args);
  }
}

describe("GitHubTeamMembership", () => {
  it("active state → member; subsequent call within ttl uses cache", async () => {
    let calls = 0;
    const exec = new MockExec(async () => {
      calls += 1;
      return { stdout: JSON.stringify({ state: "active" }) };
    });
    const port = new GitHubTeamMembership({
      exec,
      clock: new FixedClock(0),
      ttlMs: 60_000,
    });
    const a = await port.isMember("acme/reviewers", "alice");
    expect(a.kind).toBe("member");
    const b = await port.isMember("acme/reviewers", "alice");
    expect(b.kind).toBe("member");
    expect(calls).toBe(1);
  });

  it("404 from gh api → non_member", async () => {
    const exec = new MockExec(async () => {
      throw new Error("gh: HTTP 404: Not Found");
    });
    const port = new GitHubTeamMembership({
      exec,
      clock: new FixedClock(0),
      ttlMs: 60_000,
    });
    const r = await port.isMember("acme/reviewers", "mallory");
    expect(r.kind).toBe("non_member");
  });

  it("transport error (non-404) → unreachable", async () => {
    const exec = new MockExec(async () => {
      throw new Error("gh: connection reset");
    });
    const port = new GitHubTeamMembership({
      exec,
      clock: new FixedClock(0),
      ttlMs: 60_000,
    });
    const r = await port.isMember("acme/reviewers", "alice");
    expect(r.kind).toBe("unreachable");
  });

  it("pending state → non_member (invitation not accepted)", async () => {
    const exec = new MockExec(async () => ({
      stdout: JSON.stringify({ state: "pending" }),
    }));
    const port = new GitHubTeamMembership({
      exec,
      clock: new FixedClock(0),
      ttlMs: 60_000,
    });
    const r = await port.isMember("acme/reviewers", "alice");
    expect(r.kind).toBe("non_member");
  });

  it("malformed team string (no slash) → unreachable", async () => {
    const exec = new MockExec(async () => ({ stdout: "{}" }));
    const port = new GitHubTeamMembership({
      exec,
      clock: new FixedClock(0),
      ttlMs: 60_000,
    });
    const r = await port.isMember("reviewers", "alice");
    expect(r.kind).toBe("unreachable");
    // exec should not have been invoked.
    expect(exec.calls.length).toBe(0);
  });

  it("ttl expiry triggers re-fetch", async () => {
    let calls = 0;
    const exec = new MockExec(async () => {
      calls += 1;
      return { stdout: JSON.stringify({ state: "active" }) };
    });
    const clock = new FixedClock(0);
    const port = new GitHubTeamMembership({ exec, clock, ttlMs: 1_000 });
    await port.isMember("acme/reviewers", "alice");
    clock.advance(2_000);
    await port.isMember("acme/reviewers", "alice");
    expect(calls).toBe(2);
  });

  it("PR #79 P1: expired entries swept from cache on subsequent calls", async () => {
    const exec = new MockExec(async () => ({
      stdout: JSON.stringify({ state: "active" }),
    }));
    const clock = new FixedClock(0);
    const port = new GitHubTeamMembership({ exec, clock, ttlMs: 1_000 });
    await port.isMember("acme/reviewers", "alice");
    // Internal cache holds 1 entry. Advance past TTL and look up a different
    // actor — sweep should evict the stale "alice" entry.
    clock.advance(2_000);
    await port.isMember("acme/reviewers", "bob");
    // Reflective access: cache size after sweep must be just the new entry.
    const cache = (port as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBe(1);
    expect(cache.has("acme/reviewers::bob")).toBe(true);
    expect(cache.has("acme/reviewers::alice")).toBe(false);
  });

  it("URL-encodes org/team/user path components", async () => {
    const exec = new MockExec(async () => ({
      stdout: JSON.stringify({ state: "active" }),
    }));
    const port = new GitHubTeamMembership({
      exec,
      clock: new FixedClock(0),
      ttlMs: 60_000,
    });
    await port.isMember("acme corp/team x", "user@dev");
    expect(exec.calls[0]).toEqual([
      "api",
      "/orgs/acme%20corp/teams/team%20x/memberships/user%40dev",
    ]);
  });
});
