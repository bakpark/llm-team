#!/usr/bin/env -S node --enable-source-maps
/**
 * Phase 4 daemon CLI — runs continuous loops with lease-protected pickup.
 *
 *   tsx src/cli/daemon.ts --role turn-worker | dialogue-coordinator | recovery
 *     --target ./target.json [--workdir <path>]
 *     [--once] [--cycle-interval-ms 1000]
 *     [--fake-llm-fixtures <dir>] [--fake-workspace] [--fake-verification]
 *
 * Roles:
 *   - `turn-worker`         — phase-2 inner cycle (forge solo).
 *   - `dialogue-coordinator` — phase-3 middle review pickup.
 *   - `recovery`            — phase-4 sweeper. Cycles through expired leases.
 *
 * Atomicity (RGC-DAEMON-STARTUP): every daemon role takes a per-role PID
 * lockdir under `<workdir>/log/daemon-<role>.pid.lock`. Sibling failure on
 * startup terminates the process (the higher-level launcher cleans up).
 *
 * Multi-process model: a real deployment runs three processes (one per role)
 * sharing the workdir. Lease CAS in `FsLease` ensures cross-process safety
 * for object pickup; the daemon role lockdir prevents two same-role daemons
 * from racing.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FakeAdapter } from "../adapters/llm-runner/fake.js";
import { AdapterRunnerPort } from "../adapters/llm-runner/runtime-port.js";
import { FsLease } from "../adapters/lease/fs.js";
import { NdjsonLogger } from "../adapters/logger/ndjson.js";
import { FsStore } from "../adapters/store/fs.js";
import { FakeVerification } from "../adapters/verification/fake.js";
import { ShellVerification } from "../adapters/verification/shell.js";
import { GitWorktreeWorkspace } from "../adapters/workspace/git-worktree.js";
import { FakeWorkspace } from "../adapters/workspace/fake.js";
import { validateOrThrow } from "../application/config-validator.js";
import { runOneMiddleReviewTurn } from "../application/dialogue-coordinator.js";
import { FileLedger } from "../application/ledger.js";
import { runOneOuterTurn } from "../application/outer-turn.js";
import { LOG_DAEMON_PATH } from "../application/persistence-layout.js";
import { runRecoverySweep } from "../application/recovery.js";
import { runOneInnerTurn } from "../application/turn-worker.js";
import { SystemClock } from "../ports/clock.js";

type DaemonRole =
  | "turn-worker"
  | "dialogue-coordinator"
  | "outer-coordinator"
  | "recovery";

interface CliArgs {
  role: DaemonRole;
  targetPath: string;
  workdir?: string;
  once: boolean;
  cycleIntervalMs: number;
  fakeLlmFixtures?: string;
  fakeWorkspace: boolean;
  fakeVerification: boolean;
  testCmd?: string;
  callerId: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const a = [...argv];
  const out: Partial<CliArgs> & {
    fakeWorkspace: boolean;
    fakeVerification: boolean;
    once: boolean;
    cycleIntervalMs: number;
    callerId: string;
    targetPath: string;
  } = {
    fakeWorkspace: false,
    fakeVerification: false,
    once: false,
    cycleIntervalMs: 1_000,
    callerId: process.env.LLM_TEAM_CALLER_ID ?? `daemon-${process.pid}`,
    targetPath: "./target.json",
  };
  while (a.length > 0) {
    const flag = a.shift()!;
    switch (flag) {
      case "--role": {
        const v = a.shift();
        if (
          v !== "turn-worker" &&
          v !== "dialogue-coordinator" &&
          v !== "outer-coordinator" &&
          v !== "recovery"
        )
          throw new Error(
            `--role must be turn-worker | dialogue-coordinator | outer-coordinator | recovery (got ${v ?? "<missing>"})`,
          );
        out.role = v;
        break;
      }
      case "--target":
        out.targetPath = a.shift() ?? out.targetPath;
        break;
      case "--workdir":
        out.workdir = a.shift();
        break;
      case "--once":
        out.once = true;
        break;
      case "--cycle-interval-ms": {
        const n = Number.parseInt(a.shift() ?? "", 10);
        if (!Number.isFinite(n) || n < 0)
          throw new Error("--cycle-interval-ms must be a non-negative integer");
        out.cycleIntervalMs = n;
        break;
      }
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
  if (out.role == null)
    throw new Error(
      "--role is required (turn-worker | dialogue-coordinator | outer-coordinator | recovery)",
    );
  return out as CliArgs;
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

  // Per-role PID lockdir (RGC-DAEMON-STARTUP).
  const lockPath = resolve(workdir, "log", `daemon-${args.role}.pid.lock`);
  mkdirSync(resolve(workdir, "log"), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (e) {
    throw new Error(
      `another daemon role=${args.role} appears active (lockdir exists): ${lockPath}: ${(e as Error).message}`,
    );
  }
  writeFileSync(resolve(lockPath, "pid"), String(process.pid), "utf8");

  let interrupted = false;
  const onSig = () => {
    interrupted = true;
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  // Hoisted so the finally block can release any leases the daemon still
  // holds at shutdown (P2-12).
  const lease = new FsLease({ store, clock });

  try {
    const ledger = new FileLedger({
      store,
      logger,
      auditHashSeed: cfg.identity.audit_hash_seed,
    });

    const llmRunner = args.fakeLlmFixtures
      ? new AdapterRunnerPort(new FakeAdapter({ fixtureDir: args.fakeLlmFixtures }))
      : args.role === "recovery"
        ? null
        : (() => {
            throw new Error(
              "non-recovery daemons require --fake-llm-fixtures (real adapters wired in later phases)",
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

    do {
      // Every cycle starts with a recovery sweep (RGC-RECOVERY).
      const sweep = await runRecoverySweep({
        store,
        clock,
        ledger,
        lease,
        callerId: args.callerId,
        targetId: cfg.identity.target_id,
      });
      // PR #64 review P2-5: surface non-empty sweep results so operators
      // can see when recovery actually fires (otherwise it was invisible).
      if (
        sweep.expiredLeases.length > 0 ||
        sweep.reanimatedSlices.length > 0 ||
        sweep.reanimatedSessions.length > 0
      ) {
        logger.log({
          level: "warn",
          event: "recovery.swept",
          fields: {
            role: args.role,
            expired_leases: sweep.expiredLeases.length,
            reanimated_slices: sweep.reanimatedSlices,
            reanimated_sessions: sweep.reanimatedSessions,
          },
        });
      }
      let outcomeJson: string;
      switch (args.role) {
        case "turn-worker": {
          if (llmRunner == null) throw new Error("turn-worker needs llmRunner");
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
            lease,
            leaseConfig: cfg.lease,
          });
          outcomeJson = JSON.stringify({ role: args.role, outcome });
          break;
        }
        case "dialogue-coordinator": {
          if (llmRunner == null) throw new Error("dialogue-coordinator needs llmRunner");
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
            lease,
            leaseConfig: cfg.lease,
          });
          outcomeJson = JSON.stringify({ role: args.role, outcome });
          break;
        }
        case "outer-coordinator": {
          // Phase 5b.3 — outer Discovery / Specification / Planning /
          // Validation pickup. No slice-anchored lease in 5b.3 (outer
          // sessions are milestone-anchored; per-role lockdir prevents
          // duplicate outer-coordinator daemons). Cross-process safety for
          // multiple distinct milestones progresses through fairness in a
          // future phase.
          if (llmRunner == null) throw new Error("outer-coordinator needs llmRunner");
          const outcome = await runOneOuterTurn({
            store,
            clock,
            llmRunner,
            ledger,
            callerId: args.callerId,
            targetId: cfg.identity.target_id,
          });
          outcomeJson = JSON.stringify({ role: args.role, outcome });
          break;
        }
        case "recovery": {
          // Recovery sweep already ran above — emit a noop outcome.
          outcomeJson = JSON.stringify({ role: args.role, outcome: { kind: "swept" } });
          break;
        }
      }
      process.stdout.write(`${outcomeJson}\n`);
      if (args.once || interrupted) break;
      if (args.cycleIntervalMs > 0)
        await new Promise((r) => setTimeout(r, args.cycleIntervalMs));
    } while (!interrupted);
    return 0;
  } finally {
    // P2-12 fix (PR #63 review): graceful shutdown — release any leases
    // we still hold so sibling daemons don't have to wait out the TTL.
    // Per-call leases (e.g. session_lease inside dialogue-coordinator) are
    // already released via try/finally in the application layer; this
    // catches role-level leases the daemon held (none in phase-4, but the
    // hook is in place for phase-5 wire-up).
    try {
      const held = await lease.list();
      for (const l of held) {
        if (l.worker_id === args.callerId) {
          await lease.release({
            leaseId: l.lease_id,
            leaseToken: l.lease_token,
          });
        }
      }
    } catch {
      // best-effort
    }
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

export { main as daemonMain };
