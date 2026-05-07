import { newMonotonicId } from "../domain/ids.js";
import {
  VerificationRun,
  type VerificationRun as VerificationRunT,
} from "../domain/schema/verification.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import type {
  CommandSpec,
  VerificationOutcome,
  VerificationPort,
} from "../ports/verification.js";
import { layout } from "./persistence-layout.js";

/**
 * Inner-loop synchronous verification runner (#RGC-VERIFICATION).
 *
 * Phase 2 scope:
 *   - Runs the configured test commands for a slice's worktree.
 *   - Persists a single VerificationRun record.
 *   - Returns the VerificationRun id so callers can attach it to the
 *     SessionTurn (`verification_result_ref`).
 *
 * Build / lint / metric runs are exposed via the same pattern but only
 * `runInner` (test) is wired into the phase-2 cycle.
 */

export interface RunInnerVerificationInput {
  targetId: string;
  targetRevision: string;
  testCommands: CommandSpec[];
  environmentFingerprint: string;
}

export interface VerificationRunnerDeps {
  verification: VerificationPort;
  store: StorePort;
  clock: ClockPort;
}

export async function runInnerVerification(
  input: RunInnerVerificationInput,
  deps: VerificationRunnerDeps,
): Promise<VerificationRunT> {
  const outcome = await deps.verification.runTest(input.testCommands);
  return persistVerification(input, outcome, deps);
}

export async function persistVerification(
  input: RunInnerVerificationInput,
  outcome: VerificationOutcome,
  deps: VerificationRunnerDeps,
): Promise<VerificationRunT> {
  const run = VerificationRun.parse({
    verification_run_id: newMonotonicId(deps.clock.now()),
    target_id: input.targetId,
    target_revision: input.targetRevision,
    commands_or_checks: input.testCommands.map((c) => c.argv.join(" ")),
    environment_fingerprint: input.environmentFingerprint,
    started_at: outcome.startedAt,
    finished_at: outcome.finishedAt,
    result: outcome.result,
    failed_tests: outcome.failed_tests,
    log_ref: null,
  });
  await deps.store.writeAtomic(
    layout.verification(run.verification_run_id),
    JSON.stringify(run, null, 2),
  );
  return run;
}
