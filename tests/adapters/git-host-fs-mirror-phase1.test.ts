import { afterEach, describe, expect, it } from "vitest";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { MemoryStore } from "../../src/adapters/store/memory.js";

function makeHost(): { host: FsMirrorGitHost; store: MemoryStore } {
  const store = new MemoryStore();
  return { host: new FsMirrorGitHost(store), store };
}

describe("FsMirrorGitHost — Phase 1 review surface", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it("submitPullRequestReview persists + listPullRequestReviews returns it", async () => {
    const { host } = makeHost();
    const pr = await host.openPullRequest({
      title: "T",
      body: "B",
      headBranch: "feat/x",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const submit = await host.submitPullRequestReview({
      prRef: pr,
      intent: "approve",
      body: "lgtm\n<!-- llm-team:review-machine\nidempotency_key: K1\n-->",
      idempotencyKey: "K1",
    });
    expect(submit.externalReviewId).toBe("1");
    const reviews = await host.listPullRequestReviews(pr);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.state).toBe("approved");
  });

  it("findReviewByMachineKey returns the matching review (last-match probe)", async () => {
    const { host } = makeHost();
    const pr = await host.openPullRequest({
      title: "T",
      body: "B",
      headBranch: "feat/x",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await host.submitPullRequestReview({
      prRef: pr,
      intent: "request_changes",
      body: "needs work\n<!-- llm-team:review-machine\nidempotency_key: K1\n-->",
      idempotencyKey: "K1",
    });
    const probe = await host.findReviewByMachineKey(pr, "K1");
    expect(probe).not.toBeNull();
    expect(probe!.state).toBe("changes_requested");
    expect(await host.findReviewByMachineKey(pr, "MISS")).toBeNull();
  });

  it("findOpenPullRequestByMachineKey + findPullRequestByBodyMachineKey", async () => {
    const { host } = makeHost();
    const pr = await host.openPullRequest({
      title: "T",
      body: "intro\n<!-- llm-team:pr-machine\nidempotency_key: PR-1\n-->",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const found = await host.findOpenPullRequestByMachineKey("slice/abc", "PR-1");
    expect(found?.id).toBe(pr.id);
    expect(await host.findOpenPullRequestByMachineKey("slice/abc", "OTHER")).toBeNull();
    const direct = await host.findPullRequestByBodyMachineKey(pr, "PR-1");
    expect(direct?.id).toBe(pr.id);
  });

  it("getPullRequestMergeState reflects mergePullRequest", async () => {
    const { host } = makeHost();
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    expect((await host.getPullRequestMergeState(pr)).state).toBe("open");
    const merged = await host.mergePullRequest({
      prRef: pr,
      strategy: "squash",
    });
    expect(merged.mergeCommitSha).toContain("merge-");
    const state = await host.getPullRequestMergeState(pr);
    expect(state.state).toBe("merged");
    expect(state.mergeCommitSha).toBe(merged.mergeCommitSha);
  });

  it("addLabel / removeLabel / listLabels probe", async () => {
    const { host } = makeHost();
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: ["pre"],
    });
    expect(await host.listLabels(pr)).toEqual(["pre"]);
    await host.addLabel(pr, "review/needs-changes");
    expect((await host.listLabels(pr)).sort()).toEqual([
      "pre",
      "review/needs-changes",
    ]);
    await host.removeLabel(pr, "pre");
    expect(await host.listLabels(pr)).toEqual(["review/needs-changes"]);
  });

  it("dismissReview transitions review state", async () => {
    const { host } = makeHost();
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const submit = await host.submitPullRequestReview({
      prRef: pr,
      intent: "approve",
      body: "k",
      idempotencyKey: "RKEY",
    });
    await host.dismissReview({
      prRef: pr,
      externalReviewId: submit.externalReviewId,
      message: "bye",
    });
    const review = await host.getReview(pr, submit.externalReviewId);
    expect(review?.state).toBe("dismissed");
  });

  it("getPullRequestDiff returns seeded diff", async () => {
    const { host } = makeHost();
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await host.seedDiff(pr, "diff --git a b");
    expect(await host.getPullRequestDiff(pr)).toBe("diff --git a b");
  });
});
