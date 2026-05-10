import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  Outbox,
  type OutboxOpKind,
  type ProbeContext,
  runOutboxProbe,
} from "../../src/application/outbox.js";
import { LEDGER_TRANSITIONS_PATH } from "../../src/application/persistence-layout.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = "demo";
const OBJ_ID = "01HZSO0000000000000000000A";
const MANIFEST_ID = "01HZMN0000000000000000000A";

function newOutbox(): { outbox: Outbox; store: MemoryStore; ledger: FileLedger } {
  const store = new MemoryStore();
  const ledger = new FileLedger({ store });
  const outbox = new Outbox({ store, ledger });
  return { outbox, store, ledger };
}

describe("Outbox 2-phase begin/complete", () => {
  it("begin → complete posts emit ledger rows with op_kind", async () => {
    const { outbox, store } = newOutbox();
    const r1 = await outbox.begin({
      opKind: "commit_op",
      idempotencyKey: "K1",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    expect(r1.result).toBe("applied");
    const r2 = await outbox.complete({
      opKind: "commit_op",
      idempotencyKey: "K1",
      status: "posted",
      externalId: "abc123",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    expect(r2.result).toBe("applied");
    const ndjson = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    const rows = ndjson.split("\n").filter((s) => s.length > 0).map((s) => JSON.parse(s));
    expect(rows).toHaveLength(2);
    expect(rows[0].action_kind).toBe("outbox_pending");
    expect(rows[0].op_kind).toBe("commit_op");
    expect(rows[1].action_kind).toBe("outbox_posted");
  });

  it("complete is idempotent (same key+status → duplicate)", async () => {
    const { outbox } = newOutbox();
    await outbox.begin({
      opKind: "commit_op",
      idempotencyKey: "K1",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    const a = await outbox.complete({
      opKind: "commit_op",
      idempotencyKey: "K1",
      status: "posted",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    const b = await outbox.complete({
      opKind: "commit_op",
      idempotencyKey: "K1",
      status: "posted",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    expect(a.result).toBe("applied");
    expect(b.result).toBe("duplicate");
  });
});

describe("runOutboxProbe — 8 op_kind probes", () => {
  it("commit_op uses WorkspacePort.findCommitByTrailer", async () => {
    const ws = new FakeWorkspace(mkdtempSync(join(tmpdir(), "ob-")));
    ws.seedCommitTrailer("slice/abc", "sha-1", { "Idempotency-Key": "K1" });
    const ctx: ProbeContext = {
      opKind: "commit_op",
      workspace: ws,
      branch: "slice/abc",
      trailerKey: "Idempotency-Key",
      value: "K1",
    };
    const r = await runOutboxProbe(ctx);
    expect(r.recovered).toBe(true);
    expect(r.externalId).toBe("sha-1");
  });

  it("push_op uses WorkspacePort.getRemoteHeadSha and matches expectedSha", async () => {
    const ws = new FakeWorkspace(mkdtempSync(join(tmpdir(), "ob-")));
    ws.seedRemoteHead("origin", "slice/abc", "deadbeef");
    const ok = await runOutboxProbe({
      opKind: "push_op",
      workspace: ws,
      remote: "origin",
      branch: "slice/abc",
      expectedSha: "deadbeef",
    });
    expect(ok.recovered).toBe(true);
    const fail = await runOutboxProbe({
      opKind: "push_op",
      workspace: ws,
      remote: "origin",
      branch: "slice/abc",
      expectedSha: "OTHER",
    });
    expect(fail.recovered).toBe(false);
  });

  it("pr_open_op uses GitHostPort.findOpenPullRequestByMachineKey", async () => {
    const store = new MemoryStore();
    const host = new FsMirrorGitHost(store);
    const pr = await host.openPullRequest({
      title: "T",
      body: "x\n<!-- llm-team:pr-machine\nidempotency_key: PR-1\n-->",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const r = await runOutboxProbe({
      opKind: "pr_open_op",
      gitHost: host,
      headBranch: "slice/abc",
      // Outbox.recover injects idempotencyKey; here we mimic that path.
      ...({ idempotencyKey: "PR-1" } as object),
    } as unknown as ProbeContext);
    expect(r.recovered).toBe(true);
    expect(r.externalId).toBe(pr.id);
  });

  it("submit_review_op uses GitHostPort.findReviewByMachineKey", async () => {
    const store = new MemoryStore();
    const host = new FsMirrorGitHost(store);
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await host.submitPullRequestReview({
      prRef: pr,
      intent: "approve",
      body: "ok\n<!-- llm-team:review-machine\nidempotency_key: RKEY\n-->",
      idempotencyKey: "RKEY",
    });
    const r = await runOutboxProbe({
      opKind: "submit_review_op",
      gitHost: host,
      prRef: pr,
      ...({ idempotencyKey: "RKEY" } as object),
    } as unknown as ProbeContext);
    expect(r.recovered).toBe(true);
  });

  it("merge_op uses GitHostPort.getPullRequestMergeState", async () => {
    const store = new MemoryStore();
    const host = new FsMirrorGitHost(store);
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const beforeMerge = await runOutboxProbe({
      opKind: "merge_op",
      gitHost: host,
      prRef: pr,
    });
    expect(beforeMerge.recovered).toBe(false);
    await host.mergePullRequest({ prRef: pr, strategy: "squash" });
    const afterMerge = await runOutboxProbe({
      opKind: "merge_op",
      gitHost: host,
      prRef: pr,
    });
    expect(afterMerge.recovered).toBe(true);
  });

  it("add_label_op / remove_label_op use GitHostPort.listLabels", async () => {
    const store = new MemoryStore();
    const host = new FsMirrorGitHost(store);
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await host.addLabel(pr, "needs-review");
    expect(
      (
        await runOutboxProbe({
          opKind: "add_label_op",
          gitHost: host,
          prRef: pr,
          label: "needs-review",
          expect: "present",
        })
      ).recovered,
    ).toBe(true);
    expect(
      (
        await runOutboxProbe({
          opKind: "remove_label_op",
          gitHost: host,
          prRef: pr,
          label: "absent-label",
          expect: "absent",
        })
      ).recovered,
    ).toBe(true);
  });

  it("dismiss_review_op uses GitHostPort.getReview", async () => {
    const store = new MemoryStore();
    const host = new FsMirrorGitHost(store);
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
      body: "ok",
      idempotencyKey: "RK",
    });
    await host.dismissReview({
      prRef: pr,
      externalReviewId: submit.externalReviewId,
    });
    const r = await runOutboxProbe({
      opKind: "dismiss_review_op",
      gitHost: host,
      prRef: pr,
      externalReviewId: submit.externalReviewId,
    });
    expect(r.recovered).toBe(true);
  });
});

describe("Outbox.recover crash-recovery", () => {
  it("pending_without_posted → emits outbox_recovered + outbox_posted", async () => {
    const { outbox, store, ledger } = newOutbox();
    await outbox.begin({
      opKind: "commit_op",
      idempotencyKey: "K1",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    // simulate crash before complete is called → restart → probe
    const ws = new FakeWorkspace(mkdtempSync(join(tmpdir(), "ob-")));
    ws.seedCommitTrailer("slice/abc", "sha-RECOVER", {
      "Idempotency-Key": "K1",
    });
    const recovered = await outbox.recover({
      opKind: "commit_op",
      idempotencyKey: "K1",
      mode: "pending_without_posted",
      probe: {
        opKind: "commit_op",
        workspace: ws,
        branch: "slice/abc",
        trailerKey: "Idempotency-Key",
        value: "K1",
      },
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.externalId).toBe("sha-RECOVER");
    const rows = (
      (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? ""
    )
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
    const kinds = rows.map((r) => r.action_kind);
    expect(kinds).toEqual([
      "outbox_pending",
      "outbox_recovered",
      "outbox_posted",
    ]);
    void ledger; // silence unused
  });

  it("posted_without_receipt → emits only outbox_recovered (no duplicate posted)", async () => {
    const { outbox, store } = newOutbox();
    await outbox.begin({
      opKind: "submit_review_op",
      idempotencyKey: "K2",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    await outbox.complete({
      opKind: "submit_review_op",
      idempotencyKey: "K2",
      status: "posted",
      externalId: "rev-9",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    // simulate crash AFTER posted but before receipt write
    const host = new FsMirrorGitHost(new MemoryStore());
    const pr = await host.openPullRequest({
      title: "T",
      body: "x",
      headBranch: "slice/abc",
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await host.submitPullRequestReview({
      prRef: pr,
      intent: "approve",
      body: "ok\n<!-- llm-team:review-machine\nidempotency_key: K2\n-->",
      idempotencyKey: "K2",
    });
    const recovered = await outbox.recover({
      opKind: "submit_review_op",
      idempotencyKey: "K2",
      mode: "posted_without_receipt",
      probe: {
        opKind: "submit_review_op",
        gitHost: host,
        prRef: pr,
      },
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    expect(recovered.recovered).toBe(true);
    const rows = (
      (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? ""
    )
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
    const kinds = rows.map((r) => r.action_kind);
    expect(kinds).toEqual([
      "outbox_pending",
      "outbox_posted",
      "outbox_recovered",
    ]);
    // no duplicate posted row
    expect(kinds.filter((k) => k === "outbox_posted")).toHaveLength(1);
  });

  it("recover with negative probe → no extra rows", async () => {
    const { outbox, store } = newOutbox();
    await outbox.begin({
      opKind: "commit_op",
      idempotencyKey: "GHOST",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    const ws = new FakeWorkspace(mkdtempSync(join(tmpdir(), "ob-")));
    const r = await outbox.recover({
      opKind: "commit_op",
      idempotencyKey: "GHOST",
      mode: "pending_without_posted",
      probe: {
        opKind: "commit_op",
        workspace: ws,
        branch: "slice/abc",
        trailerKey: "Idempotency-Key",
        value: "GHOST",
      },
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    expect(r.recovered).toBe(false);
    const rows = (
      (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? ""
    )
      .split("\n")
      .filter((s) => s.length > 0);
    // Only the pending row; no recovered/posted appended.
    expect(rows).toHaveLength(1);
  });
});

describe("Outbox.scanRecoveryCandidatesFromLedger — both cases", () => {
  it("returns pending_without_posted + posted_without_receipt candidates", async () => {
    const { outbox, store } = newOutbox();
    // op A: pending only (crash before complete)
    await outbox.begin({
      opKind: "commit_op",
      idempotencyKey: "A",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    // op B: pending + posted (crash before receipt)
    await outbox.begin({
      opKind: "submit_review_op",
      idempotencyKey: "B",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    await outbox.complete({
      opKind: "submit_review_op",
      idempotencyKey: "B",
      status: "posted",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    // op C: pending + posted + receipt (no recovery needed)
    await outbox.begin({
      opKind: "merge_op",
      idempotencyKey: "C",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    await outbox.complete({
      opKind: "merge_op",
      idempotencyKey: "C",
      status: "posted",
      callerId: "caller",
      targetId: TARGET,
      objectId: OBJ_ID,
      manifestId: MANIFEST_ID,
    });
    const receipts = new Set<string>(["C"]);
    const candidates = await outbox.scanRecoveryCandidatesFromLedger({
      hasMatchingReceipt: async (k) => receipts.has(k),
    });
    const sorted = candidates
      .map(
        (c): [OutboxOpKind, string, string] => [c.opKind, c.idempotencyKey, c.mode],
      )
      .sort();
    expect(sorted).toEqual([
      ["commit_op", "A", "pending_without_posted"],
      ["submit_review_op", "B", "posted_without_receipt"],
    ]);
    void store;
  });
});
