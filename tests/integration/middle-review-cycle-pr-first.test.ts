/**
 * Phase 3 PR-first reviewer path (cli-spicy-anchor.md §1, §8 — PR sequence
 * PR-5). Exercises the dialogue-coordinator's `reviewer_path: "pr_first"`
 * option branch end-to-end:
 *
 *   - sentinel review → `ReviewerInvoker.invoke` (read-only checkout +
 *     submit_review_op outbox + review-machine block 9 fields + nonce)
 *   - SessionTurn persisted with additive `output_receipt_ref` /
 *     `output_intent_ref` (PR #119 P0a lesson — pr-first path mirrors
 *     legacy persistence)
 *   - `existingSurface` loaded from `Slice.review_surface_id` (PR #119
 *     P1a lesson — never null)
 *   - termination + caller-dispatch fires the same SM_APPROVED /
 *     SLICE_INTEGRATING / SM_MERGED transitions as the legacy envelope
 *     path
 *
 * Default behaviour (`reviewer_path: "envelope"` or unset) is covered by
 * the existing `middle-review-cycle.test.ts`; this file only asserts the
 * new branch path.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { runOneMiddleReviewTurn } from "../../src/application/dialogue-coordinator.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  parseLastMatch,
  verifyNonce,
} from "../../src/application/machine-block.js";
import { Outbox } from "../../src/application/outbox.js";
import { layout } from "../../src/application/persistence-layout.js";
import { ReviewerInvoker } from "../../src/application/reviewer-invoker.js";
import { newId } from "../../src/domain/ids.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { ReviewSurface } from "../../src/domain/schema/review-surface.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { SystemClock } from "../../src/ports/clock.js";

const TARGET_ID = "demo-target";
const SLICE_ID = "01HZS00000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const SLICE_MERGE_ID = "01HZSM0000000000000000000A";
const VERIFICATION_RUN_ID = "01HZVR0000000000000000000A";
const ISO = "2026-05-08T00:00:00.000Z";
const SECRET = "test-reviewer-secret";

async function seedFixtureWithSurface(
  workdir: string,
  store: FsStore,
  gitHost: FsMirrorGitHost,
): Promise<{ surfaceId: string; prId: string }> {
  mkdirSync(join(workdir, "slices"), { recursive: true });
  mkdirSync(join(workdir, "slice_merges"), { recursive: true });
  mkdirSync(join(workdir, "verifications"), { recursive: true });
  mkdirSync(join(workdir, "review_surfaces"), { recursive: true });

  // Open a real PR via the gitHost so the reviewer has a handle.
  const prRef = await gitHost.openPullRequest({
    title: "slice review subject",
    body: "stub body",
    headBranch: `slice/${SLICE_ID}`,
    baseBranch: "main",
    draft: false,
    labels: [],
  });
  const clock = new SystemClock();
  const surfaceId = newId(clock.now());
  const surface = ReviewSurface.parse({
    review_surface_id: surfaceId,
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
    head_sha: "head-sha-1",
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
    layout.reviewSurface(surfaceId),
    JSON.stringify(surface),
  );

  const slice = Slice.parse({
    slice_id: SLICE_ID,
    milestone_id: MILESTONE_ID,
    slice_kind: "internal",
    value_statement: "add() function",
    ac_ids: ["AC-1"],
    acceptance_tests: [
      { path: "tests/add.test.ts", name: "add", ac_id: "AC-1" },
    ],
    declared_scope: ["src/add.ts", "tests/add.test.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state: "SLICE_REVIEWING",
    current_session_id: null,
    review_surface_id: surfaceId,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  writeFileSync(
    join(workdir, layout.slice(SLICE_ID)),
    JSON.stringify(slice),
    "utf8",
  );
  const sm = SliceMerge.parse({
    slice_merge_id: SLICE_MERGE_ID,
    slice_id: SLICE_ID,
    target_id: TARGET_ID,
    pre_merge_workspace_revision: "inner-commit-1",
    merge_revision: null,
    inner_session_id: "01HZSE0000000000000000000A",
    review_session_id: null,
    verification_run_id: VERIFICATION_RUN_ID,
    state: "SM_READY_FOR_REVIEW",
    merged_at: null,
    merged_by_caller_id: null,
    lease_token: null,
    audit_chain_predecessor_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  writeFileSync(
    join(workdir, layout.sliceMerge(SLICE_MERGE_ID)),
    JSON.stringify(sm),
    "utf8",
  );
  const vr = {
    verification_run_id: VERIFICATION_RUN_ID,
    target_id: TARGET_ID,
    target_revision: "inner-commit-1",
    commands_or_checks: ["true"],
    environment_fingerprint: "vitest",
    started_at: ISO,
    finished_at: ISO,
    result: "pass",
    failed_tests: [],
    log_ref: null,
  };
  writeFileSync(
    join(workdir, layout.verification(VERIFICATION_RUN_ID)),
    JSON.stringify(vr),
    "utf8",
  );
  return { surfaceId, prId: prRef.id };
}

function envelopeFixture(verdict: "approve" | "request_changes"): string {
  return JSON.stringify({
    parent_loop: "middle",
    phase_or_purpose: "review",
    slice_id: SLICE_ID,
    slice_kind: "internal",
    agent_profile_id: "sentinel",
    agent_role_in_session: "lead",
    contribution_kind: "review_verdict",
    output_kind: "verdict",
    object_id: SLICE_ID,
    summary: `sentinel verdict=${verdict}`,
    verdict: { result: verdict, rationale: null },
    artifacts: {
      body: `reviewer body for ${verdict}`,
      file_comments: [],
    },
  });
}

function readLedgerRows(workdir: string) {
  const path = join(workdir, "ledger/transitions.ndjson");
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => LedgerRow.parse(JSON.parse(s)));
  } catch {
    return [];
  }
}

class StampingFakeAdapter {
  readonly id = "fake" as const;
  readonly receivedPrompts: string[] = [];
  constructor(private readonly envelopeJson: string) {}
  async run(input: { stdin: string; agentCwd: string; timeoutSec: number }) {
    this.receivedPrompts.push(input.stdin);
    const envelope = JSON.parse(this.envelopeJson) as Record<string, unknown>;
    const headers = parseFrontmatter(input.stdin);
    envelope.session_id = headers.session_id;
    envelope.turn_index = Number(headers.turn_index);
    envelope.manifest_id = headers.manifest_id;
    envelope.input_revision_pins = extractManifestPins(input.stdin);
    void input.timeoutSec;
    void input.agentCwd;
    return {
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: "```json\n" + JSON.stringify(envelope) + "\n```\n",
      stderr: "",
    };
  }
}

function parseFrontmatter(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body.startsWith("---\n")) return out;
  const end = body.indexOf("\n---\n", 4);
  if (end < 0) return out;
  const fm = body.slice(4, end);
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function extractManifestPins(prompt: string): string[] {
  const re = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const body = m[1] ?? "";
    try {
      const obj = JSON.parse(body) as {
        entries?: Array<{ revision_pin?: string }>;
      };
      if (Array.isArray(obj.entries)) {
        return obj.entries
          .map((e) => e.revision_pin)
          .filter((p): p is string => typeof p === "string" && p.length > 0);
      }
    } catch {
      /* continue */
    }
  }
  return [];
}

describe("dialogue-coordinator · reviewer_path=pr_first (Phase 3)", () => {
  it("approve verdict → PR review submitted + review-machine block + SM_APPROVED → SM_MERGED", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "middle-pr-first-approve-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const ledger = new FileLedger({ store });
    const gitHost = new FsMirrorGitHost(store);
    const { surfaceId, prId } = await seedFixtureWithSurface(
      workdir,
      store,
      gitHost,
    );
    const workspace = new FakeWorkspace(wsRoot);
    await workspace.prepareInnerWorkspace({
      sliceId: SLICE_ID,
      trunkBaseRevision: "trunk-base",
    });
    await workspace.commit({
      sliceId: SLICE_ID,
      message: "initial",
      files: [{ path: "src/add.ts", content: "x" }],
    });
    const outbox = new Outbox({ store, ledger });
    const reviewerInvoker = new ReviewerInvoker(
      {
        callerId: "test-caller",
        targetId: TARGET_ID,
        retryCap: 3,
        agentTimeoutSec: 60,
      },
      {
        store,
        clock,
        llmRunner: new AdapterRunnerPort(
          new StampingFakeAdapter(envelopeFixture("approve")),
        ),
        workspace,
        gitHost,
        ledger,
        machineBlockSecret: SECRET,
        outbox,
      },
    );

    const out = await runOneMiddleReviewTurn({
      store,
      clock,
      llmRunner: new AdapterRunnerPort(
        new StampingFakeAdapter(envelopeFixture("approve")),
      ),
      workspace,
      verification: new FakeVerification(clock, { test: { result: "pass" } }),
      ledger,
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
      reviewerPath: "pr_first",
      reviewerInvoker,
    });

    expect(out.kind).toBe("reviewer_path_pr_first");
    if (out.kind !== "reviewer_path_pr_first") return;
    expect(out.outcome.kind).toBe("succeeded");
    expect(out.decision?.converged).toBe(true);

    // PR review submitted with verifiable last-match review-machine block.
    const reviews = await gitHost.listPullRequestReviews({
      provider: "fs-mirror",
      id: prId,
    });
    expect(reviews.length).toBe(1);
    expect(reviews[0]!.state).toBe("approved");
    const parsed = parseLastMatch(reviews[0]!.body, "review");
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    expect(parsed.fields.review_surface_id).toBe(surfaceId);
    expect(parsed.fields.parent_kind).toBe("slice");
    expect(parsed.fields.session_id).toBe(out.sessionId);
    expect(verifyNonce(SECRET, "review", parsed.fields, parsed.nonce)).toBe(
      true,
    );

    // Caller-dispatch ran: SM_APPROVED + SLICE_INTEGRATING + SM_MERGED.
    const rows = readLedgerRows(workdir);
    expect(
      rows.find(
        (r) => r.object_kind === "slice_merge" && r.to_state === "SM_APPROVED",
      ),
    ).toBeDefined();
    expect(
      rows.find(
        (r) => r.object_kind === "slice_merge" && r.to_state === "SM_MERGED",
      ),
    ).toBeDefined();
    expect(
      rows.find(
        (r) => r.object_kind === "slice" && r.to_state === "SLICE_VALIDATED",
      ),
    ).toBeDefined();

    // submit_review_op outbox pending+posted rows present.
    const submitRows = rows
      .filter((r) => r.op_kind === "submit_review_op")
      .map((r) => r.action_kind);
    expect(submitRows).toContain("outbox_pending");
    expect(submitRows).toContain("outbox_posted");

    // SessionTurn additive refs persisted (PR #119 P0a lesson).
    const turnPath = layout.sessionTurn(out.sessionId, 0);
    const turn = JSON.parse(
      readFileSync(join(workdir, turnPath), "utf8"),
    ) as Record<string, unknown>;
    expect(turn.output_receipt_ref).toBeDefined();
    expect(turn.output_intent_ref).toBeDefined();
  });

  it("missing ReviewSurface (P1a guard) → invalid_envelope, no review submitted", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "middle-pr-first-nosurf-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const ledger = new FileLedger({ store });
    const gitHost = new FsMirrorGitHost(store);
    // Seed the fixture but DROP `slice.review_surface_id` so the loader
    // returns null and the coordinator must abandon the PR-first turn
    // with a structured `invalid_envelope` outcome.
    mkdirSync(join(workdir, "slices"), { recursive: true });
    mkdirSync(join(workdir, "slice_merges"), { recursive: true });
    mkdirSync(join(workdir, "verifications"), { recursive: true });
    const slice = Slice.parse({
      slice_id: SLICE_ID,
      milestone_id: MILESTONE_ID,
      slice_kind: "internal",
      value_statement: "add",
      ac_ids: ["AC-1"],
      acceptance_tests: [
        { path: "tests/add.test.ts", name: "add", ac_id: "AC-1" },
      ],
      declared_scope: ["src/add.ts"],
      declared_metric_threshold: null,
      interface_break: false,
      dependencies: [],
      trunk_base_revision: "trunk-base",
      dod_revision_pin: "dod-pin",
      state: "SLICE_REVIEWING",
      current_session_id: null,
      external_refs: [],
      created_at: ISO,
      updated_at: ISO,
    });
    writeFileSync(
      join(workdir, layout.slice(SLICE_ID)),
      JSON.stringify(slice),
      "utf8",
    );
    const sm = SliceMerge.parse({
      slice_merge_id: SLICE_MERGE_ID,
      slice_id: SLICE_ID,
      target_id: TARGET_ID,
      pre_merge_workspace_revision: "inner-commit-1",
      merge_revision: null,
      inner_session_id: "01HZSE0000000000000000000A",
      review_session_id: null,
      verification_run_id: VERIFICATION_RUN_ID,
      state: "SM_READY_FOR_REVIEW",
      merged_at: null,
      merged_by_caller_id: null,
      lease_token: null,
      audit_chain_predecessor_id: null,
      external_refs: [],
      created_at: ISO,
      updated_at: ISO,
    });
    writeFileSync(
      join(workdir, layout.sliceMerge(SLICE_MERGE_ID)),
      JSON.stringify(sm),
      "utf8",
    );
    writeFileSync(
      join(workdir, layout.verification(VERIFICATION_RUN_ID)),
      JSON.stringify({
        verification_run_id: VERIFICATION_RUN_ID,
        target_id: TARGET_ID,
        target_revision: "inner-commit-1",
        commands_or_checks: ["true"],
        environment_fingerprint: "vitest",
        started_at: ISO,
        finished_at: ISO,
        result: "pass",
        failed_tests: [],
        log_ref: null,
      }),
      "utf8",
    );

    const workspace = new FakeWorkspace(wsRoot);
    const outbox = new Outbox({ store, ledger });
    const reviewerInvoker = new ReviewerInvoker(
      {
        callerId: "test-caller",
        targetId: TARGET_ID,
        retryCap: 3,
      },
      {
        store,
        clock,
        llmRunner: new AdapterRunnerPort(
          new StampingFakeAdapter(envelopeFixture("approve")),
        ),
        workspace,
        gitHost,
        ledger,
        machineBlockSecret: SECRET,
        outbox,
      },
    );

    const out = await runOneMiddleReviewTurn({
      store,
      clock,
      llmRunner: new AdapterRunnerPort(
        new StampingFakeAdapter(envelopeFixture("approve")),
      ),
      workspace,
      verification: new FakeVerification(clock, { test: { result: "pass" } }),
      ledger,
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
      reviewerPath: "pr_first",
      reviewerInvoker,
    });

    expect(out.kind).toBe("invalid_envelope");
    if (out.kind !== "invalid_envelope") return;
    expect(out.detail).toContain("review_surface_id");

    // PR #121 review P1-A regression guard: the missing-surface guard must
    // finalize the DialogueSession to ABANDONED + emit a session_finalize
    // ledger row so `pickReadyMiddleReview` does not re-select this
    // SESSION_OPEN session on the next daemon iteration.
    const sessionPath = layout.sessionMetadata(out.sessionId);
    const sessionAfter = JSON.parse(
      readFileSync(join(workdir, sessionPath), "utf8"),
    ) as { state: string; abandoned_reason: string | null };
    expect(sessionAfter.state).toBe("ABANDONED");
    expect(sessionAfter.abandoned_reason).toBe("no_progress");
    const rows = readLedgerRows(workdir);
    expect(
      rows.find(
        (r) =>
          r.object_kind === "dialogue_session" &&
          r.action_kind === "session_finalize" &&
          r.to_state === "ABANDONED" &&
          r.session_id === out.sessionId,
      ),
    ).toBeDefined();
  });
});
