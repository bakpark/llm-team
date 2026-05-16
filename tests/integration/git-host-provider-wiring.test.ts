/**
 * Phase 6.0a — `governance.git_host_provider` factory routing.
 *
 * Audit §5-D Phase 6 follow-up: the daemon previously hardcoded
 * `FsMirrorGitHost` regardless of target config, so the `GitHubGitHost`
 * adapter (475 lines, fully implemented) was dead code. This test pins the
 * factory: `buildGitHost` MUST route to the right adapter based on
 * `cfg.governance.git_host_provider`, and the github branch MUST consult
 * the injected `GhExec` stub (no real `gh` CLI / network).
 *
 * Coverage:
 *   1. provider="fs-mirror" (default) → FsMirrorGitHost.
 *   2. provider="github" + repo set → GitHubGitHost; openPullRequest
 *      consults GhExec and parses the resulting URL.
 *   3. provider="github" without repo → throws at factory time
 *      (defensive duplicate of the schema cross-field check).
 *   4. governance block absent → defaults to fs-mirror (backward compat).
 *   5. Schema cross-field validation rejects provider="github" w/o repo.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { buildGitHost } from "../../src/adapters/git-host/factory.js";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { GitHubGitHost } from "../../src/adapters/git-host/github.js";
import { Governance } from "../../src/config/target-schema.js";
import type { GhExec, GhExecResult } from "../../src/adapters/issue-tracker/github.js";

class RecordingGhExec implements GhExec {
  public readonly calls: string[][] = [];
  constructor(private readonly canned: GhExecResult) {}
  async run(args: string[]): Promise<GhExecResult> {
    this.calls.push(args);
    return this.canned;
  }
}

const baseGovernance = {
  human_team: "acme/dev",
  control_issue_number: 9001,
  contract_change_issue_number: 9002,
};

describe("buildGitHost (Phase 6.0a) — provider routing", () => {
  it("provider=\"fs-mirror\" (default) returns FsMirrorGitHost", () => {
    const store = new MemoryStore();
    const gov = Governance.parse({ ...baseGovernance });
    const host = buildGitHost(gov, { store });
    expect(host).toBeInstanceOf(FsMirrorGitHost);
  });

  it("governance absent → defaults to fs-mirror (backward compat)", () => {
    const store = new MemoryStore();
    const host = buildGitHost(undefined, { store });
    expect(host).toBeInstanceOf(FsMirrorGitHost);
  });

  it("provider=\"github\" with repo set → GitHubGitHost, opens PR via injected GhExec", async () => {
    const store = new MemoryStore();
    const gov = Governance.parse({
      ...baseGovernance,
      git_host_provider: "github",
      git_host_repo: "acme/widgets",
    });
    const exec = new RecordingGhExec({
      stdout: "https://github.com/acme/widgets/pull/42\n",
      stderr: "",
      exitCode: 0,
    });
    const host = buildGitHost(gov, { store, ghExec: exec });
    expect(host).toBeInstanceOf(GitHubGitHost);

    const ref = await host.openPullRequest({
      headBranch: "slice/abc",
      baseBranch: "main",
      title: "test PR",
      body: "body",
      draft: false,
      labels: [],
    });
    expect(ref).toEqual({
      provider: "github",
      id: "42",
      url: "https://github.com/acme/widgets/pull/42",
    });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]).toContain("--repo");
    expect(exec.calls[0]).toContain("acme/widgets");
  });

  it("provider=\"github\" missing repo at factory → throws (defensive)", () => {
    const store = new MemoryStore();
    // Bypass the schema refine by constructing the object directly — the
    // factory must self-defend so a hand-built Governance can't crash the
    // daemon at the first PR call.
    const gov = {
      ...baseGovernance,
      signal_command_prefix: "/",
      human_team_cache_ttl_seconds: 300,
      human_team_provider: "fs-mirror" as const,
      unauthorized_author_alert: false,
      git_host_provider: "github" as const,
      // git_host_repo intentionally omitted
    };
    expect(() => buildGitHost(gov as never, { store })).toThrow(
      /git_host_repo.*required/,
    );
  });

  it("provider=\"github\" applies labelPrefix when configured", async () => {
    const store = new MemoryStore();
    const gov = Governance.parse({
      ...baseGovernance,
      git_host_provider: "github",
      git_host_repo: "acme/widgets",
      git_host_label_prefix: "smoke",
    });
    const exec = new RecordingGhExec({
      stdout: "https://github.com/acme/widgets/pull/7\n",
      stderr: "",
      exitCode: 0,
    });
    const host = buildGitHost(gov, { store, ghExec: exec });

    await host.openPullRequest({
      headBranch: "slice/x",
      baseBranch: "main",
      title: "labeled PR",
      body: "body",
      draft: false,
      labels: ["needs-review"],
    });
    const args = exec.calls[0]!;
    expect(args).toContain("smoke/needs-review");
  });
});

describe("Governance schema — git_host_* cross-field validation", () => {
  it("provider=\"github\" without git_host_repo → schema parse fails", () => {
    expect(() =>
      Governance.parse({
        ...baseGovernance,
        git_host_provider: "github",
      }),
    ).toThrow(/git_host_repo.*required/);
  });

  it("provider=\"github\" with git_host_repo → parses", () => {
    const gov = Governance.parse({
      ...baseGovernance,
      git_host_provider: "github",
      git_host_repo: "owner/name",
    });
    expect(gov.git_host_provider).toBe("github");
    expect(gov.git_host_repo).toBe("owner/name");
  });

  it("provider omitted defaults to fs-mirror", () => {
    const gov = Governance.parse({ ...baseGovernance });
    expect(gov.git_host_provider).toBe("fs-mirror");
    expect(gov.git_host_repo).toBeUndefined();
  });
});
