/**
 * RGC-CROSS-SLOT-STALE — cross-slot staleness detection (phase 6a).
 *
 * Detects when a Discovery N+1 outer session has read-base-revision-pinned
 * an artefact from Delivery N that has since changed. When detected, the
 * affected Discovery N+1 SESSION_OPEN session is transitioned to
 * AWAITING_REVALIDATION (per RGC-CROSS-SLOT-STALE Caller Action table).
 *
 * Detection signal (FS-only, phase 6a — full revision pin replay arrives
 * with phase 5c/6b telemetry):
 *
 *   - For each SESSION_OPEN whose `parent_loop = "outer"` and whose
 *     `parent_object_kind = "milestone"`:
 *       - find the milestone the session belongs to.
 *       - if the milestone is in a Discovery / Specification state AND a
 *         peer Delivery milestone (state ∈ {M_DELIVERY_BUILDING,
 *         M_DELIVERY_VALIDATING, M_DONE}) was updated AFTER the Discovery
 *         session's `updated_at`, mark the Discovery session as stale.
 *
 *   - The conservative "any newer Delivery update" trigger is intentional
 *     — phase 6a does not yet track manifest read_base_revision_pin (that
 *     arrives with KAC-SLICE-TELEMETRY inject in phase 5c). The trigger
 *     can therefore over-fire (false-stale); RGC-CROSS-SLOT-STALE allows
 *     warn-grade enforcement (`telemetry_enrichment_missing=warn`) so
 *     this conservative behaviour is contract-compliant.
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
  Milestone,
  type Milestone as MilestoneT,
  type MilestoneState,
} from "../domain/schema/milestone.js";
import { newMonotonicId } from "../domain/ids.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

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
  if (deliveryFamily.length === 0) return { staledSessionIds: [] };
  // Latest Delivery activity timestamp — the conservative trigger.
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
    if (sess.updated_at >= latestDeliveryUpdate) continue;

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
          delivery_revision: latestDeliveryUpdate,
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
