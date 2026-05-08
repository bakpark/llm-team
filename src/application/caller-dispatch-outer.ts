/**
 * SOC-DISPATCH-MATRIX outer-loop effect executor (Phase 5b.1).
 *
 * Slice-anchored effects (inner / middle review) live in
 * `caller-dispatch.ts`. Milestone-anchored outer-loop effects live here:
 *
 *   - promote_milestone_to_specification        Discovery spec_accept
 *   - promote_milestone_to_spec_approved        Specification spec_accept
 *   - park_milestone_awaiting_human             Discovery/Specification spec_reject
 *   - recover_milestone_to_draft                Discovery/Specification TIMEOUT/ABANDONED
 *   - persist_slice_dag_and_promote             Planning plan_accept
 *   - noop_planning_request_changes             Planning request_changes
 *   - finalize_milestone_done                   Validation validation_pass
 *   - recover_milestone_to_building             Validation validation_fail
 *   - noop_validation_stale                     Validation validation_stale
 *   - escalate_milestone                        Validation TIMEOUT/ABANDONED
 *
 * 본 모듈은 store/ledger 만 다루며 LLM 호출이나 manifest 빌드는 하지 않는다.
 * dialogue-coordinator 가 outer session 종착 시점에 invoke 한다.
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
    | "design_discovery"
    | "design_specification"
    | "planning_decompose"
    | "validation";
  session_state: "CONVERGED" | "TIMEOUT" | "ABANDONED";
  final_verdict: string | null;
  milestone: MilestoneT;
  sessionId: string;

  /**
   * Discovery / Specification: Spec CP body (markdown / canonical text).
   * Persisted under milestones/<id>/spec.json (5b.1 minimal — phase 6b 의
   * GitHub adapter 가 doc 디렉토리 commit 으로 확장).
   */
  specProposalBody?: string;

  /**
   * Planning plan_accept: slice DAG decomposition. cycle/missing 검증 후
   * writeAtomic + join condition 평가. Caller 는 RefactorBacklog 의 CURATED →
   * SCHEDULED + internal slice promotion 도 함께 수행한다 (5c).
   */
  slicesToPersist?: readonly SliceT[];

  /**
   * Validation validation_fail: SLICE_READY 로 회수할 책임 slice id 목록.
   */
  responsibleSliceIds?: readonly string[];

  /**
   * Validation validation_pass: ContextSummary 본문 (Caller 가 lead artifact
   * 를 후처리해 만든 것 — 5b.1 은 단순 echo).
   */
  contextSummaryInput?: SnapshotContextSummaryInput;
}

export type OuterDispatchResult =
  | { kind: "no_match"; detail: string }
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
    }
  | {
      effect: "noop_validation_stale";
      milestone_state: "M_DELIVERY_VALIDATING";
    }
  | { effect: "escalate_milestone"; milestone_state: "M_ESCALATED" };

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
  const details: OuterDispatchDetail[] = [];
  for (const effect of entry.effects) {
    details.push(await runOuterEffect(effect, input, deps));
  }
  return { kind: "applied", effects: entry.effects, details };
}

async function runOuterEffect(
  effect: DispatchEffect,
  input: OuterDispatchInput,
  deps: OuterDispatchDeps,
): Promise<OuterDispatchDetail> {
  switch (effect.kind) {
    case "promote_milestone_to_specification": {
      const specPersistedAt = await persistSpecProposal(input, deps);
      await transitionMilestone(input.milestone, "M_SPECIFICATION_DRAFT", deps, {
        phase: "Discovery",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
      });
      return {
        effect: "promote_milestone_to_specification",
        milestone_state: "M_SPECIFICATION_DRAFT",
        spec_persisted_at: specPersistedAt,
      };
    }
    case "promote_milestone_to_spec_approved": {
      await persistSpecProposal(input, deps);
      await transitionMilestone(input.milestone, "M_SPEC_APPROVED", deps, {
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
        input.phase_or_purpose === "design_discovery"
          ? "M_DISCOVERY_AWAITING_HUMAN"
          : "M_SPECIFICATION_AWAITING_HUMAN";
      await transitionMilestone(input.milestone, target, deps, {
        phase:
          input.phase_or_purpose === "design_discovery"
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
        input.phase_or_purpose === "design_discovery"
          ? "M_DISCOVERY_DRAFT"
          : "M_SPECIFICATION_DRAFT";
      await transitionMilestone(input.milestone, target, deps, {
        phase:
          input.phase_or_purpose === "design_discovery"
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
      const validation = validateSliceDag(slices);
      if (!validation.ok) {
        // Per SOC-SLICE-DEPENDENCIES Cycle Detection: lead contribution FAIL.
        // Caller routes back to request_changes — but the lookup already
        // routed us to this effect. Refuse the dispatch by throwing; the
        // coordinator should validate before invoking dispatch.
        throw new Error(
          `persist_slice_dag_and_promote: invalid DAG: ${JSON.stringify(validation.errors)}`,
        );
      }

      // 1. Write each slice atomically with state=SLICE_PENDING.
      for (const s of slices) {
        const pending = Slice.parse({
          ...s,
          state: "SLICE_PENDING",
          milestone_id: input.milestone.milestone_id,
          updated_at: deps.clock.isoNow(),
        });
        await deps.store.writeAtomic(
          layout.slice(pending.slice_id),
          JSON.stringify(pending, null, 2),
        );
      }

      // 2. Compute initial join condition: any slice with no `blocks` deps
      //    (or already-SLICE_VALIDATED deps, which can't happen for fresh
      //    slices) is promoted SLICE_PENDING → SLICE_READY.
      const states = new Map<string, string>();
      for (const s of slices) states.set(s.slice_id, "SLICE_PENDING");
      const ready = computeReadySlices({ slices, states });
      const readyIds: string[] = [];
      for (const id of ready) {
        const s = slices.find((x) => x.slice_id === id)!;
        const r = Slice.parse({
          ...s,
          state: "SLICE_READY",
          milestone_id: input.milestone.milestone_id,
          updated_at: deps.clock.isoNow(),
        });
        await deps.store.writeAtomic(
          layout.slice(r.slice_id),
          JSON.stringify(r, null, 2),
        );
        readyIds.push(id);
      }

      // 3. Persist Decision Log entry (KAC-DECISION-LOG / product_decision).
      await recordDecision(deps, {
        decision_kind: "product_decision",
        decision: `Planning accepted: ${slices.length} slice(s) decomposed`,
        rationale: `outer Planning plan_accept for milestone ${input.milestone.milestone_id}`,
        affected_milestones: [input.milestone.milestone_id],
        affected_slices: slices.map((s) => s.slice_id),
      });

      // 4. Milestone → M_DELIVERY_BUILDING.
      await transitionMilestone(input.milestone, "M_DELIVERY_BUILDING", deps, {
        phase: "Planning",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
      });
      return {
        effect: "persist_slice_dag_and_promote",
        milestone_state: "M_DELIVERY_BUILDING",
        slices_persisted: slices.length,
        ready_slice_ids: readyIds,
      };
    }
    case "noop_planning_request_changes": {
      // No state change — emit a ledger row so audit trail exists.
      await emitOuterLedgerRow(input.milestone, "M_DELIVERY_PLANNING", deps, {
        phase: "Planning",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
        result: "noop",
      });
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
        milestone_id: input.milestone.milestone_id,
      });
      await transitionMilestone(
        input.milestone,
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
      const recovered: string[] = [];
      for (const sid of input.responsibleSliceIds ?? []) {
        const path = layout.slice(sid);
        const body = await deps.store.readText(path);
        if (body == null) continue;
        const live = Slice.parse(JSON.parse(body));
        if (
          live.state !== "SLICE_VALIDATED" &&
          live.state !== "SLICE_READY"
        ) {
          const reverted = Slice.parse({
            ...live,
            state: "SLICE_READY",
            current_session_id: null,
            updated_at: deps.clock.isoNow(),
          });
          await deps.store.writeAtomic(path, JSON.stringify(reverted, null, 2));
          recovered.push(sid);
        }
      }
      await transitionMilestone(input.milestone, "M_DELIVERY_BUILDING", deps, {
        phase: "Validation",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
      });
      return {
        effect: "recover_milestone_to_building",
        milestone_state: "M_DELIVERY_BUILDING",
        recovered_slices: recovered,
      };
    }
    case "noop_validation_stale": {
      await emitOuterLedgerRow(input.milestone, "M_DELIVERY_VALIDATING", deps, {
        phase: "Validation",
        sessionId: input.sessionId,
        finalVerdict: input.final_verdict,
        result: "noop",
      });
      return {
        effect: "noop_validation_stale",
        milestone_state: "M_DELIVERY_VALIDATING",
      };
    }
    case "escalate_milestone": {
      await transitionMilestone(input.milestone, "M_ESCALATED", deps, {
        phase:
          input.phase_or_purpose === "validation" ? "Validation" : "Planning",
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

async function persistSpecProposal(
  input: OuterDispatchInput,
  deps: OuterDispatchDeps,
): Promise<string | null> {
  if (input.specProposalBody == null) return null;
  const path = `milestones/${input.milestone.milestone_id}/spec.md`;
  await deps.store.writeAtomic(path, input.specProposalBody);
  return deps.clock.isoNow();
}

async function transitionMilestone(
  milestone: MilestoneT,
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
  const path = layout.milestone(milestone.milestone_id);
  return deps.store.withFileLock(path, async () => {
    const fresh = await deps.store.readText(path);
    if (fresh == null)
      throw new Error(
        `milestone ${milestone.milestone_id} disappeared mid-dispatch`,
      );
    const live = Milestone.parse(JSON.parse(fresh));
    if (live.state === toState) return live; // idempotent
    const updated = Milestone.parse({
      ...live,
      state: toState,
      context_summary_id:
        patch?.context_summary_id ?? live.context_summary_id ?? null,
      updated_at: deps.clock.isoNow(),
    });
    await deps.store.writeAtomic(path, JSON.stringify(updated, null, 2));
    await emitMilestoneLedgerRow(live.state, updated, toState, deps, ctx);
    return updated;
  });
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

async function emitOuterLedgerRow(
  milestone: MilestoneT,
  state: MilestoneState,
  deps: OuterDispatchDeps,
  ctx: {
    phase: "Discovery" | "Specification" | "Planning" | "Validation";
    sessionId: string;
    finalVerdict: string | null;
    result?: "applied" | "noop";
  },
): Promise<void> {
  await emitMilestoneLedgerRow(state, milestone, state, deps, ctx);
}
