/**
 * Drift observer — detects out-of-band external mutations and records them
 * as `external_observation` ledger rows + flips the corresponding
 * `external_refs[].sync_status` to `conflict`.
 *
 * Authority:
 *   - `docs/architecture/external-tracking-mapping.md` §5.1 (sync_status)
 *     and §6 (inbound non-signal events go to `conflict`).
 *   - `docs/architecture/worktree-pr-lifecycle.md` §5.2 — PR native review
 *     (PRR_) and lifecycle events (close/reopen/label edit) are NOT signals.
 *
 * The observer compares the persisted `external_refs[].last_seen_external_revision`
 * with what the IssueTrackerPort / GitHostPort report now. A mismatch transitions
 * the matching ref to `conflict` and writes a ledger `external_observation` row.
 *
 * The observer is idempotent: an already-conflict ref is skipped on the next
 * run, the idempotency_key is stable per (object_id, revision) so duplicate
 * runs hit the duplicate path.
 *
 * The observer is read-only with respect to the external surfaces — recovery
 * is governed by §7 of the mapping document (human governance signal).
 */

import {
  Slice as SliceSchema,
  type Slice as SliceT,
} from "../domain/schema/slice.js";
import {
  SliceMerge as SliceMergeSchema,
  type SliceMerge as SliceMergeT,
} from "../domain/schema/slice-merge.js";
import {
  Milestone as MilestoneSchema,
  type Milestone as MilestoneT,
} from "../domain/schema/milestone.js";
import type { ExternalRef } from "../domain/schema/external-ref.js";
import { newMonotonicId } from "../domain/ids.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import type { GitHostPort } from "../ports/git-host.js";
import type { IssueTrackerPort } from "../ports/issue-tracker.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

export interface DriftObserverDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  issueTracker: IssueTrackerPort;
  gitHost: GitHostPort;
  callerId: string;
  targetId: string;
}

export interface DriftObserverResult {
  /** Refs that flipped to conflict during this run. */
  conflicts: Array<{
    object_kind: "milestone" | "slice" | "slice_merge";
    object_id: string;
    provider: string;
    external_id: string;
    /**
     * `disappeared` when the external surface returned null (orphan); otherwise
     * `revision_mismatch`.
     */
    reason: "revision_mismatch" | "disappeared";
  }>;
}

async function readJsonList<T>(
  store: StorePort,
  dir: string,
  parser: (raw: unknown) => T,
): Promise<{ name: string; value: T }[]> {
  let names: string[];
  try {
    names = await store.list(dir);
  } catch {
    return [];
  }
  const out: { name: string; value: T }[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const body = await store.readText(`${dir}/${n}`);
    if (body == null || body === "") continue;
    try {
      out.push({ name: n, value: parser(JSON.parse(body)) });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

async function loadAllMilestones(store: StorePort): Promise<MilestoneT[]> {
  const items = await readJsonList(store, "milestones", (r) =>
    MilestoneSchema.parse(r),
  );
  return items.map((i) => i.value);
}

async function loadAllSlices(store: StorePort): Promise<SliceT[]> {
  const items = await readJsonList(store, "slices", (r) =>
    SliceSchema.parse(r),
  );
  return items.map((i) => i.value);
}

async function loadAllSliceMerges(store: StorePort): Promise<SliceMergeT[]> {
  const items = await readJsonList(store, "slice_merges", (r) =>
    SliceMergeSchema.parse(r),
  );
  return items.map((i) => i.value);
}

function findMutableRef(
  refs: ExternalRef[],
  predicate: (r: ExternalRef) => boolean,
): { ref: ExternalRef; index: number } | null {
  const idx = refs.findIndex(predicate);
  if (idx < 0) return null;
  return { ref: refs[idx]!, index: idx };
}

export async function runDriftObserverSweep(
  deps: DriftObserverDeps,
): Promise<DriftObserverResult> {
  const conflicts: DriftObserverResult["conflicts"] = [];

  const milestones = await loadAllMilestones(deps.store);
  for (const ms of milestones) {
    for (const ref of ms.external_refs) {
      if (ref.kind !== "milestone") continue;
      if (ref.sync_status === "conflict") continue;
      const observed = await deps.issueTracker.fetchMilestone({
        provider: ref.provider,
        id: ref.id,
      });
      const conflictReason =
        observed == null
          ? "disappeared"
          : ref.last_seen_external_revision != null &&
              observed.revision !== ref.last_seen_external_revision
            ? "revision_mismatch"
            : null;
      if (conflictReason == null) continue;
      await flipMilestoneRefToConflict(
        deps,
        ms,
        ref,
        conflictReason,
        observed?.revision ?? null,
      );
      conflicts.push({
        object_kind: "milestone",
        object_id: ms.milestone_id,
        provider: ref.provider,
        external_id: ref.id,
        reason: conflictReason,
      });
    }
  }

  const slices = await loadAllSlices(deps.store);
  for (const sl of slices) {
    for (const ref of sl.external_refs) {
      if (ref.kind !== "tracker") continue;
      if (ref.sync_status === "conflict") continue;
      const observed = await deps.issueTracker.fetchIssue({
        provider: ref.provider,
        id: ref.id,
      });
      const conflictReason =
        observed == null
          ? "disappeared"
          : ref.last_seen_external_revision != null &&
              observed.revision !== ref.last_seen_external_revision
            ? "revision_mismatch"
            : null;
      if (conflictReason == null) continue;
      await flipSliceRefToConflict(
        deps,
        sl,
        ref,
        conflictReason,
        observed?.revision ?? null,
      );
      conflicts.push({
        object_kind: "slice",
        object_id: sl.slice_id,
        provider: ref.provider,
        external_id: ref.id,
        reason: conflictReason,
      });
    }
  }

  const sms = await loadAllSliceMerges(deps.store);
  for (const sm of sms) {
    for (const ref of sm.external_refs) {
      if (ref.kind !== "review_surface") continue;
      if (ref.sync_status === "conflict") continue;
      const observed = await deps.gitHost.fetchPullRequest({
        provider: ref.provider,
        id: ref.id,
      });
      const conflictReason =
        observed == null
          ? "disappeared"
          : ref.last_seen_external_revision != null &&
              observed.revision !== ref.last_seen_external_revision
            ? "revision_mismatch"
            : null;
      if (conflictReason == null) continue;
      await flipSliceMergeRefToConflict(
        deps,
        sm,
        ref,
        conflictReason,
        observed?.revision ?? null,
      );
      conflicts.push({
        object_kind: "slice_merge",
        object_id: sm.slice_merge_id,
        provider: ref.provider,
        external_id: ref.id,
        reason: conflictReason,
      });
    }
  }

  return { conflicts };
}

async function flipMilestoneRefToConflict(
  deps: DriftObserverDeps,
  ms: MilestoneT,
  ref: ExternalRef,
  reason: "revision_mismatch" | "disappeared",
  observedRevision: string | null,
): Promise<void> {
  await deps.store.withFileLock(layout.milestone(ms.milestone_id), async () => {
    const raw = await deps.store.readText(layout.milestone(ms.milestone_id));
    if (raw == null) return;
    const cur = MilestoneSchema.parse(JSON.parse(raw));
    const found = findMutableRef(
      cur.external_refs,
      (r) => r.provider === ref.provider && r.id === ref.id,
    );
    if (!found) return;
    if (found.ref.sync_status === "conflict") return;
    cur.external_refs[found.index] = {
      ...found.ref,
      sync_status: "conflict",
      last_seen_external_revision:
        observedRevision ?? found.ref.last_seen_external_revision,
      last_sync_attempt_at: deps.clock.isoNow(),
      last_sync_error: reason,
    };
    cur.updated_at = deps.clock.isoNow();
    await deps.store.writeAtomic(
      layout.milestone(ms.milestone_id),
      JSON.stringify(cur, null, 2),
    );
  });
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: ms.milestone_id,
    object_kind: "milestone",
    from_state: ms.state,
    to_state: ms.state,
    loop_kind: null,
    phase: null,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "external_observation",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        object_kind: "milestone",
        object_id: ms.milestone_id,
        provider: ref.provider,
        external_id: ref.id,
        observed_revision: observedRevision ?? "",
        reason,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: `drift_${reason}`,
    timestamp: deps.clock.isoNow(),
  });
}

async function flipSliceRefToConflict(
  deps: DriftObserverDeps,
  sl: SliceT,
  ref: ExternalRef,
  reason: "revision_mismatch" | "disappeared",
  observedRevision: string | null,
): Promise<void> {
  await deps.store.withFileLock(layout.slice(sl.slice_id), async () => {
    const raw = await deps.store.readText(layout.slice(sl.slice_id));
    if (raw == null) return;
    const cur = SliceSchema.parse(JSON.parse(raw));
    const found = findMutableRef(
      cur.external_refs,
      (r) => r.provider === ref.provider && r.id === ref.id,
    );
    if (!found) return;
    if (found.ref.sync_status === "conflict") return;
    cur.external_refs[found.index] = {
      ...found.ref,
      sync_status: "conflict",
      last_seen_external_revision:
        observedRevision ?? found.ref.last_seen_external_revision,
      last_sync_attempt_at: deps.clock.isoNow(),
      last_sync_error: reason,
    };
    cur.updated_at = deps.clock.isoNow();
    await deps.store.writeAtomic(
      layout.slice(sl.slice_id),
      JSON.stringify(cur, null, 2),
    );
  });
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: sl.slice_id,
    object_kind: "slice",
    from_state: sl.state,
    to_state: sl.state,
    loop_kind: null,
    phase: null,
    slice_id: sl.slice_id,
    slice_kind: sl.slice_kind,
    dod_revision: sl.dod_revision_pin,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "external_observation",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        object_kind: "slice",
        object_id: sl.slice_id,
        provider: ref.provider,
        external_id: ref.id,
        observed_revision: observedRevision ?? "",
        reason,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: `drift_${reason}`,
    timestamp: deps.clock.isoNow(),
  });
}

async function flipSliceMergeRefToConflict(
  deps: DriftObserverDeps,
  sm: SliceMergeT,
  ref: ExternalRef,
  reason: "revision_mismatch" | "disappeared",
  observedRevision: string | null,
): Promise<void> {
  await deps.store.withFileLock(
    layout.sliceMerge(sm.slice_merge_id),
    async () => {
      const raw = await deps.store.readText(
        layout.sliceMerge(sm.slice_merge_id),
      );
      if (raw == null) return;
      const cur = SliceMergeSchema.parse(JSON.parse(raw));
      const found = findMutableRef(
        cur.external_refs,
        (r) => r.provider === ref.provider && r.id === ref.id,
      );
      if (!found) return;
      if (found.ref.sync_status === "conflict") return;
      cur.external_refs[found.index] = {
        ...found.ref,
        sync_status: "conflict",
        last_seen_external_revision:
          observedRevision ?? found.ref.last_seen_external_revision,
        last_sync_attempt_at: deps.clock.isoNow(),
        last_sync_error: reason,
      };
      cur.updated_at = deps.clock.isoNow();
      await deps.store.writeAtomic(
        layout.sliceMerge(sm.slice_merge_id),
        JSON.stringify(cur, null, 2),
      );
    },
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: sm.slice_merge_id,
    object_kind: "slice_merge",
    from_state: sm.state,
    to_state: sm.state,
    loop_kind: null,
    phase: null,
    slice_id: sm.slice_id,
    slice_kind: null,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "external_observation",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        object_kind: "slice_merge",
        object_id: sm.slice_merge_id,
        provider: ref.provider,
        external_id: ref.id,
        observed_revision: observedRevision ?? "",
        reason,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: `drift_${reason}`,
    timestamp: deps.clock.isoNow(),
  });
}
