/**
 * incident-7 regression: when Planning convergence is triggered by a
 * reviewer's plan_accept verdict, the lead's `output_kind=slice_decomposition`
 * envelope (with `artifacts.slices`) lives at an earlier turn. The dispatch
 * input builder must recover those slices via session-turn scan rather than
 * relying solely on the converging envelope's artifacts.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { findSliceDecompositionSlices } from "../../src/application/outer-turn.js";
import { layout } from "../../src/application/persistence-layout.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const SLICE_A = "01HZ1000000000000000000000";
const SLICE_B = "01HZ2000000000000000000000";

function planningSliceFixture(sliceId: string, deps: string[] = []) {
  return {
    slice_id: sliceId,
    milestone_id: MILESTONE_ID,
    slice_kind: "internal",
    value_statement: `slice ${sliceId.slice(-2)}`,
    ac_ids: ["AC-1"],
    acceptance_tests: [{ path: "tests/x.test.ts", name: "x", ac_id: "AC-1" }],
    declared_scope: ["src/x.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: deps.map((d) => ({ slice_id: d, edge_type: "blocks" })),
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state: "SLICE_PENDING",
    current_session_id: null,
    spawning_proposal_id: null,
    abandoned_reason: null,
    external_refs: [],
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
  };
}

async function persistTurn(
  store: MemoryStore,
  turnIndex: number,
  envelope: Record<string, unknown>,
): Promise<void> {
  const body = {
    session_id: SESSION_ID,
    turn_index: turnIndex,
    agent_profile_id: envelope.agent_profile_id,
    input_manifest_id: null,
    input_turn_log_snapshot_ref: null,
    output_envelope: envelope,
    next_action_request: null,
    caller_routing_decision: {
      decision: "addressed",
      decision_reason: "test",
      resolved_addressed_to: null,
    },
  };
  await store.writeAtomic(
    layout.sessionTurn(SESSION_ID, turnIndex),
    JSON.stringify(body, null, 2),
  );
}

describe("findSliceDecompositionSlices (incident-7 fallback)", () => {
  it("recovers slices from an earlier lead turn when the most recent turn is a reviewer verdict", async () => {
    const store = new MemoryStore();
    // Turn 0: atlas (lead) emits slice_decomposition with two slices.
    await persistTurn(store, 0, {
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "Planning",
      agent_profile_id: "atlas",
      agent_role_in_session: "lead",
      manifest_id: "manifest-0",
      contribution_kind: "lead_draft",
      output_kind: "slice_decomposition",
      object_id: MILESTONE_ID,
      summary: "planning slice decomposition",
      artifacts: {
        slices: [
          planningSliceFixture(SLICE_A),
          planningSliceFixture(SLICE_B, [SLICE_A]),
        ],
      },
      verdict: null,
      next_action_request: null,
      failure: null,
    });
    // Turn 1: forge (reviewer) plan_accept — empty artifacts.
    await persistTurn(store, 1, {
      session_id: SESSION_ID,
      turn_index: 1,
      parent_loop: "outer",
      phase_or_purpose: "Planning",
      agent_profile_id: "forge",
      agent_role_in_session: "reviewer",
      manifest_id: "manifest-1",
      contribution_kind: "review_verdict",
      output_kind: "verdict",
      object_id: MILESTONE_ID,
      summary: "reviewer verdict=plan_accept",
      artifacts: null,
      verdict: { result: "plan_accept", rationale: null },
      next_action_request: null,
      failure: null,
    });
    // Turn 2: sentinel (reviewer) plan_accept — empty artifacts. This turn
    // triggers convergence in the production scenario.
    await persistTurn(store, 2, {
      session_id: SESSION_ID,
      turn_index: 2,
      parent_loop: "outer",
      phase_or_purpose: "Planning",
      agent_profile_id: "sentinel",
      agent_role_in_session: "reviewer",
      manifest_id: "manifest-2",
      contribution_kind: "review_verdict",
      output_kind: "verdict",
      object_id: MILESTONE_ID,
      summary: "reviewer verdict=plan_accept",
      artifacts: null,
      verdict: { result: "plan_accept", rationale: null },
      next_action_request: null,
      failure: null,
    });

    const slices = await findSliceDecompositionSlices(
      SESSION_ID,
      MILESTONE_ID,
      store,
    );
    expect(slices.length).toBe(2);
    expect(slices.map((s) => s.slice_id)).toEqual(
      expect.arrayContaining([SLICE_A, SLICE_B]),
    );
    // Slice A has no deps; B blocks on A.
    const a = slices.find((s) => s.slice_id === SLICE_A)!;
    const b = slices.find((s) => s.slice_id === SLICE_B)!;
    expect(a.dependencies).toEqual([]);
    expect(b.dependencies).toEqual([{ slice_id: SLICE_A, edge_type: "blocks" }]);
  });

  it("returns the most recent slice_decomposition when multiple exist", async () => {
    const store = new MemoryStore();
    await persistTurn(store, 0, {
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "Planning",
      agent_profile_id: "atlas",
      agent_role_in_session: "lead",
      manifest_id: "manifest-0",
      contribution_kind: "lead_draft",
      output_kind: "slice_decomposition",
      object_id: MILESTONE_ID,
      summary: "first draft",
      artifacts: { slices: [planningSliceFixture(SLICE_A)] },
      verdict: null,
      next_action_request: null,
      failure: null,
    });
    await persistTurn(store, 1, {
      session_id: SESSION_ID,
      turn_index: 1,
      parent_loop: "outer",
      phase_or_purpose: "Planning",
      agent_profile_id: "atlas",
      agent_role_in_session: "lead",
      manifest_id: "manifest-1",
      contribution_kind: "lead_draft",
      output_kind: "slice_decomposition",
      object_id: MILESTONE_ID,
      summary: "revised draft",
      artifacts: {
        slices: [
          planningSliceFixture(SLICE_A),
          planningSliceFixture(SLICE_B, [SLICE_A]),
        ],
      },
      verdict: null,
      next_action_request: null,
      failure: null,
    });

    const slices = await findSliceDecompositionSlices(
      SESSION_ID,
      MILESTONE_ID,
      store,
    );
    expect(slices.length).toBe(2);
  });

  it("returns empty when no slice_decomposition envelope exists", async () => {
    const store = new MemoryStore();
    await persistTurn(store, 0, {
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "Planning",
      agent_profile_id: "forge",
      agent_role_in_session: "reviewer",
      manifest_id: "manifest-0",
      contribution_kind: "review_verdict",
      output_kind: "verdict",
      object_id: MILESTONE_ID,
      summary: "reviewer verdict=request_changes",
      artifacts: null,
      verdict: { result: "request_changes", rationale: "x" },
      next_action_request: null,
      failure: null,
    });

    const slices = await findSliceDecompositionSlices(
      SESSION_ID,
      MILESTONE_ID,
      store,
    );
    expect(slices).toEqual([]);
  });

  it("returns empty when slice_decomposition exists but artifacts.slices is malformed", async () => {
    const store = new MemoryStore();
    await persistTurn(store, 0, {
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "Planning",
      agent_profile_id: "atlas",
      agent_role_in_session: "lead",
      manifest_id: "manifest-0",
      contribution_kind: "lead_draft",
      output_kind: "slice_decomposition",
      object_id: MILESTONE_ID,
      summary: "bogus draft",
      artifacts: { slices: "not-an-array" },
      verdict: null,
      next_action_request: null,
      failure: null,
    });

    const slices = await findSliceDecompositionSlices(
      SESSION_ID,
      MILESTONE_ID,
      store,
    );
    expect(slices).toEqual([]);
  });
});
