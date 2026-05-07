/**
 * Phase 2 inner cycle — failure-mode integration tests.
 *
 * Pairs with `inner-cycle.test.ts` (happy path + noop) to verify that each
 * off-happy-path branch:
 *   - emits an `invalid` ledger row (no audit gap),
 *   - leaves the slice / session in a state that the next pickup can
 *     reason about (no SessionNotOpenError loop, no orphan partial state),
 *   - does NOT promote the slice to SLICE_REVIEWING or SM_READY_FOR_REVIEW.
 *
 * Branches covered:
 *   1. invalid envelope (header echo mismatch — agent fixture replays the
 *      wrong session_id)
 *   2. stale-pin gate (manifest entry's recorded pin diverges from current
 *      revision — agent-io's recheckPins detects drift)
 *   3. verification fail (tests run, exit non-zero — turn persists, but no
 *      dispatch)
 *   4. verification empty-commands → error (cfg returns []; ShellVerification
 *      classifies as error per PR #61 review fix)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NdjsonLogger } from "../../src/adapters/logger/ndjson.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
import { ShellVerification } from "../../src/adapters/verification/shell.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  LOG_DAEMON_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import { runOneInnerTurn } from "../../src/application/turn-worker.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { SystemClock } from "../../src/ports/clock.js";
import type { LlmRunnerInput, LlmRunnerPort, LlmRunnerResult } from "../../src/ports/llm-runner.js";

const TARGET_ID = "demo-target";
const SLICE_ID = "01HZS00000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const ISO = "2026-05-08T00:00:00.000Z";

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

function seedReadySlice(workdir: string): void {
  const slice = Slice.parse({
    slice_id: SLICE_ID,
    milestone_id: MILESTONE_ID,
    slice_kind: "internal",
    value_statement: "demo",
    ac_ids: ["AC-1"],
    acceptance_tests: [
      { path: "tests/x.test.ts", name: "x", ac_id: "AC-1" },
    ],
    declared_scope: ["src/x.ts"],
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
  const fs = require("node:fs") as typeof import("node:fs");
  fs.mkdirSync(join(workdir, "slices"), { recursive: true });
  fs.writeFileSync(
    join(workdir, layout.slice(SLICE_ID)),
    JSON.stringify(slice),
    "utf8",
  );
}

function envelopeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    summary: "demo turn",
    artifacts: {
      files: [{ path: "src/x.ts", content: "export const x = 1;\n" }],
    },
    input_revision_pins: ["__PIN__"],
    ...overrides,
  };
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

function manifestPins(prompt: string): string[] {
  const re = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    try {
      const obj = JSON.parse(m[1] ?? "") as { entries?: Array<{ revision_pin?: string }> };
      if (Array.isArray(obj.entries)) {
        return obj.entries
          .map((e) => e.revision_pin)
          .filter((p): p is string => typeof p === "string");
      }
    } catch {}
  }
  return [];
}

/**
 * Test-only LlmRunnerPort that returns the supplied envelope literal,
 * stamping the runtime session_id / turn_index / manifest_id from the
 * prompt frontmatter and pulling input_revision_pins from the rendered
 * manifest. The override hook lets a test inject a wrong header echo
 * (used for the invalid-envelope branch).
 */
class StampingRunner implements LlmRunnerPort {
  constructor(
    private readonly envelope: Record<string, unknown>,
    private readonly transform?: (body: Record<string, unknown>) => Record<string, unknown>,
  ) {}
  async invoke(input: LlmRunnerInput): Promise<LlmRunnerResult> {
    const fs = await import("node:fs/promises");
    const promptBody = await fs.readFile(input.promptRef, "utf8");
    const fm = parseFrontmatter(promptBody);
    let env: Record<string, unknown> = {
      ...this.envelope,
      session_id: fm.session_id,
      turn_index: Number(fm.turn_index),
      manifest_id: fm.manifest_id,
      input_revision_pins: manifestPins(promptBody),
    };
    if (this.transform) env = this.transform(env);
    const stdout = "```json\n" + JSON.stringify(env) + "\n```\n";
    // Write synthetic envelope/diagnostic refs.
    const tmp = mkdtempSync(join(tmpdir(), "stamping-"));
    const envRef = join(tmp, "envelope.json");
    const diagRef = join(tmp, "diagnostics.txt");
    // The runtime executor strips the fence; here we emit the raw json
    // body to mimic the post-extraction state.
    const body = stdout
      .replace(/^```json\s*\n/, "")
      .replace(/\n```\s*$/, "");
    await fs.writeFile(envRef, body, "utf8");
    await fs.writeFile(diagRef, "", "utf8");
    return {
      exitStatus: "ok",
      envelopeRef: envRef,
      diagnosticsRef: diagRef,
      consumedAt: new Date().toISOString(),
    };
  }
}

function buildDeps(opts: {
  workdir: string;
  wsRoot: string;
  runner: LlmRunnerPort;
  testCommands: (cwd: string) => Parameters<typeof runOneInnerTurn>[0]["cfg"]["testCommands"] extends (
    cwd: string,
  ) => infer R
    ? R
    : never;
  verificationOutcome?: "pass" | "fail" | "error";
  shellVerification?: boolean;
}) {
  const store = new FsStore({ workdir: opts.workdir });
  const clock = new SystemClock();
  const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });
  const ledger = new FileLedger({ store, logger });
  const verification = opts.shellVerification
    ? new ShellVerification({ clock })
    : new FakeVerification(clock, {
        test: { result: opts.verificationOutcome ?? "pass" },
      });
  return {
    store,
    clock,
    llmRunner: opts.runner,
    workspace: new FakeWorkspace(opts.wsRoot),
    verification,
    ledger,
    cfg: {
      callerId: "test-caller",
      targetId: TARGET_ID,
      environmentFingerprint: "vitest",
      testCommands: opts.testCommands,
    },
  } as Parameters<typeof runOneInnerTurn>[0];
}

describe("Phase 2 inner cycle — failure modes", () => {
  it("invalid envelope (header echo mismatch) emits ledger invalid row + slice unchanged", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "fail-invalid-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-fail-invalid-"));
    seedReadySlice(workdir);
    const runner = new StampingRunner(envelopeBody(), (env) => ({
      ...env,
      session_id: "01HZSE0000000000000000000Z",
    }));
    const outcome = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        testCommands: (cwd) => [{ argv: ["true"], cwd }],
      }),
    );
    expect(outcome.kind).toBe("invalid_envelope");
    if (outcome.kind !== "invalid_envelope") return;
    expect(outcome.reason).toBe("header_echo_mismatch");

    const sliceLive = readJson(workdir, layout.slice(SLICE_ID), Slice.parse);
    expect(sliceLive.state).toBe("SLICE_BUILDING"); // ready-object opened the session, but did not promote past
    expect(sliceLive.current_session_id).toBe(outcome.sessionId);

    const sessionLive = readJson(
      workdir,
      layout.sessionMetadata(outcome.sessionId),
      DialogueSession.parse,
    );
    expect(sessionLive.state).toBe("SESSION_OPEN");

    const rows = readNdjsonLines(workdir, "ledger/transitions.ndjson").map((l) =>
      LedgerRow.parse(JSON.parse(l)),
    );
    const invalidRow = rows.find(
      (r) => r.action_kind === "session_progress" && r.result === "invalid",
    );
    expect(invalidRow, "must record an invalid ledger row").toBeDefined();
    expect(invalidRow?.result_detail).toContain("header_echo_mismatch");
    // No SLICE_REVIEWING transition row.
    expect(
      rows.find((r) => r.to_state === "SLICE_REVIEWING"),
    ).toBeUndefined();
  });

  // Stale-pin gate: covered at the unit level by `agent-io.test.ts`. The
  // SliceLocalPinResolver in turn-worker.ts captures the workspaceHead at
  // build time, so triggering drift through the public turn-worker entry
  // point would require a contrived custom resolver. The gate's behaviour
  // (invalid row + no commit/verification) is exercised directly via
  // `callAgent` in agent-io.test.ts → 'flags stale pins when the resolver
  // pin diverges from the manifest'.

  it("verification fail leaves SESSION_OPEN + persists session_progress (applied) but no dispatch", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "fail-verify-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-fail-verify-"));
    seedReadySlice(workdir);
    const runner = new StampingRunner(envelopeBody());
    const outcome = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        verificationOutcome: "fail",
        testCommands: (cwd) => [{ argv: ["true"], cwd }],
      }),
    );
    expect(outcome.kind).toBe("verification_failed");
    if (outcome.kind !== "verification_failed") return;

    const sliceLive = readJson(workdir, layout.slice(SLICE_ID), Slice.parse);
    expect(sliceLive.state).toBe("SLICE_BUILDING");
    const sessionLive = readJson(
      workdir,
      layout.sessionMetadata(outcome.sessionId),
      DialogueSession.parse,
    );
    expect(sessionLive.state).toBe("SESSION_OPEN");

    const rows = readNdjsonLines(workdir, "ledger/transitions.ndjson").map((l) =>
      LedgerRow.parse(JSON.parse(l)),
    );
    const turnRow = rows.find(
      (r) => r.action_kind === "session_progress" && r.turn_index === 0,
    );
    expect(turnRow).toBeDefined();
    expect(turnRow?.verification_run_id).toBe(outcome.verificationRunId);
    expect(rows.find((r) => r.to_state === "SLICE_REVIEWING")).toBeUndefined();
    expect(rows.find((r) => r.to_state === "CONVERGED")).toBeUndefined();
  });

  it("empty verification commands → error (no zero-check tests_green)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "fail-empty-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-fail-empty-"));
    seedReadySlice(workdir);
    const runner = new StampingRunner(envelopeBody());
    const outcome = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        shellVerification: true,
        testCommands: () => [],
      }),
    );
    expect(outcome.kind).toBe("verification_failed");
    if (outcome.kind !== "verification_failed") return;

    const rows = readNdjsonLines(workdir, "ledger/transitions.ndjson").map((l) =>
      LedgerRow.parse(JSON.parse(l)),
    );
    expect(rows.find((r) => r.to_state === "SLICE_REVIEWING")).toBeUndefined();
  });
});
