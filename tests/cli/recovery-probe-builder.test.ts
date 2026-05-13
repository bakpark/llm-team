/**
 * Issue #126 — production probe routing unit tests.
 *
 * Covers per-`op_kind` probe construction by `buildProductionProbeBuilder`:
 *
 *   - non-null probe shapes for all 9 op_kinds when the supporting context
 *     (ReviewSurface JSON, result_detail payload) is present;
 *   - null fallback when the surface is absent (pr_open_op first attempt)
 *     or label/dismiss payload is missing — the RecoveryCoordinator emits
 *     `recovered_skipped: no_probe` for those, which is the correct
 *     fallback rather than a dead-zone regression.
 *
 * Each probe is then executed via `runOutboxProbe` against the fake
 * adapters to confirm routing actually resolves to the right port method.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { layout } from "../../src/application/persistence-layout.js";
import { runOutboxProbe } from "../../src/application/outbox.js";
import type { PendingOutboxRow } from "../../src/application/recovery-coordinator.js";
import type { OutboxRecoveryCandidate } from "../../src/application/outbox.js";
import { buildProductionProbeBuilder } from "../../src/cli/recovery-probe-builder.js";
import type { ReviewSurface as ReviewSurfaceT } from "../../src/domain/schema/review-surface.js";

const TARGET = "demo";
const CALLER = "test-caller";
const SURFACE_ID = "01HZSR0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const BRANCH = `slice/${SLICE_ID}`;
const HEAD_SHA = "abc1234567890abcdef1234567890abcdef1234";

async function seedSurface(
  store: MemoryStore,
  overrides: Partial<ReviewSurfaceT> = {},
): Promise<ReviewSurfaceT> {
  const surface: ReviewSurfaceT = {
    review_surface_id: SURFACE_ID,
    parent_kind: "slice",
    parent_id: SLICE_ID,
    parent_phase: null,
    pr_ref: {
      provider: "fs_mirror",
      id: "1",
      node_id: null,
      url: "fs-mirror://prs/1",
    },
    branch: BRANCH,
    base_ref: "main",
    head_sha: HEAD_SHA,
    review_round: 0,
    lifecycle_state: "open",
    review_state: "pending_review",
    build_state: "ready",
    latest_verification_run_id: null,
    last_synced_external_revision: null,
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
    ...overrides,
  };
  await store.writeAtomic(
    layout.reviewSurface(SURFACE_ID),
    JSON.stringify(surface),
  );
  return surface;
}

function pending(
  opKind: PendingOutboxRow["opKind"],
  overrides: Partial<PendingOutboxRow> = {},
): PendingOutboxRow {
  return {
    opKind,
    idempotencyKey: "K-TEST",
    surfaceRef: SURFACE_ID,
    sessionId: null,
    turnIndex: null,
    agentProfileId: null,
    loopKind: null,
    callerId: CALLER,
    targetId: TARGET,
    objectId: SURFACE_ID,
    manifestId: null,
    resultDetail: null,
    ...overrides,
  };
}

function candidate(
  opKind: OutboxRecoveryCandidate["opKind"],
  key = "K-TEST",
): OutboxRecoveryCandidate {
  return { opKind, idempotencyKey: key, mode: "pending_without_posted" };
}

function makeDeps() {
  const store = new MemoryStore();
  const gitHost = new FsMirrorGitHost(store);
  const wsRoot = mkdtempSync(join(tmpdir(), "rpb-"));
  const workspace = new FakeWorkspace(wsRoot);
  return { store, gitHost, workspace };
}

describe("buildProductionProbeBuilder · per-op_kind routing", () => {
  it("commit_op → non-null probe; routes to workspace.findCommitByTrailer", async () => {
    const { store, gitHost, workspace } = makeDeps();
    await seedSurface(store);
    const idemKey = "K-COMMIT";
    workspace.seedCommitTrailer(BRANCH, "commit-sha-A", {
      "Idempotency-Key": idemKey,
    });
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("commit_op", idemKey),
      pending("commit_op", { idempotencyKey: idemKey }),
    );
    expect(probe).not.toBeNull();
    expect(probe!.opKind).toBe("commit_op");
    const probeRes = await runOutboxProbe({
      ...(probe!),
      // Outbox.recover injects idempotencyKey before calling runOutboxProbe.
      idempotencyKey: idemKey,
    } as unknown as Parameters<typeof runOutboxProbe>[0]);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe("commit-sha-A");
  });

  it("push_op → non-null probe; routes to workspace.getRemoteHeadSha", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    workspace.seedRemoteHead("origin", surface.branch, surface.head_sha);
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(candidate("push_op"), pending("push_op"));
    expect(probe).not.toBeNull();
    expect(probe!.opKind).toBe("push_op");
    const probeRes = await runOutboxProbe(probe!);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe(surface.head_sha);
  });

  it("pr_open_op → non-null probe; routes to gitHost.findOpenPullRequestByMachineKey", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    const idemKey = "K-OPEN";
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: `body\n<!-- llm-team:pr-machine\nidempotency_key: ${idemKey}\n-->`,
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("pr_open_op", idemKey),
      pending("pr_open_op", { idempotencyKey: idemKey }),
    );
    expect(probe).not.toBeNull();
    expect(probe!.opKind).toBe("pr_open_op");
    const probeRes = await runOutboxProbe({
      ...(probe!),
      idempotencyKey: idemKey,
    } as unknown as Parameters<typeof runOutboxProbe>[0]);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe(opened.id);
  });

  it("pr_open_op without surface AND without payload hints → null (no_probe)", async () => {
    const { store, gitHost, workspace } = makeDeps();
    // No surface seeded; pending row carries no `branch` payload hint.
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("pr_open_op"),
      pending("pr_open_op"),
    );
    expect(probe).toBeNull();
  });

  it("pr_open_op without surface but WITH payload branch hint → non-null probe (PR #127 review P1-1 surface-less fallback)", async () => {
    const { store, gitHost, workspace } = makeDeps();
    // No surface — Case A crash window between `outbox.begin(pr_open_op)`
    // and the Step 8 ReviewSurface write. Lead-invoker persists `branch`
    // on the pending row payload so recovery can still probe.
    const idemKey = "K-OPEN-NO-SURFACE";
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: `body\n<!-- llm-team:pr-machine\nidempotency_key: ${idemKey}\n-->`,
      headBranch: BRANCH,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("pr_open_op", idemKey),
      pending("pr_open_op", {
        idempotencyKey: idemKey,
        surfaceRef: null,
        resultDetail: JSON.stringify({ branch: BRANCH }),
      }),
    );
    expect(probe).not.toBeNull();
    expect(probe!.opKind).toBe("pr_open_op");
    const probeRes = await runOutboxProbe({
      ...(probe!),
      idempotencyKey: idemKey,
    } as unknown as Parameters<typeof runOutboxProbe>[0]);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe(opened.id);
  });

  it("commit_op without surface but WITH payload branch hint → non-null probe (PR #127 review P1-1)", async () => {
    const { store, gitHost, workspace } = makeDeps();
    // No surface seeded — first-attempt crash window for commit_op.
    const idemKey = "K-COMMIT-NO-SURFACE";
    workspace.seedCommitTrailer(BRANCH, "commit-sha-X", {
      "Idempotency-Key": idemKey,
    });
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("commit_op", idemKey),
      pending("commit_op", {
        idempotencyKey: idemKey,
        surfaceRef: null,
        resultDetail: JSON.stringify({
          branch: BRANCH,
          trailerKey: "Idempotency-Key",
        }),
      }),
    );
    expect(probe).not.toBeNull();
    const probeRes = await runOutboxProbe({
      ...(probe!),
      idempotencyKey: idemKey,
    } as unknown as Parameters<typeof runOutboxProbe>[0]);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe("commit-sha-X");
  });

  it("push_op without surface but WITH payload branch+headSha hints → non-null probe (PR #127 review P1-1)", async () => {
    const { store, gitHost, workspace } = makeDeps();
    // No surface seeded — Case A crash window for push_op.
    const expectedSha = "push-sha-X";
    workspace.seedRemoteHead("origin", BRANCH, expectedSha);
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("push_op", "K-PUSH-NO-SURFACE"),
      pending("push_op", {
        idempotencyKey: "K-PUSH-NO-SURFACE",
        surfaceRef: null,
        resultDetail: JSON.stringify({
          branch: BRANCH,
          headSha: expectedSha,
          remote: "origin",
        }),
      }),
    );
    expect(probe).not.toBeNull();
    const probeRes = await runOutboxProbe(probe!);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe(expectedSha);
  });

  it("pr_update_op → non-null probe; routes to gitHost.findPullRequestByBodyMachineKey", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    const idemKey = "K-UPDATE";
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await gitHost.updatePullRequestBody({
      prRef: opened,
      body: `body\n<!-- llm-team:pr-machine\nidempotency_key: ${idemKey}\n-->`,
    });
    // Surface pr_ref already points at the opened PR.
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("pr_update_op", idemKey),
      pending("pr_update_op", { idempotencyKey: idemKey }),
    );
    expect(probe).not.toBeNull();
    expect(probe!.opKind).toBe("pr_update_op");
    const probeRes = await runOutboxProbe({
      ...(probe!),
      idempotencyKey: idemKey,
    } as unknown as Parameters<typeof runOutboxProbe>[0]);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe(opened.id);
  });

  it("submit_review_op → non-null probe; routes to gitHost.findReviewByMachineKey", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    const idemKey = "K-SUBMIT";
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const submitted = await gitHost.submitPullRequestReview({
      prRef: opened,
      intent: "approve",
      body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
      idempotencyKey: idemKey,
    });
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("submit_review_op", idemKey),
      pending("submit_review_op", { idempotencyKey: idemKey }),
    );
    expect(probe).not.toBeNull();
    const probeRes = await runOutboxProbe({
      ...(probe!),
      idempotencyKey: idemKey,
    } as unknown as Parameters<typeof runOutboxProbe>[0]);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe(submitted.externalReviewId);
  });

  it("merge_op → non-null probe; routes to gitHost.getPullRequestMergeState", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await gitHost.mergePullRequest({ prRef: opened, strategy: "squash" });
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(candidate("merge_op"), pending("merge_op"));
    expect(probe).not.toBeNull();
    const probeRes = await runOutboxProbe(probe!);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toMatch(/^merge-1-/);
  });

  it("add_label_op → non-null probe when result_detail carries {label}; routes to gitHost.listLabels", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await gitHost.addLabel(opened, "ready-for-review");
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("add_label_op"),
      pending("add_label_op", {
        resultDetail: JSON.stringify({ label: "ready-for-review" }),
      }),
    );
    expect(probe).not.toBeNull();
    expect(probe!.opKind).toBe("add_label_op");
    const probeRes = await runOutboxProbe(probe!);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe("ready-for-review");
  });

  it("add_label_op without result_detail.label → null (no_probe until Phase 6+ invoker)", async () => {
    const { store, gitHost, workspace } = makeDeps();
    await seedSurface(store);
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("add_label_op"),
      pending("add_label_op"),
    );
    expect(probe).toBeNull();
  });

  it("remove_label_op → non-null probe; expect=absent semantic", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    // Label was never added → removal probe with expect=absent should pass.
    void opened;
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("remove_label_op"),
      pending("remove_label_op", {
        resultDetail: JSON.stringify({ label: "never-added" }),
      }),
    );
    expect(probe).not.toBeNull();
    expect(probe!.opKind).toBe("remove_label_op");
    if (probe!.opKind === "remove_label_op") {
      expect(probe!.expect).toBe("absent");
    }
    const probeRes = await runOutboxProbe(probe!);
    expect(probeRes.recovered).toBe(true);
  });

  it("dismiss_review_op → non-null probe when result_detail carries {externalReviewId}", async () => {
    const { store, gitHost, workspace } = makeDeps();
    const surface = await seedSurface(store);
    const opened = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const submitted = await gitHost.submitPullRequestReview({
      prRef: opened,
      intent: "request_changes",
      body: "body",
      idempotencyKey: "K-PRE",
    });
    await gitHost.dismissReview({
      prRef: opened,
      externalReviewId: submitted.externalReviewId,
      reason: "stale",
    });
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("dismiss_review_op"),
      pending("dismiss_review_op", {
        resultDetail: JSON.stringify({
          externalReviewId: submitted.externalReviewId,
        }),
      }),
    );
    expect(probe).not.toBeNull();
    const probeRes = await runOutboxProbe(probe!);
    expect(probeRes.recovered).toBe(true);
    expect(probeRes.externalId).toBe(submitted.externalReviewId);
  });

  it("dismiss_review_op without externalReviewId payload → null", async () => {
    const { store, gitHost, workspace } = makeDeps();
    await seedSurface(store);
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(
      candidate("dismiss_review_op"),
      pending("dismiss_review_op"),
    );
    expect(probe).toBeNull();
  });

  it("missing pending row → null (defensive)", async () => {
    const { store, gitHost, workspace } = makeDeps();
    await seedSurface(store);
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    const probe = await build(candidate("submit_review_op"), null);
    expect(probe).toBeNull();
  });

  it("surface resolved via objectId when surfaceRef is null (lead-invoker path)", async () => {
    const { store, gitHost, workspace } = makeDeps();
    await seedSurface(store);
    workspace.seedRemoteHead("origin", BRANCH, HEAD_SHA);
    const build = buildProductionProbeBuilder({ store, workspace, gitHost });
    // Lead-invoker omits surfaceRef on push_op pending row; the builder
    // must fall through to objectId to load the surface.
    const probe = await build(
      candidate("push_op"),
      pending("push_op", { surfaceRef: null, objectId: SURFACE_ID }),
    );
    expect(probe).not.toBeNull();
    const probeRes = await runOutboxProbe(probe!);
    expect(probeRes.recovered).toBe(true);
  });
});
