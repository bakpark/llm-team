/**
 * Issue #126 — e2e production probe routing.
 *
 * Validates that wiring `buildProductionProbeBuilder` into the
 * `RecoveryCoordinator` recovers `pending_without_posted` outbox candidates
 * across the supported op_kinds. Without this wiring (PR #125 baseline)
 * every candidate was reported as `recovered_skipped: no_probe` — the
 * "dead-zone" the issue cites.
 *
 * The test seeds:
 *   - a ReviewSurface JSON at the canonical layout path (the probe builder
 *     reads `surface.branch` / `surface.pr_ref` to route);
 *   - a provider-local artifact (commit trailer, remote head, PR body or
 *     review body machine-block) so the probe positively confirms the
 *     external write happened.
 *
 * For each op_kind the test then appends a low-level `outbox_pending` row
 * (mirroring real invoker output) and asserts:
 *   1. the coordinator does NOT emit `recovered_skipped: no_probe`;
 *   2. a `recovered_backfilled` outcome is produced (or, when the receipt
 *      tuple is intentionally absent, `recovered_skipped: no_receipt_slot`
 *      — still proof that the probe was invoked and matched).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FileLedger } from "../../src/application/ledger.js";
import { Outbox, type OutboxOpKind } from "../../src/application/outbox.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import {
  RecoveryCoordinator,
} from "../../src/application/recovery-coordinator.js";
import { buildProductionProbeBuilder } from "../../src/cli/recovery-probe-builder.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { AgentRunReceipt } from "../../src/domain/schema/agent-run-receipt.js";
import { newMonotonicId } from "../../src/domain/ids.js";
import { FixedClock } from "../../src/ports/clock.js";
import type { ReviewSurface as ReviewSurfaceT } from "../../src/domain/schema/review-surface.js";

const ISO = "2026-05-14T00:00:00.000Z";
const FIXED_MS = new Date(ISO).valueOf();
const TARGET = "demo";
const CALLER = "test-caller";
const SURFACE_ID = "01HZSR0000000000000000000A";
const SESSION_ID = "01HZSE0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const TURN_INDEX = 0;
const AGENT_PROFILE = "sentinel";
const BRANCH = `slice/${SLICE_ID}`;
const HEAD_SHA = "abc1234567890abcdef1234567890abcdef1234";

function makeBase() {
  const store = new MemoryStore();
  const clock = new FixedClock(FIXED_MS);
  const ledger = new FileLedger({ store });
  const gitHost = new FsMirrorGitHost(store);
  const outbox = new Outbox({ store, ledger });
  const wsRoot = mkdtempSync(join(tmpdir(), "rpr-"));
  const workspace = new FakeWorkspace(wsRoot);
  return { store, clock, ledger, gitHost, outbox, workspace };
}

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
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  };
  await store.writeAtomic(
    layout.reviewSurface(SURFACE_ID),
    JSON.stringify(surface),
  );
  return surface;
}

async function appendPending(
  ledger: FileLedger,
  clock: FixedClock,
  opts: {
    opKind: OutboxOpKind;
    idempotencyKey: string;
    surfaceRef?: string | null;
    objectId?: string;
    resultDetail?: string | null;
    sessionId?: string | null;
    turnIndex?: number | null;
    agentProfileId?: string | null;
    loopKind?: "outer" | "middle" | "inner" | null;
  },
): Promise<void> {
  await ledger.appendTransition({
    transition_id: newMonotonicId(FIXED_MS),
    target_id: TARGET,
    object_id: opts.objectId ?? SURFACE_ID,
    object_kind: "system",
    from_state: null,
    to_state: "outbox_pending",
    loop_kind: opts.loopKind ?? "middle",
    phase: null,
    slice_id: SLICE_ID,
    slice_kind: null,
    dod_revision: null,
    session_id: opts.sessionId === undefined ? SESSION_ID : opts.sessionId,
    turn_index: opts.turnIndex === undefined ? TURN_INDEX : opts.turnIndex,
    slot_kind: null,
    agent_profile_id:
      opts.agentProfileId === undefined ? AGENT_PROFILE : opts.agentProfileId,
    contribution_kind: null,
    action_kind: "outbox_pending",
    final_verdict: null,
    caller_id: CALLER,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: `outbox/${opts.opKind}/${opts.idempotencyKey}/begin`,
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: opts.resultDetail ?? null,
    timestamp: clock.isoNow(),
    ...(opts.surfaceRef === undefined ? { surface_ref: SURFACE_ID } : {}),
    ...(opts.surfaceRef != null ? { surface_ref: opts.surfaceRef } : {}),
    op_kind: opts.opKind,
  });
}

async function readActionRows(
  store: MemoryStore,
  action: string,
): Promise<unknown[]> {
  const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
  return body
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => LedgerRow.parse(JSON.parse(s)))
    .filter((r) => r.action_kind === action);
}

function makeCoordinator(deps: ReturnType<typeof makeBase>) {
  const { store, clock, ledger, gitHost, outbox, workspace } = deps;
  return new RecoveryCoordinator(
    { callerId: CALLER, targetId: TARGET },
    {
      store,
      clock,
      ledger,
      outbox,
      buildProbe: buildProductionProbeBuilder({ store, workspace, gitHost }),
    },
  );
}

describe("recovery probe routing · e2e per-op_kind (issue #126)", () => {
  it("commit_op pending_without_posted → recovered (no `no_probe`)", async () => {
    const deps = makeBase();
    await seedSurface(deps.store);
    const idemKey = "K-COMMIT";
    deps.workspace.seedCommitTrailer(BRANCH, "commit-sha-A", {
      "Idempotency-Key": idemKey,
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "commit_op",
      idempotencyKey: idemKey,
      // lead-invoker omits surfaceRef for commit_op; only objectId carries it.
      surfaceRef: null,
      loopKind: "inner",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(sweep.scanned).toBe(1);
    const skipped = sweep.items.find(
      (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
    );
    expect(skipped).toBeUndefined();
    const recovered = sweep.items.find(
      (i) => i.kind === "recovered_backfilled",
    );
    expect(recovered).toBeDefined();
    const recoveredRows = await readActionRows(deps.store, "outbox_recovered");
    expect(recoveredRows.length).toBeGreaterThanOrEqual(1);
    const receipt = AgentRunReceipt.parse(
      JSON.parse(
        (await deps.store.readText(
          layout.agentRunReceipt(SESSION_ID, TURN_INDEX),
        )) ?? "",
      ),
    );
    expect(receipt.idempotency_key).toBe(idemKey);
    expect(receipt.commit_sha).toBe("commit-sha-A");
  });

  it("push_op pending_without_posted → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    deps.workspace.seedRemoteHead("origin", surface.branch, surface.head_sha);
    const idemKey = "K-PUSH";
    await appendPending(deps.ledger, deps.clock, {
      opKind: "push_op",
      idempotencyKey: idemKey,
      surfaceRef: null,
      loopKind: "inner",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("pr_open_op pending_without_posted → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const idemKey = "K-OPEN";
    await deps.gitHost.openPullRequest({
      title: "t",
      body: `body\n<!-- llm-team:pr-machine\nidempotency_key: ${idemKey}\n-->`,
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "pr_open_op",
      idempotencyKey: idemKey,
      surfaceRef: null,
      loopKind: "inner",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("pr_update_op pending_without_posted → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const opened = await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const idemKey = "K-UPDATE";
    await deps.gitHost.updatePullRequestBody({
      prRef: opened,
      body: `body\n<!-- llm-team:pr-machine\nidempotency_key: ${idemKey}\n-->`,
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "pr_update_op",
      idempotencyKey: idemKey,
      surfaceRef: null,
      loopKind: "inner",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("submit_review_op pending_without_posted → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const opened = await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const idemKey = "K-SUBMIT";
    await deps.gitHost.submitPullRequestReview({
      prRef: opened,
      intent: "approve",
      body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
      idempotencyKey: idemKey,
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "submit_review_op",
      idempotencyKey: idemKey,
      loopKind: "middle",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("merge_op pending_without_posted → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const opened = await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await deps.gitHost.mergePullRequest({ prRef: opened, strategy: "squash" });
    const idemKey = "K-MERGE";
    await appendPending(deps.ledger, deps.clock, {
      opKind: "merge_op",
      idempotencyKey: idemKey,
      loopKind: "outer",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("add_label_op pending_without_posted (result_detail={label}) → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const opened = await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await deps.gitHost.addLabel(opened, "ready-for-review");
    const idemKey = "K-LABEL-ADD";
    await appendPending(deps.ledger, deps.clock, {
      opKind: "add_label_op",
      idempotencyKey: idemKey,
      resultDetail: JSON.stringify({ label: "ready-for-review" }),
      loopKind: "outer",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("remove_label_op pending_without_posted (label absent) → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const idemKey = "K-LABEL-RM";
    await appendPending(deps.ledger, deps.clock, {
      opKind: "remove_label_op",
      idempotencyKey: idemKey,
      resultDetail: JSON.stringify({ label: "stale-label" }),
      loopKind: "outer",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("dismiss_review_op pending_without_posted (result_detail={externalReviewId}) → recovered", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const opened = await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const submitted = await deps.gitHost.submitPullRequestReview({
      prRef: opened,
      intent: "request_changes",
      body: "x",
      idempotencyKey: "K-PRE",
    });
    await deps.gitHost.dismissReview({
      prRef: opened,
      externalReviewId: submitted.externalReviewId,
      reason: "stale",
    });
    const idemKey = "K-DISMISS";
    await appendPending(deps.ledger, deps.clock, {
      opKind: "dismiss_review_op",
      idempotencyKey: idemKey,
      resultDetail: JSON.stringify({
        externalReviewId: submitted.externalReviewId,
      }),
      loopKind: "middle",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("posted_without_receipt across op_kinds → recovered + outbox_posted dedup (1 row)", async () => {
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const opened = await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const idemKey = "K-POSTED-NO-RECEIPT";
    const submitted = await deps.gitHost.submitPullRequestReview({
      prRef: opened,
      intent: "approve",
      body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
      idempotencyKey: idemKey,
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "submit_review_op",
      idempotencyKey: idemKey,
      loopKind: "middle",
    });
    await deps.outbox.complete({
      opKind: "submit_review_op",
      idempotencyKey: idemKey,
      status: "posted",
      externalId: submitted.externalReviewId,
      externalReviewId: submitted.externalReviewId,
      callerId: CALLER,
      targetId: TARGET,
      objectId: SURFACE_ID,
      manifestId: null,
      surfaceRef: SURFACE_ID,
    });
    // Crash here — no receipt blob.
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
    // No duplicate posted row — exactly 1.
    const posted = await readActionRows(deps.store, "outbox_posted");
    expect(posted).toHaveLength(1);
    const receipt = AgentRunReceipt.parse(
      JSON.parse(
        (await deps.store.readText(
          layout.agentRunReceipt(SESSION_ID, TURN_INDEX),
        )) ?? "",
      ),
    );
    expect(receipt.idempotency_key).toBe(idemKey);
    expect(receipt.external_review_id).toBe(submitted.externalReviewId);
  });

  it("regression: stub buildProbe (PR #125 baseline) emits `no_probe` for every candidate — production builder fixes this", async () => {
    // First sweep: stub builder.
    const deps = makeBase();
    await seedSurface(deps.store);
    deps.workspace.seedCommitTrailer(BRANCH, "commit-sha-A", {
      "Idempotency-Key": "K-REG",
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "commit_op",
      idempotencyKey: "K-REG",
      surfaceRef: null,
      loopKind: "inner",
    });
    const stubbed = new RecoveryCoordinator(
      { callerId: CALLER, targetId: TARGET },
      {
        store: deps.store,
        clock: deps.clock,
        ledger: deps.ledger,
        outbox: deps.outbox,
        buildProbe: async () => null,
      },
    );
    const baseline = await stubbed.runOnce();
    const baselineSkipped = baseline.items.filter(
      (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
    );
    expect(baselineSkipped.length).toBe(1);

    // Second sweep with production builder: rebuild ledger state to a fresh
    // pending row (without a recovered marker overlapping the prior sweep).
    const deps2 = makeBase();
    await seedSurface(deps2.store);
    deps2.workspace.seedCommitTrailer(BRANCH, "commit-sha-A", {
      "Idempotency-Key": "K-REG2",
    });
    await appendPending(deps2.ledger, deps2.clock, {
      opKind: "commit_op",
      idempotencyKey: "K-REG2",
      surfaceRef: null,
      loopKind: "inner",
    });
    const production = makeCoordinator(deps2);
    const sweep = await production.runOnce();
    const noProbe = sweep.items.filter(
      (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
    );
    expect(noProbe).toHaveLength(0);
  });

  it("PR #127 review P1-1: pr_open_op surface-less Case A → recovered via payload hints", async () => {
    // Crash window: outbox.begin(pr_open_op) succeeded but the ReviewSurface
    // write at Step 8 never landed. Lead-invoker persists `branch` on the
    // pending row payload so recovery still resolves the headBranch and
    // probes `findOpenPullRequestByMachineKey` correctly.
    const deps = makeBase();
    // NOTE: NO seedSurface — this is the bug window.
    const idemKey = "K-OPEN-CASEA";
    await deps.gitHost.openPullRequest({
      title: "t",
      body: `body\n<!-- llm-team:pr-machine\nidempotency_key: ${idemKey}\n-->`,
      headBranch: BRANCH,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "pr_open_op",
      idempotencyKey: idemKey,
      surfaceRef: null,
      resultDetail: JSON.stringify({ branch: BRANCH }),
      loopKind: "inner",
    });
    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    expect(
      sweep.items.find(
        (i) => i.kind === "recovered_skipped" && i.reason === "no_probe",
      ),
    ).toBeUndefined();
    expect(
      sweep.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
  });

  it("PR #127 review P1-2: Case B scan skips commit_op/push_op rows when the (session,turn) slot already has a receipt", async () => {
    // Live lead happy path: commit_op (k1) and push_op (k2) are posted, but
    // the live receipt stores only the terminal pr_open_op key (k3). Without
    // slot-scoped dedup the scan would re-list k1/k2 as Case B candidates
    // every sweep. With the fix, the receipt at slot (SESSION_ID, TURN_INDEX)
    // covers them.
    const deps = makeBase();
    await seedSurface(deps.store);
    // Append commit_op + push_op pending+posted rows (no recovery yet — we
    // are simulating the live happy path, not Case A recovery).
    await appendPending(deps.ledger, deps.clock, {
      opKind: "commit_op",
      idempotencyKey: "K1-COMMIT",
      surfaceRef: null,
      loopKind: "inner",
    });
    await deps.outbox.complete({
      opKind: "commit_op",
      idempotencyKey: "K1-COMMIT",
      status: "posted",
      externalId: "commit-sha",
      callerId: CALLER,
      targetId: TARGET,
      objectId: SURFACE_ID,
      manifestId: null,
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "push_op",
      idempotencyKey: "K2-PUSH",
      surfaceRef: null,
      loopKind: "inner",
    });
    await deps.outbox.complete({
      opKind: "push_op",
      idempotencyKey: "K2-PUSH",
      status: "posted",
      externalId: HEAD_SHA,
      callerId: CALLER,
      targetId: TARGET,
      objectId: SURFACE_ID,
      manifestId: null,
    });
    // Live receipt — keyed by terminal `k3`, NOT k1/k2.
    const receipt = AgentRunReceipt.parse({
      session_id: SESSION_ID,
      turn_index: TURN_INDEX,
      parent_loop: "inner",
      agent_profile_id: AGENT_PROFILE,
      agent_role_in_session: "lead",
      idempotency_key: "K3-PR-OPEN",
      diagnostics_ref: "live",
      external_review_id: null,
      external_pr_id: "1",
      commit_sha: "commit-sha",
      exit_status: "ok",
      recorded_at: ISO,
    });
    await deps.store.writeAtomic(
      layout.agentRunReceipt(SESSION_ID, TURN_INDEX),
      JSON.stringify(receipt),
    );

    const coordinator = makeCoordinator(deps);
    const sweep = await coordinator.runOnce();
    // No Case B candidates for commit_op / push_op — the slot is covered.
    expect(sweep.scanned).toBe(0);
    expect(sweep.items).toHaveLength(0);
  });

  it("PR #127 review P1-2: once outbox_recovered is emitted, subsequent sweeps do not re-list the same Case B candidate", async () => {
    // Seed a posted_without_receipt scenario, run sweep 1 (recovers + emits
    // outbox_recovered), then run sweep 2 — must not re-list the same row.
    const deps = makeBase();
    const surface = await seedSurface(deps.store);
    const opened = await deps.gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: surface.branch,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    const idemKey = "K-CASEB-DEDUP";
    const submitted = await deps.gitHost.submitPullRequestReview({
      prRef: opened,
      intent: "approve",
      body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
      idempotencyKey: idemKey,
    });
    await appendPending(deps.ledger, deps.clock, {
      opKind: "submit_review_op",
      idempotencyKey: idemKey,
      loopKind: "middle",
    });
    await deps.outbox.complete({
      opKind: "submit_review_op",
      idempotencyKey: idemKey,
      status: "posted",
      externalId: submitted.externalReviewId,
      externalReviewId: submitted.externalReviewId,
      callerId: CALLER,
      targetId: TARGET,
      objectId: SURFACE_ID,
      manifestId: null,
      surfaceRef: SURFACE_ID,
    });
    const coordinator = makeCoordinator(deps);
    const first = await coordinator.runOnce();
    expect(first.scanned).toBe(1);
    expect(
      first.items.find((i) => i.kind === "recovered_backfilled"),
    ).toBeDefined();
    // Second sweep — `outbox_recovered` row already exists for this
    // (op_kind, key); scan must skip the duplicate Case B candidate.
    const second = await coordinator.runOnce();
    expect(second.scanned).toBe(0);
    expect(second.items).toHaveLength(0);
  });
});
