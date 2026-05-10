import { describe, expect, it } from "vitest";
import {
  AgentCapabilityPolicy,
  defaultLeadCapabilityPolicy,
  defaultReviewerCapabilityPolicy,
  isCapabilityStrippedEnvKey,
} from "../../src/domain/schema/agent-capability-policy.js";
import { AgentRunReceipt } from "../../src/domain/schema/agent-run-receipt.js";
import { LeadIntent } from "../../src/domain/schema/lead-intent.js";
import {
  LedgerActionKind,
  LedgerRow,
} from "../../src/domain/schema/ledger.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { ReviewSurface } from "../../src/domain/schema/review-surface.js";
import { ReviewerIntent } from "../../src/domain/schema/reviewer-intent.js";
import { SessionTurn } from "../../src/domain/schema/session-turn.js";
import { Slice } from "../../src/domain/schema/slice.js";

const ULID_A = "01HZA00000000000000000000A";
const ULID_B = "01HZB00000000000000000000A";
const ULID_C = "01HZC00000000000000000000A";
const ULID_D = "01HZD00000000000000000000A";
const ULID_M = "01HZM00000000000000000000A";
const ULID_S = "01HZS00000000000000000000A";
const ULID_SE = "01HZSE0000000000000000000A";
const ULID_MAN = "01HZMN0000000000000000000A";
const ISO = "2026-05-10T00:00:00.000Z";
const HASH = "0".repeat(64);

describe("AgentCapabilityPolicy", () => {
  it("parses lead default policy", () => {
    const p = defaultLeadCapabilityPolicy("/tmp/jail");
    const parsed = AgentCapabilityPolicy.parse(p);
    expect(parsed.read.mode).toBe("scoped");
    expect(parsed.edit.mode).toBe("scoped");
    expect(parsed.bash.mode).toBe("deny");
    expect(parsed.network).toBe("deny");
  });

  it("parses reviewer default policy with edit=deny", () => {
    const p = defaultReviewerCapabilityPolicy("/tmp/jail");
    const parsed = AgentCapabilityPolicy.parse(p);
    expect(parsed.edit.mode).toBe("deny");
    expect(parsed.read.mode).toBe("scoped");
  });

  it("identifies L3 stripped env keys", () => {
    expect(isCapabilityStrippedEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isCapabilityStrippedEnvKey("GH_TOKEN")).toBe(true);
    expect(isCapabilityStrippedEnvKey("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(isCapabilityStrippedEnvKey("LLM_TEAM_MACHINE_BLOCK_SECRET")).toBe(true);
    expect(isCapabilityStrippedEnvKey("LLM_TEAM_FOO_SECRET")).toBe(true);
    expect(isCapabilityStrippedEnvKey("MY_API_SECRET")).toBe(true);
    expect(isCapabilityStrippedEnvKey("PATH")).toBe(false);
    expect(isCapabilityStrippedEnvKey("HOME")).toBe(false);
  });
});

describe("ReviewSurface schema", () => {
  const baseSurface = {
    review_surface_id: ULID_A,
    parent_kind: "slice" as const,
    parent_id: ULID_S,
    parent_phase: null,
    pr_ref: {
      provider: "fs_mirror" as const,
      id: "1",
      node_id: null,
      url: "https://example/pr/1",
    },
    branch: "slice/abc",
    base_ref: "main",
    head_sha: "deadbeef",
    review_round: 0,
    lifecycle_state: "open" as const,
    review_state: "pending_review" as const,
    build_state: "ready" as const,
    latest_verification_run_id: null,
    last_synced_external_revision: null,
    created_at: ISO,
    updated_at: ISO,
  };

  it("parses each parent_kind (slice/milestone/spec_doc) round-trip", () => {
    expect(ReviewSurface.parse(baseSurface).parent_kind).toBe("slice");
    expect(
      ReviewSurface.parse({
        ...baseSurface,
        parent_kind: "milestone",
        parent_id: ULID_M,
        parent_phase: "Discovery",
      }).parent_kind,
    ).toBe("milestone");
    expect(
      ReviewSurface.parse({
        ...baseSurface,
        parent_kind: "spec_doc",
        parent_id: ULID_B,
        parent_phase: null,
      }).parent_kind,
    ).toBe("spec_doc");
  });

  it("requires parent_phase when parent_kind=milestone", () => {
    expect(() =>
      ReviewSurface.parse({
        ...baseSurface,
        parent_kind: "milestone",
        parent_id: ULID_M,
        parent_phase: null,
      }),
    ).toThrow(/parent_phase required/);
  });

  it("rejects parent_phase when parent_kind != milestone", () => {
    expect(() =>
      ReviewSurface.parse({
        ...baseSurface,
        parent_kind: "slice",
        parent_phase: "Discovery",
      }),
    ).toThrow(/parent_phase must be null/);
  });
});

describe("AgentRunReceipt schema", () => {
  it("parses a lead receipt", () => {
    const r = AgentRunReceipt.parse({
      session_id: ULID_SE,
      turn_index: 0,
      parent_loop: "outer",
      agent_profile_id: "atlas",
      agent_role_in_session: "lead",
      idempotency_key: ULID_A,
      diagnostics_ref: "diag/1",
      external_review_id: null,
      external_pr_id: "42",
      commit_sha: "abc123",
      exit_status: "ok",
      recorded_at: ISO,
    });
    expect(r.agent_profile_id).toBe("atlas");
  });

  it("rejects unknown exit_status", () => {
    expect(() =>
      AgentRunReceipt.parse({
        session_id: ULID_SE,
        turn_index: 0,
        parent_loop: "outer",
        agent_profile_id: "atlas",
        agent_role_in_session: "lead",
        idempotency_key: ULID_A,
        diagnostics_ref: "diag/1",
        exit_status: "weird",
        recorded_at: ISO,
      }),
    ).toThrow();
  });
});

describe("LeadIntent schema", () => {
  it("parses minimum + defaults", () => {
    const i = LeadIntent.parse({ summary: "hello" });
    expect(i.changed_files).toEqual([]);
    expect(i.decision_needed).toBe("");
  });

  it("rejects empty summary", () => {
    expect(() => LeadIntent.parse({ summary: "" })).toThrow();
  });
});

describe("ReviewerIntent schema", () => {
  it("parses approve with file comments", () => {
    const i = ReviewerIntent.parse({
      intent: "approve",
      body: "lgtm",
      file_comments: [{ path: "x.ts", line: 3, body: "nit" }],
    });
    expect(i.intent).toBe("approve");
    expect(i.file_comments).toHaveLength(1);
  });

  it("rejects intent=comment", () => {
    expect(() =>
      ReviewerIntent.parse({ intent: "comment", body: "x" }),
    ).toThrow();
  });
});

describe("SessionTurn additive optional refs", () => {
  // Build a minimal valid Envelope per the existing schema (envelope.ts §138).
  const envelope = {
    session_id: ULID_SE,
    turn_index: 0,
    parent_loop: "outer" as const,
    phase_or_purpose: "spec_proposal",
    slice_id: null,
    slice_kind: null,
    tdd_phase: null,
    agent_profile_id: "atlas" as const,
    agent_role_in_session: "lead" as const,
    contribution_kind: "lead_draft" as const,
    parent_review_verdict_id: null,
    output_kind: "spec_proposal" as const,
    object_id: ULID_M,
    manifest_id: ULID_MAN,
    input_revision_pins: ["rev-1"],
    summary: "x",
    artifacts: null,
    verdict: null,
    next_action_request: null,
    failure: null,
    idempotency_key: "key-1",
    runtime_metadata: {},
  };

  it("accepts output_receipt_ref / output_intent_ref optional", () => {
    const t = SessionTurn.parse({
      session_id: ULID_SE,
      turn_index: 0,
      agent_profile_id: "atlas",
      input_manifest_id: ULID_MAN,
      input_turn_log_snapshot_ref: null,
      output_envelope: envelope,
      next_action_request: null,
      caller_routing_decision: null,
      workspace_commit: null,
      verification_result_ref: null,
      output_receipt_ref: "intents/x.receipt.json",
      output_intent_ref: "intents/x.lead.json",
      recorded_at: ISO,
    });
    expect(t.output_receipt_ref).toBe("intents/x.receipt.json");
    expect(t.output_intent_ref).toBe("intents/x.lead.json");
  });

  it("legacy turns parse without the new fields", () => {
    const t = SessionTurn.parse({
      session_id: ULID_SE,
      turn_index: 0,
      agent_profile_id: "atlas",
      input_manifest_id: ULID_MAN,
      input_turn_log_snapshot_ref: null,
      output_envelope: envelope,
      next_action_request: null,
      caller_routing_decision: null,
      workspace_commit: null,
      verification_result_ref: null,
      recorded_at: ISO,
    });
    expect(t.output_receipt_ref).toBeUndefined();
  });
});

describe("Slice / Milestone additive review_surface fields", () => {
  it("Slice.review_surface_id is optional", () => {
    const s = Slice.parse({
      slice_id: ULID_S,
      milestone_id: ULID_M,
      slice_kind: "feature",
      value_statement: "x",
      ac_ids: [],
      acceptance_tests: [],
      declared_scope: [],
      declared_metric_threshold: null,
      interface_break: false,
      dependencies: [],
      trunk_base_revision: "deadbeef",
      dod_revision_pin: "rev-1",
      state: "SLICE_PENDING",
      current_session_id: null,
      spawning_proposal_id: null,
      abandoned_reason: null,
      external_refs: [],
      review_surface_id: ULID_A,
      created_at: ISO,
      updated_at: ISO,
    });
    expect(s.review_surface_id).toBe(ULID_A);
  });

  it("Milestone.review_surface_ids per phase is optional", () => {
    const m = Milestone.parse({
      milestone_id: ULID_M,
      target_id: "demo",
      title: "t",
      state: "M_INTAKE_QUEUED",
      slot_kind: null,
      intake_source_kind: "human_seed",
      intake_source_id: "issue:1",
      spec_revision_pin: null,
      context_summary_id: null,
      external_refs: [],
      review_surface_ids: { discovery: ULID_A, planning: ULID_B },
      created_at: ISO,
      updated_at: ISO,
    });
    expect(m.review_surface_ids?.discovery).toBe(ULID_A);
    expect(m.review_surface_ids?.specification).toBeUndefined();
  });
});

describe("LedgerRow phase-1 action_kind union-read", () => {
  const baseRow = {
    transition_id: ULID_A,
    target_id: "demo",
    object_id: ULID_S,
    object_kind: "system" as const,
    from_state: null,
    to_state: "outbox_pending",
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
    final_verdict: null,
    caller_id: "caller",
    manifest_id: null,
    input_revision_pins: [] as string[],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: "outbox/commit_op/k1/begin",
    lease_token: null,
    lease_kind: null,
    result_detail: null,
    timestamp: ISO,
    audit_hash: HASH,
    audit_hash_prev: HASH,
  };

  it("parses each new outbox / review_signal action_kind", () => {
    const new_kinds: (typeof LedgerActionKind)["options"][number][] = [
      "outbox_pending",
      "outbox_posted",
      "outbox_failed",
      "outbox_recovered",
      "review_signal_applied",
      "review_signal_dropped",
    ];
    for (const k of new_kinds) {
      const r = LedgerRow.parse({
        ...baseRow,
        action_kind: k,
        result: k === "outbox_failed" ? "error" : "applied",
      });
      expect(r.action_kind).toBe(k);
    }
  });

  it("legacy action_kind still parses (union-read)", () => {
    const r = LedgerRow.parse({
      ...baseRow,
      action_kind: "session_progress",
      result: "applied",
    });
    expect(r.action_kind).toBe("session_progress");
  });

  it("accepts the new optional correlation fields", () => {
    const r = LedgerRow.parse({
      ...baseRow,
      action_kind: "outbox_posted",
      result: "applied",
      surface_ref: "review_surfaces/abc.json",
      external_review_id: "rev-99",
      diagnostics_ref: "diag/x",
      op_kind: "submit_review_op",
      drop_reason: "five_gate_3_round_mismatch",
      nonce: "deadbeef12345678",
    });
    expect(r.op_kind).toBe("submit_review_op");
    expect(r.surface_ref).toBe("review_surfaces/abc.json");
  });

  it("rejects unknown action_kind (strict)", () => {
    expect(() =>
      LedgerRow.parse({
        ...baseRow,
        action_kind: "nonsense_kind",
        result: "applied",
      }),
    ).toThrow();
  });
});

// suppress unused-import warning for ULIDs that aren't used elsewhere
void [ULID_C, ULID_D];
