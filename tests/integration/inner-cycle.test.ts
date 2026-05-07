import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapters/llm-runner/fake.js";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { NdjsonLogger } from "../../src/adapters/logger/ndjson.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FileLedger } from "../../src/application/ledger.js";
import { LOG_DAEMON_PATH, layout } from "../../src/application/persistence-layout.js";
import { runOneInnerTurn } from "../../src/application/turn-worker.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { SessionTurn } from "../../src/domain/schema/session-turn.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { SystemClock } from "../../src/ports/clock.js";

const TARGET_ID = "demo-target";
const SLICE_ID = "01HZS00000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const ISO = "2026-05-07T00:00:00.000Z";

function envelopeFixture(): string {
  return JSON.stringify({
    parent_loop: "inner",
    phase_or_purpose: "tdd_build",
    slice_id: SLICE_ID,
    slice_kind: "internal",
    tdd_phase: "red_green",
    agent_profile_id: "forge",
    agent_role_in_session: "lead",
    contribution_kind: "lead_draft",
    output_kind: "patch",
    object_id: SLICE_ID,
    summary: "first turn — implement add()",
    artifacts: {
      files: [
        { path: "src/add.ts", content: "export const add = (a:number,b:number)=>a+b;\n" },
        { path: "tests/add.test.ts", content: "import { add } from '../src/add';\nimport { test, expect } from 'vitest';\ntest('add', () => expect(add(1,2)).toBe(3));\n" },
      ],
    },
    // session_id, turn_index, manifest_id are placeholders the fake adapter
    // will leave intact — turn-worker injects them via prompt frontmatter and
    // header-echo check expects the fixture to match exactly. We override at
    // write time below.
  });
}

function readJson<T>(workdir: string, rel: string, parse: (raw: unknown) => T): T {
  const fs = require("node:fs") as typeof import("node:fs");
  return parse(JSON.parse(fs.readFileSync(join(workdir, rel), "utf8")));
}

function readNdjsonLines(workdir: string, rel: string): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  if (!fs.existsSync(join(workdir, rel))) return [];
  return fs
    .readFileSync(join(workdir, rel), "utf8")
    .split("\n")
    .filter((s) => s.length > 0);
}

describe("Phase 2 inner cycle integration", () => {
  it("forge solo SLICE_READY → SLICE_REVIEWING + SM_READY_FOR_REVIEW + ledger rows", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "inner-cycle-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "fxt-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-"));

    // Seed the SLICE_READY internal slice.
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
      state: "SLICE_READY",
      external_refs: [],
      created_at: ISO,
      updated_at: ISO,
    });
    const fs = await import("node:fs");
    fs.mkdirSync(join(workdir, "slices"), { recursive: true });
    fs.writeFileSync(
      join(workdir, layout.slice(SLICE_ID)),
      JSON.stringify(slice),
      "utf8",
    );

    // Fake LLM fixture — turn-worker uses the fake adapter via frontmatter
    // (agent_profile=forge / phase_or_purpose=tdd_build). Header echo is
    // checked against the runtime-generated session_id / manifest_id so we
    // wire those in via __SESSION__ / __MANIFEST_ID__ placeholders. The
    // fake adapter already substitutes __MANIFEST_ID__ from frontmatter; we
    // add session_id by post-processing the fixture body in agent-io
    // pipeline indirectly — easier: write fixture with placeholders, then
    // add a substitution wrapper. The fake adapter only knows __MANIFEST_ID__
    // and __PIN__; for session_id / turn_index the cleanest path is to write
    // the fixture as a JS Function… simpler: write a lightweight outer test
    // using callAgent directly. But here we exercise the full turn-worker.
    //
    // Trick: the fake adapter emits the fixture verbatim, but our envelope
    // requires session_id matching the runtime. We use a custom adapter that
    // stamps the runtime ids onto the envelope after the FakeAdapter returns.
    writeFileSync(
      join(fixtureDir, "forge-tdd_build.json"),
      JSON.stringify({ session_id: "__SESSION__", turn_index: 0, manifest_id: "__MANIFEST_ID__", input_revision_pins: ["__PIN__"] }),
      "utf8",
    );

    const wrapAdapter = new StampingFakeAdapter(envelopeFixture(), fixtureDir);
    const llmRunner = new AdapterRunnerPort(wrapAdapter);

    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
    const ledger = new FileLedger({ store, logger });

    const outcome = await runOneInnerTurn({
      store,
      clock,
      llmRunner,
      workspace: new FakeWorkspace(wsRoot),
      verification: new FakeVerification(clock, { test: { result: "pass" } }),
      ledger,
      cfg: {
        callerId: "test-caller",
        targetId: TARGET_ID,
        environmentFingerprint: "vitest",
        testCommands: (cwd) => [{ argv: ["true"], cwd }],
      },
    });

    expect(outcome.kind).toBe("converged");
    if (outcome.kind !== "converged") return;

    // Slice → SLICE_REVIEWING
    const updatedSlice = readJson(workdir, layout.slice(SLICE_ID), (raw) =>
      Slice.parse(raw),
    );
    expect(updatedSlice.state).toBe("SLICE_REVIEWING");
    expect(updatedSlice.current_session_id).toBeNull();

    // SliceMerge → SM_READY_FOR_REVIEW
    const sm = readJson(workdir, layout.sliceMerge(outcome.sliceMergeId), (raw) =>
      SliceMerge.parse(raw),
    );
    expect(sm.state).toBe("SM_READY_FOR_REVIEW");
    expect(sm.pre_merge_workspace_revision).toBe(outcome.workspaceCommit);

    // Session → CONVERGED tests_green
    const session = readJson(
      workdir,
      layout.sessionMetadata(outcome.sessionId),
      (raw) => DialogueSession.parse(raw),
    );
    expect(session.state).toBe("CONVERGED");
    expect(session.final_verdict).toBe("tests_green");

    // SessionTurn turn 0 persisted with envelope, workspace_commit, verification ref
    const turn = readJson(
      workdir,
      layout.sessionTurn(outcome.sessionId, 0),
      (raw) => SessionTurn.parse(raw),
    );
    expect(turn.workspace_commit).toBe(outcome.workspaceCommit);
    expect(turn.verification_result_ref).toBe(outcome.verificationRunId);
    expect(turn.output_envelope.contribution_kind).toBe("lead_draft");

    // Ledger has ≥4 rows (turn + session_finalize + slice_merge + slice transition)
    const rows = readNdjsonLines(workdir, "ledger/transitions.ndjson").map((l) =>
      LedgerRow.parse(JSON.parse(l)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const turnRow = rows.find(
      (r) =>
        r.action_kind === "session_progress" &&
        r.session_id === outcome.sessionId &&
        r.turn_index === 0,
    );
    expect(turnRow).toBeDefined();
    expect(turnRow?.result).toBe("applied");
    expect(turnRow?.audit_hash_prev.length).toBe(64);

    const sliceTx = rows.find(
      (r) => r.object_kind === "slice" && r.to_state === "SLICE_REVIEWING",
    );
    expect(sliceTx).toBeDefined();
    const smTx = rows.find(
      (r) =>
        r.object_kind === "slice_merge" && r.to_state === "SM_READY_FOR_REVIEW",
    );
    expect(smTx).toBeDefined();
  });

  it("returns noop when no SLICE_READY/SLICE_BUILDING internal slices exist", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "noop-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-noop-"));
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
    const ledger = new FileLedger({ store, logger });
    const fakeAdapter = new FakeAdapter({
      fixtureDir: mkdtempSync(join(tmpdir(), "empty-fxt-")),
    });
    const outcome = await runOneInnerTurn({
      store,
      clock,
      llmRunner: new AdapterRunnerPort(fakeAdapter),
      workspace: new FakeWorkspace(wsRoot),
      verification: new FakeVerification(clock),
      ledger,
      cfg: {
        callerId: "x",
        targetId: TARGET_ID,
        environmentFingerprint: "vitest",
        testCommands: () => [],
      },
    });
    expect(outcome.kind).toBe("noop");
  });
});

/**
 * Stamping fake adapter: behaves like FakeAdapter but rewrites the
 * fixture's envelope to use the runtime session_id / turn_index / manifest_id
 * extracted from the prompt frontmatter, so the header-echo check passes.
 */
class StampingFakeAdapter {
  readonly id = "fake" as const;
  constructor(
    private readonly envelopeJson: string,
    private readonly fixtureDir: string,
  ) {
    void this.fixtureDir;
  }
  async run(input: { stdin: string; agentCwd: string; timeoutSec: number }) {
    const envelope = JSON.parse(this.envelopeJson) as Record<string, unknown>;
    const headers = parseFrontmatter(input.stdin);
    envelope.session_id = headers.session_id;
    envelope.turn_index = Number(headers.turn_index);
    envelope.manifest_id = headers.manifest_id;
    // Pull the manifest's recorded revision pin to satisfy input_revision_pins.
    const manifestPins = extractManifestPins(input.stdin);
    envelope.input_revision_pins = manifestPins;
    const stdout = "```json\n" + JSON.stringify(envelope) + "\n```\n";
    void input.timeoutSec;
    void input.agentCwd;
    return {
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout,
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
