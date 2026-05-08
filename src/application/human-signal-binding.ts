/**
 * Phase 5b.2 — convert an applied RGC-SIGNALS envelope into a
 * `human_approval` SessionTurn appended to the addressed outer DialogueSession.
 *
 * Mapping:
 *   signal.signal_type=approve              → verdict.result=approve
 *   signal.signal_type=reject               → verdict.result=reject
 *   signal.signal_type=request_rework       → verdict.result=reject (with rationale)
 *   any other type                          → unsupported (caller should not
 *                                              call this; markProcessed=invalid)
 *
 * Target binding: signal.target_kind=milestone OR dialogue_session.
 *   - milestone target: find the SESSION_OPEN outer session whose
 *     parent_object_id matches signal.target_id.
 *   - session target: load the session directly.
 *
 * Idempotency: the SessionTurn's `(session_id, turn_index)` is the
 * authoritative gate; the Caller appends at session.current_turn_index and
 * advances the session's index atomically (lock on sessionMetadata).
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  AgentAuthoredEnvelope,
  type AgentAuthoredEnvelope as AgentAuthoredEnvelopeT,
  type Verdict,
  type VerdictResult,
} from "../domain/schema/envelope.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
} from "../domain/schema/dialogue-session.js";
import type { HumanSignalEnvelope } from "../domain/schema/human-signal.js";
import { SessionTurn } from "../domain/schema/session-turn.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { enrichEnvelope, validateEnvelope } from "./envelope.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

export interface HumanSignalBindingDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export type BindingOutcome =
  | {
      kind: "appended";
      session_id: string;
      turn_index: number;
      verdict: VerdictResult;
    }
  | { kind: "no_session"; reason: string }
  | { kind: "unsupported"; reason: string };

const VERDICT_FOR: Partial<Record<HumanSignalEnvelope["signal_type"], VerdictResult>> =
  {
    approve: "approve",
    reject: "reject",
    request_rework: "reject",
  };

/**
 * Find the SESSION_OPEN outer session for a milestone target, or null.
 * Caller should already have invoked `validateEnvelope` on the raw signal.
 */
async function findOuterSession(
  store: StorePort,
  signal: HumanSignalEnvelope,
): Promise<DialogueSessionT | null> {
  if (signal.target_kind === "dialogue_session") {
    const body = await store.readText(layout.sessionMetadata(signal.target_id));
    if (body == null) return null;
    try {
      const sess = DialogueSession.parse(JSON.parse(body));
      if (sess.state !== "SESSION_OPEN") return null;
      return sess;
    } catch {
      return null;
    }
  }
  if (signal.target_kind !== "milestone") return null;

  let dirs: string[];
  try {
    dirs = await store.list("sessions");
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const body = await store.readText(layout.sessionMetadata(dir));
    if (body == null) continue;
    try {
      const sess = DialogueSession.parse(JSON.parse(body));
      if (
        sess.parent_object_kind === "milestone" &&
        sess.parent_object_id === signal.target_id &&
        sess.state === "SESSION_OPEN" &&
        sess.parent_loop === "outer"
      ) {
        return sess;
      }
    } catch {
      // skip
    }
  }
  return null;
}

function phaseFromPurpose(
  session: DialogueSessionT,
): "Discovery" | "Specification" | "Planning" | "Validation" | null {
  switch (session.purpose) {
    case "design":
      // 'design' is shared by Discovery + Specification — caller can attach
      // the actual outer phase via runtime_metadata; for binding we infer
      // by parent milestone state which the dispatcher already keys on.
      // Default to "Discovery" here; the dispatch matrix doesn't consult
      // this field for human_approval routing (turns are aggregated).
      return "Discovery";
    case "planning_decompose":
      return "Planning";
    case "validation":
      return "Validation";
    default:
      return null;
  }
}

export async function bindHumanSignalToSession(
  signal: HumanSignalEnvelope,
  deps: HumanSignalBindingDeps,
): Promise<BindingOutcome> {
  const verdictResult = VERDICT_FOR[signal.signal_type];
  if (verdictResult == null) {
    return {
      kind: "unsupported",
      reason: `signal_type=${signal.signal_type} is not bindable to human_approval contribution`,
    };
  }

  const session = await findOuterSession(deps.store, signal);
  if (session == null) {
    return {
      kind: "no_session",
      reason: `no SESSION_OPEN outer session for target_kind=${signal.target_kind}, target_id=${signal.target_id}`,
    };
  }

  const phase = phaseFromPurpose(session);
  if (phase == null) {
    return {
      kind: "unsupported",
      reason: `outer session purpose=${session.purpose} has no AGC phase mapping`,
    };
  }

  // Atomic per-session-metadata update of current_turn_index. Race with a
  // parallel coordinator append is bounded by the lock.
  const metaPath = layout.sessionMetadata(session.session_id);
  return deps.store.withFileLock(metaPath, async () => {
    const fresh = await deps.store.readText(metaPath);
    if (fresh == null) {
      return {
        kind: "no_session",
        reason: "session metadata disappeared",
      } as const;
    }
    const live = DialogueSession.parse(JSON.parse(fresh));
    if (live.state !== "SESSION_OPEN") {
      return {
        kind: "no_session",
        reason: `session ${live.session_id} state=${live.state}`,
      } as const;
    }

    // Build the synthetic agent-authored envelope.
    const turn_index = live.current_turn_index;
    const manifest_id = newMonotonicId(deps.clock.now());
    const verdict: Verdict = {
      result: verdictResult,
      rationale: signal.rationale,
    };
    const agent: AgentAuthoredEnvelopeT = AgentAuthoredEnvelope.parse({
      session_id: live.session_id,
      turn_index,
      parent_loop: "outer",
      phase_or_purpose: phase,
      slice_id: null,
      slice_kind: null,
      tdd_phase: null,
      agent_profile_id: "human",
      agent_role_in_session: "reviewer",
      contribution_kind: "human_approval",
      output_kind: "verdict",
      object_id: live.parent_object_id,
      manifest_id,
      input_revision_pins: [live.workspace_revision_pin],
      summary: signal.rationale ?? `human ${signal.signal_type}`,
      artifacts: null,
      verdict,
      next_action_request: null,
      failure: null,
    });
    const enriched = enrichEnvelope(agent, {
      idempotency: {
        scope: "per_turn",
        parts: {
          session_id: live.session_id,
          turn_index,
          agent_profile_id: "human",
          manifest_id,
          input_revision_pins: [live.workspace_revision_pin],
        },
      },
      runtime_metadata: { source_signal_id: signal.signal_id },
    });
    if (!enriched.ok) {
      return {
        kind: "unsupported",
        reason: `enrichEnvelope failed: ${enriched.detail}`,
      } as const;
    }
    const validated = validateEnvelope(enriched.value);
    if (!validated.ok) {
      return {
        kind: "unsupported",
        reason: `validateEnvelope failed: ${validated.detail}`,
      } as const;
    }

    const turn = SessionTurn.parse({
      session_id: live.session_id,
      turn_index,
      agent_profile_id: "human",
      input_manifest_id: manifest_id,
      input_turn_log_snapshot_ref: null,
      output_envelope: validated.value,
      next_action_request: null,
      caller_routing_decision: null,
      workspace_commit: null,
      verification_result_ref: null,
      recorded_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(
      layout.sessionTurn(live.session_id, turn_index),
      JSON.stringify(turn, null, 2),
    );

    // Advance session.current_turn_index atomically.
    const advanced = DialogueSession.parse({
      ...live,
      current_turn_index: turn_index + 1,
      updated_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(metaPath, JSON.stringify(advanced, null, 2));

    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: live.session_id,
      object_kind: "session_turn",
      from_state: null,
      to_state: "SESSION_OPEN",
      loop_kind: "outer",
      phase,
      slice_id: null,
      slice_kind: null,
      dod_revision: null,
      session_id: live.session_id,
      turn_index,
      slot_kind: null,
      agent_profile_id: "human",
      contribution_kind: "human_approval",
      action_kind: "signal_apply",
      final_verdict: verdictResult,
      caller_id: deps.callerId,
      manifest_id,
      input_revision_pins: [live.workspace_revision_pin],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: validated.value.idempotency_key,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: deps.clock.isoNow(),
    });

    return {
      kind: "appended",
      session_id: live.session_id,
      turn_index,
      verdict: verdictResult,
    } as const;
  });
}
