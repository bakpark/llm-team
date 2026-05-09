/**
 * Phase 6b — GitHub mirror lifecycle integration test.
 *
 * Exercises the FsMirrorIssueTracker + FsMirrorGitHost adapters end-to-end
 * over the dispatch matrix flow:
 *   - Caller creates a Milestone → mirror creates GitHub Milestone with
 *     `slot/discovery` label and state label.
 *   - Slice persistence → Issue creation with `slice-state/*` labels.
 *   - SliceMerge open → draft PR.
 *   - SliceMerge SM_DRAFT → SM_READY_FOR_REVIEW → PR ready (draft toggle).
 *
 * Also exercises the GitHub adapter (`gh` CLI wrapper) with a mock `GhExec`
 * to confirm it produces the correct argv sequences without touching the
 * network.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FsMirrorIssueTracker } from "../../src/adapters/issue-tracker/fs-mirror.js";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import {
  GitHubIssueTracker,
  type GhExec,
} from "../../src/adapters/issue-tracker/github.js";
import { GitHubGitHost } from "../../src/adapters/git-host/github.js";

describe("Phase 6b — FsMirror lifecycle", () => {
  it("creates a milestone with slot/state labels and returns a stable ref", async () => {
    const store = new MemoryStore();
    const it1 = new FsMirrorIssueTracker(store);
    const ref = await it1.createMilestone({
      title: "M1: feature",
      stateLabel: "state/M_DISCOVERY_DRAFT",
      slotLabel: "slot/discovery",
      body: "spec body v1",
    });
    expect(ref.provider).toBe("fs-mirror");
    expect(ref.id).toBe("1");
    const fetched = await it1.fetchMilestone(ref);
    expect(fetched).not.toBeNull();
    expect(fetched!.labels).toEqual([
      "state/M_DISCOVERY_DRAFT",
      "slot/discovery",
    ]);
    expect(fetched!.title).toBe("M1: feature");
    expect(fetched!.revision).toBe("1");
  });

  it("transitions milestone state via label/body replacement", async () => {
    const store = new MemoryStore();
    const it1 = new FsMirrorIssueTracker(store);
    const ref = await it1.createMilestone({
      title: "M1",
      stateLabel: "state/M_DISCOVERY_DRAFT",
      slotLabel: "slot/discovery",
    });
    await it1.updateMilestoneState({
      milestoneRef: ref,
      labels: ["state/M_DELIVERY_BUILDING", "slot/delivery"],
      body: "spec accepted",
    });
    const fetched = await it1.fetchMilestone(ref);
    expect(fetched!.labels).toEqual([
      "state/M_DELIVERY_BUILDING",
      "slot/delivery",
    ]);
    expect(fetched!.body).toBe("spec accepted");
    expect(fetched!.revision).toBe("2");
  });

  it("Slice → Issue with slice-state labels", async () => {
    const store = new MemoryStore();
    const it1 = new FsMirrorIssueTracker(store);
    const milestone = await it1.createMilestone({ title: "M1" });
    const issue = await it1.createIssue({
      kind: "tracker",
      title: "Slice 1: foo",
      body: "AC list",
      labels: ["slice-state/pending"],
      milestoneRef: milestone,
    });
    expect(issue.id).toBe("1");
    await it1.updateIssue({
      issueRef: issue,
      labels: ["slice-state/building"],
    });
    const fetched = await it1.fetchIssue(issue);
    expect(fetched!.state).toBe("open");
    expect(fetched!.labels).toEqual(["slice-state/building"]);
    expect(fetched!.revision).toBe("2");
  });

  it("Slice closes on SLICE_VALIDATED and revision advances", async () => {
    const store = new MemoryStore();
    const it1 = new FsMirrorIssueTracker(store);
    const issue = await it1.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: ["slice-state/reviewing"],
    });
    await it1.updateIssue({
      issueRef: issue,
      labels: ["slice-state/validated"],
      state: "closed",
    });
    const fetched = await it1.fetchIssue(issue);
    expect(fetched!.state).toBe("closed");
    expect(fetched!.labels).toEqual(["slice-state/validated"]);
  });

  it("SliceMerge opens draft PR + transitions to ready (draft=false)", async () => {
    const store = new MemoryStore();
    const gh = new FsMirrorGitHost(store);
    const pr = await gh.openPullRequest({
      title: "Slice 1: foo",
      body: "draft",
      headBranch: "slice/1",
      baseBranch: "main",
      draft: true,
      labels: ["sm-state/draft"],
    });
    expect(pr.id).toBe("1");
    const initial = await gh.fetchPullRequest(pr);
    expect(initial!.draft).toBe(true);
    expect(initial!.state).toBe("open");
    await gh.updatePullRequest({
      prRef: pr,
      draft: false,
      labels: ["sm-state/ready-for-review"],
    });
    const ready = await gh.fetchPullRequest(pr);
    expect(ready!.draft).toBe(false);
    expect(ready!.labels).toEqual(["sm-state/ready-for-review"]);
  });

  it("SM_APPROVED → SM_MERGED — PR merged state + label", async () => {
    const store = new MemoryStore();
    const gh = new FsMirrorGitHost(store);
    const pr = await gh.openPullRequest({
      title: "S",
      body: "",
      headBranch: "slice/1",
      baseBranch: "main",
      draft: false,
      labels: ["sm-state/approved"],
    });
    await gh.updatePullRequest({
      prRef: pr,
      state: "merged",
      labels: ["sm-state/merged"],
    });
    const f = await gh.fetchPullRequest(pr);
    expect(f!.state).toBe("merged");
    expect(f!.labels).toEqual(["sm-state/merged"]);
  });

  it("middle review comments append without losing label state", async () => {
    const store = new MemoryStore();
    const gh = new FsMirrorGitHost(store);
    const pr = await gh.openPullRequest({
      title: "S",
      body: "",
      headBranch: "slice/1",
      baseBranch: "main",
      draft: false,
      labels: ["sm-state/ready-for-review"],
    });
    const c = await gh.postPullRequestComment({
      prRef: pr,
      body: "review_verdict=approve",
    });
    expect(c.commentId).toBe("1");
    const f = await gh.fetchPullRequest(pr);
    expect(f!.labels).toEqual(["sm-state/ready-for-review"]);
  });
});

describe("Phase 6b — GitHub adapter argv contract", () => {
  function captureExec(): {
    exec: GhExec;
    calls: { args: string[]; stdin?: string }[];
    stdout: string;
  } {
    const calls: { args: string[]; stdin?: string }[] = [];
    let nextStdout = "";
    const exec: GhExec = {
      async run(args, stdin) {
        calls.push({ args, stdin });
        return { stdout: nextStdout };
      },
    };
    return {
      exec,
      calls,
      get stdout() {
        return nextStdout;
      },
      set stdout(v: string) {
        nextStdout = v;
      },
    } as never;
  }

  it("createIssue invokes gh issue create + parses URL", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    let nextStdout = "https://github.com/x/y/issues/42";
    const exec: GhExec = {
      async run(args, stdin) {
        calls.push({ args, stdin });
        return { stdout: nextStdout };
      },
    };
    const it1 = new GitHubIssueTracker({ repo: "x/y", exec });
    const ref = await it1.createIssue({
      kind: "tracker",
      title: "Slice 1",
      body: "ac",
      labels: ["slice-state/pending"],
    });
    expect(ref.provider).toBe("github");
    expect(ref.id).toBe("42");
    expect(ref.url).toBe("https://github.com/x/y/issues/42");
    expect(calls[0]!.args[0]).toBe("issue");
    expect(calls[0]!.args).toContain("--title");
    expect(calls[0]!.args).toContain("Slice 1");
    expect(calls[0]!.args).toContain("--label");
    expect(calls[0]!.args).toContain("slice-state/pending");
  });

  it("createIssue applies labelPrefix override", async () => {
    const calls: { args: string[] }[] = [];
    const exec: GhExec = {
      async run(args) {
        calls.push({ args });
        return { stdout: "https://github.com/x/y/issues/1" };
      },
    };
    const it1 = new GitHubIssueTracker({
      repo: "x/y",
      exec,
      labelPrefix: "team-a",
    });
    await it1.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: ["slice-state/pending"],
    });
    const argSet = new Set(calls[0]!.args);
    expect(argSet.has("team-a/slice-state/pending")).toBe(true);
  });

  it("openPullRequest passes --draft and parses pull URL", async () => {
    const calls: { args: string[] }[] = [];
    const exec: GhExec = {
      async run(args) {
        calls.push({ args });
        return { stdout: "https://github.com/x/y/pull/9" };
      },
    };
    const gh = new GitHubGitHost({ repo: "x/y", exec });
    const ref = await gh.openPullRequest({
      title: "S",
      body: "b",
      headBranch: "slice/1",
      baseBranch: "main",
      draft: true,
      labels: ["sm-state/draft"],
    });
    expect(ref.id).toBe("9");
    expect(ref.provider).toBe("github");
    expect(calls[0]!.args).toContain("--draft");
    expect(calls[0]!.args).toContain("--head");
    expect(calls[0]!.args).toContain("slice/1");
  });

  it("updatePullRequest with draft=false issues `gh pr ready`", async () => {
    const calls: { args: string[] }[] = [];
    const exec: GhExec = {
      async run(args) {
        calls.push({ args });
        return { stdout: "" };
      },
    };
    const gh = new GitHubGitHost({ repo: "x/y", exec });
    await gh.updatePullRequest({
      prRef: { provider: "github", id: "9" },
      draft: false,
    });
    expect(calls.some((c) => c.args[0] === "pr" && c.args[1] === "ready")).toBe(
      true,
    );
  });
});
