/**
 * Phase 5 cycle prelude — PrWatcher poll + caller-dispatch-prfirst routing.
 *
 * cli-spicy-anchor.md §1 step 4 calls for the daemon's cycle prelude to
 * poll the active ReviewSurface set and route any 5-gate-passing review
 * verdict through `PrFirstDispatcher`. This module is a thin orchestrator:
 *
 *   1. Enumerate open ReviewSurface objects under `<workdir>/review_surfaces/`.
 *   2. For each, call `PrWatcher.pollReviewSurface`.
 *   3. For every `applied` per-review outcome, route to `PrFirstDispatcher`
 *      with the loaded slice / sliceMerge / milestone payload.
 *
 * The helper is intentionally read-mostly: it does not mutate ReviewSurface
 * state itself; both the watcher (review_signal_applied / dropped ledger
 * rows) and the dispatcher (review_state / build_state / merge transitions)
 * own their own writes.
 *
 * Returns aggregated counts so the daemon can log a single summary line per
 * cycle.
 */
import type { Milestone as MilestoneT } from "../domain/schema/milestone.js";
import { Milestone } from "../domain/schema/milestone.js";
import {
  ReviewSurface,
  type ReviewSurface as ReviewSurfaceT,
} from "../domain/schema/review-surface.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import {
  SliceMerge,
  type SliceMerge as SliceMergeT,
} from "../domain/schema/slice-merge.js";
import type { CommandSpec } from "../ports/verification.js";
import type { StorePort } from "../ports/store.js";
import {
  PrFirstDispatcher,
  type PrFirstDispatchResult,
} from "../application/caller-dispatch-prfirst.js";
import { PrWatcher } from "../application/pr-watcher.js";
import { layout } from "../application/persistence-layout.js";

export interface PrWatcherCycleDeps {
  store: StorePort;
  prWatcher: PrWatcher;
  prFirstDispatcher: PrFirstDispatcher;
  /** Trunk revision used for re-verification — typically the active branch base. */
  trunkRevision: string;
  /** Reverify command builder threaded into PrFirstDispatcher slice approve. */
  reverifyTestCommands: (workspaceCwd: string) => CommandSpec[];
  environmentFingerprint: string;
}

export interface PrWatcherCycleSummary {
  surfacesPolled: number;
  reviewsApplied: number;
  reviewsDropped: number;
  reviewsDuplicate: number;
  dispatches: number;
  /** Per-surface dispatch results (kept short — caller decides whether to log). */
  results: PrFirstDispatchResult[];
}

const EMPTY_SUMMARY: PrWatcherCycleSummary = {
  surfacesPolled: 0,
  reviewsApplied: 0,
  reviewsDropped: 0,
  reviewsDuplicate: 0,
  dispatches: 0,
  results: [],
};

/**
 * Run one cycle prelude pass: poll every open ReviewSurface, dispatch
 * applied verdicts. Idempotent — repeated calls with no new reviews emit
 * `duplicate_applied` (gate ⑤) and skip dispatch.
 */
export async function runPrWatcherCyclePrelude(
  deps: PrWatcherCycleDeps,
): Promise<PrWatcherCycleSummary> {
  const surfaces = await listOpenReviewSurfaces(deps.store);
  if (surfaces.length === 0) return { ...EMPTY_SUMMARY };

  let reviewsApplied = 0;
  let reviewsDropped = 0;
  let reviewsDuplicate = 0;
  const results: PrFirstDispatchResult[] = [];

  for (const surface of surfaces) {
    const poll = await deps.prWatcher.pollReviewSurface(surface);
    for (const r of poll.reviews) {
      switch (r.kind) {
        case "applied":
          reviewsApplied += 1;
          break;
        case "dropped":
          reviewsDropped += 1;
          break;
        case "duplicate_applied":
          reviewsDuplicate += 1;
          break;
      }
    }

    // Pick the latest applied review (last-match precedence aligns with
    // §11 — the canonical signal is always the most recent passing review).
    let applied: Extract<(typeof poll.reviews)[number], { kind: "applied" }> | null = null;
    for (let i = poll.reviews.length - 1; i >= 0; i -= 1) {
      const candidate = poll.reviews[i]!;
      if (candidate.kind === "applied") {
        applied = candidate;
        break;
      }
    }
    if (applied == null) continue;

    const dispatched = await dispatchApplied(deps, surface, applied);
    if (dispatched != null) results.push(dispatched);
  }

  return {
    surfacesPolled: surfaces.length,
    reviewsApplied,
    reviewsDropped,
    reviewsDuplicate,
    dispatches: results.length,
    results,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function listOpenReviewSurfaces(
  store: StorePort,
): Promise<ReviewSurfaceT[]> {
  let names: string[];
  try {
    names = await store.list("review_surfaces");
  } catch {
    return [];
  }
  const out: ReviewSurfaceT[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`review_surfaces/${name}`);
    if (body == null || body.length === 0) continue;
    let surface: ReviewSurfaceT;
    try {
      surface = ReviewSurface.parse(JSON.parse(body));
    } catch {
      continue;
    }
    // Only `open` surfaces accept new applied reviews; `merged` / `closed`
    // surfaces are terminal and the watcher correctly emits
    // `duplicate_applied` if revisited, but skipping early is cheaper.
    if (surface.lifecycle_state !== "open") continue;
    out.push(surface);
  }
  return out;
}

async function dispatchApplied(
  deps: PrWatcherCycleDeps,
  surface: ReviewSurfaceT,
  applied: { verdict: "approve" | "request_changes" | "comment"; receipt: { session_id: string } },
): Promise<PrFirstDispatchResult | null> {
  // The watcher emits `verdict: "comment"` for review.state=commented; we
  // do not dispatch those — they are recorded as `review_signal_applied`
  // but produce no state change (cli-spicy-anchor.md §10).
  if (applied.verdict === "comment") return null;
  const verdict = applied.verdict;

  if (surface.parent_kind === "slice") {
    const slice = await loadSliceById(deps.store, surface.parent_id);
    if (slice == null) return null;
    const sliceMerge = await loadActiveSliceMerge(deps.store, slice.slice_id);
    if (sliceMerge == null) return null;
    return await deps.prFirstDispatcher.dispatch({
      parent_kind: "slice",
      reviewSurface: surface,
      slice,
      sliceMerge,
      sessionId: applied.receipt.session_id,
      verdict,
      verificationRunId: surface.latest_verification_run_id,
      trunkRevision: deps.trunkRevision,
      testCommandsForReverify: deps.reverifyTestCommands,
      environmentFingerprint: deps.environmentFingerprint,
    });
  }
  if (surface.parent_kind === "milestone") {
    const milestone = await loadMilestoneById(deps.store, surface.parent_id);
    if (milestone == null || surface.parent_phase == null) return null;
    return await deps.prFirstDispatcher.dispatch({
      parent_kind: "milestone",
      reviewSurface: surface,
      milestone,
      sessionId: applied.receipt.session_id,
      verdict,
      parentPhase: surface.parent_phase,
    });
  }
  // spec_doc — dispatcher emits a fail-loud `review_signal_dropped` row.
  return await deps.prFirstDispatcher.dispatch({
    parent_kind: "spec_doc",
    reviewSurface: surface,
    sessionId: applied.receipt.session_id,
    verdict,
  });
}

async function loadSliceById(
  store: StorePort,
  sliceId: string,
): Promise<SliceT | null> {
  const body = await store.readText(layout.slice(sliceId));
  if (body == null || body.length === 0) return null;
  try {
    return Slice.parse(JSON.parse(body));
  } catch {
    return null;
  }
}

async function loadActiveSliceMerge(
  store: StorePort,
  sliceId: string,
): Promise<SliceMergeT | null> {
  let names: string[];
  try {
    names = await store.list("slice_merges");
  } catch {
    return null;
  }
  let candidate: SliceMergeT | null = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`slice_merges/${name}`);
    if (body == null || body.length === 0) continue;
    let sm: SliceMergeT;
    try {
      sm = SliceMerge.parse(JSON.parse(body));
    } catch {
      continue;
    }
    if (sm.slice_id !== sliceId) continue;
    // Prefer the most recently updated active row.
    if (candidate == null || sm.updated_at > candidate.updated_at) {
      candidate = sm;
    }
  }
  return candidate;
}

async function loadMilestoneById(
  store: StorePort,
  milestoneId: string,
): Promise<MilestoneT | null> {
  const body = await store.readText(layout.milestone(milestoneId));
  if (body == null || body.length === 0) return null;
  try {
    return Milestone.parse(JSON.parse(body));
  } catch {
    return null;
  }
}
