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
import { composePrompt } from "../../src/application/prompt-compose.js";
import { AgentAuthoredEnvelope } from "../../src/domain/schema/envelope.js";
import { ContextManifest } from "../../src/domain/schema/manifest.js";

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

const FORBIDDEN_CONTAINER_KEYS = [
  "header",
  "target",
  "agc_output_version",
  "next_action_hint",
  "spec_proposal",
];

function buildManifest() {
  return ContextManifest.parse({
    manifest_id: MANIFEST_ID,
    session_id: SESSION_ID,
    turn_index: 0,
    purpose: "design",
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
