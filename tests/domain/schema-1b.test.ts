import { describe, expect, it } from "vitest";
import { DialogueSession, SessionState } from "../../src/domain/schema/dialogue-session.js";
import {
  AgentAuthoredEnvelope,
  Envelope,
} from "../../src/domain/schema/envelope.js";
import { ContextManifest, FetchScope } from "../../src/domain/schema/manifest.js";
import { SessionTurn } from "../../src/domain/schema/session-turn.js";
import {
  MetricRun,
  VerificationRun,
} from "../../src/domain/schema/verification.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const MANIFEST_ID = "01HZMA0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const VRUN_ID = "01HZV00000000000000000000A";
const MRUN_ID = "01HZK00000000000000000000A";
const ISO = "2026-05-07T00:00:00.000Z";

describe("ContextManifest schema (AGC-CONTEXT-MANIFEST)", () => {
  it("round-trips a minimal manifest", () => {
    const m = ContextManifest.parse({
      manifest_id: MANIFEST_ID,
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      entries: [
        {
          object_kind: "slice",
          object_id: SLICE_ID,
          fetch_scope: "body",
          revision_pin: "abc1234",
          required: true,
          purpose: "primary input",
        },
      ],
      created_at: ISO,
    });
    expect(m.entries.length).toBe(1);
  });

  it("rejects unknown fetch_scope", () => {
    expect(() => FetchScope.parse("body+everything")).toThrow();
  });

  it("rejects non-ULID manifest_id", () => {
    expect(() =>
      ContextManifest.parse({
        manifest_id: "not-a-ulid",
        session_id: SESSION_ID,
        turn_index: 0,
        purpose: "tdd_build",
        target: { object_kind: "slice", object_id: SLICE_ID },
        entries: [],
        created_at: ISO,
      }),
    ).toThrow();
  });

  it("rejects unknown extra keys", () => {
    expect(() =>
      ContextManifest.parse({
        manifest_id: MANIFEST_ID,
        session_id: SESSION_ID,
        turn_index: 0,
        purpose: "tdd_build",
        target: { object_kind: "slice", object_id: SLICE_ID },
        entries: [],
        created_at: ISO,
        extra: "x",
      }),
    ).toThrow();
  });
});

describe("DialogueSession schema (SOC-SESSION-LIFECYCLE)", () => {
  it("has all 5 states", () => {
    expect(SessionState.options.length).toBe(5);
    expect(SessionState.options).toContain("AWAITING_REVALIDATION");
  });

  it("round-trips an inner tdd_build session", () => {
    const s = DialogueSession.parse({
      session_id: SESSION_ID,
      parent_object_kind: "slice",
      parent_object_id: SLICE_ID,
      parent_loop: "inner",
      purpose: "tdd_build",
      participants: [{ agent_profile_id: "forge", role: "lead" }],
      session_termination: {
        finalization_rule: "lead_only",
        required_evidence: [
          {
            kind: "verification_green",
            acceptance_tests: ["tests/foo.test.ts:bar"],
            deterministic_checks: ["typecheck"],
          },
        ],
        composite_rule: "evidence_only",
      },
      workspace_revision_pin: "abc1234",
      current_turn_index: 0,
      state: "SESSION_OPEN",
      max_turns: 10,
      created_at: ISO,
      updated_at: ISO,
    });
    expect(s.spawned_contribution_id).toBeNull();
    expect(s.session_termination.required_evidence.length).toBe(1);
  });

  it("rejects empty participants", () => {
    expect(() =>
      DialogueSession.parse({
        session_id: SESSION_ID,
        parent_object_kind: "slice",
        parent_object_id: SLICE_ID,
        parent_loop: "inner",
        purpose: "tdd_build",
        participants: [],
        session_termination: {
          finalization_rule: "lead_only",
          required_evidence: [],
          composite_rule: "evidence_only",
        },
        workspace_revision_pin: "abc1234",
        current_turn_index: 0,
        state: "SESSION_OPEN",
        max_turns: 10,
        created_at: ISO,
        updated_at: ISO,
      }),
    ).toThrow();
  });
});

describe("AgentAuthoredEnvelope (AGC-OUTPUT pre-enrichment)", () => {
  function baseAgent(
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "inner",
      phase_or_purpose: "tdd_build",
      slice_id: SLICE_ID,
      slice_kind: "internal",
      tdd_phase: "red_green",
      agent_profile_id: "forge",
      agent_role_in_session: "lead",
      contribution_kind: "lead_draft",
      output_kind: "patch",
      object_id: SLICE_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc1234"],
      summary: "first turn",
      ...overrides,
    };
  }

  it("round-trips a minimal envelope", () => {
    const e = AgentAuthoredEnvelope.parse(baseAgent());
    expect(e.verdict).toBeNull();
    expect(e.failure).toBeNull();
  });

  it("strips strict — rejects idempotency_key (caller-only)", () => {
    expect(() =>
      AgentAuthoredEnvelope.parse(baseAgent({ idempotency_key: "x" })),
    ).toThrow();
  });

  it("strips strict — rejects runtime_metadata (caller-only)", () => {
    expect(() =>
      AgentAuthoredEnvelope.parse(baseAgent({ runtime_metadata: {} })),
    ).toThrow();
  });

  it("rejects non-ULID session_id", () => {
    expect(() =>
      AgentAuthoredEnvelope.parse(baseAgent({ session_id: "not-ulid" })),
    ).toThrow();
  });
});

describe("Envelope (AGC-OUTPUT canonical)", () => {
  it("round-trips canonical envelope with caller-enriched fields", () => {
    const e = Envelope.parse({
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "inner",
      phase_or_purpose: "tdd_build",
      slice_id: SLICE_ID,
      slice_kind: "internal",
      tdd_phase: "red_green",
      agent_profile_id: "forge",
      agent_role_in_session: "lead",
      contribution_kind: "lead_draft",
      output_kind: "patch",
      object_id: SLICE_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc1234"],
      summary: "first turn",
      idempotency_key: "scope=per_turn|sid=01HZSE0000000000000000000A|t=0|profile=forge|kind=lead_draft",
      runtime_metadata: { workspace_commit: "deadbeef" },
    });
    expect(e.idempotency_key.length).toBeGreaterThan(0);
    expect(e.runtime_metadata).toEqual({ workspace_commit: "deadbeef" });
  });
});

describe("SessionTurn schema", () => {
  it("round-trips with embedded canonical envelope", () => {
    const turn = SessionTurn.parse({
      session_id: SESSION_ID,
      turn_index: 0,
      agent_profile_id: "forge",
      input_manifest_id: MANIFEST_ID,
      output_envelope: {
        session_id: SESSION_ID,
        turn_index: 0,
        parent_loop: "inner",
        phase_or_purpose: "tdd_build",
        slice_id: SLICE_ID,
        slice_kind: "internal",
        tdd_phase: "red_green",
        agent_profile_id: "forge",
        agent_role_in_session: "lead",
        contribution_kind: "lead_draft",
        output_kind: "patch",
        object_id: SLICE_ID,
        manifest_id: MANIFEST_ID,
        input_revision_pins: ["abc1234"],
        summary: "first turn",
        idempotency_key: "k1",
        runtime_metadata: {},
      },
      caller_routing_decision: {
        decision: "dropped",
        decision_reason: "single-agent inner session, no next_action_request",
        resolved_addressed_to: null,
      },
      workspace_commit: "deadbeef",
      verification_result_ref: VRUN_ID,
      recorded_at: ISO,
    });
    expect(turn.caller_routing_decision?.decision).toBe("dropped");
  });
});

describe("VerificationRun + MetricRun schemas (RGC-VERIFICATION)", () => {
  it("VerificationRun round-trip", () => {
    const v = VerificationRun.parse({
      verification_run_id: VRUN_ID,
      target_id: "demo",
      target_revision: "deadbeef",
      commands_or_checks: ["npm test", "npm run typecheck"],
      environment_fingerprint: "node20-vitest2",
      started_at: ISO,
      finished_at: ISO,
      result: "fail",
      failed_tests: [
        { path: "tests/foo.test.ts", name: "should bar", message: "expected 1, got 2" },
      ],
    });
    expect(v.failed_tests.length).toBe(1);
    expect(v.log_ref).toBeNull();
  });

  it("MetricRun round-trip", () => {
    const m = MetricRun.parse({
      metric_run_id: MRUN_ID,
      target_id: "demo",
      metric_name: "cyclomatic",
      target_revision: "deadbeef",
      value: 8,
      comparator: "lte",
      threshold: 10,
      result: "met",
      started_at: ISO,
      finished_at: ISO,
    });
    expect(m.result).toBe("met");
  });

  it("rejects invalid result enum", () => {
    expect(() =>
      VerificationRun.parse({
        verification_run_id: VRUN_ID,
        target_id: "demo",
        target_revision: "deadbeef",
        commands_or_checks: [],
        environment_fingerprint: "x",
        started_at: ISO,
        finished_at: ISO,
        result: "skipped",
      }),
    ).toThrow();
  });
});
