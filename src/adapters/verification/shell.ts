import { spawn } from "node:child_process";
import type { FailedTest } from "../../domain/schema/verification.js";
import type {
  CommandSpec,
  MetricOutcome,
  VerificationOutcome,
  VerificationPort,
  VerificationResult,
} from "../../ports/verification.js";
import type { ClockPort } from "../../ports/clock.js";

/**
 * Shell verification adapter — spawns commands without a shell. Argv must be
 * pre-tokenised by the caller (target.yaml). All stdout/stderr is captured
 * to the log buffer in command order.
 *
 * Test-failure parsing is intentionally absent in phase 2: the outcome's
 * `failed_tests[]` is empty when an exec fails, and the exit code drives
 * `pass`/`fail` classification. Phase 3+ may bolt on JUnit / Vitest report
 * parsers behind the same port.
 */

export interface ShellVerificationCfg {
  clock: ClockPort;
  /** Default per-command timeout if a CommandSpec does not set one. */
  defaultTimeoutSec?: number;
}

export class ShellVerification implements VerificationPort {
  constructor(private readonly cfg: ShellVerificationCfg) {}

  async runBuild(commands: CommandSpec[]): Promise<VerificationOutcome> {
    return this.runAll(commands);
  }

  async runTest(commands: CommandSpec[]): Promise<VerificationOutcome> {
    return this.runAll(commands);
  }

  async runLint(commands: CommandSpec[]): Promise<VerificationOutcome> {
    return this.runAll(commands);
  }

  async runMetric(input: {
    command: CommandSpec;
    compare: (value: number) => "met" | "unmet";
  }): Promise<MetricOutcome> {
    const startedAt = this.cfg.clock.isoNow();
    const exec = await runOne(input.command, this.timeout(input.command));
    const finishedAt = this.cfg.clock.isoNow();
    const log = formatExec(input.command, exec);
    const value = parseMetricValue(exec.stdout);
    const result =
      Number.isNaN(value) || exec.code !== 0 ? "unmet" : input.compare(value);
    return {
      result,
      value: Number.isNaN(value) ? 0 : value,
      log,
      startedAt,
      finishedAt,
    };
  }

  private async runAll(commands: CommandSpec[]): Promise<VerificationOutcome> {
    const startedAt = this.cfg.clock.isoNow();
    let result: VerificationResult = "pass";
    const exitCodes: (number | null)[] = [];
    const logs: string[] = [];
    const failed: FailedTest[] = [];
    for (const c of commands) {
      const exec = await runOne(c, this.timeout(c));
      logs.push(formatExec(c, exec));
      exitCodes.push(exec.code);
      if (exec.spawnError) {
        result = "error";
        break;
      }
      if (exec.code !== 0) {
        result = "fail";
      }
    }
    const finishedAt = this.cfg.clock.isoNow();
    return {
      result,
      log: logs.join("\n"),
      failed_tests: failed,
      startedAt,
      finishedAt,
      exitCodes,
    };
  }

  private timeout(c: CommandSpec): number | undefined {
    return c.timeoutSec ?? this.cfg.defaultTimeoutSec;
  }
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut?: boolean;
}

async function runOne(
  c: CommandSpec,
  timeoutSec?: number,
): Promise<ExecResult> {
  if (c.argv.length === 0)
    return { code: null, stdout: "", stderr: "", spawnError: "empty argv" };
  return new Promise((resolveP) => {
    const child = spawn(c.argv[0]!, c.argv.slice(1), {
      cwd: c.cwd,
      env: c.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    if (timeoutSec != null && timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutSec * 1000);
    }
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolveP({
        code: null,
        stdout,
        stderr,
        spawnError: (err as Error).message,
      });
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolveP({ code, stdout, stderr, timedOut });
    });
  });
}

function formatExec(c: CommandSpec, r: ExecResult): string {
  const head = `$ ${c.argv.join(" ")} (cwd=${c.cwd})`;
  const tail = r.spawnError
    ? `[spawn error: ${r.spawnError}]`
    : `[exit=${r.code}${r.timedOut ? " timed_out" : ""}]`;
  return [head, r.stdout, r.stderr, tail].filter((s) => s.length > 0).join("\n");
}

function parseMetricValue(stdout: string): number {
  const trimmed = stdout.trim().split(/\s+/).pop() ?? "";
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : Number.NaN;
}
