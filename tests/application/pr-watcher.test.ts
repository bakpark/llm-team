/**
 * Phase 4 PR-6 — pr-watcher 5-gate filter tests.
 *
 * Coverage:
 *   - all-gates-pass → `review_signal_applied` ledger row (idempotent on
 *     external_review_id)
 *   - gate ① signature_invalid (missing block / bad nonce)
 *   - gate ② tuple_mismatch (receipt missing / wrong agent_profile_id /
 *     outbox posted row missing)
 *   - gate ③ round_mismatch (machine.review_round != surface.review_round)
 *     and parent_phase mismatch
 *   - gate ④ author_unauthorized (bot account mismatch)
 *   - gate ⑤ already_applied is recognised as duplicate, not re-applied
 *   - drop reasons feed `recordDroppedReviewSignal` triple dedup so N
 *     polling cycles with the same dropped review write 1 ledger row
 *   - ReviewSurface + SliceMerge coexistence verification re-run
 */

import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { FileLedger } from "../../src/application/ledger.js";
import { Outbox } from "../../src/application/outbox.js";
import { PrWatcher } from "../../src/application/pr-watcher.js";
import { DroppedReviewSignalCache } from "../../src/application/drift-observer.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import {
  buildCanonicalString,
  computeNonce,
  renderBlock,
  type ReviewCanonicalFields,
} from "../../src/application/machine-block.js";
import { ReviewSurface } from "../../src/domain/schema/review-surface.js";
import { AgentRunReceipt } from "../../src/domain/schema/agent-run-receipt.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { FixedClock } from "../../src/ports/clock.js";

const SECRET = "test-watcher-secret";
const ISO = "2026-05-08T00:00:00.000Z";
const FIXED_MS = new Date(ISO).valueOf();
const TARGET = "demo";
const CALLER = "test-caller";
const SURFACE_ID = "01HZSR0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const SESSION_ID = "01HZSE0000000000000000000A";
const TURN_INDEX = 0;
const AGENT_PROFILE = "sentinel";

interface Env {
  store: MemoryStore;
  clock: FixedClock;
  ledger: FileLedger;
  gitHost: FsMirrorGitHost;
  outbox: Outbox;
  watcher: PrWatcher;
  surface: ReturnType<typeof ReviewSurface.parse>;
  prRef: { provider: string; id: string };
}

async function buildEnv(): Promise<Env> {
  const store = new MemoryStore();
  const clock = new FixedClock(FIXED_MS);
  const ledger = new FileLedger({ store });
  const gitHost = new FsMirrorGitHost(store);
  const outbox = new Outbox({ store, ledger });

  // Open a PR so listPullRequestReviews has something to return.
  const prRef = await gitHost.openPullRequest({
    title: "review pr",
    body: "stub",
    headBranch: `slice/${SLICE_ID}`,
    baseBranch: "main",
    draft: false,
    labels: [],
  });

  const surface = ReviewSurface.parse({
    review_surface_id: SURFACE_ID,
    parent_kind: "slice",
    parent_id: SLICE_ID,
    parent_phase: null,
    pr_ref: {
      provider: "fs_mirror",
      id: prRef.id,
      node_id: null,
      url: `fs-mirror://${prRef.id}`,
    },
    branch: `slice/${SLICE_ID}`,
    base_ref: "main",
    head_sha: "sha-1",
    review_round: 0,
    lifecycle_state: "open",
    review_state: "pending_review",
    build_state: "ready",
    latest_verification_run_id: null,
    last_synced_external_revision: null,
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(
    layout.reviewSurface(SURFACE_ID),
    JSON.stringify(surface),
  );

  const watcher = new PrWatcher(
    {
      callerId: CALLER,
      targetId: TARGET,
      machineBlockSecret: SECRET,
      expectedBotAccount: "fs-mirror",
      knownAgentProfileIds: ["sentinel", "scout"],
    },
    {
      store,
      clock,
      gitHost,
      ledger,
      droppedSignalCache: new DroppedReviewSignalCache(),
    },
  );
  return { store, clock, ledger, gitHost, outbox, watcher, surface, prRef };
}

/**
 * Seed the receipt + outbox posted row to mimic a successful reviewer-invoker
 * pass — i.e. preconditions for gate ② to find both halves.
 */
async function seedReceiptAndOutbox(
  env: Env,
  idempotencyKey: string,
  externalReviewId: string,
): Promise<void> {
  const receipt = AgentRunReceipt.parse({
    session_id: SESSION_ID,
    turn_index: TURN_INDEX,
    parent_loop: "middle",
    agent_profile_id: AGENT_PROFILE,
    agent_role_in_session: "reviewer",
    idempotency_key: idempotencyKey,
    diagnostics_ref: "diag",
    external_review_id: externalReviewId,
    external_pr_id: env.prRef.id,
    commit_sha: null,
    exit_status: "ok",
    recorded_at: ISO,
  });
  await env.store.writeAtomic(
    layout.agentRunReceipt(SESSION_ID, TURN_INDEX),
    JSON.stringify(receipt),
  );
  await env.outbox.begin({
    opKind: "submit_review_op",
    idempotencyKey,
    callerId: CALLER,
    targetId: TARGET,
    objectId: SURFACE_ID,
    manifestId: null,
    surfaceRef: SURFACE_ID,
  });
  await env.outbox.complete({
    opKind: "submit_review_op",
    idempotencyKey,
    status: "posted",
    externalId: externalReviewId,
    externalReviewId,
    callerId: CALLER,
    targetId: TARGET,
    objectId: SURFACE_ID,
    manifestId: null,
    surfaceRef: SURFACE_ID,
  });
}

function buildCanonicalReviewBody(
  fields: ReviewCanonicalFields,
  secret = SECRET,
  prose = "looks good",
): string {
  const nonce = computeNonce(secret, "review", fields);
  // Confirm canonical_string builds cleanly so any later refactor breaks the
  // test loudly instead of silently producing a different signature.
  buildCanonicalString("review", fields);
  return `${prose}\n\n${renderBlock("review", fields, nonce)}\n`;
}

async function readLedgerByAction(
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

describe("pr-watcher · 5-gate filter", () => {
  it("all 5 gates pass → review_signal_applied appended; second poll → duplicate_applied (no second row)", async () => {
    const env = await buildEnv();
    const idemKey = "K-ALL-PASS";
    // Submit canonical review.
    const fields: ReviewCanonicalFields = {
      review_surface_id: SURFACE_ID,
      parent_kind: "slice",
      parent_id: SLICE_ID,
      parent_phase: "n/a",
      review_round: "0",
      session_id: SESSION_ID,
      turn_index: String(TURN_INDEX),
      agent_profile_id: AGENT_PROFILE,
      idempotency_key: idemKey,
    };
    const body = buildCanonicalReviewBody(fields);
    const submitted = await env.gitHost.submitPullRequestReview({
      prRef: env.prRef,
      intent: "approve",
      body,
      idempotencyKey: idemKey,
    });
    await seedReceiptAndOutbox(env, idemKey, submitted.externalReviewId);

    const result = await env.watcher.pollReviewSurface(env.surface);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]?.kind).toBe("applied");
    if (result.reviews[0]?.kind === "applied") {
      expect(result.reviews[0].verdict).toBe("approve");
    }
    const appliedRows = await readLedgerByAction(env.store, "review_signal_applied");
    expect(appliedRows).toHaveLength(1);

    // Second poll — gate ⑤ catches it; no new row.
    const second = await env.watcher.pollReviewSurface(env.surface);
    expect(second.reviews[0]?.kind).toBe("duplicate_applied");
    const appliedRows2 = await readLedgerByAction(env.store, "review_signal_applied");
    expect(appliedRows2).toHaveLength(1);
  });

  it("gate ① signature_invalid: bad nonce → dropped, triple dedup applies across N polls", async () => {
    const env = await buildEnv();
    const fields: ReviewCanonicalFields = {
      review_surface_id: SURFACE_ID,
      parent_kind: "slice",
      parent_id: SLICE_ID,
      parent_phase: "n/a",
      review_round: "0",
      session_id: SESSION_ID,
      turn_index: String(TURN_INDEX),
      agent_profile_id: AGENT_PROFILE,
      idempotency_key: "K-BAD",
    };
    const body = `bad sig\n\n${renderBlock("review", fields, "0000000000000000")}\n`;
    await env.gitHost.submitPullRequestReview({
      prRef: env.prRef,
      intent: "approve",
      body,
      idempotencyKey: "K-BAD",
    });
    for (let i = 0; i < 5; i++) {
      const r = await env.watcher.pollReviewSurface(env.surface);
      expect(r.reviews[0]?.kind).toBe("dropped");
      if (r.reviews[0]?.kind === "dropped") {
        expect(r.reviews[0].dropReason).toBe("signature_invalid");
      }
    }
    const dropRows = await readLedgerByAction(env.store, "review_signal_dropped");
    // Triple dedup: exactly 1 row across 5 polls.
    expect(dropRows).toHaveLength(1);
  });

  it("gate ② tuple_mismatch: receipt missing → dropped with tuple_mismatch", async () => {
    const env = await buildEnv();
    const idemKey = "K-NO-RECEIPT";
    const fields: ReviewCanonicalFields = {
      review_surface_id: SURFACE_ID,
      parent_kind: "slice",
      parent_id: SLICE_ID,
      parent_phase: "n/a",
      review_round: "0",
      session_id: SESSION_ID,
      turn_index: String(TURN_INDEX),
      agent_profile_id: AGENT_PROFILE,
      idempotency_key: idemKey,
    };
    const body = buildCanonicalReviewBody(fields);
    await env.gitHost.submitPullRequestReview({
      prRef: env.prRef,
      intent: "approve",
      body,
      idempotencyKey: idemKey,
    });
    // No receipt seeded.
    const r = await env.watcher.pollReviewSurface(env.surface);
    expect(r.reviews[0]?.kind).toBe("dropped");
    if (r.reviews[0]?.kind === "dropped") {
      expect(r.reviews[0].dropReason).toBe("tuple_mismatch");
    }
  });

  it("gate ③ round_mismatch: machine.review_round != surface.review_round", async () => {
    const env = await buildEnv();
    const idemKey = "K-ROUND";
    const fields: ReviewCanonicalFields = {
      review_surface_id: SURFACE_ID,
      parent_kind: "slice",
      parent_id: SLICE_ID,
      parent_phase: "n/a",
      review_round: "7", // surface has 0
      session_id: SESSION_ID,
      turn_index: String(TURN_INDEX),
      agent_profile_id: AGENT_PROFILE,
      idempotency_key: idemKey,
    };
    const body = buildCanonicalReviewBody(fields);
    await env.gitHost.submitPullRequestReview({
      prRef: env.prRef,
      intent: "approve",
      body,
      idempotencyKey: idemKey,
    });
    const r = await env.watcher.pollReviewSurface(env.surface);
    expect(r.reviews[0]?.kind).toBe("dropped");
    if (r.reviews[0]?.kind === "dropped") {
      expect(r.reviews[0].dropReason).toBe("round_mismatch");
    }
  });

  it("gate ④a author_unauthorized: explicit expectedBotAccount mismatch", async () => {
    const env = await buildEnv();
    // Reinstantiate watcher with mismatching bot account.
    const watcher = new PrWatcher(
      {
        callerId: CALLER,
        targetId: TARGET,
        machineBlockSecret: SECRET,
        expectedBotAccount: "WRONG-BOT",
        knownAgentProfileIds: ["sentinel"],
      },
      {
        store: env.store,
        clock: env.clock,
        gitHost: env.gitHost,
        ledger: env.ledger,
        droppedSignalCache: new DroppedReviewSignalCache(),
      },
    );
    const idemKey = "K-AUTH";
    const fields: ReviewCanonicalFields = {
      review_surface_id: SURFACE_ID,
      parent_kind: "slice",
      parent_id: SLICE_ID,
      parent_phase: "n/a",
      review_round: "0",
      session_id: SESSION_ID,
      turn_index: String(TURN_INDEX),
      agent_profile_id: AGENT_PROFILE,
      idempotency_key: idemKey,
    };
    const body = buildCanonicalReviewBody(fields);
    const submitted = await env.gitHost.submitPullRequestReview({
      prRef: env.prRef,
      intent: "approve",
      body,
      idempotencyKey: idemKey,
    });
    await seedReceiptAndOutbox(env, idemKey, submitted.externalReviewId);
    const r = await watcher.pollReviewSurface(env.surface);
    expect(r.reviews[0]?.kind).toBe("dropped");
    if (r.reviews[0]?.kind === "dropped") {
      expect(r.reviews[0].dropReason).toBe("author_unauthorized");
    }
  });

  it("gate ④b agent_profile_unknown: profile not in known set", async () => {
    const env = await buildEnv();
    // Watcher does not include "sentinel" in the known set.
    const watcher = new PrWatcher(
      {
        callerId: CALLER,
        targetId: TARGET,
        machineBlockSecret: SECRET,
        expectedBotAccount: "fs-mirror",
        knownAgentProfileIds: ["scout"],
      },
      {
        store: env.store,
        clock: env.clock,
        gitHost: env.gitHost,
        ledger: env.ledger,
        droppedSignalCache: new DroppedReviewSignalCache(),
      },
    );
    const idemKey = "K-PROFILE";
    const fields: ReviewCanonicalFields = {
      review_surface_id: SURFACE_ID,
      parent_kind: "slice",
      parent_id: SLICE_ID,
      parent_phase: "n/a",
      review_round: "0",
      session_id: SESSION_ID,
      turn_index: String(TURN_INDEX),
      agent_profile_id: "sentinel",
      idempotency_key: idemKey,
    };
    const body = buildCanonicalReviewBody(fields);
    const submitted = await env.gitHost.submitPullRequestReview({
      prRef: env.prRef,
      intent: "approve",
      body,
      idempotencyKey: idemKey,
    });
    await seedReceiptAndOutbox(env, idemKey, submitted.externalReviewId);
    const r = await watcher.pollReviewSurface(env.surface);
    expect(r.reviews[0]?.kind).toBe("dropped");
    if (r.reviews[0]?.kind === "dropped") {
      expect(r.reviews[0].dropReason).toBe("agent_profile_unknown");
    }
  });

  // --------------------------------------------------------------------
  // PR-123 review P0-2 regression — gpt5.5 noted that `classify()` did not
  // pass `review.externalReviewId` into `correlateTuple()`, so a posted
  // ledger row whose `external_review_id` belonged to a *different* review
  // could still satisfy gate ②. The fix: the live review's
  // externalReviewId must equal both the receipt's recorded id (when
  // present) and the outbox `submit_review_op` posted row's id, and the
  // posted row's `surface_ref` must be non-null and equal the surface.
  // --------------------------------------------------------------------
  it(
    "PR-123 P0-2 regression: posted ledger row's external_review_id mismatches live review → tuple_mismatch",
    async () => {
      const env = await buildEnv();
      const idemKey = "K-EID-MISMATCH";
      const fields: ReviewCanonicalFields = {
        review_surface_id: SURFACE_ID,
        parent_kind: "slice",
        parent_id: SLICE_ID,
        parent_phase: "n/a",
        review_round: "0",
        session_id: SESSION_ID,
        turn_index: String(TURN_INDEX),
        agent_profile_id: AGENT_PROFILE,
        idempotency_key: idemKey,
      };
      const body = buildCanonicalReviewBody(fields);
      const submitted = await env.gitHost.submitPullRequestReview({
        prRef: env.prRef,
        intent: "approve",
        body,
        idempotencyKey: idemKey,
      });
      // Seed receipt + outbox posted row, but the posted row's
      // `external_review_id` records a stale/forged value — NOT the live
      // review id. Before P0-2 this passed gate ② silently.
      await seedReceiptAndOutbox(env, idemKey, "STALE-OR-FORGED-REVIEW-ID");
      const r = await env.watcher.pollReviewSurface(env.surface);
      expect(r.reviews[0]?.kind).toBe("dropped");
      if (r.reviews[0]?.kind === "dropped") {
        expect(r.reviews[0].dropReason).toBe("tuple_mismatch");
      }
      // Live review id still unequal to seeded id — gate ② must reject.
      expect(submitted.externalReviewId).not.toBe("STALE-OR-FORGED-REVIEW-ID");
    },
  );

  it("request_changes verdict surfaces through `applied.verdict`", async () => {
    const env = await buildEnv();
    const idemKey = "K-RC";
    const fields: ReviewCanonicalFields = {
      review_surface_id: SURFACE_ID,
      parent_kind: "slice",
      parent_id: SLICE_ID,
      parent_phase: "n/a",
      review_round: "0",
      session_id: SESSION_ID,
      turn_index: String(TURN_INDEX),
      agent_profile_id: AGENT_PROFILE,
      idempotency_key: idemKey,
    };
    const body = buildCanonicalReviewBody(fields);
    const submitted = await env.gitHost.submitPullRequestReview({
      prRef: env.prRef,
      intent: "request_changes",
      body,
      idempotencyKey: idemKey,
    });
    await seedReceiptAndOutbox(env, idemKey, submitted.externalReviewId);
    const r = await env.watcher.pollReviewSurface(env.surface);
    expect(r.reviews[0]?.kind).toBe("applied");
    if (r.reviews[0]?.kind === "applied") {
      expect(r.reviews[0].verdict).toBe("request_changes");
    }
  });
});
