/**
 * RGC-CROSS-SLOT-STALE — cross-slot staleness detection.
 *
 * Detects when a Discovery N+1 outer session has read-base-revision-pinned
 * an artefact from Delivery N that has since changed. When detected, the
 * affected Discovery N+1 SESSION_OPEN session is transitioned to
 * AWAITING_REVALIDATION (per RGC-CROSS-SLOT-STALE Caller Action table).
 *
 * Detection signal — phase 8b (KAC-SLICE-TELEMETRY pin comparison):
 *
 *   - For each SESSION_OPEN whose `parent_loop = "outer"` and whose
 *     `parent_object_kind = "milestone"` and whose milestone is in a
 *     Discovery / Specification state:
 *
 *     1. Resolve the session's *latest* SessionTurn → its `input_manifest_id`.
 *     2. Read the manifest; locate the entry whose `object_kind` is
 *        `slice_telemetry` (injected by `outer-turn.ts` for the live
 *        Delivery N).
 *     3. Look up the Delivery milestone's *current* SliceTelemetry (via
 *        `loadLatestSliceTelemetry`) and compare its `audit_hash` to the
 *        manifest entry's `revision_pin`. Drift → AWAITING_REVALIDATION.
 *
 *   - Fallback (no telemetry inject yet — fresh Discovery session whose
 *     first turn has not run, or no Delivery has emitted telemetry): the
 *     conservative phase-6a trigger ("any newer Delivery update than the
 *     Discovery session's updated_at") is preserved. This preserves
 *     dual-slot safety while telemetry catches up — KAC-SLICE-TELEMETRY
 *     is `telemetry_enrichment_missing=warn`, so over-firing here remains
 *     contract-compliant.
 *
 * Atomicity: each session is transitioned under
 * `withFileLock(sessionMetadata)` with a read-check-write. The function is
 * idempotent — calling twice without intervening Delivery activity is a
 * noop on the second call.
 */
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
} from "../domain/schema/dialogue-session.js";
import {
  ContextManifest,
  type ContextManifest as ContextManifestT,
} from "../domain/schema/manifest.js";
import {
  Milestone,
  type Milestone as MilestoneT,
  type MilestoneState,
} from "../domain/schema/milestone.js";
import { SliceTelemetry } from "../domain/schema/knowledge.js";
import { newMonotonicId } from "../domain/ids.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";
import { loadLatestSliceTelemetry } from "./slice-telemetry.js";

const DISCOVERY_FAMILY: readonly MilestoneState[] = [
  "M_DISCOVERY_DRAFT",
  "M_DISCOVERY_AWAITING_HUMAN",
  "M_SPECIFICATION_DRAFT",
  "M_SPECIFICATION_AWAITING_HUMAN",
];

const DELIVERY_FAMILY: readonly MilestoneState[] = [
  "M_DELIVERY_BUILDING",
  "M_DELIVERY_VALIDATING",
  "M_DONE",
];

export interface CrossSlotStaleDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export interface CrossSlotStaleResult {
  /** Session ids transitioned to AWAITING_REVALIDATION this run. */
  staledSessionIds: string[];
}

async function listMilestones(store: StorePort): Promise<MilestoneT[]> {
  let names: string[];
  try {
    names = await store.list("milestones");
  } catch {
    return [];
  }
  const out: MilestoneT[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`milestones/${name}`);
    if (body == null) continue;
    try {
      out.push(Milestone.parse(JSON.parse(body)));
    } catch {
      // skip
    }
  }
  return out;
}

async function listOpenOuterSessions(
  store: StorePort,
): Promise<DialogueSessionT[]> {
  let dirs: string[];
  try {
    dirs = await store.list("sessions");
  } catch {
    return [];
  }
  const out: DialogueSessionT[] = [];
  for (const dir of dirs) {
    const body = await store.readText(layout.sessionMetadata(dir));
    if (body == null) continue;
    try {
      const sess = DialogueSession.parse(JSON.parse(body));
      if (
        sess.parent_loop === "outer" &&
        sess.parent_object_kind === "milestone" &&
        sess.state === "SESSION_OPEN"
      ) {
        out.push(sess);
      }
    } catch {
      // skip
    }
  }
  return out;
}

export async function detectCrossSlotStaleSessions(
  deps: CrossSlotStaleDeps,
): Promise<CrossSlotStaleResult> {
  const milestones = await listMilestones(deps.store);
  if (milestones.length === 0) return { staledSessionIds: [] };
  const byId = new Map(milestones.map((m) => [m.milestone_id, m]));

  const deliveryFamily = milestones.filter((m) =>
    DELIVERY_FAMILY.includes(m.state),
  );
  // Edge case (PR #70 P1-4): when no Delivery N has reached
  // M_DELIVERY_BUILDING/VALIDATING/DONE — including the case where the
  // Delivery slot is empty entirely or only holds M_DELIVERY_PLANNING —
  // there is no Delivery N artefact for Discovery N+1 to be stale against.
  // Skip the pass; an explicit check rather than relying on the reduce
  // below makes the intent visible to readers.
  if (deliveryFamily.length === 0) return { staledSessionIds: [] };
  // Latest Delivery activity timestamp — the fallback trigger when no
  // KAC-SLICE-TELEMETRY pin is available for comparison.
  const latestDeliveryUpdate = deliveryFamily.reduce(
    (acc, m) => (m.updated_at > acc ? m.updated_at : acc),
    deliveryFamily[0]!.updated_at,
  );

  const sessions = await listOpenOuterSessions(deps.store);
  const staledIds: string[] = [];

  for (const sess of sessions) {
    const milestone = byId.get(sess.parent_object_id);
    if (milestone == null) continue;
    if (!DISCOVERY_FAMILY.includes(milestone.state)) continue;

    const driftKind = await detectDriftForSession(
      sess,
      milestone,
      deliveryFamily,
      latestDeliveryUpdate,
      deps.store,
    );
    if (driftKind == null) continue;

    const sessionPath = layout.sessionMetadata(sess.session_id);
    const transitioned = await deps.store.withFileLock(
      sessionPath,
      async () => {
        const fresh = await deps.store.readText(sessionPath);
        if (fresh == null) return false;
        let live: DialogueSessionT;
        try {
          live = DialogueSession.parse(JSON.parse(fresh));
        } catch {
          return false;
        }
        if (live.state !== "SESSION_OPEN") return false;
        const next: DialogueSessionT = DialogueSession.parse({
          ...live,
          state: "AWAITING_REVALIDATION",
          updated_at: deps.clock.isoNow(),
        });
        await deps.store.writeAtomic(
          sessionPath,
          JSON.stringify(next, null, 2),
        );
        return true;
      },
    );
    if (!transitioned) continue;

    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: sess.session_id,
      object_kind: "dialogue_session",
      from_state: "SESSION_OPEN",
      to_state: "AWAITING_REVALIDATION",
      loop_kind: "outer",
      phase: null,
      slice_id: null,
      slice_kind: null,
      dod_revision: null,
      session_id: sess.session_id,
      turn_index: null,
      slot_kind: null,
      agent_profile_id: null,
      contribution_kind: null,
      action_kind: "recover",
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
          kind: "cross_slot_stale",
          session_id: sess.session_id,
          // Idempotency key keys on the trigger that fired so a session
          // re-flagged via a different drift kind would still produce a
          // distinct ledger row. `telemetry_pin_drift` carries the new
          // pin; `delivery_updated_at` falls back to the latest Delivery
          // updated_at (phase-6a conservative trigger).
          drift_kind: driftKind.kind,
          drift_value: driftKind.value,
        },
      }),
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: "cross_slot_stale",
      timestamp: deps.clock.isoNow(),
    });
    staledIds.push(sess.session_id);
  }

  return { staledSessionIds: staledIds };
}

/**
 * Per-session drift signal.
 *
 * `kind="telemetry_pin_drift"` — the Discovery session's latest manifest
 * referenced a SliceTelemetry whose audit_hash no longer matches the
 * Delivery milestone's current SliceTelemetry. `value` records the new
 * audit_hash.
 *
 * `kind="delivery_updated_at"` — fallback (phase-6a conservative trigger):
 * Delivery activity timestamp moved past the Discovery session's
 * `updated_at`, and either no telemetry inject was present yet OR a
 * telemetry pin was present but the Discovery session's updated_at also
 * pre-dates the latest Delivery activity. `value` records the latest
 * Delivery `updated_at`.
 */
type DriftKind =
  | { kind: "telemetry_pin_drift"; value: string }
  | { kind: "delivery_updated_at"; value: string };

async function detectDriftForSession(
  sess: DialogueSessionT,
  discoveryMilestone: MilestoneT,
  deliveryFamily: readonly MilestoneT[],
  latestDeliveryUpdate: string,
  store: StorePort,
): Promise<DriftKind | null> {
  const inject = await loadInjectedTelemetryPin(sess, store);
  if (inject != null) {
    // PR #77 P1 fix: pin the comparison to the *original* Delivery
    // milestone the manifest was built against. The previous logic
    // re-selected "most-recently-updated Delivery in the target" at
    // detection time, which could swap to a different Delivery and
    // produce false-stale (different milestone's telemetry compared) or
    // missed-stale (the pinned milestone got rotated past). We resolve
    // the pinned telemetry record (by its `telemetry_id` = manifest
    // entry's object_id) to recover its `milestone_id`, then compare
    // against that milestone's *current* telemetry only.
    const pinnedDeliveryMilestoneId = await resolvePinnedDeliveryMilestoneId(
      inject.telemetryId,
      store,
    );
    if (pinnedDeliveryMilestoneId != null) {
      // Confirm the pinned Delivery still exists and matches this
      // Discovery's target (else fall through to the conservative
      // trigger).
      const pinnedDeliveryStillKnown = deliveryFamily.some(
        (m) =>
          m.target_id === discoveryMilestone.target_id &&
          m.milestone_id !== discoveryMilestone.milestone_id &&
          m.milestone_id === pinnedDeliveryMilestoneId,
      );
      if (pinnedDeliveryStillKnown) {
        const live = await loadLatestSliceTelemetry(
          store,
          pinnedDeliveryMilestoneId,
        );
        if (live != null && live.audit_hash !== inject.pin) {
          return { kind: "telemetry_pin_drift", value: live.audit_hash };
        }
        if (live != null && live.audit_hash === inject.pin) {
          // Pin matches live telemetry — explicit "no drift" signal. Skip
          // the fallback trigger so a moved Delivery updated_at without a
          // material slice change does not re-stale.
          return null;
        }
        // live==null but a pin existed: Delivery telemetry was rotated /
        // archived — treat as drift.
        return { kind: "telemetry_pin_drift", value: "<missing>" };
      }
    } else {
      // The pinned telemetry record itself is gone — treat as drift so
      // the Discovery session re-resolves its base on next pickup.
      return { kind: "telemetry_pin_drift", value: "<missing>" };
    }
  }
  // Fallback — phase-6a conservative trigger. Over-fires by design;
  // KAC-SLICE-TELEMETRY allows warn-grade enforcement so this stays
  // contract-compliant until every Discovery session has an injected pin.
  if (sess.updated_at < latestDeliveryUpdate) {
    return { kind: "delivery_updated_at", value: latestDeliveryUpdate };
  }
  return null;
}

/**
 * Resolve the slice_telemetry manifest entry from the session's most-recent
 * SessionTurn's `input_manifest_id`. Returns the entry's `revision_pin`
 * (the pinned `audit_hash`) and `object_id` (the pinned `telemetry_id`).
 * Returns null when no turn exists yet or the manifest has no slice_telemetry
 * entry.
 */
async function loadInjectedTelemetryPin(
  sess: DialogueSessionT,
  store: StorePort,
): Promise<{ pin: string; telemetryId: string } | null> {
  if (sess.current_turn_index <= 0) return null;
  // current_turn_index points at the *next* turn; the latest persisted
  // turn is current_turn_index - 1.
  const lastIdx = sess.current_turn_index - 1;
  const turnBody = await store.readText(
    layout.sessionTurn(sess.session_id, lastIdx),
  );
  if (turnBody == null) return null;
  let manifestId: string;
  try {
    const turn = JSON.parse(turnBody) as { input_manifest_id?: unknown };
    if (typeof turn.input_manifest_id !== "string") return null;
    manifestId = turn.input_manifest_id;
  } catch {
    return null;
  }
  const manifestBody = await store.readText(layout.manifest(manifestId));
  if (manifestBody == null) return null;
  let manifest: ContextManifestT;
  try {
    manifest = ContextManifest.parse(JSON.parse(manifestBody));
  } catch {
    return null;
  }
  const entry = manifest.entries.find((e) => e.object_kind === "slice_telemetry");
  if (entry == null) return null;
  return { pin: entry.revision_pin, telemetryId: entry.object_id };
}

/**
 * Read a persisted SliceTelemetry record by its `telemetry_id` and return
 * the Delivery `milestone_id` it was emitted against. Returns null when
 * the file is missing or unparseable.
 */
async function resolvePinnedDeliveryMilestoneId(
  telemetryId: string,
  store: StorePort,
): Promise<string | null> {
  const body = await store.readText(layout.sliceTelemetry(telemetryId));
  if (body == null) return null;
  try {
    return SliceTelemetry.parse(JSON.parse(body)).milestone_id;
  } catch {
    return null;
  }
}
