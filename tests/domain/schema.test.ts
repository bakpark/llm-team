import { describe, expect, it } from "vitest";
import { Lease, LeaseKind } from "../../src/domain/schema/lease.js";
import {
  LedgerObjectKind,
  LedgerResult,
  LedgerRow,
} from "../../src/domain/schema/ledger.js";
import { Milestone, MilestoneState } from "../../src/domain/schema/milestone.js";
import { Slice, SliceState } from "../../src/domain/schema/slice.js";
import {
  SliceMerge,
  SliceMergeState,
} from "../../src/domain/schema/slice-merge.js";

describe("MilestoneState", () => {
  it("includes all 11 states", () => {
    expect(MilestoneState.options.length).toBe(11);
    expect(MilestoneState.options).toContain("M_INTAKE_QUEUED");
    expect(MilestoneState.options).toContain("M_DONE");
    expect(MilestoneState.options).toContain("M_ESCALATED");
  });
});

describe("Milestone schema", () => {
  it("round-trips a minimal record", () => {
    const m = {
      milestone_id: "01HZ0",
      target_id: "demo",
      title: "first milestone",
      state: "M_INTAKE_QUEUED" as const,
      slot_kind: null,
      intake_source_kind: "human_seed",
      intake_source_id: "issue:1",
      spec_revision_pin: null,
      context_summary_id: null,
      external_refs: [],
      created_at: "2026-05-07T00:00:00Z",
      updated_at: "2026-05-07T00:00:00Z",
    };
    expect(Milestone.parse(m)).toEqual(m);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      Milestone.parse({
        milestone_id: "x",
        target_id: "y",
        title: "z",
        state: "M_INTAKE_QUEUED",
        slot_kind: null,
        intake_source_kind: "human_seed",
        intake_source_id: "issue:1",
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: "t",
        updated_at: "t",
        extra: "x",
      }),
    ).toThrow();
  });
});

describe("SliceState", () => {
  it("includes SLICE_INTEGRATING (gpt5.5 review fix)", () => {
    expect(SliceState.options).toContain("SLICE_INTEGRATING");
  });

  it("has exactly 7 states", () => {
    expect(SliceState.options.length).toBe(7);
  });
});

describe("Slice schema", () => {
  it("round-trips an internal slice", () => {
    const s = Slice.parse({
      slice_id: "01HZSLICE",
      milestone_id: "01HZM",
      slice_kind: "internal",
      value_statement: "tighten config validator",
      acceptance_tests: [],
      declared_scope: ["src/config"],
      interface_break: false,
      dependencies: [],
      trunk_base_revision: "abc",
      dod_revision_pin: "dod-1",
      state: "SLICE_READY",
      created_at: "t",
      updated_at: "t",
    });
    expect(s.ac_ids).toEqual([]);
    expect(s.declared_metric_threshold).toBeNull();
    expect(s.current_session_id).toBeNull();
  });

  it("supports declared_metric_threshold", () => {
    const s = Slice.parse({
      slice_id: "01HZSLICE",
      milestone_id: "01HZM",
      slice_kind: "internal",
      value_statement: "reduce complexity",
      acceptance_tests: [],
      declared_scope: ["src/"],
      declared_metric_threshold: {
        metric_name: "cyclomatic",
        comparator: "lte",
        value: 10,
      },
      interface_break: false,
      dependencies: [
        { slice_id: "01HZA", edge_type: "blocks" },
        { slice_id: "01HZB", edge_type: "coordinates_with" },
      ],
      trunk_base_revision: "abc",
      dod_revision_pin: "dod-1",
      state: "SLICE_PENDING",
      created_at: "t",
      updated_at: "t",
    });
    expect(s.declared_metric_threshold?.metric_name).toBe("cyclomatic");
    expect(s.dependencies.length).toBe(2);
  });
});

describe("SliceMergeState", () => {
  it("has exactly 7 states", () => {
    expect(SliceMergeState.options.length).toBe(7);
  });
});

describe("SliceMerge schema", () => {
  it("round-trips with all nullable fields null in SM_DRAFT", () => {
    const sm = SliceMerge.parse({
      slice_merge_id: "01HZSM",
      slice_id: "01HZSLICE",
      target_id: "demo",
      pre_merge_workspace_revision: null,
      merge_revision: null,
      inner_session_id: "01HZINNER",
      review_session_id: null,
      verification_run_id: null,
      state: "SM_DRAFT",
      merged_at: null,
      merged_by_caller_id: null,
      lease_token: null,
      created_at: "t",
      updated_at: "t",
    });
    expect(sm.audit_chain_predecessor_id).toBeNull();
    expect(sm.external_refs).toEqual([]);
  });
});

describe("Lease discriminated union", () => {
  it("parses each of the 4 lease kinds", () => {
    expect(LeaseKind.options.length).toBe(4);
    const slot = Lease.parse({
      kind: "slot_lock",
      lease_id: "L1",
      lease_token: "T1",
      target_id: "demo",
      worker_id: "w1",
      acquired_at: "t",
      expires_at: "t+1",
      ttl_ms: 1000,
      ttl_source: "by_lease_kind",
      slot_kind: "delivery",
    });
    if (slot.kind !== "slot_lock") throw new Error("type");
    expect(slot.slot_kind).toBe("delivery");

    const turn = Lease.parse({
      kind: "turn_lease",
      lease_id: "L2",
      lease_token: "T2",
      target_id: "demo",
      worker_id: "w1",
      acquired_at: "t",
      expires_at: "t+1",
      ttl_ms: 1000,
      ttl_source: "by_agent_profile",
      session_id: "S1",
      turn_index: 0,
      agent_profile_id: "forge",
    });
    if (turn.kind !== "turn_lease") throw new Error("type");
    expect(turn.agent_profile_id).toBe("forge");
  });

  it("rejects a slot_lock missing slot_kind", () => {
    expect(() =>
      Lease.parse({
        kind: "slot_lock",
        lease_id: "L",
        lease_token: "T",
        target_id: "x",
        worker_id: "w",
        acquired_at: "t",
        expires_at: "t",
        ttl_ms: 1,
        ttl_source: "by_lease_kind",
      }),
    ).toThrow();
  });
});

describe("LedgerRow schema", () => {
  it("round-trips a minimal row", () => {
    const row = LedgerRow.parse({
      transition_id: "01HZTX",
      target_id: "demo",
      object_id: "01HZM",
      object_kind: "milestone",
      from_state: null,
      to_state: "M_INTAKE_QUEUED",
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
      action_kind: "intake",
      final_verdict: null,
      caller_id: "caller-1",
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: "intake:human_seed:issue:1",
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: "2026-05-07T00:00:00Z",
      audit_hash: "0".repeat(64),
      audit_hash_prev: "0".repeat(64),
    });
    expect(row.action_kind).toBe("intake");
    expect(row.result).toBe("applied");
  });

  it("requires audit_hash to be 64-hex sha256", () => {
    expect(() =>
      LedgerRow.parse({
        transition_id: "x",
        target_id: "x",
        object_id: "x",
        object_kind: "milestone",
        from_state: null,
        to_state: "x",
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
        action_kind: "intake",
        final_verdict: null,
        caller_id: "c",
        manifest_id: null,
        input_revision_pins: [],
        output_hash: null,
        verification_run_id: null,
        metric_run_id: null,
        idempotency_key: "k",
        lease_token: null,
        lease_kind: null,
        result: "applied",
        result_detail: null,
        timestamp: "t",
        audit_hash: "not-hex",
        audit_hash_prev: "0".repeat(64),
      }),
    ).toThrow();
  });

  it("LedgerObjectKind covers 8 entities including system", () => {
    expect(LedgerObjectKind.options.length).toBe(8);
    expect(LedgerObjectKind.options).toContain("system");
  });

  it("LedgerResult includes all 10 result classes", () => {
    expect(LedgerResult.options.length).toBe(10);
    expect(LedgerResult.options).toContain("escalated");
    expect(LedgerResult.options).toContain("rolled_back");
  });
});
