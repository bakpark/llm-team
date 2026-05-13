/**
 * Production probe routing for `RecoveryCoordinator.buildProbe` (issue #126).
 *
 * PR #125 (audit P0-1) wired `RecoveryCoordinator.runOnce()` into the daemon
 * recovery role, but left `buildProbe: async () => null` so every candidate
 * was reported as `recovered_skipped: no_probe`. The sweep ran but recovered
 * 0 candidates — a dead-zone risk for outbox crash recovery.
 *
 * This module owns the per-`op_kind` probe construction. The daemon entry
 * (`case "recovery"`) plugs the returned `ProbeBuilder` into the coordinator
 * before invoking the sweep. Keeping the routing here (not in
 * `pr-first-wiring.ts`) preserves role-specific port resolution per issue
 * #126: the production GitHostPort adapter selection is a Phase 6+ concern
 * (current wiring uses `FsMirrorGitHost`), and only the recovery role needs
 * the probe paths.
 *
 * Probe map (cli-spicy-anchor.md §7-2):
 *
 *   | op_kind            | port             | method                            |
 *   |--------------------|------------------|-----------------------------------|
 *   | commit_op          | WorkspacePort    | findCommitByTrailer               |
 *   | push_op            | WorkspacePort    | getRemoteHeadSha                  |
 *   | pr_open_op         | GitHostPort      | findOpenPullRequestByMachineKey   |
 *   | pr_update_op       | GitHostPort      | findPullRequestByBodyMachineKey   |
 *   | submit_review_op   | GitHostPort      | findReviewByMachineKey            |
 *   | merge_op           | GitHostPort      | getPullRequestMergeState          |
 *   | add_label_op       | GitHostPort      | listLabels                        |
 *   | remove_label_op    | GitHostPort      | listLabels                        |
 *   | dismiss_review_op  | GitHostPort      | getReview                         |
 *
 * Resolution strategy:
 *
 *   - `pending.objectId` (and/or `pending.surfaceRef`) is the
 *     `review_surface_id`. The probe builder loads the ReviewSurface JSON
 *     and reads:
 *       - `surface.branch`         → commit_op/push_op/pr_open_op headBranch
 *       - `surface.pr_ref`         → ExternalRefHandle for PR ops
 *   - When the surface is absent (e.g. `pr_open_op` first attempt that
 *     crashed before the surface was persisted) the probe builder returns
 *     `null`, and the coordinator emits `recovered_skipped: no_probe` for
 *     that candidate. This is the correct fallback — the recovery path is
 *     only deterministic when the originating invoker persisted enough
 *     context onto the pending row / surface.
 *
 * Configuration:
 *
 *   - `trailerKey` defaults to `Idempotency-Key` matching
 *     `lead-invoker.DEFAULT_TRAILER_KEY`.
 *   - `remoteName` defaults to `origin` matching
 *     `lead-invoker.DEFAULT_REMOTE`.
 *   - `commitTrailerDepth` defaults to 32 (enough to span a few rebuilds
 *     without scanning the full history). Pass-through unbounded scans are
 *     avoided so `findCommitByTrailer` does not stall on long branches.
 */
import type {
  PendingOutboxRow,
  ProbeBuilder,
} from "../application/recovery-coordinator.js";
import { layout } from "../application/persistence-layout.js";
import type { ProbeContext } from "../application/outbox.js";
import {
  ReviewSurface,
  type ReviewSurface as ReviewSurfaceT,
} from "../domain/schema/review-surface.js";
import type { ExternalRefHandle } from "../ports/issue-tracker.js";
import type { GitHostPort } from "../ports/git-host.js";
import type { StorePort } from "../ports/store.js";
import type { WorkspacePort } from "../ports/workspace.js";

const DEFAULT_TRAILER_KEY = "Idempotency-Key";
const DEFAULT_REMOTE = "origin";
const DEFAULT_COMMIT_TRAILER_DEPTH = 32;

export interface ProductionProbeBuilderDeps {
  store: StorePort;
  workspace: WorkspacePort;
  gitHost: GitHostPort;
  /** Defaults to "Idempotency-Key" — matches lead-invoker. */
  trailerKey?: string;
  /** Defaults to "origin" — matches lead-invoker. */
  remoteName?: string;
  /** Bounded walk-back for commit_op probe. Defaults to 32. */
  commitTrailerDepth?: number;
}

/**
 * Build a `ProbeBuilder` whose returned `ProbeContext` is routed to the
 * actual `WorkspacePort` / `GitHostPort` instances wired in the daemon. The
 * returned function is the value the daemon plugs into
 * `RecoveryCoordinator.deps.buildProbe`.
 */
export function buildProductionProbeBuilder(
  deps: ProductionProbeBuilderDeps,
): ProbeBuilder {
  const trailerKey = deps.trailerKey ?? DEFAULT_TRAILER_KEY;
  const remoteName = deps.remoteName ?? DEFAULT_REMOTE;
  const commitDepth = deps.commitTrailerDepth ?? DEFAULT_COMMIT_TRAILER_DEPTH;

  return async (candidate, pending) => {
    if (pending == null) return null;
    const surface = await loadReviewSurface(deps.store, pending);

    switch (candidate.opKind) {
      case "commit_op": {
        if (surface == null) return null;
        const ctx: ProbeContext = {
          opKind: "commit_op",
          workspace: deps.workspace,
          branch: surface.branch,
          trailerKey,
          value: candidate.idempotencyKey,
          depth: commitDepth,
        };
        return ctx;
      }
      case "push_op": {
        if (surface == null) return null;
        const ctx: ProbeContext = {
          opKind: "push_op",
          workspace: deps.workspace,
          remote: remoteName,
          branch: surface.branch,
          // Outbox push_op completes by re-reading the remote head; the
          // expected sha is the head-of-branch as recorded on the surface.
          // For pending_without_posted (no completed write), `surface.head_sha`
          // is the local sha the lead-invoker committed before pushing.
          expectedSha: surface.head_sha,
        };
        return ctx;
      }
      case "pr_open_op": {
        if (surface == null) return null;
        const ctx: ProbeContext = {
          opKind: "pr_open_op",
          gitHost: deps.gitHost,
          headBranch: surface.branch,
        };
        return ctx;
      }
      case "pr_update_op": {
        if (surface == null) return null;
        const ctx: ProbeContext = {
          opKind: "pr_update_op",
          gitHost: deps.gitHost,
          prRef: handleFromSurface(surface),
        };
        return ctx;
      }
      case "submit_review_op": {
        if (surface == null) return null;
        const ctx: ProbeContext = {
          opKind: "submit_review_op",
          gitHost: deps.gitHost,
          prRef: handleFromSurface(surface),
        };
        return ctx;
      }
      case "merge_op": {
        if (surface == null) return null;
        const ctx: ProbeContext = {
          opKind: "merge_op",
          gitHost: deps.gitHost,
          prRef: handleFromSurface(surface),
        };
        return ctx;
      }
      case "add_label_op":
      case "remove_label_op": {
        if (surface == null) return null;
        const label = pickPayloadString(pending, "label");
        if (label == null) return null;
        const ctx: ProbeContext = {
          opKind: candidate.opKind,
          gitHost: deps.gitHost,
          prRef: handleFromSurface(surface),
          label,
          expect: candidate.opKind === "add_label_op" ? "present" : "absent",
        };
        return ctx;
      }
      case "dismiss_review_op": {
        if (surface == null) return null;
        const externalReviewId = pickPayloadString(pending, "externalReviewId");
        if (externalReviewId == null) return null;
        const ctx: ProbeContext = {
          opKind: "dismiss_review_op",
          gitHost: deps.gitHost,
          prRef: handleFromSurface(surface),
          externalReviewId,
        };
        return ctx;
      }
      default: {
        const _exhaustive: never = candidate.opKind;
        void _exhaustive;
        return null;
      }
    }
  };
}

/**
 * Try `pending.surfaceRef` first, then `pending.objectId`. Both invoker
 * code paths put the `review_surface_id` in at least one of these fields:
 *
 *   - lead-invoker:    objectId = surfaceId,  surfaceRef = unset (commit/push/pr_open)
 *   - reviewer-invoker: objectId = surfaceId, surfaceRef = surfaceId
 *   - caller-dispatch (merge_op): same as reviewer
 *
 * Returns null when the surface JSON cannot be parsed (first-attempt
 * pr_open_op crashes leave the surface unwritten until step 8 of the lead
 * invoker; that case is correctly reported as `no_probe`).
 */
async function loadReviewSurface(
  store: StorePort,
  pending: PendingOutboxRow,
): Promise<ReviewSurfaceT | null> {
  const candidates = [pending.surfaceRef, pending.objectId].filter(
    (v): v is string => v != null && v.length > 0,
  );
  for (const id of candidates) {
    let path: string;
    try {
      path = layout.reviewSurface(id);
    } catch {
      // `objectId` is not always a ULID (e.g. system rows). Skip and try next.
      continue;
    }
    const body = await store.readText(path);
    if (body == null || body.length === 0) continue;
    try {
      return ReviewSurface.parse(JSON.parse(body));
    } catch {
      continue;
    }
  }
  return null;
}

function handleFromSurface(surface: ReviewSurfaceT): ExternalRefHandle {
  return {
    provider: surface.pr_ref.provider,
    id: surface.pr_ref.id,
    url: surface.pr_ref.url,
  };
}

/**
 * Production label/dismiss invokers (Phase 6+) will populate the outbox
 * pending row's `result_detail` with `{ label: ... }` or
 * `{ externalReviewId: ... }`. Until those invokers exist this helper
 * returns null and the probe builder yields a `no_probe` outcome — which
 * is the correct fallback while no production caller for these op_kinds
 * exists in the codebase.
 *
 * Defensive: result_detail is plain string (may be JSON or non-JSON).
 */
function pickPayloadString(
  pending: PendingOutboxRow,
  key: "label" | "externalReviewId",
): string | null {
  const raw = pending.resultDetail;
  if (raw == null || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
