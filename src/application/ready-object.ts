import { newMonotonicId } from "../domain/ids.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
} from "../domain/schema/dialogue-session.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

/**
 * Phase 2 turn pickup — internal slices only, forge solo, inner tdd_build.
 *
 * `dialogue-coordinator` and `caller-dispatch` (phase 3) generalise this; the
 * present module covers a single combination so the first e2e cycle has a
 * deterministic entry point.
 *
 * Behaviour:
 *   - Lists `slices/` and selects the oldest SLICE_READY internal slice.
 *   - If the slice has no `current_session_id`, opens a new SESSION_OPEN
 *     DialogueSession (lead_only, forge, inner, tdd_build) and advances the
 *     slice to SLICE_BUILDING. Both writes happen inside `withFileLock` and
 *     are followed by a ledger row (`action_kind=session_progress`,
 *     `to_state=SLICE_BUILDING`) so the audit trail covers the transition.
 *   - If the slice already has a SESSION_OPEN session, returns that session
 *     to continue (turn_index taken from session.current_turn_index).
 *   - Returns null when no SLICE_READY/SLICE_BUILDING internal slices exist.
 *
 * Idempotency: opening a session writes both records under
 * `withFileLock(slice_path)` so concurrent runners cannot create two
 * sessions for the same slice.
 */

export interface ReadyTurn {
  slice: SliceT;
  session: DialogueSessionT;
  turnIndex: number;
  /** Whether the session was newly opened by this pickup. */
  newSession: boolean;
}

export interface PickReadyTurnDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export async function pickReadyInnerTurn(
  deps: PickReadyTurnDeps,
): Promise<ReadyTurn | null> {
  const slice = await pickOldestReadyInternalSlice(deps);
  if (slice == null) return null;
  return openOrResumeSession(slice, deps);
}

async function pickOldestReadyInternalSlice(
  deps: PickReadyTurnDeps,
): Promise<SliceT | null> {
  const entries = await deps.store.list("slices");
  const candidates: SliceT[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const body = await deps.store.readText(`slices/${name}`);
    if (body == null) continue;
    let parsed: SliceT;
    try {
      parsed = Slice.parse(JSON.parse(body));
    } catch {
      continue;
    }
    if (parsed.slice_kind !== "internal") continue;
    if (parsed.state !== "SLICE_READY" && parsed.state !== "SLICE_BUILDING")
      continue;
    candidates.push(parsed);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return candidates[0]!;
}

async function openOrResumeSession(
  slice: SliceT,
  deps: PickReadyTurnDeps,
): Promise<ReadyTurn> {
  return deps.store.withFileLock(layout.slice(slice.slice_id), async () => {
    const reread = await rereadSlice(slice.slice_id, deps);
    const live = reread ?? slice;
    if (live.current_session_id != null) {
      const sessionBody = await deps.store.readText(
        layout.sessionMetadata(live.current_session_id),
      );
      if (sessionBody == null)
        throw new Error(
          `slice ${live.slice_id} references session ${live.current_session_id} but metadata.json missing`,
        );
      const session = DialogueSession.parse(JSON.parse(sessionBody));
      if (session.state !== "SESSION_OPEN") {
        throw new SessionNotOpenError(
          slice.slice_id,
          session.session_id,
          session.state,
        );
      }
      return {
        slice: live,
        session,
        turnIndex: session.current_turn_index,
        newSession: false,
      };
    }
    const previousState = live.state;
    const session = await openSession(live, deps);
    const updated = Slice.parse({
      ...live,
      state: "SLICE_BUILDING",
      current_session_id: session.session_id,
      updated_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(
      layout.slice(updated.slice_id),
      JSON.stringify(updated, null, 2),
    );

    // P0 fix (PR #61 review): emit a ledger row for the SLICE_READY →
    // SLICE_BUILDING transition + session-open so the audit trail does
    // not skip the transition. Caller-side idempotency uses the canonical
    // compositor.
    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: updated.slice_id,
      object_kind: "slice",
      from_state: previousState,
      to_state: "SLICE_BUILDING",
      loop_kind: "inner",
      phase: null,
      slice_id: updated.slice_id,
      slice_kind: updated.slice_kind,
      dod_revision: updated.dod_revision_pin,
      session_id: session.session_id,
      turn_index: null,
      slot_kind: "delivery",
      agent_profile_id: "forge",
      contribution_kind: null,
      action_kind: "session_progress",
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
          kind: "session_open",
          slice_id: updated.slice_id,
          session_id: session.session_id,
        },
      }),
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: deps.clock.isoNow(),
    });

    return {
      slice: updated,
      session,
      turnIndex: session.current_turn_index,
      newSession: true,
    };
  });
}

async function rereadSlice(
  sliceId: string,
  deps: PickReadyTurnDeps,
): Promise<SliceT | null> {
  const body = await deps.store.readText(layout.slice(sliceId));
  if (body == null) return null;
  return Slice.parse(JSON.parse(body));
}

async function openSession(
  slice: SliceT,
  deps: PickReadyTurnDeps,
): Promise<DialogueSessionT> {
  const sessionId = newMonotonicId(deps.clock.now());
  const session = DialogueSession.parse({
    session_id: sessionId,
    parent_object_kind: "slice",
    parent_object_id: slice.slice_id,
    parent_loop: "inner",
    purpose: "tdd_build",
    participants: [{ agent_profile_id: "forge", role: "lead" }],
    session_termination: {
      finalization_rule: "lead_only",
      required_evidence: [
        {
          kind: "verification_green",
          acceptance_tests: slice.acceptance_tests.map(
            (a) => `${a.path}:${a.name}`,
          ),
          deterministic_checks: [],
        },
      ],
      composite_rule: "evidence_only",
    },
    workspace_revision_pin: slice.trunk_base_revision,
    current_turn_index: 0,
    state: "SESSION_OPEN",
    max_turns: 10,
    created_at: deps.clock.isoNow(),
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sessionMetadata(sessionId),
    JSON.stringify(session, null, 2),
  );
  return session;
}

export class SessionNotOpenError extends Error {
  constructor(
    readonly sliceId: string,
    readonly sessionId: string,
    readonly state: string,
  ) {
    super(
      `slice ${sliceId} session ${sessionId} is in state ${state}, expected SESSION_OPEN`,
    );
    this.name = "SessionNotOpenError";
  }
}
