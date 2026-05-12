/**
 * Phase 4 PR-6 (#122 P1-B) — recovery-coordinator sweep tests.
 *
 * Coverage:
 *   - Case A `pending_without_posted`: outbox_pending exists, no posted/
 *     failed/recovered. Probe positive → outbox_recovered + outbox_posted
 *     appended + AgentRunReceipt backfilled.
 *   - Case B `posted_without_receipt`: outbox_posted exists but no
 *     receipt blob. Probe positive → outbox_recovered appended (no
 *     duplicate posted), receipt backfilled, 5-gate ② full-tuple
 *     correlation restored.
 *   - kill -9 simulation: crash between outbox.complete and receipt write
 *     → coordinator finds the candidate → no duplicate review posted to
 *     the host.
 */

import { describe, expect, it } from "vitest";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FileLedger } from "../../src/application/ledger.js";
import { Outbox } from "../../src/application/outbox.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import {
  RecoveryCoordinator,
  type ProbeBuilder,
} from "../../src/application/recovery-coordinator.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { AgentRunReceipt } from "../../src/domain/schema/agent-run-receipt.js";
import { newMonotonicId } from "../../src/domain/ids.js";
import { FixedClock } from "../../src/ports/clock.js";

const ISO = "2026-05-08T00:00:00.000Z";
const FIXED_MS = new Date(ISO).valueOf();
const TARGET = "demo";
const CALLER = "test-caller";
const SURFACE_ID = "01HZSR0000000000000000000A";
const SESSION_ID = "01HZSE0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const TURN_INDEX = 0;
const AGENT_PROFILE = "sentinel";

function makeBase() {
  const store = new MemoryStore();
  const clock = new FixedClock(FIXED_MS);
  const ledger = new FileLedger({ store });
  const gitHost = new FsMirrorGitHost(store);
  const outbox = new Outbox({ store, ledger });
  const wsRoot = mkdtempSync(join(tmpdir(), "rc-"));
  const workspace = new FakeWorkspace(wsRoot);
  return { store, clock, ledger, gitHost, outbox, workspace };
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

describe("recovery-coordinator · scan + backfill", () => {
  it("Case A pending_without_posted (submit_review_op) → outbox_recovered + outbox_posted + receipt backfilled", async () => {
    const { store, clock, ledger, gitHost, outbox } = makeBase();
    // Seed: outbox_pending only — no posted / receipt. Simulates a daemon
    // crash AFTER outbox.begin but BEFORE the host call.
    const idemKey = "K-CASE-A";
    // Real provider write — probe should find the review.
    const prRef = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: `slice/${SLICE_ID}`,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await gitHost.submitPullRequestReview({
      prRef,
      intent: "approve",
      body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
      idempotencyKey: idemKey,
    });
    // Append a low-level pending row that carries the (session_id,
    // turn_index, agent_profile_id) tuple the coordinator needs for
    // backfill. Phase 2/3 invokers populate these fields directly. The
    // outbox.begin() shorthand leaves them null, so we bypass it here to
    // model the post-crash ledger state realistically.
    await ledger.appendTransition({
      transition_id: newMonotonicId(FIXED_MS),
      target_id: TARGET,
      object_id: SURFACE_ID,
      object_kind: "system",
      from_state: null,
      to_state: "outbox_pending",
      loop_kind: "middle",
      phase: null,
      slice_id: SLICE_ID,
      slice_kind: null,
      dod_revision: null,
      session_id: SESSION_ID,
      turn_index: TURN_INDEX,
      slot_kind: null,
      agent_profile_id: AGENT_PROFILE,
      contribution_kind: null,
      action_kind: "outbox_pending",
      final_verdict: null,
      caller_id: CALLER,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: `outbox/submit_review_op/${idemKey}/begin`,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: clock.isoNow(),
      surface_ref: SURFACE_ID,
      op_kind: "submit_review_op",
    });

    const buildProbe: ProbeBuilder = async (candidate) => {
      if (candidate.opKind !== "submit_review_op") return null;
      return {
        opKind: "submit_review_op",
        gitHost,
        prRef,
      };
    };
    const coordinator = new RecoveryCoordinator(
      { callerId: CALLER, targetId: TARGET },
      { store, clock, ledger, outbox, buildProbe },
    );
    const sweep = await coordinator.runOnce();
    expect(sweep.scanned).toBeGreaterThanOrEqual(1);
    const recovered = sweep.items.find(
      (i) => i.kind === "recovered_backfilled",
    );
    expect(recovered).toBeDefined();

    // Ledger: outbox_recovered + outbox_posted appended.
    const recoveredRows = await readActionRows(store, "outbox_recovered");
    expect(recoveredRows.length).toBeGreaterThanOrEqual(1);
    const postedRows = await readActionRows(store, "outbox_posted");
    expect(postedRows.length).toBeGreaterThanOrEqual(1);

    // Receipt backfill: blob exists + parses + idempotency_key matches.
    const body =
      (await store.readText(layout.agentRunReceipt(SESSION_ID, TURN_INDEX))) ??
      "";
    expect(body.length).toBeGreaterThan(0);
    const receipt = AgentRunReceipt.parse(JSON.parse(body));
    expect(receipt.idempotency_key).toBe(idemKey);
    expect(receipt.external_review_id).not.toBeNull();
    expect(receipt.agent_role_in_session).toBe("reviewer");
  });

  it("Case B posted_without_receipt → outbox_recovered appended (no duplicate posted), receipt backfilled", async () => {
    const { store, clock, ledger, gitHost, outbox } = makeBase();
    const idemKey = "K-CASE-B";
    const prRef = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: `slice/${SLICE_ID}`,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    // Real outbox flow: pending then posted (provider write succeeded).
    // Simulate the agent's full ledger row by using the same low-level
    // append that the Phase 3 reviewer-invoker would emit.
    await ledger.appendTransition({
      transition_id: newMonotonicId(FIXED_MS),
      target_id: TARGET,
      object_id: SURFACE_ID,
      object_kind: "system",
      from_state: null,
      to_state: "outbox_pending",
      loop_kind: "middle",
      phase: null,
      slice_id: SLICE_ID,
      slice_kind: null,
      dod_revision: null,
      session_id: SESSION_ID,
      turn_index: TURN_INDEX,
      slot_kind: null,
      agent_profile_id: AGENT_PROFILE,
      contribution_kind: null,
      action_kind: "outbox_pending",
      final_verdict: null,
      caller_id: CALLER,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: `outbox/submit_review_op/${idemKey}/begin`,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: clock.isoNow(),
      surface_ref: SURFACE_ID,
      op_kind: "submit_review_op",
    });
    // Real host call (provider write).
    const submitted = await gitHost.submitPullRequestReview({
      prRef,
      intent: "approve",
      body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
      idempotencyKey: idemKey,
    });
    await outbox.complete({
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

    const buildProbe: ProbeBuilder = async (candidate) => {
      if (candidate.opKind !== "submit_review_op") return null;
      return {
        opKind: "submit_review_op",
        gitHost,
        prRef,
      };
    };
    const coordinator = new RecoveryCoordinator(
      { callerId: CALLER, targetId: TARGET },
      { store, clock, ledger, outbox, buildProbe },
    );
    const sweep = await coordinator.runOnce();
    const recovered = sweep.items.find(
      (i) => i.kind === "recovered_backfilled",
    );
    expect(recovered).toBeDefined();

    // Exactly 1 outbox_posted row — no duplicate.
    const postedRows = await readActionRows(store, "outbox_posted");
    expect(postedRows).toHaveLength(1);
    const recoveredRows = await readActionRows(store, "outbox_recovered");
    expect(recoveredRows).toHaveLength(1);

    // Receipt backfilled — 5-gate ② full-tuple correlation restored.
    const body =
      (await store.readText(layout.agentRunReceipt(SESSION_ID, TURN_INDEX))) ??
      "";
    expect(body.length).toBeGreaterThan(0);
    const receipt = AgentRunReceipt.parse(JSON.parse(body));
    expect(receipt.idempotency_key).toBe(idemKey);
    expect(receipt.external_review_id).toBe(submitted.externalReviewId);
  });

  it("kill -9 simulation: crash after outbox.complete before receipt — re-running coordinator does NOT post a duplicate review", async () => {
    const { store, clock, ledger, gitHost, outbox } = makeBase();
    const idemKey = "K-KILL-9";
    const prRef = await gitHost.openPullRequest({
      title: "t",
      body: "x",
      headBranch: `slice/${SLICE_ID}`,
      baseBranch: "main",
      draft: false,
      labels: [],
    });
    await ledger.appendTransition({
      transition_id: newMonotonicId(FIXED_MS),
      target_id: TARGET,
      object_id: SURFACE_ID,
      object_kind: "system",
      from_state: null,
      to_state: "outbox_pending",
      loop_kind: "middle",
      phase: null,
      slice_id: SLICE_ID,
      slice_kind: null,
      dod_revision: null,
      session_id: SESSION_ID,
      turn_index: TURN_INDEX,
      slot_kind: null,
      agent_profile_id: AGENT_PROFILE,
      contribution_kind: null,
      action_kind: "outbox_pending",
      final_verdict: null,
      caller_id: CALLER,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: `outbox/submit_review_op/${idemKey}/begin`,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: clock.isoNow(),
      surface_ref: SURFACE_ID,
      op_kind: "submit_review_op",
    });
    const submitted = await gitHost.submitPullRequestReview({
      prRef,
      intent: "approve",
      body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
      idempotencyKey: idemKey,
    });
    await outbox.complete({
      opKind: "submit_review_op",
      idempotencyKey: idemKey,
      status: "posted",
      externalId: submitted.externalReviewId,
      callerId: CALLER,
      targetId: TARGET,
      objectId: SURFACE_ID,
      manifestId: null,
      surfaceRef: SURFACE_ID,
    });

    const beforeReviews = await gitHost.listPullRequestReviews(prRef);
    expect(beforeReviews).toHaveLength(1);

    const buildProbe: ProbeBuilder = async (candidate) => {
      if (candidate.opKind !== "submit_review_op") return null;
      return {
        opKind: "submit_review_op",
        gitHost,
        prRef,
      };
    };
    const coordinator = new RecoveryCoordinator(
      { callerId: CALLER, targetId: TARGET },
      { store, clock, ledger, outbox, buildProbe },
    );
    // First sweep — recovers + backfills receipt.
    await coordinator.runOnce();
    // Second sweep — no candidates (now `hasMatchingReceipt` returns true
    // for the backfilled key) → no additional reviews posted.
    const sweep2 = await coordinator.runOnce();
    expect(sweep2.scanned).toBe(0);
    const afterReviews = await gitHost.listPullRequestReviews(prRef);
    expect(afterReviews).toHaveLength(1);
  });

  it("missing pending row → recovered_skipped(missing_pending_row)", async () => {
    const { store, clock, ledger, gitHost, outbox } = makeBase();
    // Seed an `outbox_posted` row without a matching pending row.
    await ledger.appendTransition({
      transition_id: newMonotonicId(FIXED_MS),
      target_id: TARGET,
      object_id: SURFACE_ID,
      object_kind: "system",
      from_state: null,
      to_state: "outbox_posted",
      loop_kind: "middle",
      phase: null,
      slice_id: null,
      slice_kind: null,
      dod_revision: null,
      session_id: null,
      turn_index: null,
      slot_kind: null,
      agent_profile_id: null,
      contribution_kind: null,
      action_kind: "outbox_posted",
      final_verdict: null,
      caller_id: CALLER,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: "outbox/submit_review_op/K-ORPHAN/complete:posted",
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: clock.isoNow(),
      op_kind: "submit_review_op",
    });
    const buildProbe: ProbeBuilder = async () => null;
    const coordinator = new RecoveryCoordinator(
      { callerId: CALLER, targetId: TARGET },
      { store, clock, ledger, outbox, buildProbe },
    );
    const sweep = await coordinator.runOnce();
    expect(sweep.scanned).toBe(1);
    expect(sweep.items[0]?.kind).toBe("recovered_skipped");
    if (sweep.items[0]?.kind === "recovered_skipped") {
      expect(sweep.items[0].reason).toBe("missing_pending_row");
    }
    void gitHost;
  });

  // ----------------------------------------------------------------------
  // PR-123 review P0-1 regression — gpt5.5 noted that real invoker outbox
  // rows previously left receipt-tuple fields null, so the coordinator
  // bailed with `no_receipt_slot`. Earlier tests above side-loaded a hand-
  // built `outbox_pending` row to bypass that gap. This regression goes
  // through the real `Outbox.begin` API (now extended with the receipt
  // tuple) and asserts the coordinator can backfill from that row alone.
  // ----------------------------------------------------------------------
  it(
    "PR-123 P0-1 regression: real Outbox.begin row carries receipt tuple → coordinator backfills without side-loaded ledger row",
    async () => {
      const { store, clock, ledger, gitHost, outbox } = makeBase();
      const idemKey = "K-REAL-OUTBOX";
      const prRef = await gitHost.openPullRequest({
        title: "t",
        body: "x",
        headBranch: `slice/${SLICE_ID}`,
        baseBranch: "main",
        draft: false,
        labels: [],
      });
      // Real Outbox.begin — receipt tuple flows through into the pending
      // ledger row. No direct `ledger.appendTransition` for this case.
      await outbox.begin({
        opKind: "submit_review_op",
        idempotencyKey: idemKey,
        callerId: CALLER,
        targetId: TARGET,
        objectId: SURFACE_ID,
        manifestId: null,
        surfaceRef: SURFACE_ID,
        sessionId: SESSION_ID,
        turnIndex: TURN_INDEX,
        agentProfileId: AGENT_PROFILE,
        loopKind: "middle",
      });
      // Provider write (the host call that completed before the crash).
      await gitHost.submitPullRequestReview({
        prRef,
        intent: "approve",
        body: `ok\n<!-- llm-team:review-machine\nidempotency_key: ${idemKey}\n-->`,
        idempotencyKey: idemKey,
      });
      // Crash here — no outbox.complete, no receipt blob.

      // Confirm the pending row really carries the tuple via the ledger.
      const ledgerBody =
        (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
      const pendingRow = ledgerBody
        .split("\n")
        .filter((s) => s.length > 0)
        .map((s) => LedgerRow.parse(JSON.parse(s)))
        .find((r) => r.action_kind === "outbox_pending");
      expect(pendingRow?.session_id).toBe(SESSION_ID);
      expect(pendingRow?.turn_index).toBe(TURN_INDEX);
      expect(pendingRow?.agent_profile_id).toBe(AGENT_PROFILE);
      expect(pendingRow?.loop_kind).toBe("middle");

      const buildProbe: ProbeBuilder = async (candidate) => {
        if (candidate.opKind !== "submit_review_op") return null;
        return { opKind: "submit_review_op", gitHost, prRef };
      };
      const coordinator = new RecoveryCoordinator(
        { callerId: CALLER, targetId: TARGET },
        { store, clock, ledger, outbox, buildProbe },
      );
      const sweep = await coordinator.runOnce();
      const recovered = sweep.items.find(
        (i) => i.kind === "recovered_backfilled",
      );
      expect(recovered).toBeDefined();
      // Receipt blob written by backfill — 5-gate ② full-tuple ready.
      const body =
        (await store.readText(
          layout.agentRunReceipt(SESSION_ID, TURN_INDEX),
        )) ?? "";
      expect(body.length).toBeGreaterThan(0);
      const receipt = AgentRunReceipt.parse(JSON.parse(body));
      expect(receipt.idempotency_key).toBe(idemKey);
      expect(receipt.agent_role_in_session).toBe("reviewer");
      expect(receipt.external_review_id).not.toBeNull();
    },
  );
});
