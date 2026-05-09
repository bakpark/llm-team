/**
 * GitHub side-effect timeline — single authority for the time-ordered
 * sequence of mirror writes that accompany a single Caller dispatch.
 *
 * Authority: `docs/architecture/github-side-effect-timeline.md` §2.
 *
 * The module exposes a single helper `executeMirrorTimeline` that runs a
 * sequence of mirror steps under a single per-object lock. Steps execute
 * sequentially in the order supplied; if a step throws, subsequent steps
 * are skipped and the timeline returns a `partial_fail` outcome with the
 * step index at which failure occurred. Caller code is responsible for
 * applying RGC-FAILURE partial-fail rollback (we do not roll back here —
 * the timeline only enforces ordering and atomicity-per-step).
 *
 * The `lockKey` is normally the FS-side path of the internal object whose
 * `external_refs[]` will be updated. Holding this lock around the entire
 * sequence ensures concurrent dispatches that touch the same object cannot
 * interleave their mirror writes.
 */

import type { StorePort } from "../ports/store.js";

export interface MirrorStep {
  /** Stable name for diagnostics and ledger result_detail. */
  name: string;
  /**
   * Action — must be idempotent at the surface level (Provider mirror) so
   * that retries hit the same external state. The timeline does not retry
   * automatically.
   */
  run: () => Promise<void>;
}

export type MirrorTimelineOutcome =
  | { result: "ok"; stepsRun: number }
  | {
      result: "partial_fail";
      stepsRun: number;
      failedStep: string;
      error: string;
    };

export interface ExecuteTimelineInput {
  store: StorePort;
  /**
   * FS lock key — typically `layout.<object>(id)`. The timeline acquires this
   * lock for the full duration of the step sequence.
   */
  lockKey: string;
  steps: MirrorStep[];
}

/**
 * Run the supplied mirror steps in order under a single store lock. Returns
 * the count of completed steps. On failure, the lock is released and the
 * outcome carries the failed step's name so the caller can record a
 * `result_detail` string ("partial_fail:<step_name>") in its ledger row.
 *
 * PR #71 P1-3 — lock-held network I/O note:
 *   `step.run()` may invoke `gh` CLI calls (network I/O) while the
 *   `lockKey` lock is held. This is a deliberate trade: the lock guarantees
 *   that the timeline's ledger row + external mutations land in a single
 *   ordered sequence per object, even though it inflates lock-hold time
 *   under network latency. Callers that mirror to a hot object should keep
 *   the per-object timeline short; structural relief (e.g. splitting
 *   network steps from internal-state writes) is tracked as a future
 *   refactor and is not required for correctness.
 */
export async function executeMirrorTimeline(
  input: ExecuteTimelineInput,
): Promise<MirrorTimelineOutcome> {
  return input.store.withFileLock(input.lockKey, async () => {
    let i = 0;
    for (; i < input.steps.length; i++) {
      const step = input.steps[i]!;
      try {
        await step.run();
      } catch (err) {
        return {
          result: "partial_fail" as const,
          stepsRun: i,
          failedStep: step.name,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { result: "ok" as const, stepsRun: i };
  });
}
