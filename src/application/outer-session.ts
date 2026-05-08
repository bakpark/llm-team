/**
 * Phase 5b.2 — outer-loop DialogueSession lifecycle helpers.
 *
 * Builds + persists outer sessions for Discovery / Specification / Planning /
 * Validation. Mirrors `dialogue-coordinator.openMiddleReviewSession` but for
 * milestone-anchored sessions (parent_object_kind="milestone").
 *
 * Termination presets per SOC-SESSION-TERMINATION §Session 사용 예:
 *   - Discovery / Specification: quorum_then_lead + (no evidence) +
 *       finalization_only, with `human` participant required.
 *   - Planning: unanimous_approve + (no evidence) + finalization_only.
 *   - Validation: lead_only + verification_green + evidence_only.
 *
 * Pickup map: milestone state → outer phase to invoke next.
 *   M_DISCOVERY_DRAFT             → Discovery
 *   M_DISCOVERY_AWAITING_HUMAN    → Discovery (re-evaluate when signal arrives)
 *   M_SPECIFICATION_DRAFT         → Specification
 *   M_SPECIFICATION_AWAITING_HUMAN → Specification
 *   M_DELIVERY_PLANNING           → Planning
 *   M_DELIVERY_VALIDATING         → Validation
 *
 * 본 모듈은 LLM 호출 / manifest 빌드를 하지 않는다. dialogue-coordinator 의
 * `runOneOuterTurn` (5b.3 또는 후속) 가 invoke + persist + dispatch 를 담당.
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  AgentProfileId,
  type AgentProfileId as AgentProfileIdT,
} from "../domain/schema/contribution.js";
import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
  type Participant,
  type SessionTermination,
} from "../domain/schema/dialogue-session.js";
import {
  Milestone,
  type Milestone as MilestoneT,
  type MilestoneState,
} from "../domain/schema/milestone.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

export type OuterPhase =
  | "Discovery"
  | "Specification"
  | "Planning"
  | "Validation";

export interface OuterSessionDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
  /** Default 8 — outer sessions need more turns than middle review. */
  maxOuterTurns?: number;
}

/**
 * milestone state ↔ outer phase. Caller is expected to filter only the
 * states that are actively-pickable by an outer worker (excludes M_DONE,
 * M_ESCALATED, M_INTAKE_QUEUED, M_SPEC_APPROVED, M_DELIVERY_BUILDING —
 * those flow through other workers).
 */
export function outerPhaseForState(
  state: MilestoneState,
): OuterPhase | null {
  switch (state) {
    case "M_DISCOVERY_DRAFT":
    case "M_DISCOVERY_AWAITING_HUMAN":
      return "Discovery";
    case "M_SPECIFICATION_DRAFT":
    case "M_SPECIFICATION_AWAITING_HUMAN":
      return "Specification";
    case "M_DELIVERY_PLANNING":
      return "Planning";
    case "M_DELIVERY_VALIDATING":
      return "Validation";
    default:
      return null;
  }
}

/**
 * Default participants per phase (TCC-LOOP-POLICIES §default). Caller can
 * override via target.yaml 의 loop_policies block in a future phase; for
 * now this is the source of truth.
 */
export function defaultParticipants(phase: OuterPhase): Participant[] {
  switch (phase) {
    case "Discovery":
      return [
        { agent_profile_id: "atlas", role: "lead" },
        { agent_profile_id: "sentinel", role: "reviewer" },
        { agent_profile_id: "human", role: "reviewer" },
      ];
    case "Specification":
      return [
        { agent_profile_id: "atlas", role: "lead" },
        { agent_profile_id: "forge", role: "reviewer" },
        { agent_profile_id: "sentinel", role: "reviewer" },
        { agent_profile_id: "human", role: "reviewer" },
      ];
    case "Planning":
      return [
        { agent_profile_id: "atlas", role: "lead" },
        { agent_profile_id: "forge", role: "reviewer" },
        { agent_profile_id: "sentinel", role: "reviewer" },
      ];
    case "Validation":
      return [
        { agent_profile_id: "sentinel", role: "lead" },
        { agent_profile_id: "scout", role: "observer" },
      ];
  }
}

/**
 * Default `SessionTermination` per outer phase. Mirrors SOC-SESSION-TERMINATION
 * §Session 사용 예.
 */
export function defaultTermination(phase: OuterPhase): SessionTermination {
  switch (phase) {
    case "Discovery":
      return {
        finalization_rule: "quorum_then_lead",
        required_evidence: [],
        composite_rule: "finalization_only",
        quorum_min_approvals: 1,
      };
    case "Specification":
      return {
        finalization_rule: "quorum_then_lead",
        required_evidence: [],
        composite_rule: "finalization_only",
        quorum_min_approvals: 2,
      };
    case "Planning":
      return {
        finalization_rule: "unanimous_approve",
        required_evidence: [],
        composite_rule: "finalization_only",
        quorum_min_approvals: null,
      };
    case "Validation":
      return {
        finalization_rule: "lead_only",
        required_evidence: [
          {
            kind: "verification_green",
            acceptance_tests: [],
            deterministic_checks: [],
          },
        ],
        composite_rule: "evidence_only",
        quorum_min_approvals: null,
      };
  }
}

function purposeFor(
  phase: OuterPhase,
): "design" | "planning_decompose" | "validation" {
  switch (phase) {
    case "Discovery":
    case "Specification":
      return "design";
    case "Planning":
      return "planning_decompose";
    case "Validation":
      return "validation";
  }
}

function leadFor(phase: OuterPhase): AgentProfileIdT {
  return AgentProfileId.parse(phase === "Validation" ? "sentinel" : "atlas");
}

export interface OpenOuterSessionInput {
  milestone: MilestoneT;
  phase: OuterPhase;
  /**
   * Workspace revision pin to record on the session — for outer loops this
   * is typically the milestone's spec_revision_pin or trunk HEAD. Caller
   * supplies the resolved pin.
   */
  workspaceRevisionPin: string;
}

export async function openOuterSession(
  input: OpenOuterSessionInput,
  deps: OuterSessionDeps,
): Promise<DialogueSessionT> {
  const sessionId = newMonotonicId(deps.clock.now());
  const session = DialogueSession.parse({
    session_id: sessionId,
    parent_object_kind: "milestone",
    parent_object_id: input.milestone.milestone_id,
    parent_loop: "outer",
    purpose: purposeFor(input.phase),
    participants: defaultParticipants(input.phase),
    session_termination: defaultTermination(input.phase),
    workspace_revision_pin: input.workspaceRevisionPin,
    current_turn_index: 0,
    state: "SESSION_OPEN",
    max_turns: deps.maxOuterTurns ?? 8,
    created_at: deps.clock.isoNow(),
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(
    layout.sessionMetadata(sessionId),
    JSON.stringify(session, null, 2),
  );
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: sessionId,
    object_kind: "dialogue_session",
    from_state: null,
    to_state: "SESSION_OPEN",
    loop_kind: "outer",
    phase: input.phase,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: sessionId,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: leadFor(input.phase),
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
        kind: "outer_session_open",
        session_id: sessionId,
        milestone_id: input.milestone.milestone_id,
        phase: input.phase,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
  return session;
}

export interface OuterPickup {
  milestone: MilestoneT;
  phase: OuterPhase;
  /** SESSION_OPEN session if one already exists for this milestone. */
  existingSession: DialogueSessionT | null;
}

/**
 * Scan persisted milestones for the next outer-pickable candidate.
 * Returns the oldest-by-updated_at milestone whose state maps to an outer
 * phase. If multiple workers can race on this; cross-process protection
 * comes from `slot_lock` (phase 6a) — for 5b.2 callers should serialize via
 * the existing daemon's per-role lockdir.
 */
export async function pickReadyOuterSession(
  deps: Pick<OuterSessionDeps, "store">,
): Promise<OuterPickup | null> {
  let names: string[];
  try {
    names = await deps.store.list("milestones");
  } catch {
    return null;
  }
  const candidates: { milestone: MilestoneT; phase: OuterPhase }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const body = await deps.store.readText(`milestones/${name}`);
    if (body == null) continue;
    let m: MilestoneT;
    try {
      m = Milestone.parse(JSON.parse(body));
    } catch {
      continue;
    }
    const phase = outerPhaseForState(m.state);
    if (phase != null) candidates.push({ milestone: m, phase });
  }
  if (candidates.length === 0) return null;
  // Oldest-by-updated_at first (fairness baseline; cross-slot priority is
  // applied by `application/fairness.ts` in phase 6a).
  candidates.sort((a, b) =>
    a.milestone.updated_at.localeCompare(b.milestone.updated_at),
  );
  const top = candidates[0]!;

  // Look for an existing SESSION_OPEN session for this milestone.
  let existing: DialogueSessionT | null = null;
  try {
    const sessionDirs = await deps.store.list("sessions");
    for (const dir of sessionDirs) {
      const metaBody = await deps.store.readText(
        layout.sessionMetadata(dir),
      );
      if (metaBody == null) continue;
      try {
        const sess = DialogueSession.parse(JSON.parse(metaBody));
        if (
          sess.parent_object_kind === "milestone" &&
          sess.parent_object_id === top.milestone.milestone_id &&
          sess.state === "SESSION_OPEN"
        ) {
          existing = sess;
          break;
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // sessions/ may not exist
  }
  return { milestone: top.milestone, phase: top.phase, existingSession: existing };
}
