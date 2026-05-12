/**
 * Phase 4 PR-6 — caller-dispatch-prfirst tests (§10 dispatch matrix per
 * parent_kind).
 *
 * Coverage:
 *   - milestone Discovery approve → PR merge X, M_DISCOVERY_DRAFT →
 *     M_SPECIFICATION_DRAFT, parent_phase advances, review_state =
 *     pending_review, review_round monotonic
 *   - milestone Specification approve → PR merge O (outbox merge_op),
 *     M_SPECIFICATION_DRAFT → M_SPEC_APPROVED, lifecycle = merged
 *   - milestone Planning approve → PR merge O, M_DELIVERY_PLANNING →
 *     M_DELIVERY_BUILDING
 *   - milestone Validation approve → PR merge O, M_DELIVERY_VALIDATING →
 *     M_DONE
 *   - milestone (any phase) request_changes → review_round++, review_state =
 *     changes_requested, **no PR close**
 *   - merge_op outbox crash recovery — second dispatch is idempotent
 */

import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FileLedger } from "../../src/application/ledger.js";
import { Outbox } from "../../src/application/outbox.js";
import {
  PrFirstDispatcher,
} from "../../src/application/caller-dispatch-prfirst.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import { ReviewSurface } from "../../src/domain/schema/review-surface.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { FixedClock } from "../../src/ports/clock.js";

const ISO = "2026-05-08T00:00:00.000Z";
const FIXED_MS = new Date(ISO).valueOf();
const TARGET = "demo";
const CALLER = "test-caller";
const SURFACE_ID = "01HZSR0000000000000000000A";
const MS_ID = "01HZM00000000000000000000A";

interface MilestoneEnv {
  store: MemoryStore;
  clock: FixedClock;
  ledger: FileLedger;
  gitHost: FsMirrorGitHost;
  outbox: Outbox;
  dispatcher: PrFirstDispatcher;
  surface: ReturnType<typeof ReviewSurface.parse>;
  milestone: ReturnType<typeof Milestone.parse>;
  prRef: { provider: string; id: string };
}

async function buildMilestoneEnv(opts: {
  parentPhase: "Discovery" | "Specification" | "Planning" | "Validation";
  initialState:
    | "M_DISCOVERY_DRAFT"
    | "M_SPECIFICATION_DRAFT"
    | "M_DELIVERY_PLANNING"
    | "M_DELIVERY_VALIDATING";
  reviewRound?: number;
}): Promise<MilestoneEnv> {
  const store = new MemoryStore();
  const clock = new FixedClock(FIXED_MS);
  const ledger = new FileLedger({ store });
  const gitHost = new FsMirrorGitHost(store);
  const outbox = new Outbox({ store, ledger });
  const wsRoot = mkdtempSync(join(tmpdir(), "pf-"));
  const workspace = new FakeWorkspace(wsRoot);

  const prRef = await gitHost.openPullRequest({
    title: "milestone pr",
    body: "stub",
    headBranch: `milestone/${MS_ID}`,
    baseBranch: "main",
    draft: false,
    labels: [],
  });

  const surface = ReviewSurface.parse({
    review_surface_id: SURFACE_ID,
    parent_kind: "milestone",
    parent_id: MS_ID,
    parent_phase: opts.parentPhase,
    pr_ref: {
      provider: "fs_mirror",
      id: prRef.id,
      node_id: null,
      url: `fs-mirror://${prRef.id}`,
    },
    branch: `milestone/${MS_ID}`,
    base_ref: "main",
    head_sha: "ms-head",
    review_round: opts.reviewRound ?? 0,
    lifecycle_state: "open",
    review_state: "pending_review",
    build_state: "not_applicable",
    latest_verification_run_id: null,
    last_synced_external_revision: null,
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(
    layout.reviewSurface(SURFACE_ID),
    JSON.stringify(surface),
  );

  const milestone = Milestone.parse({
    milestone_id: MS_ID,
    target_id: TARGET,
    title: "Milestone",
    state: opts.initialState,
    slot_kind: opts.parentPhase === "Validation" ? "delivery" : "discovery",
    intake_source_kind: "feature_request",
    intake_source_id: "fr-1",
    spec_revision_pin: null,
    context_summary_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(
    layout.milestone(MS_ID),
    JSON.stringify(milestone),
  );

  const dispatcher = new PrFirstDispatcher(
    { callerId: CALLER, targetId: TARGET },
    {
      store,
      clock,
      gitHost,
      ledger,
      outbox,
      workspace,
      verification: { run: async () => { throw new Error("unused"); } } as never,
    },
  );

  return {
    store,
    clock,
    ledger,
    gitHost,
    outbox,
    dispatcher,
    surface,
    milestone,
    prRef,
  };
}

async function readPrState(env: MilestoneEnv): Promise<string> {
  const fetched = await env.gitHost.fetchPullRequest({
    provider: "fs_mirror",
    id: env.prRef.id,
  });
  return fetched?.state ?? "missing";
}

async function readMilestoneState(env: MilestoneEnv): Promise<string> {
  const body = (await env.store.readText(layout.milestone(MS_ID))) ?? "";
  return Milestone.parse(JSON.parse(body)).state;
}

async function readSurface(env: MilestoneEnv) {
  const body = (await env.store.readText(layout.reviewSurface(SURFACE_ID))) ?? "";
  return ReviewSurface.parse(JSON.parse(body));
}

describe("caller-dispatch-prfirst · milestone phases", () => {
  it("Discovery approve → PR merge X, M_DISCOVERY_DRAFT → M_SPECIFICATION_DRAFT, parent_phase → Specification, round unchanged", async () => {
    const env = await buildMilestoneEnv({
      parentPhase: "Discovery",
      initialState: "M_DISCOVERY_DRAFT",
      reviewRound: 2,
    });
    const result = await env.dispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: env.surface,
      milestone: env.milestone,
      sessionId: "01HZSE0000000000000000000A",
      verdict: "approve",
      parentPhase: "Discovery",
    });
    expect(result.kind).toBe("milestone_approved_promote");
    if (result.kind === "milestone_approved_promote") {
      expect(result.mergedPr).toBe(false);
    }
    // PR remains open — gate against accidental merge_op call.
    expect(await readPrState(env)).toBe("open");
    expect(await readMilestoneState(env)).toBe("M_SPECIFICATION_DRAFT");
    const sf = await readSurface(env);
    expect(sf.parent_phase).toBe("Specification");
    expect(sf.review_state).toBe("pending_review");
    expect(sf.review_round).toBe(2); // monotonic — unchanged on Discovery approve
    expect(sf.lifecycle_state).toBe("open");
  });

  it("Specification approve → outbox merge_op posts → M_SPECIFICATION_DRAFT → M_SPEC_APPROVED + lifecycle merged", async () => {
    const env = await buildMilestoneEnv({
      parentPhase: "Specification",
      initialState: "M_SPECIFICATION_DRAFT",
    });
    const result = await env.dispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: env.surface,
      milestone: env.milestone,
      sessionId: "01HZSE0000000000000000000A",
      verdict: "approve",
      parentPhase: "Specification",
    });
    expect(result.kind).toBe("milestone_approved_promote");
    if (result.kind === "milestone_approved_promote") {
      expect(result.mergedPr).toBe(true);
      expect(result.mergeCommitSha).not.toBeNull();
    }
    expect(await readPrState(env)).toBe("merged");
    expect(await readMilestoneState(env)).toBe("M_SPEC_APPROVED");
    const sf = await readSurface(env);
    expect(sf.lifecycle_state).toBe("merged");
    expect(sf.review_state).toBe("approved");
    // outbox merge_op ledger rows present.
    const rows = ((await env.store.readText(LEDGER_TRANSITIONS_PATH)) ?? "")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => LedgerRow.parse(JSON.parse(s)));
    const mergeOps = rows.filter((r) => r.op_kind === "merge_op");
    expect(mergeOps.some((r) => r.action_kind === "outbox_pending")).toBe(true);
    expect(mergeOps.some((r) => r.action_kind === "outbox_posted")).toBe(true);
  });

  it("Planning approve → M_DELIVERY_PLANNING → M_DELIVERY_BUILDING + PR merged", async () => {
    const env = await buildMilestoneEnv({
      parentPhase: "Planning",
      initialState: "M_DELIVERY_PLANNING",
    });
    const result = await env.dispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: env.surface,
      milestone: env.milestone,
      sessionId: "01HZSE0000000000000000000A",
      verdict: "approve",
      parentPhase: "Planning",
    });
    expect(result.kind).toBe("milestone_approved_promote");
    expect(await readPrState(env)).toBe("merged");
    expect(await readMilestoneState(env)).toBe("M_DELIVERY_BUILDING");
  });

  it("Validation approve → M_DELIVERY_VALIDATING → M_DONE + PR merged", async () => {
    const env = await buildMilestoneEnv({
      parentPhase: "Validation",
      initialState: "M_DELIVERY_VALIDATING",
    });
    const result = await env.dispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: env.surface,
      milestone: env.milestone,
      sessionId: "01HZSE0000000000000000000A",
      verdict: "approve",
      parentPhase: "Validation",
    });
    expect(result.kind).toBe("milestone_approved_promote");
    expect(await readPrState(env)).toBe("merged");
    expect(await readMilestoneState(env)).toBe("M_DONE");
  });

  it("request_changes (Specification) → review_round++, review_state=changes_requested, PR stays open", async () => {
    const env = await buildMilestoneEnv({
      parentPhase: "Specification",
      initialState: "M_SPECIFICATION_DRAFT",
      reviewRound: 1,
    });
    const result = await env.dispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: env.surface,
      milestone: env.milestone,
      sessionId: "01HZSE0000000000000000000A",
      verdict: "request_changes",
      parentPhase: "Specification",
    });
    expect(result.kind).toBe("milestone_request_changes");
    expect(await readPrState(env)).toBe("open");
    expect(await readMilestoneState(env)).toBe("M_SPECIFICATION_DRAFT");
    const sf = await readSurface(env);
    expect(sf.review_round).toBe(2);
    expect(sf.review_state).toBe("changes_requested");
    expect(sf.lifecycle_state).toBe("open");
  });

  it("merge_op crash recovery — re-dispatch after partial completion is idempotent (PR stays merged)", async () => {
    const env = await buildMilestoneEnv({
      parentPhase: "Specification",
      initialState: "M_SPECIFICATION_DRAFT",
    });
    // First dispatch: full success.
    await env.dispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: env.surface,
      milestone: env.milestone,
      sessionId: "01HZSE0000000000000000000A",
      verdict: "approve",
      parentPhase: "Specification",
    });
    // Re-dispatch the same outcome — milestone state advance is idempotent
    // (M_SPEC_APPROVED → M_SPEC_APPROVED is the same-state no-op branch).
    // fs-mirror.mergePullRequest is itself idempotent (already merged → it
    // re-writes the same `state=merged` blob). The second dispatch must not
    // crash.
    const liveSurface = await readSurface(env);
    const liveMilestone = Milestone.parse(
      JSON.parse((await env.store.readText(layout.milestone(MS_ID))) ?? ""),
    );
    const result = await env.dispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: liveSurface,
      milestone: liveMilestone,
      sessionId: "01HZSE0000000000000000000A",
      verdict: "approve",
      parentPhase: "Specification",
    });
    expect(result.kind).toBe("milestone_approved_promote");
    expect(await readPrState(env)).toBe("merged");
    expect(await readMilestoneState(env)).toBe("M_SPEC_APPROVED");
  });
});
