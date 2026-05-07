import { describe, expect, it } from "vitest";
import {
  AGC_INVALID_REASONS,
  AgcInvalidError,
  enrichEnvelope,
  parseAgentAuthored,
  validateEnvelope,
} from "../../src/application/envelope.js";
import type { IdempotencyParts } from "../../src/application/idempotency.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const MANIFEST_ID = "01HZMA0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const M_ID = "01HZM00000000000000000000A";

function perTurn(
  overrides: Partial<IdempotencyParts extends { scope: "per_turn"; parts: infer P } ? P : never> = {},
): IdempotencyParts {
  return {
    scope: "per_turn",
    parts: {
      session_id: SESSION_ID,
      turn_index: 0,
      agent_profile_id: "forge",
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc1234"],
      ...overrides,
    },
  };
}

function innerTdd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    summary: "ok",
    ...overrides,
  };
}

function pipeline(raw: Record<string, unknown>) {
  const parsed = parseAgentAuthored(raw);
  if (!parsed.ok) return parsed;
  const enriched = enrichEnvelope(parsed.value, {
    idempotency: perTurn(),
    runtime_metadata: {},
  });
  if (!enriched.ok) return enriched;
  return validateEnvelope(enriched.value);
}

describe("parseAgentAuthored", () => {
  it("accepts a valid inner tdd_build envelope", () => {
    expect(parseAgentAuthored(innerTdd()).ok).toBe(true);
  });

  it("rejects non-object payloads", () => {
    expect(parseAgentAuthored(null)).toMatchObject({ ok: false, reason: "schema_violation" });
    expect(parseAgentAuthored([1, 2, 3])).toMatchObject({ ok: false, reason: "schema_violation" });
    expect(parseAgentAuthored("string")).toMatchObject({ ok: false, reason: "schema_violation" });
  });

  it("rejects agent-authored idempotency_key", () => {
    expect(parseAgentAuthored(innerTdd({ idempotency_key: "x" }))).toMatchObject({
      ok: false,
      reason: "agent_authored_idempotency_key",
    });
  });

  it("rejects agent-authored runtime_metadata", () => {
    expect(parseAgentAuthored(innerTdd({ runtime_metadata: {} }))).toMatchObject({
      ok: false,
      reason: "agent_authored_runtime_metadata",
    });
  });

  it("rejects legacy agent_role / operation / phase_run_id", () => {
    expect(parseAgentAuthored(innerTdd({ agent_role: "coder" }))).toMatchObject({
      ok: false,
      reason: "legacy_field_present",
    });
    expect(parseAgentAuthored(innerTdd({ operation: "merge" }))).toMatchObject({
      ok: false,
      reason: "legacy_field_present",
    });
    expect(parseAgentAuthored(innerTdd({ phase_run_id: "x" }))).toMatchObject({
      ok: false,
      reason: "legacy_field_present",
    });
  });

  it("rejects deprecated contribution_kind enum (rework_patch)", () => {
    expect(
      parseAgentAuthored(innerTdd({ contribution_kind: "rework_patch" })),
    ).toMatchObject({ ok: false, reason: "schema_violation" });
  });

  it("rejects contribution_kind=session_outcome (Caller-only per AGC-CONTRIBUTION)", () => {
    expect(
      parseAgentAuthored(
        innerTdd({
          contribution_kind: "session_outcome",
          output_kind: "verdict",
          verdict: { result: "tests_green", rationale: "passed" },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "agent_authored_session_outcome" });
  });
});

describe("enrichEnvelope", () => {
  it("composes idempotency_key from SOC-IDEMPOTENCY parts and injects runtime_metadata", () => {
    const a = parseAgentAuthored(innerTdd());
    if (!a.ok) throw new Error("agent parse failed");
    const r = enrichEnvelope(a.value, {
      idempotency: perTurn(),
      runtime_metadata: { workspace_commit: "deadbeef" },
    });
    if (!r.ok) throw new Error("enrich failed");
    expect(r.value.idempotency_key).toBe(
      `per_turn|${SESSION_ID}|0|forge|${MANIFEST_ID}|abc1234`,
    );
    expect(r.value.runtime_metadata).toEqual({ workspace_commit: "deadbeef" });
  });

  it("is deterministic — identical parts produce identical keys", () => {
    const a = parseAgentAuthored(innerTdd());
    if (!a.ok) throw new Error();
    const r1 = enrichEnvelope(a.value, { idempotency: perTurn(), runtime_metadata: {} });
    const r2 = enrichEnvelope(a.value, { idempotency: perTurn(), runtime_metadata: {} });
    if (!r1.ok || !r2.ok) throw new Error();
    expect(r1.value.idempotency_key).toBe(r2.value.idempotency_key);
  });

  it("rejects runtime_metadata key colliding with envelope field", () => {
    const a = parseAgentAuthored(innerTdd());
    if (!a.ok) throw new Error("agent parse failed");
    const r = enrichEnvelope(a.value, {
      idempotency: perTurn(),
      runtime_metadata: { summary: "shadow" },
    });
    expect(r).toMatchObject({ ok: false, reason: "enrich_key_collision" });
  });

  it("rejects collision with envelope-level idempotency_key key in metadata", () => {
    const a = parseAgentAuthored(innerTdd());
    if (!a.ok) throw new Error("agent parse failed");
    const r = enrichEnvelope(a.value, {
      idempotency: perTurn(),
      runtime_metadata: { idempotency_key: "x" },
    });
    expect(r).toMatchObject({ ok: false, reason: "enrich_key_collision" });
  });
});

describe("validateEnvelope (AGC-CONTRIBUTION-OUTPUTS matrix)", () => {
  it("accepts inner tdd_build lead_draft → patch", () => {
    expect(pipeline(innerTdd()).ok).toBe(true);
  });

  it("accepts middle review review_verdict → verdict (approve)", () => {
    const r = pipeline({
      session_id: SESSION_ID,
      turn_index: 1,
      parent_loop: "middle",
      phase_or_purpose: "review",
      slice_id: SLICE_ID,
      slice_kind: "internal",
      agent_profile_id: "sentinel",
      agent_role_in_session: "lead",
      contribution_kind: "review_verdict",
      output_kind: "verdict",
      object_id: SLICE_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc1234"],
      summary: "approved",
      verdict: { result: "approve", rationale: "lgtm" },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects inner tdd_build → milestone_package (matrix violation)", () => {
    const r = pipeline(innerTdd({ output_kind: "milestone_package" }));
    expect(r).toMatchObject({ ok: false, reason: "matrix_violation" });
  });

  it("rejects outer Validation lead_draft missing verdict", () => {
    const r = pipeline({
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "Validation",
      agent_profile_id: "sentinel",
      agent_role_in_session: "lead",
      contribution_kind: "lead_draft",
      output_kind: "milestone_package",
      object_id: M_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc"],
      summary: "ok",
    });
    expect(r).toMatchObject({ ok: false, reason: "matrix_violation" });
  });

  it("accepts outer Validation lead_draft with verdict.result=PASS", () => {
    const r = pipeline({
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "Validation",
      agent_profile_id: "sentinel",
      agent_role_in_session: "lead",
      contribution_kind: "lead_draft",
      output_kind: "milestone_package",
      object_id: M_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc"],
      summary: "ok",
      verdict: { result: "PASS", rationale: "ac all green" },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects phase_or_purpose=tdd_build under parent_loop=outer", () => {
    const r = pipeline({
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "tdd_build",
      agent_profile_id: "atlas",
      agent_role_in_session: "lead",
      contribution_kind: "lead_draft",
      output_kind: "spec_proposal",
      object_id: M_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc"],
      summary: "ok",
    });
    expect(r).toMatchObject({ ok: false, reason: "phase_or_purpose_outside_loop" });
  });

  it("requires slice_id when parent_loop=middle|inner", () => {
    const r = pipeline(innerTdd({ slice_id: null }));
    expect(r).toMatchObject({ ok: false, reason: "missing_required_envelope_field" });
  });

  it("requires tdd_phase when parent_loop=inner", () => {
    const r = pipeline(innerTdd({ tdd_phase: null }));
    expect(r).toMatchObject({ ok: false, reason: "missing_required_envelope_field" });
  });

  it("output_kind=failure requires the failure block", () => {
    expect(pipeline(innerTdd({ output_kind: "failure" }))).toMatchObject({
      ok: false,
      reason: "missing_required_envelope_field",
    });
    expect(
      pipeline(
        innerTdd({
          output_kind: "failure",
          failure: { type: "need_context", rationale: "manifest entry missing" },
        }),
      ).ok,
    ).toBe(true);
  });

  it("output_kind=failure still requires loop-conditional fields (slice_id/slice_kind/tdd_phase)", () => {
    // slice_id absent on inner failure must STILL be rejected — failure
    // does not waive the AGC-OUTPUT loop-conditional invariants.
    expect(
      pipeline(
        innerTdd({
          slice_id: null,
          output_kind: "failure",
          failure: { type: "invalid_output", rationale: "x" },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "missing_required_envelope_field" });

    expect(
      pipeline(
        innerTdd({
          tdd_phase: null,
          output_kind: "failure",
          failure: { type: "invalid_output", rationale: "x" },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "missing_required_envelope_field" });
  });

  it("accepts proposal contribution under any loop", () => {
    const r = pipeline(
      innerTdd({
        contribution_kind: "proposal",
        output_kind: "proposal_artifact",
        agent_profile_id: "scout",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects review_verdict with verdict.result outside enum", () => {
    const r = pipeline({
      session_id: SESSION_ID,
      turn_index: 1,
      parent_loop: "middle",
      phase_or_purpose: "review",
      slice_id: SLICE_ID,
      slice_kind: "internal",
      agent_profile_id: "sentinel",
      agent_role_in_session: "lead",
      contribution_kind: "review_verdict",
      output_kind: "verdict",
      object_id: SLICE_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["abc1234"],
      summary: "x",
      verdict: { result: "tests_green", rationale: "wrong context" },
    });
    expect(r).toMatchObject({ ok: false, reason: "matrix_violation" });
  });
});

describe("AgcInvalidError + AGC_INVALID_REASONS", () => {
  it("error wraps reason + detail", () => {
    const err = new AgcInvalidError("schema_violation", "x");
    expect(err.reason).toBe("schema_violation");
    expect(err.message).toContain("AGC-INVALID:schema_violation");
  });

  it("AGC_INVALID_REASONS contains all reasons surfaced by parser/enricher/matrix", () => {
    for (const r of [
      "schema_violation",
      "matrix_violation",
      "missing_required_envelope_field",
      "phase_or_purpose_outside_loop",
      "agent_authored_idempotency_key",
      "agent_authored_runtime_metadata",
      "agent_authored_session_outcome",
      "enrich_key_collision",
      "legacy_field_present",
    ] as const) {
      expect(AGC_INVALID_REASONS).toContain(r);
    }
  });
});
