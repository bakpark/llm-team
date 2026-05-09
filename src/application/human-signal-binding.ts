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
import {
  Milestone,
  type Milestone as MilestoneT,
} from "../domain/schema/milestone.js";
import { SessionTurn } from "../domain/schema/session-turn.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import type { TeamMembershipPort } from "../ports/team-membership.js";
import { enrichEnvelope, validateEnvelope } from "./envelope.js";
import type { LedgerAppender } from "./ledger.js";
import { outerPhaseForState, type OuterPhase } from "./outer-session.js";
import { layout } from "./persistence-layout.js";

/**
 * Phase 9a (G2-4): operator-declared policy when the team-membership lookup
 * is unreachable. `block` rejects the signal (fail-closed); `warn` admits
 * the signal but the binding hook is required to emit an audit-only ledger
 * row separate from the normal applied row. The default is `block` —
 * unknown invariants resolve to `block` per `resolveEnforcementLevel`.
 */
export type UnreachablePolicy = "warn" | "block";

export interface HumanSignalBindingDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
  /**
   * Phase 9a: when set, the binding hook verifies that `signal.actor` is a
   * member of `humanTeam` BEFORE creating any contribution. Adapters MAY
   * cache positive results (`governance.human_team_cache_ttl_seconds`).
   * Omit (or `humanTeam=null`) to skip the check — phase-5b callers without
   * a configured team retain the legacy "any actor" behaviour.
   */
  teamMembership?: TeamMembershipPort;
  humanTeam?: string | null;
  /** See `UnreachablePolicy`. Defaults to `block`. */
  unreachablePolicy?: UnreachablePolicy;
}

export type BindingOutcome =
  | {
      kind: "appended";
      session_id: string;
      turn_index: number;
      verdict: VerdictResult;
      /**
       * PR #79 P1 review: present when an `unreachable + warn` admit must
       * be paired with an audit-only ledger row. The caller (drain) emits
       * `emitMembershipRejection(deps, signal, "actor_team_lookup_unreachable")`
       * AFTER `markProcessed` succeeds with `alreadyProcessed=false`, so
       * a crash between bind and markProcessed does not leak a duplicate
       * audit row on the next drain cycle.
       */
      pendingMembershipAudit?: typeof ACTOR_TEAM_LOOKUP_UNREACHABLE;
    }
  | { kind: "no_session"; reason: string }
  | { kind: "unsupported"; reason: string }
  /**
   * Phase 9a (G2-4): the actor is not a member of the configured human team
   * (or the lookup was unreachable and policy resolved to `block`). The
   * binding hook NO LONGER emits the ledger row inline — the caller (drain)
   * MUST `markProcessed(state="invalid")` first and THEN call
   * `emitMembershipRejection(deps, signal, pendingMembershipAudit)` so a
   * mid-flight crash + retry does not produce duplicate `result=invalid`
   * audit rows (PR #79 P1 review). `result=invalid` is not part of
   * `FileLedger.replay()`'s applied-keys set so dedup cannot absorb it.
   */
  | {
      kind: "invalid";
      reason: string;
      pendingMembershipAudit:
        | typeof ACTOR_NOT_IN_HUMAN_TEAM
        | typeof ACTOR_TEAM_LOOKUP_UNREACHABLE;
    }
  /**
   * PR #79 P0 review (gpt5.5): TCC-GOVERNANCE mandates fail-closed
   * `human_team` lookup with **backoff retry** (envelope queue 보류) — not
   * permanent rejection. Returned when the membership lookup is unreachable
   * and policy resolves to `block`. Caller (drain) MUST NOT `markProcessed`
   * and MUST NOT emit a `result=invalid` ledger row — the signal stays
   * pending so the next drain cycle re-runs the lookup once GitHub Teams
   * API recovers.
   */
  | { kind: "unreachable_retry"; reason: string };

/**
 * Sentinel `result_detail` written to the ledger when membership rejects
 * the actor. Surfaces in audit queries (TCC-GOVERNANCE conformance).
 */
export const ACTOR_NOT_IN_HUMAN_TEAM = "actor_not_in_human_team";
export const ACTOR_TEAM_LOOKUP_UNREACHABLE = "actor_team_lookup_unreachable";

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
  // Codex P2: collect candidates and pick most-recently-updated SESSION_OPEN
  // for determinism when multiple outer sessions exist for one milestone
  // (e.g. re-opens after AWAITING_HUMAN cycles).
  const candidates: DialogueSessionT[] = [];
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
        candidates.push(sess);
      }
    } catch {
      // skip
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return candidates[0]!;
}

/**
 * Derive the AGC outer phase label from the parent milestone's state.
 * Codex P1: previously this was based on session.purpose, but
 * Discovery/Specification share `purpose="design"` so Specification
 * sessions were getting phase="Discovery" labels in the persisted
 * envelope. The dispatcher (5b.3) keys on this field, so the wrong label
 * would route to the wrong dispatch row.
 *
 * Caller (binding) reads the milestone fresh from store — this is the
 * single source of truth for the phase label.
 */
async function resolvePhaseForBinding(
  store: StorePort,
  session: DialogueSessionT,
): Promise<OuterPhase | null> {
  if (session.parent_loop !== "outer") return null;
  if (session.purpose === "planning_decompose") return "Planning";
  if (session.purpose === "validation") return "Validation";
  // session.purpose === "design" → Discovery vs Specification: derive from
  // parent milestone state.
  if (session.parent_object_kind !== "milestone") return null;
  const body = await store.readText(layout.milestone(session.parent_object_id));
  if (body == null) return null;
  let milestone: MilestoneT;
  try {
    milestone = Milestone.parse(JSON.parse(body));
  } catch {
    return null;
  }
  const phase = outerPhaseForState(milestone.state);
  // outerPhaseForState may return Planning/Validation but we already handled
  // those above; here we only care about Discovery vs Specification.
  if (phase === "Discovery" || phase === "Specification") return phase;
  return null;
}

/**
 * Emit a `signal_apply` ledger row with `result=invalid` for an actor that
 * failed the team-membership check. Mirrors the applied-row shape so audit
 * queries can group by `idempotency_key` (here: signal_id-derived) and the
 * downstream consumer sees a single authoritative reason.
 *
 * This row is NOT tied to a SessionTurn — `session_id` / `turn_index` are
 * null because no contribution was created.
 *
 * PR #79 P1 review: callers (drain) MUST invoke this AFTER `markProcessed`
 * succeeds with `alreadyProcessed=false`, so a crash between binding and
 * markProcessed does not leak a duplicate `result=invalid` row on the next
 * drain cycle. `result=invalid` rows are not in
 * `FileLedger.replay()`'s applied-keys set so dedup cannot absorb retries.
 */
export async function emitMembershipRejection(
  deps: HumanSignalBindingDeps,
  signal: HumanSignalEnvelope,
  detail: typeof ACTOR_NOT_IN_HUMAN_TEAM | typeof ACTOR_TEAM_LOOKUP_UNREACHABLE,
): Promise<void> {
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: signal.signal_id,
    object_kind: "session_turn",
    from_state: null,
    // No state machine transition occurred — the row records the rejection
    // event itself. `rejected` is the audit-only sentinel; downstream
    // queries filter by `result=invalid` + `action_kind=signal_apply`.
    to_state: "rejected",
    loop_kind: "outer",
    phase: null,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: "human",
    contribution_kind: "human_approval",
    action_kind: "signal_apply",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: `signal_apply::${signal.signal_id}::membership`,
    lease_token: null,
    lease_kind: null,
    result: "invalid",
    result_detail: detail,
    timestamp: deps.clock.isoNow(),
  });
}

/**
 * Phase 9a (G2-4): verify the signal author belongs to the configured
 * human team before any contribution is created.
 *
 * Returned non-null outcome shapes (PR #79 review):
 *   - `invalid` (non-member, OR unreachable+block when `unreachablePolicy=block`
 *     was historically used): caller MUST `markProcessed(invalid)` and then
 *     emit the audit ledger row via `pendingMembershipAudit`.
 *   - `unreachable_retry` (NEW; unreachable + block, contract-aligned):
 *     caller MUST NOT `markProcessed` and MUST NOT emit a ledger row; the
 *     signal stays pending so the next drain cycle re-runs the lookup
 *     (TCC-GOVERNANCE backoff retry).
 *   - `null` ADMIT: includes member + unreachable+warn. When the lookup
 *     was unreachable+warn, the membership audit detail is signalled to
 *     the caller via the `pendingWarnAudit` parameter so the audit row
 *     can be emitted AFTER markProcessed succeeds.
 *
 * No ledger emission happens inside this function — that responsibility
 * is delegated to the caller (drain) so retries cannot leak duplicate
 * `result=invalid` rows.
 */
async function verifyActorMembership(
  signal: HumanSignalEnvelope,
  deps: HumanSignalBindingDeps,
  pendingWarnAudit: { detail: typeof ACTOR_TEAM_LOOKUP_UNREACHABLE | null },
): Promise<BindingOutcome | null> {
  if (deps.teamMembership == null || deps.humanTeam == null) return null;
  const policy: UnreachablePolicy = deps.unreachablePolicy ?? "block";
  const result = await deps.teamMembership.isMember(deps.humanTeam, signal.actor);
  if (result.kind === "member") return null;
  if (result.kind === "non_member") {
    return {
      kind: "invalid",
      reason: ACTOR_NOT_IN_HUMAN_TEAM,
      pendingMembershipAudit: ACTOR_NOT_IN_HUMAN_TEAM,
    };
  }
  // unreachable — apply policy.
  if (policy === "block") {
    // PR #79 P0 review (gpt5.5): TCC-GOVERNANCE line 102 mandates
    // fail-closed via "envelope 큐 진입 보류, backoff 재시도". Returning
    // `unreachable_retry` keeps the signal pending so a transient
    // 401/403/network blip does not permanently consume the approval.
    return {
      kind: "unreachable_retry",
      reason: ACTOR_TEAM_LOOKUP_UNREACHABLE,
    };
  }
  // warn: admit the signal but record an audit row so the gap is visible.
  // The audit emission is deferred to the caller (after markProcessed)
  // via `pendingWarnAudit` to preserve the same anti-duplication guarantee.
  pendingWarnAudit.detail = ACTOR_TEAM_LOOKUP_UNREACHABLE;
  return null;
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

  // Phase 9a (G2-4): actor must be a member of the configured human team
  // before any contribution is created. Hook is opt-in via deps.teamMembership.
  const pendingWarnAudit: { detail: typeof ACTOR_TEAM_LOOKUP_UNREACHABLE | null } = {
    detail: null,
  };
  const membership = await verifyActorMembership(signal, deps, pendingWarnAudit);
  if (membership != null) return membership;

  const session = await findOuterSession(deps.store, signal);
  if (session == null) {
    return {
      kind: "no_session",
      reason: `no SESSION_OPEN outer session for target_kind=${signal.target_kind}, target_id=${signal.target_id}`,
    };
  }

  // Codex P1: derive phase from milestone state, not session.purpose, since
  // Discovery + Specification share purpose="design".
  const phase = await resolvePhaseForBinding(deps.store, session);
  if (phase == null) {
    return {
      kind: "unsupported",
      reason: `outer session purpose=${session.purpose} (parent_object_id=${session.parent_object_id}) has no AGC phase mapping`,
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

    // Codex P1: ledger append BEFORE the SessionTurn + metadata writes.
    // Per_turn idempotency_key dedups duplicate retries as
    // result=duplicate. If ledger fails here, no SessionTurn is persisted
    // and the next drain re-tries with the same key (lock + re-read of
    // sessionMetadata sees current_turn_index unchanged). This prevents
    // the silent audit-row gap the prior ordering produced when
    // writeAtomic(metaPath) succeeded but ledger failed.
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

    return {
      kind: "appended",
      session_id: live.session_id,
      turn_index,
      verdict: verdictResult,
      ...(pendingWarnAudit.detail != null
        ? { pendingMembershipAudit: pendingWarnAudit.detail }
        : {}),
    } as const;
  });
}
