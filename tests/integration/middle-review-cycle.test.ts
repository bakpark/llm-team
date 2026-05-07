/**
 * Phase 3 integration: middle review cycle.
 *
 * Seeds a SLICE_REVIEWING slice + SM_READY_FOR_REVIEW SliceMerge + a passed
 * VerificationRun (the inner-cycle's residual evidence), then drives
 * `runOneMiddleReviewTurn` and asserts the post-state for three branches:
 *   1. middle approve → SM_MERGED + SLICE_VALIDATED.
 *   2. middle request_changes → SM_CLOSED + SLICE_BUILDING (rebuild).
 *   3. SM_STALE branch via FakeWorkspace.rebaseConflictSlices.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { NdjsonLogger } from "../../src/adapters/logger/ndjson.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { runOneMiddleReviewTurn } from "../../src/application/dialogue-coordinator.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  LOG_DAEMON_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { SystemClock } from "../../src/ports/clock.js";

const TARGET_ID = "demo-target";
const SLICE_ID = "01HZS00000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const SLICE_MERGE_ID = "01HZSM0000000000000000000A";
const VERIFICATION_RUN_ID = "01HZVR0000000000000000000A";
const ISO = "2026-05-08T00:00:00.000Z";

interface SeedOpts {
  slicePath?: string;
  /** Override slice's trunk_base_revision so reverify uses that. */
  trunkRevision?: string;
}

function seedFixture(workdir: string, opts: SeedOpts = {}) {
  mkdirSync(join(workdir, "slices"), { recursive: true });
  mkdirSync(join(workdir, "slice_merges"), { recursive: true });
  mkdirSync(join(workdir, "verifications"), { recursive: true });
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
    trunk_base_revision: opts.trunkRevision ?? "trunk-base",
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
    object_id: SLICE_MERGE_ID,
    summary: `sentinel verdict=${verdict}`,
    verdict: { result: verdict, rationale: null },
    artifacts: null,
  });
}

function readLedgerRows(workdir: string) {
  const path = join(workdir, "ledger/transitions.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => LedgerRow.parse(JSON.parse(s)));
}

function readJson<T>(workdir: string, rel: string, parse: (raw: unknown) => T): T {
  return parse(JSON.parse(readFileSync(join(workdir, rel), "utf8")));
}

describe("Phase 3 middle review cycle", () => {
  it("approve verdict → SM_APPROVED → SLICE_INTEGRATING → SM_MERGED + SLICE_VALIDATED", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "middle-approve-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));
    seedFixture(workdir);
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
    const ledger = new FileLedger({ store, logger });
    // FakeWorkspace needs the slice prepared so `rebaseOntoTrunk` can compute
    // the new commit. The middle review path calls prepareReadOnlyCheckout
    // first, but rebase relies on `prepareInnerWorkspace` having registered
    // state. We pre-register here.
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

    const adapter = new StampingFakeAdapter(envelopeFixture("approve"));
    const llmRunner = new AdapterRunnerPort(adapter);
    const verification = new FakeVerification(clock, { test: { result: "pass" } });

    const out = await runOneMiddleReviewTurn({
      store,
      clock,
      llmRunner,
      workspace,
      verification,
      ledger,
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
    });

    expect(out.kind).toBe("turn_persisted");
    if (out.kind !== "turn_persisted") return;
    expect(out.decision.converged).toBe(true);
    expect(out.dispatch?.kind).toBe("applied");

    const slice = readJson(workdir, layout.slice(SLICE_ID), (raw) =>
      Slice.parse(raw),
    );
    expect(slice.state).toBe("SLICE_VALIDATED");

    const sm = readJson(workdir, layout.sliceMerge(SLICE_MERGE_ID), (raw) =>
      SliceMerge.parse(raw),
    );
    expect(sm.state).toBe("SM_MERGED");
    expect(sm.merge_revision).not.toBeNull();
    expect(sm.merged_by_caller_id).toBe("test-caller");

    const session = readJson(
      workdir,
      layout.sessionMetadata(out.sessionId),
      (raw) => DialogueSession.parse(raw),
    );
    expect(session.state).toBe("CONVERGED");
    expect(session.final_verdict).toBe("approve");
    expect(session.purpose).toBe("review");

    const rows = readLedgerRows(workdir);
    // Expect: session_open + session_progress + session_finalize + SM_APPROVED
    // + SLICE_INTEGRATING + SM_MERGED + SLICE_VALIDATED.
    const findRow = (predicate: (r: ReturnType<typeof LedgerRow.parse>) => boolean) =>
      rows.find(predicate);
    expect(findRow((r) => r.action_kind === "session_finalize" && r.final_verdict === "approve")).toBeDefined();
    expect(findRow((r) => r.object_kind === "slice_merge" && r.to_state === "SM_APPROVED")).toBeDefined();
    expect(findRow((r) => r.object_kind === "slice" && r.to_state === "SLICE_INTEGRATING")).toBeDefined();
    expect(findRow((r) => r.object_kind === "slice_merge" && r.to_state === "SM_MERGED")).toBeDefined();
    expect(findRow((r) => r.object_kind === "slice" && r.to_state === "SLICE_VALIDATED")).toBeDefined();
  });

  it("request_changes verdict → SM_CLOSED + SLICE_BUILDING (rebuild slot)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "middle-rc-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));
    seedFixture(workdir);
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
    const ledger = new FileLedger({ store, logger });
    const workspace = new FakeWorkspace(wsRoot);

    const adapter = new StampingFakeAdapter(envelopeFixture("request_changes"));
    const llmRunner = new AdapterRunnerPort(adapter);

    const out = await runOneMiddleReviewTurn({
      store,
      clock,
      llmRunner,
      workspace,
      verification: new FakeVerification(clock, { test: { result: "pass" } }),
      ledger,
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
    });

    expect(out.kind).toBe("turn_persisted");
    if (out.kind !== "turn_persisted") return;
    expect(out.decision.converged).toBe(true);
    if (!out.decision.converged) return;
    expect(out.decision.final_verdict).toBe("request_changes");

    const slice = readJson(workdir, layout.slice(SLICE_ID), (raw) =>
      Slice.parse(raw),
    );
    expect(slice.state).toBe("SLICE_BUILDING");
    expect(slice.current_session_id).toBeNull();

    const sm = readJson(workdir, layout.sliceMerge(SLICE_MERGE_ID), (raw) =>
      SliceMerge.parse(raw),
    );
    expect(sm.state).toBe("SM_CLOSED");

    const rows = readLedgerRows(workdir);
    expect(
      rows.find(
        (r) => r.object_kind === "slice_merge" && r.to_state === "SM_CLOSED",
      ),
    ).toBeDefined();
    expect(
      rows.find(
        (r) => r.object_kind === "slice" && r.to_state === "SLICE_BUILDING",
      ),
    ).toBeDefined();
  });

  it("SM_STALE branch — rebase conflict during integration → SLICE_BLOCKED + SM_STALE (PR #62 P0-4)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "middle-stale-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));
    seedFixture(workdir);
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
    const ledger = new FileLedger({ store, logger });
    const workspace = new FakeWorkspace(wsRoot, {
      rebaseConflictSlices: new Set([SLICE_ID]),
    });
    await workspace.prepareInnerWorkspace({
      sliceId: SLICE_ID,
      trunkBaseRevision: "trunk-base",
    });

    const adapter = new StampingFakeAdapter(envelopeFixture("approve"));
    const llmRunner = new AdapterRunnerPort(adapter);

    const out = await runOneMiddleReviewTurn({
      store,
      clock,
      llmRunner,
      workspace,
      verification: new FakeVerification(clock, { test: { result: "pass" } }),
      ledger,
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
    });

    expect(out.kind).toBe("turn_persisted");
    if (out.kind !== "turn_persisted") return;
    expect(out.dispatch?.kind).toBe("applied");

    const slice = readJson(workdir, layout.slice(SLICE_ID), (raw) =>
      Slice.parse(raw),
    );
    // P0-4 fix: SLICE_BLOCKED instead of SLICE_REVIEWING (which was an
    // orphan state in phase 3 — pickReadyMiddleReview only finds
    // SM_READY_FOR_REVIEW, so SLICE_REVIEWING + SM_STALE was un-pickable).
    expect(slice.state).toBe("SLICE_BLOCKED");

    const sm = readJson(workdir, layout.sliceMerge(SLICE_MERGE_ID), (raw) =>
      SliceMerge.parse(raw),
    );
    expect(sm.state).toBe("SM_STALE");
    expect(sm.merge_revision).toBeNull();

    const rows = readLedgerRows(workdir);
    expect(
      rows.find(
        (r) =>
          r.object_kind === "slice_merge" &&
          r.to_state === "SM_STALE" &&
          r.result === "stale",
      ),
    ).toBeDefined();
  });

  it("reverify fail during integration → SM_STALE + SLICE_BLOCKED (PR #62 P2-12)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "middle-reverify-fail-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));
    seedFixture(workdir);
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
    const ledger = new FileLedger({ store, logger });
    const workspace = new FakeWorkspace(wsRoot);
    await workspace.prepareInnerWorkspace({
      sliceId: SLICE_ID,
      trunkBaseRevision: "trunk-base",
    });

    const adapter = new StampingFakeAdapter(envelopeFixture("approve"));
    const llmRunner = new AdapterRunnerPort(adapter);
    // FakeVerification returns `fail` for the reverify pass even though
    // rebase succeeds — this exercises the second SM_STALE branch the
    // SM_STALE conflict test does not cover.
    const verification = new FakeVerification(clock, { test: { result: "fail" } });

    const out = await runOneMiddleReviewTurn({
      store,
      clock,
      llmRunner,
      workspace,
      verification,
      ledger,
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
    });

    expect(out.kind).toBe("turn_persisted");
    if (out.kind !== "turn_persisted") return;

    const slice = readJson(workdir, layout.slice(SLICE_ID), (raw) =>
      Slice.parse(raw),
    );
    expect(slice.state).toBe("SLICE_BLOCKED");

    const sm = readJson(workdir, layout.sliceMerge(SLICE_MERGE_ID), (raw) =>
      SliceMerge.parse(raw),
    );
    expect(sm.state).toBe("SM_STALE");

    const rows = readLedgerRows(workdir);
    expect(
      rows.find(
        (r) =>
          r.object_kind === "slice_merge" &&
          r.to_state === "SM_STALE" &&
          r.result === "stale" &&
          (r.result_detail ?? "").includes("reverify"),
      ),
    ).toBeDefined();
  });

  it("returns noop when no SM_READY_FOR_REVIEW exists", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "middle-noop-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
    const ledger = new FileLedger({ store, logger });
    const adapter = new StampingFakeAdapter(envelopeFixture("approve"));
    const llmRunner = new AdapterRunnerPort(adapter);
    const out = await runOneMiddleReviewTurn({
      store,
      clock,
      llmRunner,
      workspace: new FakeWorkspace(wsRoot),
      verification: new FakeVerification(clock),
      ledger,
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      reverifyTestCommands: () => [],
    });
    expect(out.kind).toBe("noop");
  });
});

/**
 * Stamping fake adapter: behaves like FakeAdapter but rewrites the fixture's
 * envelope to use the runtime session_id / turn_index / manifest_id taken
 * from the prompt frontmatter, so the header-echo check in agent-io passes.
 */
class StampingFakeAdapter {
  readonly id = "fake" as const;
  constructor(private readonly envelopeJson: string) {}
  async run(input: { stdin: string; agentCwd: string; timeoutSec: number }) {
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
      const obj = JSON.parse(body) as { entries?: Array<{ revision_pin?: string }> };
      if (Array.isArray(obj.entries)) {
        return obj.entries
          .map((e) => e.revision_pin)
          .filter((p): p is string => typeof p === "string" && p.length > 0);
      }
    } catch {
      // continue
    }
  }
  return [];
}
