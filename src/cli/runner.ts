#!/usr/bin/env -S node --enable-source-maps
import { readFile } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FakeAdapter } from "../adapters/llm-runner/fake.js";
import { AdapterRunnerPort } from "../adapters/llm-runner/runtime-port.js";
import { NdjsonLogger } from "../adapters/logger/ndjson.js";
import { FsStore } from "../adapters/store/fs.js";
import { FakeVerification } from "../adapters/verification/fake.js";
import { ShellVerification } from "../adapters/verification/shell.js";
import { GitWorktreeWorkspace } from "../adapters/workspace/git-worktree.js";
import { FakeWorkspace } from "../adapters/workspace/fake.js";
import { validateOrThrow } from "../application/config-validator.js";
import { FileLedger } from "../application/ledger.js";
import { LOG_DAEMON_PATH } from "../application/persistence-layout.js";
import { runOneInnerTurn } from "../application/turn-worker.js";
import { runOneMiddleReviewTurn } from "../application/dialogue-coordinator.js";
import { SystemClock } from "../ports/clock.js";

/**
 * CLI entrypoint — runs a single coordinator iteration and exits.
 *
 * Phase 2 (inner cycle, forge solo):
 *   tsx src/cli/runner.ts --once --agent-profile forge \
 *     --target ./target.json [--workdir <path>]
 *     [--fake-llm-fixtures <dir>] [--fake-workspace] [--fake-verification]
 *
 * Phase 3 (middle review, sentinel solo):
 *   tsx src/cli/runner.ts --once --dialogue-coordinator \
 *     --target ./target.json [--workdir <path>]
 *     [--fake-llm-fixtures <dir>] [--fake-workspace] [--fake-verification]
 *
 * `--dialogue-coordinator` and `--agent-profile` are mutually exclusive —
 * the flag picks which loop the runner advances. Daemon mode (continuous
 * cycle, multi-process) arrives in phase 4.
 *
 * PID lockdir at `<workdir>/log/runner.pid.lock` prevents two runners
 * from racing on the same workdir. The lock is released on exit.
 */

interface CliArgs {
  once: boolean;
  agentProfile: string;
  dialogueCoordinator: boolean;
  targetPath: string;
  workdir?: string;
  fakeLlmFixtures?: string;
  fakeWorkspace: boolean;
  fakeVerification: boolean;
  testCmd?: string;
  callerId: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const a = [...argv];
  const out: CliArgs = {
    once: false,
    agentProfile: "",
    dialogueCoordinator: false,
    targetPath: "./target.json",
    fakeWorkspace: false,
    fakeVerification: false,
    callerId: process.env.LLM_TEAM_CALLER_ID ?? `caller-${process.pid}`,
  };
  while (a.length > 0) {
    const flag = a.shift()!;
    switch (flag) {
      case "--once":
        out.once = true;
        break;
      case "--agent-profile":
        out.agentProfile = a.shift() ?? "";
        break;
      case "--dialogue-coordinator":
        out.dialogueCoordinator = true;
        break;
      case "--target":
        out.targetPath = a.shift() ?? "";
        break;
      case "--workdir":
        out.workdir = a.shift();
        break;
      case "--fake-llm-fixtures":
        out.fakeLlmFixtures = a.shift();
        break;
      case "--fake-workspace":
        out.fakeWorkspace = true;
        break;
      case "--fake-verification":
        out.fakeVerification = true;
        break;
      case "--test-cmd":
        out.testCmd = a.shift();
        break;
      case "--caller-id":
        out.callerId = a.shift() ?? out.callerId;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!out.once) throw new Error("CLI requires --once");
  if (out.dialogueCoordinator && out.agentProfile !== "")
    throw new Error(
      "--dialogue-coordinator and --agent-profile are mutually exclusive",
    );
  if (!out.dialogueCoordinator && out.agentProfile !== "forge")
    throw new Error(
      "phase 2 inner cycle requires --agent-profile forge (or use --dialogue-coordinator for phase 3 middle review)",
    );
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const targetRaw = JSON.parse(await readFile(args.targetPath, "utf8"));
  const cfg = validateOrThrow(targetRaw);
  const workdir = resolve(
    args.workdir ?? cfg.identity.workdir_path ?? process.cwd(),
  );
  const store = new FsStore({ workdir });
  const clock = new SystemClock();
  const logger = new NdjsonLogger({ store, clock, relPath: LOG_DAEMON_PATH });

  // PID lockdir
  const lockPath = resolve(workdir, "log", "runner.pid.lock");
  mkdirSync(resolve(workdir, "log"), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (e) {
    throw new Error(
      `another runner appears active (lockdir exists): ${lockPath}: ${(e as Error).message}`,
    );
  }
  writeFileSync(resolve(lockPath, "pid"), String(process.pid), "utf8");

  try {
    const ledger = new FileLedger({
      store,
      logger,
      auditHashSeed: cfg.identity.audit_hash_seed,
    });

    const llmRunner = args.fakeLlmFixtures
      ? new AdapterRunnerPort(
          new FakeAdapter({ fixtureDir: args.fakeLlmFixtures }),
        )
      : (() => {
          throw new Error(
            "phase 2 CLI requires --fake-llm-fixtures (real adapters wired in later phases)",
          );
        })();

    const workspace = args.fakeWorkspace
      ? new FakeWorkspace(resolve(workdir, "workspaces"))
      : new GitWorktreeWorkspace({
          repoRoot: process.cwd(),
          workspacesDir: resolve(workdir, "workspaces"),
        });

    const verification = args.fakeVerification
      ? new FakeVerification(clock)
      : new ShellVerification({ clock });

    const testCommands = (cwd: string) => [
      args.testCmd
        ? { argv: tokenize(args.testCmd), cwd }
        : { argv: ["npm", "test"], cwd },
    ];

    if (args.dialogueCoordinator) {
      const outcome = await runOneMiddleReviewTurn({
        store,
        clock,
        llmRunner,
        workspace,
        verification,
        ledger,
        callerId: args.callerId,
        targetId: cfg.identity.target_id,
        environmentFingerprint: `node${process.version}`,
        reverifyTestCommands: testCommands,
      });
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      return outcome.kind === "noop" || outcome.kind === "turn_persisted"
        ? 0
        : 1;
    }

    const outcome = await runOneInnerTurn({
      store,
      clock,
      llmRunner,
      workspace,
      verification,
      ledger,
      cfg: {
        callerId: args.callerId,
        targetId: cfg.identity.target_id,
        testCommands,
        environmentFingerprint: `node${process.version}`,
      },
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return outcome.kind === "noop" ||
      outcome.kind === "converged"
      ? 0
      : 1;
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function tokenize(cmd: string): string[] {
  return cmd.split(/\s+/).filter((s) => s.length > 0);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exit(2);
    },
  );
}

export { main as runnerMain };
