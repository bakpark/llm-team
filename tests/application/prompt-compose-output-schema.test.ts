/**
 * Incident-1 (Bug A) regression — `composePrompt` must emit an Output Schema
 * section that matches the FLAT `AgentAuthoredEnvelope` Zod schema.
 *
 * Earlier the section read "Required header echo: …" which an LLM
 * (claude-opus-4-7, atlas) interpreted as "wrap fields in a `header` object",
 * producing nested envelopes that failed schema_violation. This test guards:
 *   1) every required top-level field name appears in the rendered prompt,
 *   2) the prompt explicitly forbids container keys (`header`, `target`, …),
 *   3) the embedded example envelope parses through `AgentAuthoredEnvelope`.
 */
import { describe, expect, it } from "vitest";
import {
  composePrompt,
  OUTPUT_SCHEMA_FORBIDDEN_KEYS,
} from "../../src/application/prompt-compose.js";
import { AgentAuthoredEnvelope } from "../../src/domain/schema/envelope.js";
import { ContextManifest } from "../../src/domain/schema/manifest.js";
import {
  enrichEnvelope,
  parseAgentAuthored,
  validateEnvelope,
} from "../../src/application/envelope.js";
import type { IdempotencyParts } from "../../src/application/idempotency.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const MANIFEST_ID = "01HZMA0000000000000000000A";
const ISO = "2026-05-07T00:00:00.000Z";

const REQUIRED_TOP_LEVEL_FIELDS = [
  "session_id",
  "turn_index",
  "parent_loop",
  "phase_or_purpose",
  "agent_profile_id",
  "agent_role_in_session",
  "contribution_kind",
  "output_kind",
  "object_id",
  "manifest_id",
  "input_revision_pins",
  "summary",
];

// Sourced from `prompt-compose.ts` so prompt directive and test stay in sync.
const FORBIDDEN_CONTAINER_KEYS = OUTPUT_SCHEMA_FORBIDDEN_KEYS;

function perTurn(profile: "atlas" | "forge" | "sentinel" | "scout"): IdempotencyParts {
  return {
    scope: "per_turn",
    parts: {
      session_id: SESSION_ID,
      turn_index: 0,
      agent_profile_id: profile,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["deadbeef"],
    },
  };
}

/**
 * Run the example envelope through the full Caller pipeline:
 *   parseAgentAuthored -> enrichEnvelope -> validateEnvelope.
 * This is the same path real Agent output traverses in `runOneOuterTurn`,
 * so a passing example envelope guarantees the prompt directive matches the
 * AGC-CONTRIBUTION-OUTPUTS matrix instead of merely satisfying `.parse()`.
 */
function pipelineValidate(
  raw: unknown,
  profile: "atlas" | "forge" | "sentinel" | "scout",
):
  | { ok: true }
  | { ok: false; reason: string; detail: string } {
  const parsed = parseAgentAuthored(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail };
  const enriched = enrichEnvelope(parsed.value, {
    idempotency: perTurn(profile),
    runtime_metadata: {},
  });
  if (!enriched.ok)
    return { ok: false, reason: enriched.reason, detail: enriched.detail };
  const validated = validateEnvelope(enriched.value);
  if (!validated.ok)
    return { ok: false, reason: validated.reason, detail: validated.detail };
  return { ok: true };
}

function manifestPurposeFor(loop: string, phase: string): string {
  if (loop === "inner" && phase === "tdd_build") return "tdd_build";
  if (loop === "middle" && phase === "review") return "review";
  if (loop === "outer" && phase === "Planning") return "planning_decompose";
  if (loop === "outer" && phase === "Validation") return "validation";
  if (loop === "outer" && phase === "Specification") return "build";
  return "design";
}

function buildManifest(purpose: string = "design") {
  return ContextManifest.parse({
    manifest_id: MANIFEST_ID,
    session_id: SESSION_ID,
    turn_index: 0,
    purpose,
    target: { object_kind: "slice", object_id: SLICE_ID },
    entries: [
      {
        object_kind: "slice",
        object_id: SLICE_ID,
        fetch_scope: "body",
        revision_pin: "deadbeef",
        required: true,
        purpose: "primary",
      },
    ],
    created_at: ISO,
  });
}

function extractExampleEnvelope(prompt: string): unknown {
  // Skip the manifest fenced block — the example envelope is the LAST
  // ```json fenced block, emitted inside the # Output Schema section.
  const blocks: string[] = [];
  const re = /```json\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) != null) {
    if (m[1] != null) blocks.push(m[1]);
  }
  if (blocks.length === 0) {
    throw new Error("no ```json fenced block found in prompt");
  }
  const last = blocks[blocks.length - 1]!;
  return JSON.parse(last);
}

describe("composePrompt — Output Schema section (incident-1 / Bug A)", () => {
  it("renders every required AgentAuthoredEnvelope top-level field for outer.Discovery atlas (lead, turn 0)", () => {
    const prompt = composePrompt({
      agentProfileId: "atlas",
      agentRoleInSession: "lead",
      parentLoop: "outer",
      phaseOrPurpose: "Discovery",
      sessionId: SESSION_ID,
      turnIndex: 0,
      manifest: buildManifest(),
      workspaceRevisionPin: "deadbeef",
    });
    expect(prompt).toContain("# Output Schema");
    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
      expect(prompt).toContain(field);
    }
  });

  it("explicitly forbids container keys that previously caused schema_violation", () => {
    const prompt = composePrompt({
      agentProfileId: "atlas",
      agentRoleInSession: "lead",
      parentLoop: "outer",
      phaseOrPurpose: "Discovery",
      sessionId: SESSION_ID,
      turnIndex: 0,
      manifest: buildManifest(),
      workspaceRevisionPin: "deadbeef",
    });
    expect(prompt).toMatch(/Forbidden keys at the root/i);
    for (const key of FORBIDDEN_CONTAINER_KEYS) {
      expect(prompt).toContain(`\`${key}\``);
    }
    // The earlier prose phrasing must be gone — guards regression.
    expect(prompt).not.toMatch(/Required header echo:/);
  });

  it("emits an example envelope that parses through AgentAuthoredEnvelope (Discovery atlas lead)", () => {
    const prompt = composePrompt({
      agentProfileId: "atlas",
      agentRoleInSession: "lead",
      parentLoop: "outer",
      phaseOrPurpose: "Discovery",
      sessionId: SESSION_ID,
      turnIndex: 0,
      manifest: buildManifest(),
      workspaceRevisionPin: "deadbeef",
    });
    const example = extractExampleEnvelope(prompt);
    const parsed = AgentAuthoredEnvelope.parse(example);
    expect(parsed.session_id).toBe(SESSION_ID);
    expect(parsed.manifest_id).toBe(MANIFEST_ID);
    expect(parsed.parent_loop).toBe("outer");
    expect(parsed.phase_or_purpose).toBe("Discovery");
    expect(parsed.agent_profile_id).toBe("atlas");
    expect(parsed.agent_role_in_session).toBe("lead");
    expect(parsed.output_kind).toBe("spec_proposal");
    expect(parsed.contribution_kind).toBe("lead_draft");
    expect(parsed.input_revision_pins).toEqual(["deadbeef"]);
  });

  it("emits a parseable example for inner.tdd_build forge (lead, red_green)", () => {
    const prompt = composePrompt({
      agentProfileId: "forge",
      agentRoleInSession: "lead",
      parentLoop: "inner",
      phaseOrPurpose: "tdd_build",
      sessionId: SESSION_ID,
      turnIndex: 0,
      manifest: ContextManifest.parse({
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
            revision_pin: "deadbeef",
            required: true,
            purpose: "primary",
          },
        ],
        created_at: ISO,
      }),
      workspaceRevisionPin: "deadbeef",
    });
    const example = extractExampleEnvelope(prompt);
    const parsed = AgentAuthoredEnvelope.parse(example);
    expect(parsed.parent_loop).toBe("inner");
    expect(parsed.phase_or_purpose).toBe("tdd_build");
    expect(parsed.agent_profile_id).toBe("forge");
    expect(parsed.output_kind).toBe("patch");
    expect(parsed.tdd_phase).toBe("red_green");
  });
});

/**
 * Pipeline regression — for every prompt scenario the embedded example
 * envelope must survive `parseAgentAuthored -> enrichEnvelope ->
 * validateEnvelope`, not merely `AgentAuthoredEnvelope.parse`. This catches
 * matrix violations (e.g. wrong `output_kind` for the (parent_loop, phase,
 * contribution_kind) row) and missing loop-conditional fields (`slice_id`,
 * `slice_kind`, `tdd_phase`) that the bare Zod parse would silently default
 * to null.
 */
describe("composePrompt — example envelope passes full validator pipeline", () => {
  type Case = {
    label: string;
    profile: "atlas" | "forge" | "sentinel" | "scout";
    role: "lead" | "reviewer" | "observer";
    loop: "outer" | "middle" | "inner";
    phase: string;
    expected: { output_kind: string; contribution_kind: string };
  };
  const cases: Case[] = [
    {
      label: "outer.Discovery atlas lead",
      profile: "atlas",
      role: "lead",
      loop: "outer",
      phase: "Discovery",
      expected: { output_kind: "spec_proposal", contribution_kind: "lead_draft" },
    },
    {
      label: "outer.Discovery sentinel reviewer",
      profile: "sentinel",
      role: "reviewer",
      loop: "outer",
      phase: "Discovery",
      expected: { output_kind: "verdict", contribution_kind: "review_verdict" },
    },
    {
      label: "outer.Specification atlas lead",
      profile: "atlas",
      role: "lead",
      loop: "outer",
      phase: "Specification",
      expected: { output_kind: "spec_proposal", contribution_kind: "lead_draft" },
    },
    {
      label: "outer.Planning atlas lead",
      profile: "atlas",
      role: "lead",
      loop: "outer",
      phase: "Planning",
      expected: {
        output_kind: "slice_decomposition",
        contribution_kind: "lead_draft",
      },
    },
    {
      label: "outer.Validation sentinel lead",
      profile: "sentinel",
      role: "lead",
      loop: "outer",
      phase: "Validation",
      expected: {
        output_kind: "milestone_package",
        contribution_kind: "lead_draft",
      },
    },
    {
      label: "middle.review sentinel reviewer",
      profile: "sentinel",
      role: "reviewer",
      loop: "middle",
      phase: "review",
      expected: { output_kind: "verdict", contribution_kind: "review_verdict" },
    },
    {
      label: "inner.tdd_build forge lead",
      profile: "forge",
      role: "lead",
      loop: "inner",
      phase: "tdd_build",
      expected: { output_kind: "patch", contribution_kind: "lead_draft" },
    },
  ];

  for (const c of cases) {
    it(`example envelope is valid end-to-end for ${c.label}`, () => {
      const prompt = composePrompt({
        agentProfileId: c.profile,
        agentRoleInSession: c.role,
        parentLoop: c.loop,
        phaseOrPurpose: c.phase,
        sessionId: SESSION_ID,
        turnIndex: 0,
        manifest: buildManifest(manifestPurposeFor(c.loop, c.phase)),
        workspaceRevisionPin: "deadbeef",
      });
      const example = extractExampleEnvelope(prompt);
      const parsed = AgentAuthoredEnvelope.parse(example);
      expect(parsed.output_kind).toBe(c.expected.output_kind);
      expect(parsed.contribution_kind).toBe(c.expected.contribution_kind);
      // Loop-conditional fields must be present where required.
      if (c.loop === "middle" || c.loop === "inner") {
        expect(parsed.slice_id).not.toBeNull();
        expect(parsed.slice_kind).not.toBeNull();
      }
      if (c.loop === "inner") {
        expect(parsed.tdd_phase).not.toBeNull();
      }
      const result = pipelineValidate(example, c.profile);
      if (!result.ok) {
        throw new Error(
          `pipeline failed for ${c.label}: ${result.reason} — ${result.detail}`,
        );
      }
      expect(result.ok).toBe(true);
    });
  }
});
