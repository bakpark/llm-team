import type { FailedTest } from "../domain/schema/verification.js";

/**
 * Verification port (#RGC-VERIFICATION).
 *
 * Phase 2 surface — inner-loop synchronous execution. The port's job is to
 * run a target-configured command and return the deterministic outcome.
 * Persistence (VerificationRun / MetricRun records) is handled in
 * `application/verification-runner.ts`.
 *
 * Result classification (pass/fail/error):
 *   - `pass`   — all checks succeeded
 *   - `fail`   — checks ran, at least one failed (test failure, lint error,
 *                metric below threshold)
 *   - `error`  — could not run (binary missing, infra failure)
 */

export type VerificationResult = "pass" | "fail" | "error";

export interface CommandSpec {
  /** Argv-style command. Implementations resolve the binary and run it without a shell. */
  argv: string[];
  cwd: string;
  /** Optional override; otherwise inherits process env. */
  env?: NodeJS.ProcessEnv;
  /** Soft per-command timeout in seconds. */
  timeoutSec?: number;
}

export interface VerificationOutcome {
  result: VerificationResult;
  /** Per-command stdout/stderr concatenated, in command order. */
  log: string;
  /** Empty for build/lint runs; populated for test runs that report structured failures. */
  failed_tests: FailedTest[];
  startedAt: string;
  finishedAt: string;
  exitCodes: (number | null)[];
}

export interface MetricOutcome {
  result: "met" | "unmet";
  value: number;
  log: string;
  startedAt: string;
  finishedAt: string;
}

export interface VerificationPort {
  runBuild(commands: CommandSpec[]): Promise<VerificationOutcome>;
  runTest(commands: CommandSpec[]): Promise<VerificationOutcome>;
  runLint(commands: CommandSpec[]): Promise<VerificationOutcome>;

  /**
   * Runs a metric command and parses its single-number stdout. Comparator +
   * threshold are applied by the caller; the port returns the raw value and
   * a met/unmet decision passed in via `compare`.
   */
  runMetric(input: {
    command: CommandSpec;
    compare: (value: number) => "met" | "unmet";
  }): Promise<MetricOutcome>;
}
