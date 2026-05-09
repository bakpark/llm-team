/**
 * Phase prod-4 — E2E sandbox harness.
 *
 * Provides a single seam (`createE2eRun` + `runInnerTddBuild` +
 * `verifyBlastRadius`) used by the `tests/e2e/*` scenarios. Behaviour:
 *
 *   - createE2eRun: mkdtemp workdir (mode 0700), copy + override sandbox
 *     fixture (`tests/fixtures/targets/e2e-sandbox.json`) onto the new
 *     workdir path, parse with `validateOrThrow`, return handle.
 *
 *   - runInnerTddBuild: drives `runOneInnerTurn` with a caller-supplied
 *     LlmRunnerPort. Default mock injection emits a `tests_green`
 *     envelope so the harness round-trip is exercised in default `npm
 *     test`. The LLM_TEAM_E2E live path simply requires the caller to
 *     pass a live runner — the harness has no opinion about the
 *     concrete adapter.
 *
 *   - verifyBlastRadius: invariant-style assertions used by the live
 *     scenario: trunk worktree must be untouched and any production
 *     ledger captured pre-run must remain byte-identical.
 *
 * Phase 10b will fold this into the production runner; the helper lives
 * in `tests/helpers/` so it never ships in the application bundle.
 */
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeAdapter } from "../../src/adapters/llm-runner/fake.js";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import type { LlmRunnerPort } from "../../src/ports/llm-runner.js";
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
import { validateOrThrow } from "../../src/application/config-validator.js";
import type { TargetConfig } from "../../src/config/target-schema.js";
import { SystemClock } from "../../src/ports/clock.js";

export const SANDBOX_FIXTURE_PATH = resolve(
  __dirname,
  "..",
  "fixtures",
  "targets",
  "e2e-sandbox.json",
);

export const DEFAULT_E2E_COST_CAP_USD = 0.2;

export interface E2eRunHandle {
  /** Absolute path of the sandboxed workdir (mode 0700). */
  workdir: string;
  /** Absolute path of the agent_cwd (mkdtemp sibling). */
  agentCwd: string;
  /** Parsed + workdir-overridden target config. */
  target: TargetConfig;
  /** Per-run cost cap (USD). */
  costCapUsd: number;
  /** Tear-down — removes workdir + agent_cwd. */
  cleanup(): void;
}

export interface CreateE2eRunOptions {
  /** Override fixture path (defaults to phase-prod-0 sandbox fixture). */
  fixturePath?: string;
  /** Override the per-run USD cap. */
  costCapUsd?: number;
  /** Process env (used for LLM_TEAM_E2E_COST_CAP_USD / LLM_TEAM_E2E_TMPDIR). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn an isolated sandbox run rooted at `mkdtempSync(<tmpdir>/llm-team-e2e-)`.
 *
 * The fixture is parsed (via `validateOrThrow`) and its `workdir_path` /
 * `agent_cwd` fields are rewritten to point inside the freshly-created
 * temp directory so subsequent FsStore writes never escape the run dir.
 */
export function createE2eRun(
  options: CreateE2eRunOptions = {},
): E2eRunHandle {
  const env = options.env ?? process.env;
  const root =
    env.LLM_TEAM_E2E_TMPDIR && env.LLM_TEAM_E2E_TMPDIR.length > 0
      ? env.LLM_TEAM_E2E_TMPDIR
      : tmpdir();
  const runRoot = mkdtempSync(join(root, "llm-team-e2e-"));
  // 0700: the sandbox is single-user; reject group/other access so secrets
  // captured under cycles/ never leak via shared tmp.
  chmodSync(runRoot, 0o700);

  const workdir = join(runRoot, "workdir");
  const agentCwd = join(runRoot, "agent_cwd");

  const fixturePath = options.fixturePath ?? SANDBOX_FIXTURE_PATH;
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
    string,
    unknown
  >;
  const identity = (raw["identity"] ?? {}) as Record<string, unknown>;
  raw["identity"] = {
    ...identity,
    workdir_path: workdir,
    agent_cwd: agentCwd,
  };
  const target = validateOrThrow(raw);

  const costCapUsd =
    options.costCapUsd ??
    parseCostCap(env.LLM_TEAM_E2E_COST_CAP_USD, DEFAULT_E2E_COST_CAP_USD);

  return {
    workdir,
    agentCwd,
    target,
    costCapUsd,
    cleanup() {
      try {
        rmSync(runRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function parseCostCap(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface RunInnerTddBuildOptions {
  handle: E2eRunHandle;
  /** Pre-built llmRunner. Default = mock FakeAdapter wired with `fixtureDir`. */
  llmRunner?: LlmRunnerPort;
  /**
   * Test commands callback forwarded to runOneInnerTurn. Default returns a
   * single `["true"]` invocation so FakeVerification's pass result is
   * accepted by the inner runner.
   */
  testCommands?: (cwd: string) => Array<{ argv: string[]; cwd: string }>;
  /** caller_id passed through to runOneInnerTurn. Default `e2e-caller`. */
  callerId?: string;
}

/**
 * Drives a single inner tdd_build turn against the sandbox run handle.
 *
 * The default LlmRunner is the test-only `FakeAdapter` — callers MUST
 * provide their own llmRunner when invoking from the LLM_TEAM_E2E live
 * scenario. The harness is intentionally agnostic about the concrete
 * adapter so it can be reused by future live providers.
 */
export async function runInnerTddBuild(opts: RunInnerTddBuildOptions) {
  const { handle } = opts;
  const store = new FsStore({ workdir: handle.workdir });
  const clock = new SystemClock();
  const logger = new NdjsonLogger({
    store,
    clock,
    relPath: LOG_DAEMON_PATH,
  });
  const ledger = new FileLedger({ store, logger });
  const wsRoot = join(handle.agentCwd, "workspaces");
  const workspace = new FakeWorkspace(wsRoot);
  const verification = new FakeVerification(clock, {
    test: { result: "pass" },
  });

  const llmRunner =
    opts.llmRunner ??
    new AdapterRunnerPort(
      new FakeAdapter({
        fixtureDir: join(handle.workdir, "_fixtures"),
      }),
    );

  return runOneInnerTurn({
    store,
    clock,
    llmRunner,
    workspace,
    verification,
    ledger,
    cfg: {
      callerId: opts.callerId ?? "e2e-caller",
      targetId: handle.target.identity.target_id,
      environmentFingerprint: "e2e-sandbox",
      testCommands:
        opts.testCommands ?? ((cwd) => [{ argv: ["true"], cwd }]),
    },
  });
}

export interface BlastRadiusSnapshot {
  /** `git status --short` output of the trunk repo. */
  trunkStatus: string;
  /** Byte-length of production ledger (or null if absent). */
  productionLedgerSize: number | null;
}

export interface BlastRadiusInput {
  /** Trunk repo root (cwd of the running test process). */
  trunkRoot?: string;
  /** Production ledger path to snapshot (optional). */
  productionLedgerPath?: string;
}

/**
 * Capture a baseline before a live e2e run. `verifyBlastRadius` will
 * compare the post-run state against this snapshot.
 */
export function snapshotBlastRadius(
  input: BlastRadiusInput = {},
): BlastRadiusSnapshot {
  const trunkRoot = input.trunkRoot ?? process.cwd();
  const trunkStatus = gitStatusShort(trunkRoot);
  const productionLedgerSize = ledgerSize(input.productionLedgerPath);
  return { trunkStatus, productionLedgerSize };
}

/**
 * Asserts that the trunk worktree and (optional) production ledger are
 * unchanged relative to `baseline`. Throws on mismatch — callers can
 * wrap in `expect(() => verifyBlastRadius(...)).not.toThrow()`.
 */
export function verifyBlastRadius(
  baseline: BlastRadiusSnapshot,
  input: BlastRadiusInput = {},
): void {
  const trunkRoot = input.trunkRoot ?? process.cwd();
  const trunkNow = gitStatusShort(trunkRoot);
  if (trunkNow !== baseline.trunkStatus) {
    throw new Error(
      `blast-radius: trunk git status drifted\nbefore:\n${baseline.trunkStatus}\nafter:\n${trunkNow}`,
    );
  }
  const ledgerNow = ledgerSize(input.productionLedgerPath);
  if (ledgerNow !== baseline.productionLedgerSize) {
    throw new Error(
      `blast-radius: production ledger size changed (${baseline.productionLedgerSize} → ${ledgerNow})`,
    );
  }
}

function gitStatusShort(cwd: string): string {
  try {
    return execSync("git status --short", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Non-git directories: return a stable sentinel so two snapshots can
    // still be compared by equality.
    return "<no-git>";
  }
}

function ledgerSize(path: string | undefined): number | null {
  if (!path) return null;
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

export const __layoutForTests = layout;
