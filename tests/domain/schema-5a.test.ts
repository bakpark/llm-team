import { describe, expect, it } from "vitest";
import {
  FeatureRequest,
  FeatureRequestState,
} from "../../src/domain/schema/feature-request.js";
import {
  HumanSignalEnvelope,
  HumanSignalRecord,
  SignalType,
} from "../../src/domain/schema/human-signal.js";
import {
  ContextSummary,
  DecisionEntry,
  DecisionKind,
  RefactorBacklogItem,
  RefactorBacklogState,
  SliceTelemetry,
} from "../../src/domain/schema/knowledge.js";

const ULID_A = "01HZA00000000000000000000A";
const ULID_B = "01HZB00000000000000000000B";
const ULID_C = "01HZC00000000000000000000C";
const ULID_M = "01HZM00000000000000000000A";
const ULID_S = "01HZS00000000000000000000A";
const ULID_F = "01HZF00000000000000000000A";
const ISO = "2026-05-08T00:00:00.000Z";
const SHA = "a".repeat(64);

describe("DecisionKind", () => {
  it("has all 6 kinds from KAC-DECISION-LOG", () => {
    expect(DecisionKind.options).toEqual([
      "product_decision",
      "refactor",
      "spike_finding",
      "architectural_debt",
      "cross_milestone_amendment",
      "acceptance_test_amendment",
    ]);
  });
});

describe("DecisionEntry schema", () => {
  it("round-trips a minimal record", () => {
    const d = DecisionEntry.parse({
      decision_id: ULID_A,
      decision_kind: "product_decision",
      decision: "single retry only",
      rationale: "infinite loop risk",
      decided_at: ISO,
      audit_hash: SHA,
    });
    expect(d.alternatives).toEqual([]);
    expect(d.affected_milestones).toEqual([]);
    expect(d.supersedes).toBeNull();
  });

  it("rejects bad audit_hash", () => {
    expect(() =>
      DecisionEntry.parse({
        decision_id: ULID_A,
        decision_kind: "refactor",
        decision: "x",
        rationale: "y",
        decided_at: ISO,
        audit_hash: "short",
      }),
    ).toThrow();
  });
});

describe("ContextSummary schema", () => {
  it("round-trips a Validation-pass output", () => {
    const cs = ContextSummary.parse({
      summary_id: ULID_B,
      milestone_id: ULID_M,
      user_value: "users can add",
      behavior_changes: ["new add() endpoint"],
      decisions_to_preserve: [ULID_A],
      risks: ["overflow"],
      slices: [
        {
          slice_id: ULID_S,
          slice_kind: "feature",
          validated_revision: "v1",
          ac_ids: ["AC-1"],
        },
      ],
      generated_at: ISO,
      audit_hash: SHA,
    });
    expect(cs.slices.length).toBe(1);
    expect(cs.architectural_debt_indicators).toEqual([]);
  });
});

describe("RefactorBacklog 6-state lifecycle", () => {
  it("includes all 6 states", () => {
    expect(RefactorBacklogState.options).toEqual([
      "PROPOSED",
      "CURATED",
      "SCHEDULED",
      "DONE",
      "DROPPED",
      "SUPERSEDED",
    ]);
  });

  it("round-trips a PROPOSED item", () => {
    const r = RefactorBacklogItem.parse({
      proposal_id: ULID_C,
      proposed_at: ISO,
      proposed_by: "scout",
      state: "PROPOSED",
      scope: "src/foo.ts",
      suggested_refactor: "extract helper",
      rationale: "cyclomatic complexity 18",
      code_location: "src/foo.ts",
      updated_at: ISO,
      audit_hash: SHA,
    });
    expect(r.state).toBe("PROPOSED");
    expect(r.spawning_slice_id).toBeNull();
    expect(r.metric_target).toBeNull();
  });
});

describe("SliceTelemetry schema", () => {
  it("round-trips with empty arrays", () => {
    const t = SliceTelemetry.parse({
      telemetry_id: ULID_A,
      milestone_id: ULID_M,
      generated_at: ISO,
      audit_hash: SHA,
    });
    expect(t.in_progress_slices).toEqual([]);
    expect(t.validated_slices).toEqual([]);
  });
});

describe("HumanSignal envelope", () => {
  it("has all 11 signal types from RGC-SIGNALS", () => {
    expect(SignalType.options.length).toBe(11);
    for (const t of [
      "approve",
      "reject",
      "request_rework",
      "request_recover",
      "pause",
      "resume",
      "amendment_approve",
      "cross_milestone_amendment",
      "acceptance_test_rename",
      "purge_acceptance_tests",
      "stop",
    ]) {
      expect(SignalType.options).toContain(t);
    }
  });

  it("round-trips an approve envelope", () => {
    const env = HumanSignalEnvelope.parse({
      signal_id: "sig-001",
      signal_type: "approve",
      target_kind: "milestone",
      target_id: ULID_M,
      actor: "alice",
      created_at: ISO,
      source: "fs_drop",
    });
    expect(env.target_revision_pin).toBeNull();
    expect(env.related_object_id).toBeNull();
  });

  it("HumanSignalRecord wraps envelope with processing state", () => {
    const rec = HumanSignalRecord.parse({
      envelope: {
        signal_id: "sig-001",
        signal_type: "reject",
        target_kind: "milestone",
        target_id: ULID_M,
        actor: "alice",
        created_at: ISO,
        source: "fs_drop",
      },
      processing_state: "pending",
    });
    expect(rec.processing_state).toBe("pending");
    expect(rec.applied_at).toBeNull();
  });
});

describe("FeatureRequest schema", () => {
  it("has 3 states", () => {
    expect(FeatureRequestState.options).toEqual([
      "queued",
      "promoted",
      "rejected",
    ]);
  });

  it("round-trips a queued request", () => {
    const fr = FeatureRequest.parse({
      request_id: ULID_F,
      title: "support add",
      submitted_by: "alice",
      submitted_at: ISO,
      state: "queued",
    });
    expect(fr.body).toBe("");
    expect(fr.promoted_milestone_id).toBeNull();
  });
});
