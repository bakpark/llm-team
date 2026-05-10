/**
 * SOC-DISPATCH-MATRIX outer-loop effect executor (Phase 5b.1).
 *
 * Slice-anchored effects (inner / middle review) live in
 * `caller-dispatch.ts`. Milestone-anchored outer-loop effects live here.
 *
 * Atomicity (PR #66 P0-1 fix): every outer dispatch runs inside a single
 * `withFileLock(milestonePath)` so slice writes + Decision Log + Spec CP +
 * milestone state transition are observed atomically. A crash between any
 * two of these steps leaves the milestone state unchanged; the next cycle's
 * dispatch retries from the same source state.
 *
 * Source-state guard (PR #66 P0-2 fix): each effect declares its
 * `ALLOWED_SOURCE_STATES`. A stale outcome cannot pull a milestone in
 * M_DONE / M_ESCALATED / *_AWAITING_HUMAN backwards.
 *
 * Ledger always emits (PR #66 P0-3 fix): even when the milestone is already
 * at the target state (idempotent re-run), `appendTransition` is called so
 * the audit trail is complete. The ledger's idempotency_key dedups the row
 * as `duplicate` rather than producing a silent gap.
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  lookupDispatch,
  type DispatchEffect,
} from "../domain/dispatch-matrix.js";
import {
  Milestone,
  type Milestone as MilestoneT,
  type MilestoneState,
} from "../domain/schema/milestone.js";
import {
  Slice,
  type Slice as SliceT,
} from "../domain/schema/slice.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { idempotencyKey } from "./idempotency.js";
import {
  recordDecision,
  snapshotContextSummary,
  type SnapshotContextSummaryInput,
} from "./knowledge.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";
import { computeReadySlices, validateSliceDag } from "./slice-dag.js";

export interface OuterDispatchDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export interface OuterDispatchInput {
  parent_loop: "outer";
  phase_or_purpose:
    | "Discovery"
    | "Specification"
    | "Planning"
    | "Validation";
  session_state: "CONVERGED" | "TIMEOUT" | "ABANDONED";
  final_verdict: string | null;
  milestone: MilestoneT;
  sessionId: string;

  /**
   * Discovery / Specification: Spec CP body (markdown / canonical text).
   * Persisted under `layout.milestoneSpec(milestone_id)` (5b.1 minimal —
   * phase 6b 의 GitHub adapter 가 doc 디렉토리 commit 으로 확장).
   */
  specProposalBody?: string;

  /**
   * Planning plan_accept: slice DAG decomposition. cycle/missing 검증 후
   * writeAtomic + join condition 평가. RefactorBacklog promotion은 5c.
   */
  slicesToPersist?: readonly SliceT[];

  /**
   * Validation validation_fail: SLICE_READY 로 회수할 책임 slice id 목록.
   */
  responsibleSliceIds?: readonly string[];

  /**
   * Validation validation_pass: ContextSummary 본문.
   */
  contextSummaryInput?: SnapshotContextSummaryInput;
}

export type OuterDispatchResult =
  | { kind: "no_match"; detail: string }
  | { kind: "illegal_transition"; detail: string }
  | { kind: "applied"; effects: DispatchEffect[]; details: OuterDispatchDetail[] };

export type OuterDispatchDetail =
  | {
      effect: "promote_milestone_to_specification";
      milestone_state: "M_SPECIFICATION_DRAFT";
      spec_persisted_at: string | null;
    }
  | {
      effect: "promote_milestone_to_spec_approved";
      milestone_state: "M_SPEC_APPROVED";
    }
  | {
      effect: "park_milestone_awaiting_human";
      milestone_state:
        | "M_DISCOVERY_AWAITING_HUMAN"
        | "M_SPECIFICATION_AWAITING_HUMAN";
    }
  | {
      effect: "recover_milestone_to_draft";
      milestone_state: "M_DISCOVERY_DRAFT" | "M_SPECIFICATION_DRAFT";
    }
  | {
      effect: "persist_slice_dag_and_promote";
      milestone_state: "M_DELIVERY_BUILDING";
      slices_persisted: number;
      ready_slice_ids: readonly string[];
    }
  | { effect: "noop_planning_request_changes"; milestone_state: "M_DELIVERY_PLANNING" }
  | {
      effect: "finalize_milestone_done";
      milestone_state: "M_DONE";
      context_summary_id: string;
    }
  | {
      effect: "recover_milestone_to_building";
      milestone_state: "M_DELIVERY_BUILDING";
      recovered_slices: readonly string[];
      skipped_foreign_slices: readonly string[];
    }
  | {
      effect: "noop_validation_stale";
      milestone_state: "M_DELIVERY_VALIDATING";
    }
  | { effect: "escalate_milestone"; milestone_state: "M_ESCALATED" };

/**
 * Effect 별 허용 source state. 명시되지 않은 (effect, source) 조합은
 * `illegal_transition` 으로 거부된다.
 */
const ALLOWED_SOURCE_STATES: Record<string, ReadonlyArray<MilestoneState>> = {
  promote_milestone_to_specification: ["M_DISCOVERY_DRAFT"],
  promote_milestone_to_spec_approved: ["M_SPECIFICATION_DRAFT"],
  park_milestone_awaiting_human: [
    "M_DISCOVERY_DRAFT",
    "M_SPECIFICATION_DRAFT",
    // idempotent re-park (already AWAITING_HUMAN)
    "M_DISCOVERY_AWAITING_HUMAN",
    "M_SPECIFICATION_AWAITING_HUMAN",
  ],
  recover_milestone_to_draft: [
    "M_DISCOVERY_AWAITING_HUMAN",
    "M_SPECIFICATION_AWAITING_HUMAN",
    // idempotent re-draft
    "M_DISCOVERY_DRAFT",
    "M_SPECIFICATION_DRAFT",
  ],
  persist_slice_dag_and_promote: [
    "M_DELIVERY_PLANNING",
    // idempotent re-run after partial crash
    "M_DELIVERY_BUILDING",
  ],
  noop_planning_request_changes: ["M_DELIVERY_PLANNING"],
  finalize_milestone_done: [
    "M_DELIVERY_VALIDATING",
    // idempotent re-finalize
    "M_DONE",
  ],
  recover_milestone_to_building: [
    "M_DELIVERY_VALIDATING",
    // idempotent re-revert
    "M_DELIVERY_BUILDING",
  ],
  noop_validation_stale: ["M_DELIVERY_VALIDATING"],
  escalate_milestone: [
    // any non-terminal — explicit listing keeps the guard auditable.
    "M_INTAKE_QUEUED",
    "M_DISCOVERY_DRAFT",
    "M_DISCOVERY_AWAITING_HUMAN",
    "M_SPECIFICATION_DRAFT",
    "M_SPECIFICATION_AWAITING_HUMAN",
    "M_SPEC_APPROVED",
    "M_DELIVERY_PLANNING",
    "M_DELIVERY_BUILDING",
    "M_DELIVERY_VALIDATING",
    // idempotent re-escalate
    "M_ESCALATED",
  ],
};

export async function dispatchOuterOutcome(
  input: OuterDispatchInput,
  deps: OuterDispatchDeps,
): Promise<OuterDispatchResult> {
  const entry = lookupDispatch({
    parent_loop: input.parent_loop,
    phase_or_purpose: input.phase_or_purpose,
    session_state: input.session_state,
    final_verdict: input.final_verdict,
  });
  if (entry == null) {
    return {
      kind: "no_match",
      detail: `no DISPATCH_MATRIX entry for (loop=outer, purpose=${input.phase_or_purpose}, state=${input.session_state}, verdict=${input.final_verdict ?? "<null>"})`,
    };
  }

  // incident-7 P0 (PR #104 review): when the dispatched effect is
  // `persist_slice_dag_and_promote` but `slicesToPersist` is empty/missing,
  // refuse the dispatch as `no_match` rather than throwing. Throwing
  // propagates through `finalizeConvergedSession` → `runOneOuterTurn` → the
  // daemon top-level reject handler and exits the process. Returning
  // `no_match` lets `finalizeConvergedSession` emit an error ledger row and
  // surface a `dispatch_no_match` outcome — milestone stays in
  // M_DELIVERY_PLANNING for the next outer-coordinator cycle to retry.
  if (
    entry.effects.some((e) => e.kind === "persist_slice_dag_and_promote") &&
    (input.slicesToPersist == null || input.slicesToPersist.length === 0)
  ) {
    return {
      kind: "no_match",
      detail:
        "persist_slice_dag_and_promote: refusing to advance milestone with empty slice DAG (incident-7)",
    };
  }

  // PR #66 P0-1: take the milestone lock once and run every effect inside
  // it. Slice writes, Decision Log entries, Spec CP, and the milestone
  // state transition all observe the same lock.
  const milestonePath = layout.milestone(input.milestone.milestone_id);
  return deps.store.withFileLock(milestonePath, async () => {
    const fresh = await deps.store.readText(milestonePath);
    if (fresh == null) {
      return {
        kind: "illegal_transition",
        detail: `milestone ${input.milestone.milestone_id} disappeared mid-dispatch`,
      };
    }
    const live = Milestone.parse(JSON.parse(fresh));

    // PR #66 P0-2: validate source state for every effect before any
    // mutation. Refuse the dispatch if even one effect is illegal.
    for (const eff of entry.effects) {
      const allowed = ALLOWED_SOURCE_STATES[eff.kind];
      if (allowed == null) {
        return {
          kind: "illegal_transition",
          detail: `effect ${eff.kind} has no ALLOWED_SOURCE_STATES entry`,
        };
      }
      if (!allowed.includes(live.state)) {
        return {
          kind: "illegal_transition",
          detail: `effect ${eff.kind} not allowed from milestone state ${live.state}`,
        };
      }
    }

    const details: OuterDispatchDetail[] = [];
    for (const effect of entry.effects) {
      details.push(await runOuterEffect(effect, input, live, deps));
    }
    return { kind: "applied", effects: entry.effects, details };
  });
}

async function runOuterEffect(
  effect: DispatchEffect,
  input: OuterDispatchInput,
  liveMilestone: MilestoneT,
  deps: OuterDispatchDeps,
): Promise<OuterDispatchDetail> {
  switch (effect.kind) {
    case "promote_milestone_to_specification": {
      const specPersistedAt = await persistSpecProposal(input, deps);
      await transitionMilestoneInLock(
        liveMilestone,
        "M_SPECIFICATION_DRAFT",
        deps,
        {
          phase: "Discovery",
          sessionId: input.sessionId,
          finalVerdict: input.final_verdict,
        },
      );
      return {
        effect: "promote_milestone_to_specification",
        milestone_state: "M_SPECIFICATION_DRAFT",
        spec_persisted_at: specPersistedAt,
      };
    }
    case "promote_milestone_to_spec_approved": {
      await persistSpecProposal(input, deps);
      await transitionMilestoneInLock(liveMilestone, "M_SPEC_APPROVED", deps, {
        phase: "Specification",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
      });
      return {
        effect: "promote_milestone_to_spec_approved",
        milestone_state: "M_SPEC_APPROVED",
      };
    }
    case "park_milestone_awaiting_human": {
      const target: MilestoneState =
        input.phase_or_purpose === "Discovery"
          ? "M_DISCOVERY_AWAITING_HUMAN"
          : "M_SPECIFICATION_AWAITING_HUMAN";
      await transitionMilestoneInLock(liveMilestone, target, deps, {
        phase:
          input.phase_or_purpose === "Discovery"
            ? "Discovery"
            : "Specification",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
      });
      return {
        effect: "park_milestone_awaiting_human",
        milestone_state: target as
          | "M_DISCOVERY_AWAITING_HUMAN"
          | "M_SPECIFICATION_AWAITING_HUMAN",
      };
    }
    case "recover_milestone_to_draft": {
      const target: MilestoneState =
        input.phase_or_purpose === "Discovery"
          ? "M_DISCOVERY_DRAFT"
          : "M_SPECIFICATION_DRAFT";
      await transitionMilestoneInLock(liveMilestone, target, deps, {
        phase:
          input.phase_or_purpose === "Discovery"
            ? "Discovery"
            : "Specification",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
      });
      return {
        effect: "recover_milestone_to_draft",
        milestone_state: target as
          | "M_DISCOVERY_DRAFT"
          | "M_SPECIFICATION_DRAFT",
      };
    }
    case "persist_slice_dag_and_promote": {
      const slices = input.slicesToPersist ?? [];
      // incident-7 P0 (PR #104 review): the empty-slices case is rejected
      // upstream in `dispatchOuterOutcome` as `no_match` (returning a
      // structured error rather than throwing, so the daemon does not
      // crash). This branch is unreachable when slices is empty, but keep
      // a defensive invariant check that returns rather than throws.
      if (slices.length === 0) {
        throw new Error(
          "persist_slice_dag_and_promote: invariant violation — empty slice DAG should have been rejected upstream (incident-7)",
        );
      }
      const validation = validateSliceDag(slices);
      if (!validation.ok) {
        // Per SOC-SLICE-DEPENDENCIES Cycle Detection: lead contribution FAIL.
        // Caller should validate before invoking dispatch; throw to surface
        // the contract violation.
        throw new Error(
          `persist_slice_dag_and_promote: invalid DAG: ${JSON.stringify(validation.errors)}`,
        );
      }

      // 1. Write each slice atomically with state=SLICE_PENDING. Idempotent
      //    on retry — same slice_id rewrites are safe.
      for (const s of slices) {
        const pending = Slice.parse({
          ...s,
          state: "SLICE_PENDING",
          milestone_id: liveMilestone.milestone_id,
          updated_at: deps.clock.isoNow(),
        });
        await deps.store.writeAtomic(
          layout.slice(pending.slice_id),
          JSON.stringify(pending, null, 2),
        );
      }

      // 2. Compute initial join condition: blocks-free slices → SLICE_READY.
      const states = new Map<string, string>();
      for (const s of slices) states.set(s.slice_id, "SLICE_PENDING");
      const ready = computeReadySlices({ slices, states });
      const sliceById = new Map(slices.map((s) => [s.slice_id, s]));
      const readyIds: string[] = [];
      for (const id of ready) {
        const s = sliceById.get(id)!;
        const r = Slice.parse({
          ...s,
          state: "SLICE_READY",
          milestone_id: liveMilestone.milestone_id,
          updated_at: deps.clock.isoNow(),
        });
        await deps.store.writeAtomic(
          layout.slice(r.slice_id),
          JSON.stringify(r, null, 2),
        );
        readyIds.push(id);
      }

      // 3. Decision Log entry (KAC-DECISION-LOG / product_decision).
      await recordDecision(deps, {
        decision_kind: "product_decision",
        decision: `Planning accepted: ${slices.length} slice(s) decomposed`,
        rationale: `outer Planning plan_accept for milestone ${liveMilestone.milestone_id}`,
        affected_milestones: [liveMilestone.milestone_id],
        affected_slices: slices.map((s) => s.slice_id),
      });

      // 4. Milestone → M_DELIVERY_BUILDING.
      await transitionMilestoneInLock(
        liveMilestone,
        "M_DELIVERY_BUILDING",
        deps,
        {
          phase: "Planning",
          sessionId: input.sessionId,
          finalVerdict: input.final_verdict,
        },
      );
      return {
        effect: "persist_slice_dag_and_promote",
        milestone_state: "M_DELIVERY_BUILDING",
        slices_persisted: slices.length,
        ready_slice_ids: readyIds,
      };
    }
    case "noop_planning_request_changes": {
      // Keep state, emit ledger row for audit trail.
      await emitMilestoneLedgerRow(
        liveMilestone.state,
        liveMilestone,
        liveMilestone.state,
        deps,
        {
          phase: "Planning",
          sessionId: input.sessionId,
          finalVerdict: input.final_verdict,
          result: "noop",
        },
      );
      return {
        effect: "noop_planning_request_changes",
        milestone_state: "M_DELIVERY_PLANNING",
      };
    }
    case "finalize_milestone_done": {
      if (input.contextSummaryInput == null)
        throw new Error("finalize_milestone_done requires contextSummaryInput");
      const summary = await snapshotContextSummary(deps, {
        ...input.contextSummaryInput,
        milestone_id: liveMilestone.milestone_id,
      });
      await transitionMilestoneInLock(
        liveMilestone,
        "M_DONE",
        deps,
        {
          phase: "Validation",
          sessionId: input.sessionId,
          finalVerdict: input.final_verdict,
        },
        { context_summary_id: summary.summary_id },
      );
      return {
        effect: "finalize_milestone_done",
        milestone_state: "M_DONE",
        context_summary_id: summary.summary_id,
      };
    }
    case "recover_milestone_to_building": {
      // PR #66 P0-4 + P1-5 + P1-7 fix: revert any responsible slice that is
      // not already SLICE_READY (incl. SLICE_VALIDATED), filter foreign-
      // milestone slices, and lock each slice path for the read-modify-write.
      const recovered: string[] = [];
      const skipped: string[] = [];
      for (const sid of input.responsibleSliceIds ?? []) {
        const slicePath = layout.slice(sid);
        await deps.store.withFileLock(slicePath, async () => {
          const body = await deps.store.readText(slicePath);
          if (body == null) {
            skipped.push(sid);
            return;
          }
          const live = Slice.parse(JSON.parse(body));
          if (live.milestone_id !== liveMilestone.milestone_id) {
            // P1-5: refuse to revert slices that belong to another milestone.
            skipped.push(sid);
            return;
          }
          if (live.state === "SLICE_READY") return; // idempotent
          const reverted = Slice.parse({
            ...live,
            state: "SLICE_READY",
            current_session_id: null,
            updated_at: deps.clock.isoNow(),
          });
          await deps.store.writeAtomic(
            slicePath,
            JSON.stringify(reverted, null, 2),
          );
          recovered.push(sid);
        });
      }
      await transitionMilestoneInLock(
        liveMilestone,
        "M_DELIVERY_BUILDING",
        deps,
        {
          phase: "Validation",
          sessionId: input.sessionId,
          finalVerdict: input.final_verdict,
        },
      );
      return {
        effect: "recover_milestone_to_building",
        milestone_state: "M_DELIVERY_BUILDING",
        recovered_slices: recovered,
        skipped_foreign_slices: skipped,
      };
    }
    case "noop_validation_stale": {
      await emitMilestoneLedgerRow(
        liveMilestone.state,
        liveMilestone,
        liveMilestone.state,
        deps,
        {
          phase: "Validation",
          sessionId: input.sessionId,
          finalVerdict: input.final_verdict,
          result: "noop",
        },
      );
      return {
        effect: "noop_validation_stale",
        milestone_state: "M_DELIVERY_VALIDATING",
      };
    }
    case "escalate_milestone": {
      await transitionMilestoneInLock(liveMilestone, "M_ESCALATED", deps, {
        phase: phaseFor(input.phase_or_purpose),
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
        result: "escalated",
      });
      return {
        effect: "escalate_milestone",
        milestone_state: "M_ESCALATED",
      };
    }
    default:
      throw new Error(
        `caller-dispatch-outer: unknown outer effect kind=${(effect as { kind: string }).kind}`,
      );
  }
}

function phaseFor(
  purpose: OuterDispatchInput["phase_or_purpose"],
): "Discovery" | "Specification" | "Planning" | "Validation" {
  switch (purpose) {
    case "Discovery":
      return "Discovery";
    case "Specification":
      return "Specification";
    case "Planning":
      return "Planning";
    case "Validation":
      return "Validation";
  }
}

async function persistSpecProposal(
  input: OuterDispatchInput,
  deps: OuterDispatchDeps,
): Promise<string | null> {
  if (input.specProposalBody == null) return null;
  await deps.store.writeAtomic(
    layout.milestoneSpec(input.milestone.milestone_id),
    input.specProposalBody,
  );
  return deps.clock.isoNow();
}

/**
 * Caller MUST already hold `withFileLock(milestonePath)`. This helper does
 * not re-acquire the lock — it does the milestone read-state-write inline
 * so the caller can sequence side effects (slices, decisions, etc.) inside
 * the same critical section.
 *
 * PR #66 P0-3 fix: the ledger row is always emitted (even on idempotent
 * re-run where state is unchanged). The ledger's per_session_outcome
 * idempotency_key dedups duplicates as `result=duplicate` rather than
 * leaving an audit gap.
 */
async function transitionMilestoneInLock(
  liveMilestone: MilestoneT,
  toState: MilestoneState,
  deps: OuterDispatchDeps,
  ctx: {
    phase: "Discovery" | "Specification" | "Planning" | "Validation";
    sessionId: string;
    finalVerdict: string | null;
    result?: "applied" | "noop" | "escalated";
  },
  patch?: { context_summary_id?: string },
): Promise<MilestoneT> {
  const path = layout.milestone(liveMilestone.milestone_id);
  const fromState = liveMilestone.state;
  if (liveMilestone.state === toState && patch?.context_summary_id == null) {
    // Idempotent re-run. Skip writeAtomic (no content change) but still
    // emit the ledger row so the audit trail is complete.
    await emitMilestoneLedgerRow(fromState, liveMilestone, toState, deps, ctx);
    return liveMilestone;
  }
  const updated = Milestone.parse({
    ...liveMilestone,
    state: toState,
    context_summary_id:
      patch?.context_summary_id ?? liveMilestone.context_summary_id ?? null,
    updated_at: deps.clock.isoNow(),
  });
  await deps.store.writeAtomic(path, JSON.stringify(updated, null, 2));
  await emitMilestoneLedgerRow(fromState, updated, toState, deps, ctx);
  return updated;
}

async function emitMilestoneLedgerRow(
  fromState: MilestoneState,
  milestone: MilestoneT,
  toState: MilestoneState,
  deps: OuterDispatchDeps,
  ctx: {
    phase: "Discovery" | "Specification" | "Planning" | "Validation";
    sessionId: string;
    finalVerdict: string | null;
    result?: "applied" | "noop" | "escalated";
  },
): Promise<void> {
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: milestone.milestone_id,
    object_kind: "milestone",
    from_state: fromState,
    to_state: toState,
    loop_kind: "outer",
    phase: ctx.phase,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: ctx.sessionId,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "session_finalize",
    final_verdict: ctx.finalVerdict,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "per_session_outcome",
      parts: {
        session_id: ctx.sessionId,
        final_verdict: ctx.finalVerdict ?? "",
        finalization_decision: "composite",
        workspace_revision_pin_at_convergence: null,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: ctx.result ?? "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
}
