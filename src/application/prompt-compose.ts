import type { ContextManifest } from "../domain/schema/manifest.js";
import type {
  AgentProfileId,
  AgentRoleInSession,
  ParentLoop,
} from "../domain/schema/contribution.js";

/**
 * 4-part prompt composition (#AGC-PROMPT-SERIALIZATION,
 * #ARC-ADAPTER-PROMPT-CONTRACT).
 *
 * Layout: frontmatter (header echo) + `# Context` + `# Instruction` +
 * `# Output Schema`. The frontmatter carries the seven echo fields the
 * adapter contract requires (agent_profile_id, phase_or_purpose,
 * manifest_id, session_id, turn_index, parent_loop, agent_role_in_session).
 *
 * The fenced manifest JSON is included verbatim in `# Context` so adapters
 * (including the fake adapter's `__PIN_*__` placeholders) can resolve
 * manifest entries without re-reading the manifest file.
 *
 * Role-specific instruction body and output schema are kept minimal —
 * phase 5 prompt builders will expand them with knowledge artefacts.
 */

export interface ComposePromptInput {
  agentProfileId: AgentProfileId;
  agentRoleInSession: AgentRoleInSession;
  parentLoop: ParentLoop;
  phaseOrPurpose: string;
  sessionId: string;
  turnIndex: number;
  manifest: ContextManifest;
  workspaceRevisionPin: string;
  /** Optional extra instruction body appended to the role default. */
  extraInstruction?: string;
}

export function composePrompt(input: ComposePromptInput): string {
  const fm = [
    "---",
    `agent_profile_id: ${input.agentProfileId}`,
    `phase_or_purpose: ${input.phaseOrPurpose}`,
    `manifest_id: ${input.manifest.manifest_id}`,
    `session_id: ${input.sessionId}`,
    `turn_index: ${input.turnIndex}`,
    `parent_loop: ${input.parentLoop}`,
    `agent_role_in_session: ${input.agentRoleInSession}`,
    "---",
  ].join("\n");
  const manifestJson = JSON.stringify(input.manifest, null, 2);
  const context = [
    "# Context",
    "",
    "## Manifest",
    "",
    "```json",
    manifestJson,
    "```",
    "",
    `workspace_revision_pin: ${input.workspaceRevisionPin}`,
  ].join("\n");
  const instruction = [
    "# Instruction",
    "",
    instructionBody(input),
    input.extraInstruction ?? "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const outputSchema = [
    "# Output Schema",
    "",
    "Emit a single ```json fenced block with the AGC-OUTPUT envelope.",
    "Required header echo: session_id, turn_index, parent_loop,",
    "phase_or_purpose, agent_profile_id, agent_role_in_session, manifest_id.",
  ].join("\n");
  return [fm, "", context, "", instruction, "", outputSchema, ""].join("\n");
}

function instructionBody(input: ComposePromptInput): string {
  if (input.parentLoop === "inner" && input.phaseOrPurpose === "tdd_build") {
    return [
      "You are forge in the inner tdd_build loop.",
      "Read the manifest, perform a single TDD step, and emit a patch envelope.",
      "Set output_kind=patch, contribution_kind=lead_draft, tdd_phase ∈ {red_green, refactor}.",
    ].join("\n");
  }
  return `You are ${input.agentProfileId} in the ${input.parentLoop} loop (${input.phaseOrPurpose}).`;
}
