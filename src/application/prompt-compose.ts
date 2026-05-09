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
  // RGC-HUMAN-CONTRIBUTION: human input never reaches the LLM runner — the
  // human-signal-binding pipeline appends synthetic SessionTurns directly.
  // Refuse to compose a prompt for a human participant so the runner cannot
  // accidentally invoke an LLM with agent_profile_id=human.
  if (input.agentProfileId === "human") {
    throw new Error(
      "composePrompt: agent_profile_id=human cannot have a prompt — human turns arrive via human-signal-binding",
    );
  }
  if (input.parentLoop === "inner" && input.phaseOrPurpose === "tdd_build") {
    return [
      "You are forge in the inner tdd_build loop.",
      "Read the manifest, perform a single TDD step, and emit a patch envelope.",
      "Set output_kind=patch, contribution_kind=lead_draft, tdd_phase ∈ {red_green, refactor}.",
    ].join("\n");
  }
  if (input.parentLoop === "outer") {
    return outerInstructionBody(input);
  }
  return `You are ${input.agentProfileId} in the ${input.parentLoop} loop (${input.phaseOrPurpose}).`;
}

function outerInstructionBody(input: ComposePromptInput): string {
  const role = input.agentRoleInSession;
  switch (input.phaseOrPurpose) {
    case "Discovery":
      if (role === "lead") {
        return [
          `You are ${input.agentProfileId} (lead) in the outer Discovery phase.`,
          "Read the manifest's milestone body, accumulated decisions, and the",
          "prior SessionTurn summary (if present in the manifest).",
          "On your FIRST turn (no prior turns) emit a Spec CP draft as a",
          "`spec_proposal` lead_draft (problem framing, user value, scope",
          "boundary). Do NOT include AC-IDs yet — those arrive in Specification.",
          "Set output_kind=spec_proposal, contribution_kind=lead_draft, verdict=null.",
          "On a SUBSEQUENT turn after reviewer quorum (quorum_then_lead): emit",
          "the FINAL verdict — output_kind=verdict, contribution_kind=review_verdict,",
          "verdict.result ∈ {spec_accept, spec_reject, request_changes}. Address",
          "every prior `request_changes` rationale in the rationale field.",
        ].join("\n");
      }
      return [
        `You are ${input.agentProfileId} (${role}) reviewing a Discovery Spec CP.`,
        "Emit a verdict envelope. Acceptable verdicts: spec_accept, spec_reject,",
        "request_changes. Provide a concrete rationale.",
        "Set output_kind=verdict, contribution_kind=review_verdict.",
      ].join("\n");
    case "Specification":
      if (role === "lead") {
        return [
          `You are ${input.agentProfileId} (lead) in the outer Specification phase.`,
          "On your FIRST turn (no prior turns) promote the Discovery Spec CP",
          "into scenarios + AC-IDs + acceptance test stubs. Each AC must have",
          "a stable AC-ID and at least one acceptance test (path + name). Set",
          "pending markers per SOC-OPERATIONS Specification.",
          "Set output_kind=spec_proposal, contribution_kind=lead_draft, verdict=null.",
          "On a SUBSEQUENT turn after reviewer quorum (quorum_then_lead, min",
          "approvals = 2): emit the FINAL verdict — output_kind=verdict,",
          "contribution_kind=review_verdict, verdict.result ∈ {spec_accept,",
          "spec_reject, request_changes}. Address every prior `request_changes`",
          "rationale in the rationale field.",
        ].join("\n");
      }
      return [
        `You are ${input.agentProfileId} (${role}) reviewing the Specification.`,
        "Verdict: spec_accept / spec_reject / request_changes.",
        "Set output_kind=verdict, contribution_kind=review_verdict.",
      ].join("\n");
    case "Planning":
      if (role === "lead") {
        return [
          `You are ${input.agentProfileId} (lead) in the outer Planning phase.`,
          "Decompose the approved spec into a slice DAG. Each slice declares",
          "slice_id, slice_kind, value_statement, ac_ids[], acceptance_tests[],",
          "declared_scope[], dependencies[] ({slice_id, edge_type}). DAG must",
          "be acyclic; cycle detection runs in caller. Set",
          "output_kind=slice_decomposition, contribution_kind=lead_draft.",
        ].join("\n");
      }
      return [
        `You are ${input.agentProfileId} (${role}) reviewing the slice DAG.`,
        "Verdict: plan_accept / request_changes.",
        "Set output_kind=verdict, contribution_kind=review_verdict.",
      ].join("\n");
    case "Validation":
      if (role === "lead") {
        return [
          `You are ${input.agentProfileId} (lead) in the outer Validation phase.`,
          "Aggregate slice validation evidence (verification runs, acceptance",
          "test outcomes per AC-ID). Emit a milestone_package envelope with",
          "verdict ∈ {PASS, FAIL, STALE}.",
          "Set output_kind=milestone_package, contribution_kind=lead_draft.",
        ].join("\n");
      }
      return [
        `You are ${input.agentProfileId} (${role}) observing the Validation phase.`,
        "Provide observations. No verdict required.",
      ].join("\n");
    default:
      return `You are ${input.agentProfileId} in the outer loop (${input.phaseOrPurpose}).`;
  }
}
