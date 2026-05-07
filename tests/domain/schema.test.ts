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

const M_ID = "01HZM00000000000000000000A";
const M2_ID = "01HZM00000000000000000000B";
const S_ID = "01HZS00000000000000000000A";
const S2_ID = "01HZS00000000000000000000B";
const SM_ID = "01HZSM0000000000000000000A";
const TX_ID = "01HZTX0000000000000000000A";
const SESSION_ID = "01HZSE0000000000000000000A";
const ISO = "2026-05-07T00:00:00.000Z";

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
    const m = Milestone.parse({
      milestone_id: M_ID,
      target_id: "demo",
      title: "first milestone",
      state: "M_INTAKE_QUEUED",
      slot_kind: null,
      intake_source_kind: "human_seed",
      intake_source_id: "issue:1",
      spec_revision_pin: null,
      context_summary_id: null,
      external_refs: [],
      created_at: ISO,
      updated_at: ISO,
    });
    expect(m.milestone_id).toBe(M_ID);
  });

  it("rejects non-ULID milestone_id", () => {
    expect(() =>
      Milestone.parse({
        milestone_id: "not-a-ulid",
        target_id: "demo",
        title: "x",
        state: "M_INTAKE_QUEUED",
        slot_kind: null,
        intake_source_kind: "human_seed",
        intake_source_id: "issue:1",
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: ISO,
        updated_at: ISO,
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      Milestone.parse({
        milestone_id: M_ID,
        target_id: "demo",
        title: "x",
        state: "M_INTAKE_QUEUED",
        slot_kind: null,
        intake_source_kind: "human_seed",
        intake_source_id: "issue:1",
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: ISO,
        updated_at: ISO,
        extra: "x",
      }),
    ).toThrow();
  });
});

describe("SliceState", () => {
  it("includes SLICE_INTEGRATING", () => {
    expect(SliceState.options).toContain("SLICE_INTEGRATING");
  });

  it("has exactly 7 states", () => {
    expect(SliceState.options.length).toBe(7);
  });
});

describe("Slice schema", () => {
  it("round-trips an internal slice", () => {
    const s = Slice.parse({
      slice_id: S_ID,
      milestone_id: M_ID,
      slice_kind: "internal",
      value_statement: "tighten config validator",
      acceptance_tests: [],
      declared_scope: ["src/config"],
      interface_break: false,
      dependencies: [],
      trunk_base_revision: "abc",
      dod_revision_pin: "dod-1",
      state: "SLICE_READY",
      created_at: ISO,
      updated_at: ISO,
    });
    expect(s.ac_ids).toEqual([]);
    expect(s.declared_metric_threshold).toBeNull();
    expect(s.current_session_id).toBeNull();
  });

  it("supports declared_metric_threshold and dependencies", () => {
    const s = Slice.parse({
      slice_id: S_ID,
      milestone_id: M_ID,
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
        { slice_id: S2_ID, edge_type: "blocks" },
        { slice_id: M2_ID, edge_type: "coordinates_with" },
      ],
      trunk_base_revision: "abc",
      dod_revision_pin: "dod-1",
      state: "SLICE_PENDING",
      created_at: ISO,
      updated_at: ISO,
    });
    expect(s.declared_metric_threshold?.metric_name).toBe("cyclomatic");
    expect(s.dependencies.length).toBe(2);
  });

  it("rejects non-ISO datetimes", () => {
    expect(() =>
      Slice.parse({
        slice_id: S_ID,
        milestone_id: M_ID,
        slice_kind: "internal",
        value_statement: "x",
        acceptance_tests: [],
        declared_scope: [],
        interface_break: false,
        dependencies: [],
        trunk_base_revision: "abc",
        dod_revision_pin: "dod-1",
        state: "SLICE_READY",
        created_at: "not-iso",
        updated_at: ISO,
      }),
    ).toThrow();
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
      slice_merge_id: SM_ID,
      slice_id: S_ID,
      target_id: "demo",
      pre_merge_workspace_revision: null,
      merge_revision: null,
      inner_session_id: SESSION_ID,
      review_session_id: null,
      verification_run_id: null,
      state: "SM_DRAFT",
      merged_at: null,
      merged_by_caller_id: null,
      lease_token: null,
      created_at: ISO,
      updated_at: ISO,
    });
    expect(sm.audit_chain_predecessor_id).toBeNull();
    expect(sm.external_refs).toEqual([]);
  });
});

describe("Lease discriminated union (RGC-LEASE-KINDS)", () => {
  it("uses lease_kind as the discriminator, claimed_at, object_id", () => {
    expect(LeaseKind.options.length).toBe(4);
    const slot = Lease.parse({
      lease_kind: "slot_lock",
      lease_id: "01HZQ00000000000000000000A",
      lease_token: "T1",
      target_id: "demo",
      object_id: `${M_ID}:delivery`,
      worker_id: "w1",
      claimed_at: ISO,
      expires_at: ISO,
      ttl_ms: 1000,
      ttl_source: "by_lease_kind",
      slot_kind: "delivery",
      milestone_id: M_ID,
    });
    if (slot.lease_kind !== "slot_lock") throw new Error("type");
    expect(slot.slot_kind).toBe("delivery");
    expect(slot.object_id).toBe(`${M_ID}:delivery`);

    const turn = Lease.parse({
      lease_kind: "turn_lease",
      lease_id: "01HZQ00000000000000000000B",
      lease_token: "T2",
      target_id: "demo",
      object_id: `${SESSION_ID}:0`,
      worker_id: "w1",
      claimed_at: ISO,
      expires_at: ISO,
      ttl_ms: 1000,
      ttl_source: "by_agent_profile",
      session_id: SESSION_ID,
      turn_index: 0,
      agent_profile_id: "forge",
    });
    if (turn.lease_kind !== "turn_lease") throw new Error("type");
    expect(turn.agent_profile_id).toBe("forge");
  });

  it("rejects a slot_lock missing slot_kind", () => {
    expect(() =>
      Lease.parse({
        lease_kind: "slot_lock",
        lease_id: "01HZQ00000000000000000000C",
        lease_token: "T",
        target_id: "x",
        object_id: "x",
        worker_id: "w",
        claimed_at: ISO,
        expires_at: ISO,
        ttl_ms: 1,
        ttl_source: "by_lease_kind",
      }),
    ).toThrow();
  });

  it("rejects non-datetime claimed_at", () => {
    expect(() =>
      Lease.parse({
        lease_kind: "slice_lease",
        lease_id: "01HZQ00000000000000000000D",
        lease_token: "T",
        target_id: "x",
        object_id: S_ID,
        worker_id: "w",
        claimed_at: "yesterday",
        expires_at: ISO,
        ttl_ms: 1,
        ttl_source: "by_lease_kind",
        slice_id: S_ID,
      }),
    ).toThrow();
  });
});

describe("LedgerRow schema", () => {
  function baseLedger(
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      transition_id: TX_ID,
      target_id: "demo",
      object_id: M_ID,
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
      idempotency_key: "intake|kind=human_seed&id=issue:1",
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: ISO,
      audit_hash: "0".repeat(64),
      audit_hash_prev: "0".repeat(64),
      ...overrides,
    };
  }

  it("round-trips a minimal row", () => {
    const row = LedgerRow.parse(baseLedger());
    expect(row.action_kind).toBe("intake");
    expect(row.result).toBe("applied");
  });

  it("requires audit_hash to be 64-hex sha256", () => {
    expect(() => LedgerRow.parse(baseLedger({ audit_hash: "not-hex" }))).toThrow();
  });

  it("rejects non-ULID transition_id", () => {
    expect(() =>
      LedgerRow.parse(baseLedger({ transition_id: "not-a-ulid" })),
    ).toThrow();
  });

  it("rejects non-datetime timestamp", () => {
    expect(() =>
      LedgerRow.parse(baseLedger({ timestamp: "yesterday" })),
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
