#!/usr/bin/env -S node --enable-source-maps
/**
 * Phase 4 daemon CLI — runs continuous loops with lease-protected pickup.
 *
 *   tsx src/cli/daemon.ts --role turn-worker | dialogue-coordinator | recovery
 *     | drift-observer | scout-scanner
 *     --target ./target.json [--workdir <path>]
 *     [--once] [--cycle-interval-ms 1000]
 *     [--fake-llm-fixtures <dir>] [--fake-workspace] [--fake-verification]
 *
 * Roles:
 *   - `turn-worker`         — phase-2 inner cycle (forge solo).
 *   - `dialogue-coordinator` — phase-3 middle review pickup.
 *   - `recovery`            — phase-4 sweeper. Cycles through expired leases.
 *   - `drift-observer`      — phase-7c (G1-2). Polls external surfaces for
 *     non-signal drift and writes `external_observation` ledger rows. Uses
 *     the FsMirror IssueTracker / GitHost adapters; production GitHub-API
 *     wiring is out of scope for this phase.
 *   - `scout-scanner`       — phase-9b (G1-3). Periodic KAC-REFACTOR-BACKLOG
 *     scan over in-progress Delivery slices. Default cadence 5min when
 *     `--cycle-interval-ms` is omitted. The actual metric-collection
 *     adapter (TCC-REFACTOR-METRICS) is still spec-only — the daemon
 *     wiring uses a no-op scanner so the role runs idempotently with
 *     zero RefactorBacklog mutations until the adapter lands.
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
import { MultiProfileLlmRunner } from "../adapters/llm-runner/multi-profile.js";
import { AdapterRunnerPort } from "../adapters/llm-runner/runtime-port.js";
import { buildRunnerRegistry } from "../config/runner-registry.js";
import { FsLease } from "../adapters/lease/fs.js";
import { NdjsonLogger } from "../adapters/logger/ndjson.js";
import { FsStore } from "../adapters/store/fs.js";
import { FakeVerification } from "../adapters/verification/fake.js";
import { ShellVerification } from "../adapters/verification/shell.js";
import { GitWorktreeWorkspace } from "../adapters/workspace/git-worktree.js";
import { FakeWorkspace } from "../adapters/workspace/fake.js";
import { FsHumanSignal } from "../adapters/human-signal/fs.js";
import { FsMirrorIssueTracker } from "../adapters/issue-tracker/fs-mirror.js";
import { FsMirrorGitHost } from "../adapters/git-host/fs-mirror.js";
import { buildTeamMembership } from "../adapters/team-membership/factory.js";
import { resolveEnforcementLevel } from "../application/invariant-enforcement.js";
import { validateOrThrow } from "../application/config-validator.js";
import { runDaemonPrelude } from "../application/control-state.js";
import { runOneMiddleReviewTurn } from "../application/dialogue-coordinator.js";
import { runOneDualTrackTurn } from "../application/dual-track-scheduler.js";
import { runHumanSignalDrain } from "../application/human-signal-drain.js";
import { runDriftObserverSweep } from "../application/drift-observer.js";
import { FileLedger } from "../application/ledger.js";
import { runOneOuterTurn } from "../application/outer-turn.js";
import { LOG_DAEMON_PATH } from "../application/persistence-layout.js";
import { runRecoverySweep } from "../application/recovery.js";
import { runScoutScannerSweep } from "../application/scout-observer.js";
import { runOneInnerTurn } from "../application/turn-worker.js";
import { SystemClock } from "../ports/clock.js";

type DaemonRole =
  | "turn-worker"
  | "dialogue-coordinator"
  | "outer-coordinator"
  | "dual-track-scheduler"
  | "recovery"
  | "drift-observer"
  | "scout-scanner";

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

// PR #75 review (P1): drift-observer is an external surface poller and
// should not run at the default 1s cadence. When `--cycle-interval-ms` is
// omitted for `--role drift-observer`, fall back to ~60s.
const DEFAULT_CYCLE_INTERVAL_MS = 1_000;
const DRIFT_OBSERVER_DEFAULT_CYCLE_INTERVAL_MS = 60_000;
// Phase 9b (G1-3): scout-scanner is an architectural debt scanner over
// in-progress Delivery slices. The planning §변경 spec pins the default
// cadence to 5min — the scanner produces RefactorBacklog candidates and
// running it at the daemon's 1s default would (a) waste churn on an
// idempotent dedup path and (b) flood the ledger with no-op cycles.
const SCOUT_SCANNER_DEFAULT_CYCLE_INTERVAL_MS = 300_000;

function parseArgs(argv: readonly string[]): CliArgs {
  const a = [...argv];
  let cycleIntervalMsExplicit = false;
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
    cycleIntervalMs: DEFAULT_CYCLE_INTERVAL_MS,
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
          v !== "dual-track-scheduler" &&
          v !== "recovery" &&
          v !== "drift-observer" &&
          v !== "scout-scanner"
        )
          throw new Error(
            `--role must be turn-worker | dialogue-coordinator | outer-coordinator | dual-track-scheduler | recovery | drift-observer | scout-scanner (got ${v ?? "<missing>"})`,
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
        cycleIntervalMsExplicit = true;
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
      "--role is required (turn-worker | dialogue-coordinator | outer-coordinator | dual-track-scheduler | recovery | drift-observer | scout-scanner)",
    );
  if (out.role === "drift-observer" && !cycleIntervalMsExplicit) {
    out.cycleIntervalMs = DRIFT_OBSERVER_DEFAULT_CYCLE_INTERVAL_MS;
  }
  if (out.role === "scout-scanner" && !cycleIntervalMsExplicit) {
    out.cycleIntervalMs = SCOUT_SCANNER_DEFAULT_CYCLE_INTERVAL_MS;
  }
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

    // Phase 7a (G1-1): production wiring assembles a MultiProfileLlmRunner
    // from cfg.agent_profiles via buildRunnerRegistry. The legacy
    // --fake-llm-fixtures flag is preserved as a test-only override so
    // existing fixture-driven integration tests keep working.
    //
    // PR #73 review (P1): the production registry path explicitly opts out
    // of the test-only `fake` runner. Integration tests that exercise the
    // production wiring with `runner: "fake"` set
    // `LLM_TEAM_ALLOW_FAKE_RUNNER=1`; production deployments never set it,
    // so a smuggled `runner: "fake"` in target.json fails fast.
    const needsLlmRunner =
      args.role !== "recovery" &&
      args.role !== "dual-track-scheduler" &&
      args.role !== "drift-observer" &&
      args.role !== "scout-scanner";
    const allowFake = process.env.LLM_TEAM_ALLOW_FAKE_RUNNER === "1";
    const llmRunner = args.fakeLlmFixtures
      ? new AdapterRunnerPort(new FakeAdapter({ fixtureDir: args.fakeLlmFixtures }))
      : needsLlmRunner
        ? new MultiProfileLlmRunner(buildRunnerRegistry(cfg, { allowFake }))
        : null;

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

    // Phase 7b: a single FsHumanSignal adapter feeds the per-cycle drain
    // for every role. The control-state machine lives at
    // `<workdir>/control/state.json` (see runDaemonPrelude).
    const humanSignal = new FsHumanSignal(store);

    // Phase 9a (G2-4): TCC-GOVERNANCE actor verification. Only the
    // outer-coordinator binds approve/reject signals to outer sessions, so
    // the membership port is wired alongside that binding.
    //
    // Phase 9d follow-up to PR #79 P0 #1: the adapter is now selected by
    // `cfg.governance.human_team_provider` ("fs-mirror" | "github").
    // Default = fs-mirror keeps phase-9a parity wiring; "github" routes to
    // the `gh api` Teams adapter (auth via `GH_TOKEN`/login state per Inv #4).
    const teamMembership = buildTeamMembership(cfg.governance, { store, clock });
    const humanTeam = cfg.governance?.human_team ?? null;
    const unreachablePolicy = resolveEnforcementLevel(
      cfg.invariant_enforcement,
      "actor_team_membership_unreachable",
    );

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
      // Phase 7b (G1-4): drain pending human signals + apply the control
      // state machine, then gate pickup. This runs for every role so
      // pause/resume/stop are observed everywhere.
      await runHumanSignalDrain({
        store,
        signal: humanSignal,
        clock,
        applyControlState: true,
        // PR #74 codex P1: emit `pause_resume` applied ledger row when the
        // control state machine actually transitions (RUNNING↔PAUSED, →STOPPED).
        controlAudit: {
          ledger,
          callerId: args.callerId,
          targetId: cfg.identity.target_id,
        },
        // Outer-coordinator can additionally bind approve/reject signals to
        // the open outer DialogueSession. Other roles deal only with the
        // control-state side-effect; the binding deps are omitted so
        // bindable signals stay pending until the outer-coordinator picks
        // them up (drain emits `deferred` for those).
        ...(args.role === "outer-coordinator"
          ? {
              binding: {
                store,
                clock,
                ledger,
                callerId: args.callerId,
                targetId: cfg.identity.target_id,
                // Phase 9a (G2-4): actor membership check before any
                // human_approval contribution is created. When humanTeam
                // is null (operator did not configure governance), the
                // hook is bypassed — phase-5b semantics retained.
                teamMembership,
                humanTeam,
                unreachablePolicy,
              },
            }
          : {}),
      });
      const gate = await runDaemonPrelude({
        store,
        clock,
        ledger,
        callerId: args.callerId,
        targetId: cfg.identity.target_id,
        role: args.role,
      });
      if (gate.action === "stopped") {
        // Graceful daemon shutdown — STOPPED is terminal. The finally
        // block releases held leases and the role lockdir.
        process.stdout.write(
          `${JSON.stringify({ role: args.role, outcome: { kind: "stopped" } })}\n`,
        );
        return 0;
      }
      if (gate.action === "paused") {
        process.stdout.write(
          `${JSON.stringify({
            role: args.role,
            outcome: { kind: "noop", detail: "paused" },
          })}\n`,
        );
        if (args.once || interrupted) break;
        if (args.cycleIntervalMs > 0)
          await new Promise((r) => setTimeout(r, args.cycleIntervalMs));
        continue;
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
        case "dual-track-scheduler": {
          // Phase 6a — atomic 4-step slot promotion (intake_queue +
          // delivery_promotion_queue). No LLM runner; no slice-anchored
          // lease (the scheduler claims slot_lock for the duration of
          // each promotion only).
          const outcome = await runOneDualTrackTurn({
            store,
            clock,
            ledger,
            lease,
            callerId: args.callerId,
            targetId: cfg.identity.target_id,
            dualTrack: cfg.dual_track,
            leaseConfig: cfg.lease,
          });
          outcomeJson = JSON.stringify({ role: args.role, outcome });
          break;
        }
        case "recovery": {
          // Recovery sweep already ran above — emit a noop outcome.
          outcomeJson = JSON.stringify({ role: args.role, outcome: { kind: "swept" } });
          break;
        }
        case "scout-scanner": {
          // Phase 9b (G1-3) — KAC-REFACTOR-BACKLOG periodic scan over
          // in-progress Delivery slices. The default scan callback returns
          // [] — TCC-REFACTOR-METRICS adapter wiring is out of scope for
          // this phase, so the daemon role runs idempotently with zero
          // RefactorBacklog mutations until the metric adapter lands. The
          // sweep still exercises the dedup + ledger-emit path via
          // `scoutScan` whenever a candidate-producing scan is supplied.
          const out = await runScoutScannerSweep(
            { scan: async () => [] },
            {
              store,
              clock,
              ledger,
              callerId: args.callerId,
              targetId: cfg.identity.target_id,
            },
          );
          outcomeJson = JSON.stringify({
            role: args.role,
            outcome: {
              kind: "swept",
              proposed: out.proposed.length,
              duplicates: out.duplicates.length,
              scanned_slices: out.scannedSliceCount,
            },
          });
          break;
        }
        case "drift-observer": {
          // Phase 7c (G1-2) — poll external surfaces for non-signal drift.
          // Uses FsMirror adapters; production GitHub-API wiring is out of
          // scope for this phase. Slice/SliceMerge edits inside the sweep
          // are protected by store.withFileLock, and the per-role lockdir
          // already excludes a sibling drift-observer daemon, so no
          // additional lease is required here.
          const issueTracker = new FsMirrorIssueTracker(store);
          const gitHost = new FsMirrorGitHost(store);
          const out = await runDriftObserverSweep({
            store,
            clock,
            ledger,
            issueTracker,
            gitHost,
            callerId: args.callerId,
            targetId: cfg.identity.target_id,
            // PR #75 review (P1): provider guard — only refs whose
            // `provider` matches the wired adapter (fs-mirror) are swept.
            adapterProvider: FsMirrorIssueTracker.provider,
          });
          outcomeJson = JSON.stringify({
            role: args.role,
            outcome: { kind: "swept", conflicts: out.conflicts.length },
          });
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
