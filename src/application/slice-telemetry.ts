/**
 * Phase 8b — KAC-SLICE-TELEMETRY emit + lookup.
 *
 * Producer: Delivery slice state transitions (slice-merge.ts) call
 * `emitSliceTelemetry(milestoneId)` so the Discovery N+1 manifest inject
 * (outer-turn.ts) and RGC-CROSS-SLOT-STALE (cross-slot-stale.ts) see live
 * progress.
 *
 * Build rule: scan all slices for `milestoneId`; partition by state into
 *   - in_progress  ∈ {SLICE_PENDING, SLICE_READY, SLICE_BUILDING,
 *                     SLICE_REVIEWING, SLICE_INTEGRATING}
 *   - validated    ∈ {SLICE_VALIDATED}
 *   - blocked      ∈ {SLICE_BLOCKED}
 * `recent_session_outcomes` / `edge_cases` / `recent_metric_runs` ride along
 * as caller-supplied lists (default empty for the slice-merge wiring).
 *
 * Persistence:
 *   1. Compute body-only sha256 (`bodyAuditHash`) over the canonical-json
 *      record minus `audit_hash` — same convention as decisions and
 *      RefactorBacklog so KAC-MANIFEST consumers can recompute the pin.
 *   2. Read the pointer file (`layout.latestSliceTelemetryByMilestone`); if
 *      the existing telemetry's `audit_hash` matches, return it (idempotent
 *      no-op — no second file, no ledger row).
 *   3. Otherwise persist `layout.sliceTelemetry(<new_id>)` and overwrite the
 *      pointer atomically. Append a single ledger row keyed by
 *      `(kind=slice_telemetry_emit, milestone_id, audit_hash)`.
 *
 * The audit_hash itself is the dedup signal — when nothing material changed
 * we skip the write so the pointer doesn't churn.
 */
import {
  SliceTelemetry,
  type SliceTelemetry as SliceTelemetryT,
  type TelemetryBlockedSlice,
  type TelemetryInProgressSlice,
  type TelemetryValidatedSlice,
  type TelemetrySessionOutcome,
} from "../domain/schema/knowledge.js";
import { newMonotonicId } from "../domain/ids.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import { bodyAuditHash } from "./knowledge.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

export interface SliceTelemetryDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export interface EmitSliceTelemetryInput {
  milestone_id: string;
  /**
   * Optional supplementary fields. Slice partition is always recomputed
   * from the live Slice store; the caller may pass session outcomes,
   * recent metric runs and edge-case patterns it has aggregated.
   */
  recent_session_outcomes?: readonly TelemetrySessionOutcome[];
  edge_cases?: readonly string[];
  recent_metric_runs?: readonly string[];
}

export interface EmitSliceTelemetryResult {
  telemetry: SliceTelemetryT;
  /** True when a new telemetry file was written. False on idempotent reuse. */
  persisted: boolean;
}

const IN_PROGRESS_STATES = new Set([
  "SLICE_PENDING",
  "SLICE_READY",
  "SLICE_BUILDING",
  "SLICE_REVIEWING",
  "SLICE_INTEGRATING",
]);

/**
 * Build + persist a fresh SliceTelemetry for `milestone_id`. Returns the
 * existing telemetry unchanged when the freshly-built body audit_hash
 * matches the pointer's recorded audit_hash.
 */
export async function emitSliceTelemetry(
  input: EmitSliceTelemetryInput,
  deps: SliceTelemetryDeps,
): Promise<EmitSliceTelemetryResult> {
  const slices = await listSlicesForMilestone(deps.store, input.milestone_id);

  const in_progress: TelemetryInProgressSlice[] = [];
  const validated: TelemetryValidatedSlice[] = [];
  const blocked: TelemetryBlockedSlice[] = [];
  for (const s of slices) {
    if (IN_PROGRESS_STATES.has(s.state)) {
      in_progress.push({
        slice_id: s.slice_id,
        slice_kind: s.slice_kind,
        state: s.state,
        current_session_id: s.current_session_id,
      });
    } else if (s.state === "SLICE_VALIDATED") {
      validated.push({
        slice_id: s.slice_id,
        slice_kind: s.slice_kind,
        // SOC-MERGE-POLICY: the slice's `dod_revision_pin` carries the
        // post-merge validated revision. trunk_base_revision pre-dates the
        // merge so we prefer dod_revision_pin when present.
        validated_revision: s.dod_revision_pin,
      });
    } else if (s.state === "SLICE_BLOCKED") {
      blocked.push({
        slice_id: s.slice_id,
        slice_kind: s.slice_kind,
        abandoned_reason: s.abandoned_reason,
      });
    }
  }

  // Sort each partition by slice_id so the audit_hash is deterministic.
  in_progress.sort((a, b) => a.slice_id.localeCompare(b.slice_id));
  validated.sort((a, b) => a.slice_id.localeCompare(b.slice_id));
  blocked.sort((a, b) => a.slice_id.localeCompare(b.slice_id));

  const telemetry_id = newMonotonicId(deps.clock.now());
  const generated_at = deps.clock.isoNow();
  const body = {
    telemetry_id,
    milestone_id: input.milestone_id,
    generated_at,
    in_progress_slices: in_progress,
    validated_slices: validated,
    blocked_slices: blocked,
    recent_session_outcomes: [...(input.recent_session_outcomes ?? [])],
    edge_cases: [...(input.edge_cases ?? [])],
    recent_metric_runs: [...(input.recent_metric_runs ?? [])],
  };
  // body-only audit_hash — KAC-MANIFEST consumers must recompute it from
  // the persisted record minus audit_hash. The id+generated_at are
  // intentionally part of the body-hash because they bind the audit chain
  // to a specific persisted instance — but that means a no-op call would
  // compute a *new* hash every invocation. The idempotency check below
  // recomputes the hash *with the prior id+generated_at* to dedup.
  const audit_hash = bodyAuditHash(body);
  const built: SliceTelemetryT = SliceTelemetry.parse({ ...body, audit_hash });

  // Idempotent: if a prior telemetry exists for this milestone AND its
  // partition shape is identical, reuse it. Identity is checked by
  // recomputing the prior body's audit_hash against a copy of the prior
  // record with this call's `telemetry_id` / `generated_at` substituted —
  // i.e. compare the partition fields only.
  const prior = await loadLatestSliceTelemetry(deps.store, input.milestone_id);
  if (prior != null && partitionEquivalent(prior, built)) {
    return { telemetry: prior, persisted: false };
  }

  await deps.store.writeAtomic(
    layout.sliceTelemetry(telemetry_id),
    JSON.stringify(built, null, 2),
  );
  await deps.store.writeAtomic(
    layout.latestSliceTelemetryByMilestone(input.milestone_id),
    JSON.stringify({ telemetry_id }, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: telemetry_id,
    object_kind: "system",
    from_state: prior?.audit_hash ?? null,
    to_state: audit_hash,
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
        kind: "slice_telemetry_emit",
        milestone_id: input.milestone_id,
        audit_hash,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  return { telemetry: built, persisted: true };
}

/**
 * Resolve the latest SliceTelemetry for `milestone_id` via the pointer
 * file. Returns null if no telemetry has been emitted yet.
 */
export async function loadLatestSliceTelemetry(
  store: StorePort,
  milestone_id: string,
): Promise<SliceTelemetryT | null> {
  const pointerBody = await store.readText(
    layout.latestSliceTelemetryByMilestone(milestone_id),
  );
  if (pointerBody == null) return null;
  let pointer: { telemetry_id?: unknown };
  try {
    pointer = JSON.parse(pointerBody) as { telemetry_id?: unknown };
  } catch {
    return null;
  }
  if (typeof pointer.telemetry_id !== "string") return null;
  const body = await store.readText(layout.sliceTelemetry(pointer.telemetry_id));
  if (body == null) return null;
  try {
    return SliceTelemetry.parse(JSON.parse(body));
  } catch {
    return null;
  }
}

async function listSlicesForMilestone(
  store: StorePort,
  milestone_id: string,
): Promise<SliceT[]> {
  let names: string[];
  try {
    names = await store.list("slices");
  } catch {
    return [];
  }
  const out: SliceT[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`slices/${name}`);
    if (body == null) continue;
    try {
      const slice = Slice.parse(JSON.parse(body));
      if (slice.milestone_id === milestone_id) out.push(slice);
    } catch {
      // skip malformed slice
    }
  }
  return out;
}

function partitionEquivalent(
  a: SliceTelemetryT,
  b: SliceTelemetryT,
): boolean {
  return (
    a.milestone_id === b.milestone_id &&
    JSON.stringify(a.in_progress_slices) ===
      JSON.stringify(b.in_progress_slices) &&
    JSON.stringify(a.validated_slices) ===
      JSON.stringify(b.validated_slices) &&
    JSON.stringify(a.blocked_slices) === JSON.stringify(b.blocked_slices) &&
    JSON.stringify(a.recent_session_outcomes) ===
      JSON.stringify(b.recent_session_outcomes) &&
    JSON.stringify(a.edge_cases) === JSON.stringify(b.edge_cases) &&
    JSON.stringify(a.recent_metric_runs) ===
      JSON.stringify(b.recent_metric_runs)
  );
}
