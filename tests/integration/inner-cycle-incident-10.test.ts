/**
 * incident-10 — turn-worker behaviour on per-phase timeout overrides + the
 * `inner_lr_invoke_timeout` retry cap.
 *
 * Anchors:
 *   - target-schema: ContextBudgetEntry.timeout_sec, FailurePolicy.inner_lr_timeout_cap
 *   - failure-policy: countLrInvokeTimeoutsFromLedger, classifyAgentIoStageFailure
 *   - turn-worker: agentTimeoutSec resolution + abandonInnerSession (lr_invoke tag)
 *
 * Two integration scenarios:
 *   1. agentTimeoutSec resolution prefers `cfg.contextBudget["inner.tdd_build"].timeout_sec`
 *      over the legacy `agentTimeoutSec` fallback. The runner records the
 *      `timeoutSec` value it sees and the test asserts on it.
 *   2. After 5 prior `lr_invoke/lr_exit_status: ... exitStatus=timeout`
 *      ledger rows for the session, the next pickup classifies the session
 *      as ABANDONED via `inner_lr_invoke_escalated`.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NdjsonLogger } from "../../src/adapters/logger/ndjson.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
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
import type {
  LlmRunnerInput,
  LlmRunnerPort,
  LlmRunnerResult,
} from "../../src/ports/llm-runner.js";

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
    acceptance_tests: [{ path: "tests/x.test.ts", name: "x", ac_id: "AC-1" }],
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
  mkdirSync(join(workdir, "slices"), { recursive: true });
  writeFileSync(
    join(workdir, layout.slice(SLICE_ID)),
    JSON.stringify(slice),
    "utf8",
  );
}

/**
 * Runner that always returns `exitStatus: "timeout"` and records the
 * timeoutSec it was asked to honor. Used by both scenarios to (a) capture
 * the per-phase override and (b) drive the retry-cap path.
 */
class TimeoutRunner implements LlmRunnerPort {
  public lastTimeoutSec = -1;
  public callCount = 0;

  async invoke(input: LlmRunnerInput): Promise<LlmRunnerResult> {
    this.lastTimeoutSec = input.timeoutSec;
    this.callCount += 1;
    const fs = await import("node:fs/promises");
    const tmp = mkdtempSync(join(tmpdir(), "timeout-runner-"));
    const envRef = join(tmp, "envelope.json");
    const diagRef = join(tmp, "diagnostics.txt");
    await fs.writeFile(envRef, "", "utf8");
    await fs.writeFile(diagRef, "", "utf8");
    return {
      exitStatus: "timeout",
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
  contextBudget?: import("../../src/config/target-schema.js").ContextBudget;
  failurePolicy?: import("../../src/config/target-schema.js").FailurePolicy;
  agentTimeoutSec?: number;
}) {
  const store = new FsStore({ workdir: opts.workdir });
  const clock = new SystemClock();
  const logger = new NdjsonLogger({
    store,
    clock,
    relPath: LOG_DAEMON_PATH,
  });
  const ledger = new FileLedger({ store, logger });
  const verification = new FakeVerification(clock, {
    test: { result: "pass" },
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
      testCommands: (cwd: string) => [{ argv: ["true" as string], cwd }],
      contextBudget: opts.contextBudget,
      failurePolicy: opts.failurePolicy,
      agentTimeoutSec: opts.agentTimeoutSec,
    },
  } as Parameters<typeof runOneInnerTurn>[0];
}

describe("incident-10 — agentTimeoutSec resolution", () => {
  it("prefers context_budget per-phase timeout_sec over agentTimeoutSec fallback", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "incident-10-tmo-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-incident-10-tmo-"));
    seedReadySlice(workdir);
    const runner = new TimeoutRunner();
    await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        agentTimeoutSec: 120, // legacy fallback that the override must beat
        contextBudget: {
          "inner.tdd_build": { token_hard_cap: 128_000, timeout_sec: 600 },
        },
      }),
    );
    expect(runner.lastTimeoutSec).toBe(600);
  });

  it("falls back to architecture default (600) for inner.tdd_build when no override is set", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "incident-10-default-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-incident-10-default-"));
    seedReadySlice(workdir);
    const runner = new TimeoutRunner();
    await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        // No contextBudget, no agentTimeoutSec — should use TIMEOUT_SEC_DEFAULTS.
      }),
    );
    expect(runner.lastTimeoutSec).toBe(600);
  });

  it("PR #110 P1-a: legacy agentTimeoutSec wins over architecture default when no per-phase timeout_sec is set", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "incident-10-legacy-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-incident-10-legacy-"));
    seedReadySlice(workdir);
    const runner = new TimeoutRunner();
    await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        // Operator explicitly set the legacy global `agentTimeoutSec: 30`
        // and did NOT supply a per-phase `context_budget.*.timeout_sec`.
        // Per PR #110 P1-a, the explicit caller override must take
        // precedence over `TIMEOUT_SEC_DEFAULTS["inner.tdd_build"]` so
        // operator-set short timeouts are not silently inflated.
        agentTimeoutSec: 30,
        contextBudget: {
          "inner.tdd_build": { token_hard_cap: 128_000 },
        },
      }),
    );
    expect(runner.lastTimeoutSec).toBe(30);
  });
});

describe("incident-10 — inner_lr_invoke_timeout retry cap", () => {
  it("after 5 prior lr_invoke timeout rows, next pickup classifies the session ABANDONED", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "incident-10-cap-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-incident-10-cap-"));
    seedReadySlice(workdir);

    // First turn establishes the inner session via the standard pickup path.
    // (The runner returns timeout, so an `lr_invoke/lr_exit_status` invalid
    // row is appended automatically.) After this we know `current_session_id`.
    const runner = new TimeoutRunner();
    const first = await runOneInnerTurn(
      buildDeps({ workdir, wsRoot, runner }),
    );
    expect(first.kind).toBe("invalid_envelope");
    if (first.kind !== "invalid_envelope") return;
    const sessionId = first.sessionId;

    // Inject 4 more synthetic prior `lr_invoke/lr_exit_status` invalid
    // rows for the same session via the public ledger API (so audit_hash
    // chaining is preserved). Combined with the row produced by the
    // first call above, the next pickup sees totalFailures=5.
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const logger = new NdjsonLogger({
      store,
      clock,
      relPath: LOG_DAEMON_PATH,
    });
    const ledger = new FileLedger({ store, logger });
    for (let i = 0; i < 4; i++) {
      await ledger.appendTransition({
        transition_id: `01HZSE000000000000000000${i}A`,
        target_id: TARGET_ID,
        object_id: sessionId,
        object_kind: "session_turn",
        from_state: null,
        to_state: `turn_index=${i + 100}`,
        loop_kind: "inner",
        phase: null,
        slice_id: SLICE_ID,
        slice_kind: "internal",
        dod_revision: "dod-pin",
        session_id: sessionId,
        turn_index: i + 100,
        slot_kind: "delivery",
        agent_profile_id: "forge",
        contribution_kind: null,
        action_kind: "session_progress",
        final_verdict: null,
        caller_id: "test-caller",
        manifest_id: `01HZMA000000000000000000${i}A`,
        input_revision_pins: [],
        output_hash: null,
        verification_run_id: null,
        metric_run_id: null,
        idempotency_key: `synthetic-${i}`,
        lease_token: null,
        lease_kind: null,
        result: "invalid",
        result_detail:
          "lr_invoke/lr_exit_status: LlmRunner exitStatus=timeout; envelopeRef=/tmp/x",
        timestamp: ISO,
      });
    }

    // Second pickup of the same session: still SESSION_OPEN, runner still
    // times out. evaluateRetry sees totalFailures-1 == 5 (after the
    // emitInvalidTurn writes its row the new total is 6) → counter passed
    // is 5 → 5 >= cap=5 → escalate.
    const second = await runOneInnerTurn(
      buildDeps({ workdir, wsRoot, runner }),
    );
    expect(second.kind).toBe("inner_lr_invoke_escalated");
    if (second.kind !== "inner_lr_invoke_escalated") return;
    expect(second.sessionId).toBe(sessionId);
    expect(second.detail).toContain("inner_lr_invoke_timeout");

    // Session metadata is now ABANDONED, so the next pickup will not
    // re-select it (pickReadyInnerTurn guards on SESSION_OPEN).
    const sessionLive = readJson(
      workdir,
      layout.sessionMetadata(sessionId),
      DialogueSession.parse,
    );
    expect(sessionLive.state).toBe("ABANDONED");
    expect(sessionLive.abandoned_reason).toBe("no_progress");

    const rows = readNdjsonLines(workdir, "ledger/transitions.ndjson").map(
      (l) => LedgerRow.parse(JSON.parse(l)),
    );
    const finalize = rows.find(
      (r) =>
        r.action_kind === "session_finalize" &&
        r.session_id === sessionId &&
        r.to_state === "ABANDONED",
    );
    expect(finalize, "must record session_finalize row").toBeDefined();
    // idempotency tag distinguishes incident-10 from incident-3 cap-hits.
    expect(finalize?.idempotency_key).toContain("ABANDONED");
  });

  it("respects operator override (failure_policy.inner_lr_timeout_cap = 1)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "incident-10-override-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-incident-10-override-"));
    seedReadySlice(workdir);

    const runner = new TimeoutRunner();
    // First turn opens the session and records 1 timeout row. With
    // operator override cap=1 the very next pickup escalates: after the
    // 2nd `emitInvalidTurn` writes its row, ledger total=2 → counter
    // passed to evaluateRetry is 1 → 1 >= cap=1 → escalate.
    const first = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        failurePolicy: { inner_lr_timeout_cap: 1 },
      }),
    );
    expect(first.kind).toBe("invalid_envelope");
    if (first.kind !== "invalid_envelope") return;

    const second = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        failurePolicy: { inner_lr_timeout_cap: 1 },
      }),
    );
    expect(second.kind).toBe("inner_lr_invoke_escalated");
  });

  it("PR #110 P0: on inner_lr_invoke_escalated the slice is rolled back to SLICE_READY with current_session_id=null and a slice-transition ledger row is appended", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "incident-10-p0-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-incident-10-p0-"));
    seedReadySlice(workdir);

    const runner = new TimeoutRunner();
    // cap=1 so we escalate on the 2nd pickup without injecting synthetic rows.
    const first = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        failurePolicy: { inner_lr_timeout_cap: 1 },
      }),
    );
    expect(first.kind).toBe("invalid_envelope");
    if (first.kind !== "invalid_envelope") return;
    const sessionId = first.sessionId;

    // After 1st turn the slice should be SLICE_BUILDING with current_session_id set.
    const sliceMid = readJson(workdir, layout.slice(SLICE_ID), Slice.parse);
    expect(sliceMid.state).toBe("SLICE_BUILDING");
    expect(sliceMid.current_session_id).toBe(sessionId);

    const second = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        failurePolicy: { inner_lr_timeout_cap: 1 },
      }),
    );
    expect(second.kind).toBe("inner_lr_invoke_escalated");

    // P0 contract: slice restored to SLICE_READY, current_session_id cleared.
    const sliceAfter = readJson(workdir, layout.slice(SLICE_ID), Slice.parse);
    expect(sliceAfter.state).toBe("SLICE_READY");
    expect(sliceAfter.current_session_id).toBeNull();

    // Ledger must contain a slice transition row recording the rollback.
    const rows = readNdjsonLines(workdir, "ledger/transitions.ndjson").map(
      (l) => LedgerRow.parse(JSON.parse(l)),
    );
    const sliceRollback = rows.find(
      (r) =>
        r.object_kind === "slice" &&
        r.object_id === SLICE_ID &&
        r.to_state === "SLICE_READY" &&
        r.session_id === sessionId &&
        r.idempotency_key.includes("abandon_slice_rollback"),
    );
    expect(
      sliceRollback,
      "must record slice SLICE_BUILDING → SLICE_READY rollback row",
    ).toBeDefined();
  });
});

describe("incident-10 — context_budget forwarding (PR #110 P1-b)", () => {
  it("forwards cfg.contextBudget to callAgent so per-phase token_hard_cap reaches composePromptWithBudget", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "incident-10-budget-"));
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-incident-10-budget-"));
    seedReadySlice(workdir);

    // Tiny per-phase token_hard_cap forces composePromptWithBudget to
    // produce `context_budget_truncation` BEFORE the LLM runner is
    // invoked. This is observable proof that `cfg.contextBudget` made it
    // through callAgent → composePromptWithBudget. Without the P1-b fix,
    // the resolver would only see contextBudget for the timeout path and
    // composePromptWithBudget would fall back to architecture defaults
    // (no truncation triggered).
    const runner = new TimeoutRunner();
    const outcome = await runOneInnerTurn(
      buildDeps({
        workdir,
        wsRoot,
        runner,
        contextBudget: {
          "inner.tdd_build": { token_hard_cap: 1 },
        },
      }),
    );

    expect(outcome.kind).toBe("invalid_envelope");
    if (outcome.kind !== "invalid_envelope") return;
    expect(outcome.stage).toBe("prompt_compose");
    expect(outcome.reason).toBe("context_budget_truncation");
    // Runner must NOT have been invoked — composePromptWithBudget short-circuits.
    expect(runner.callCount).toBe(0);
  });
});
