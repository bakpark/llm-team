export function buildValidPrompt(opts?: {
  agentProfileId?: string;
  phaseOrPurpose?: string;
  manifestId?: string;
  schemaInBody?: boolean;
}): string {
  const p = {
    agentProfileId: opts?.agentProfileId ?? "atlas",
    phaseOrPurpose: opts?.phaseOrPurpose ?? "discovery",
    manifestId: opts?.manifestId ?? "m-001",
  };
  const fenced = opts?.schemaInBody
    ? "\n예시 schema:\n```json\n{ \"# Output Schema\": \"inside fenced block\" }\n```\n"
    : "";
  return `---
session_id: s-001
turn_index: 1
parent_loop: outer
phase_or_purpose: ${p.phaseOrPurpose}
agent_profile_id: ${p.agentProfileId}
agent_role_in_session: lead
manifest_id: ${p.manifestId}
echo_strict: true
---

# Context

본 turn 의 context 본문.${fenced}

# Instruction

본 turn 의 instruction.

# Output Schema

산출은 단일 \`\`\`json fenced block.
`;
}
