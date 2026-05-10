import type {
  ContextManifest,
  FetchScope,
  ManifestEntry,
} from "../domain/schema/manifest.js";
import type {
  AgentProfileId,
  AgentRoleInSession,
  ParentLoop,
} from "../domain/schema/contribution.js";
import {
  resolveContextBudget,
  type ContextBudget,
} from "../config/target-schema.js";
import { estimateTokensFromHeader } from "./manifest-builder.js";

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
  const outputSchema = renderOutputSchema(input);
  return [fm, "", context, "", instruction, "", outputSchema, ""].join("\n");
}

/**
 * AGC-OUTPUT envelope is a FLAT, .strict() Zod object — see
 * `src/domain/schema/envelope.ts` (`AgentAuthoredEnvelope`). The earlier prose
 * version of this section ("Required header echo: …") was misread by LLMs as
 * "wrap those keys in a `header` object", producing nested envelopes that
 * failed schema_violation. This renderer enumerates every required top-level
 * field by name, forbids common container keys, and ships a minimal valid
 * example envelope tailored to the (parent_loop, phase, role) being prompted.
 */
function renderOutputSchema(input: ComposePromptInput): string {
  const example = buildExampleEnvelope(input);
  const exampleJson = JSON.stringify(example, null, 2);
  return [
    "# Output Schema",
    "",
    "Emit a single ```json fenced block whose root is the AGC-OUTPUT envelope.",
    "The envelope is a FLAT object — every field below is a TOP-LEVEL key.",
    "Do NOT wrap fields under a `header`, `target`, or any other container.",
    "",
    "Required top-level fields (always present):",
    "- `session_id` (ULID)",
    "- `turn_index` (integer ≥ 0)",
    "- `parent_loop` (\"outer\" | \"middle\" | \"inner\")",
    "- `phase_or_purpose` (string)",
    "- `agent_profile_id` (\"atlas\" | \"forge\" | \"sentinel\" | \"scout\")",
    "- `agent_role_in_session` (\"lead\" | \"reviewer\" | \"observer\")",
    "- `contribution_kind` (\"lead_draft\" | \"review_verdict\" | \"human_approval\" | \"session_outcome\" | \"proposal\")",
    "- `output_kind` (\"spec_proposal\" | \"task_plan\" | \"slice_decomposition\" | \"patch\" | \"verdict\" | \"milestone_package\" | \"proposal_artifact\" | \"failure\")",
    "- `object_id` (ULID — primary target: slice / milestone / SliceMerge id)",
    "- `manifest_id` (ULID — echo the manifest_id from the manifest above)",
    "- `input_revision_pins` (array of strings — at minimum `[workspace_revision_pin]`)",
    "- `summary` (non-empty string — human-readable narrative of what you produced)",
    "",
    "Optional top-level fields (use null/omit when not applicable):",
    "- `slice_id`, `slice_kind`, `tdd_phase`, `parent_review_verdict_id`",
    "- `artifacts` (record<string, unknown> | null — encode structured details such as",
    "  problem framing, scenarios, scope_boundary, etc. INSIDE this bag, not at root)",
    "- `verdict` ({ result, rationale } | null) — required when emitting a verdict",
    "- `next_action_request` ({ addressed_to, intent, evidence_request[], proposal_artifact_ref? } | null)",
    "- `failure` ({ type, rationale } | null) — only when output_kind=\"failure\"",
    "",
    "Forbidden keys at the root: `header`, `target`, `agc_output_version`,",
    "`next_action_hint`, `input_status`, and any artifact-specific container",
    "(`spec_proposal`, `task_plan`, `slice_decomposition`, `patch`,",
    "`milestone_package`, `proposal_artifact`). Encode artifact details inside",
    "the `artifacts` record and the human narrative inside `summary`.",
    "",
    "When you need a follow-up turn from another agent, populate",
    "`next_action_request` as `{ addressed_to: <agent_profile_id|\"caller\">,",
    "intent: <short string>, evidence_request: [{ kind, scope }, …],",
    "proposal_artifact_ref: <string|null> }`. Otherwise set it to `null`.",
    "",
    "Minimal valid example for the current (parent_loop, phase, role) — copy",
    "the SHAPE, not the values:",
    "",
    "```json",
    exampleJson,
    "```",
  ].join("\n");
}

/**
 * Build a minimal envelope that satisfies `AgentAuthoredEnvelope.parse(...)`
 * for the (parent_loop, phase_or_purpose, agent_role_in_session) being
 * prompted. The example is meant for prompt-time guidance; values are
 * placeholders and must not be copied verbatim by the LLM.
 *
 * The shape returned mirrors the real envelope exactly — no extra keys, no
 * grouping. The accompanying regression test parses this through the Zod
 * schema so future drift surfaces immediately.
 */
function buildExampleEnvelope(input: ComposePromptInput): Record<string, unknown> {
  const PLACEHOLDER_OBJECT_ID = "01HZX0000000000000000000EX";
  const role = input.agentRoleInSession;
  const isOuterDiscoveryLead =
    input.parentLoop === "outer" &&
    input.phaseOrPurpose === "Discovery" &&
    role === "lead";
  const isOuterReviewerVerdict =
    input.parentLoop === "outer" &&
    (input.phaseOrPurpose === "Discovery" ||
      input.phaseOrPurpose === "Specification" ||
      input.phaseOrPurpose === "Planning") &&
    role !== "lead" &&
    role !== "observer";
  const isInnerForgeBuild =
    input.parentLoop === "inner" && input.phaseOrPurpose === "tdd_build";

  const base: Record<string, unknown> = {
    session_id: input.sessionId,
    turn_index: input.turnIndex,
    parent_loop: input.parentLoop,
    phase_or_purpose: input.phaseOrPurpose,
    slice_id: null,
    slice_kind: null,
    tdd_phase: null,
    agent_profile_id: input.agentProfileId === "human" ? "atlas" : input.agentProfileId,
    agent_role_in_session: role,
    contribution_kind: "lead_draft",
    parent_review_verdict_id: null,
    output_kind: "spec_proposal",
    object_id: PLACEHOLDER_OBJECT_ID,
    manifest_id: input.manifest.manifest_id,
    input_revision_pins: [input.workspaceRevisionPin],
    summary: "<one-paragraph human-readable narrative of this turn's output>",
    artifacts: null,
    verdict: null,
    next_action_request: null,
    failure: null,
  };

  if (isOuterDiscoveryLead) {
    base.output_kind = "spec_proposal";
    base.contribution_kind = "lead_draft";
    base.artifacts = {
      problem_framing: "<what user-facing problem this milestone solves>",
      user_value: "<who benefits and how>",
      scope_boundary: {
        in_scope: ["<bullet>"],
        out_of_scope: ["<bullet>"],
      },
    };
    base.summary =
      "Spec CP draft: <1–3 sentences summarising problem, user value, and scope>";
    return base;
  }

  if (isOuterReviewerVerdict) {
    base.output_kind = "verdict";
    base.contribution_kind = "review_verdict";
    base.verdict = {
      result: "request_changes",
      rationale: "<concrete reason — cite the spec section or AC-ID>",
    };
    base.summary =
      "Reviewer verdict on the proposed Spec/Plan: request_changes / spec_accept / spec_reject.";
    return base;
  }

  if (isInnerForgeBuild) {
    base.output_kind = "patch";
    base.contribution_kind = "lead_draft";
    base.tdd_phase = "red_green";
    base.artifacts = {
      patch_description: "<what files changed and why>",
      tests_added: ["<test name>"],
    };
    base.summary =
      "Inner TDD step (red_green or refactor): <what was implemented or refactored>";
    return base;
  }

  // Default fallback — generic lead_draft skeleton.
  return base;
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

/**
 * AGC-CONTEXT-BUDGET / TCC-CONTEXT-BUDGET enforcement (phase 8a, G2-1).
 *
 * Sums per-entry `token_estimate` (attached by `manifest-builder`) plus the
 * 4-part frontmatter / instruction / output-schema overhead, compares to the
 * `(parent_loop, phase_or_purpose)` cap from `resolveContextBudget`, and —
 * when over — drops manifest entries by AGC-CONTEXT-BUDGET truncation
 * priority (lowest fetch_scope first). Required entries are never dropped.
 *
 * On persistent overflow the function returns the AGC-INVALID classification
 * `context_budget_truncation` so the caller skips the LLM invocation. This
 * mirrors `parseAgentAuthored` / `enrichEnvelope` outcome shape.
 */

/** Truncation priority per AGC-CONTEXT-BUDGET (lowest = drop first). */
const FETCH_SCOPE_DROP_PRIORITY: Record<FetchScope, number> = {
  tree: 0,
  "body+turn_log": 1,
  "body+comments": 2,
  body: 3,
  metadata: 4,
};

/**
 * Per-entry overhead added on top of `token_estimate` to account for the
 * manifest JSON wrapping (commas, quoting, indentation). Deterministic
 * char/4-equivalent constant.
 */
const ENTRY_FRAMING_TOKENS = 8;

/**
 * Fixed prompt scaffolding (frontmatter + section headers + output schema
 * boilerplate). Empirically the assembled body without entries hovers near
 * 240 chars → ~60 tokens; we round up generously.
 */
const PROMPT_SCAFFOLD_TOKENS = 96;

export interface ComposePromptWithBudgetInput extends ComposePromptInput {
  /** Operator override map — when omitted the architecture default applies. */
  contextBudget?: ContextBudget;
  /**
   * Optional fixed instruction-body overhead estimate. Defaults to char/4
   * over the role-specific body the composer would produce.
   */
  extraInstructionTokenEstimate?: number;
}

export type ComposePromptWithBudgetOutcome =
  | {
      ok: true;
      body: string;
      manifest: ContextManifest;
      droppedEntries: ManifestEntry[];
      tokenEstimate: number;
      cap: number;
    }
  | {
      ok: false;
      reason: "context_budget_truncation";
      detail: string;
      cap: number | null;
      tokenEstimate: number;
    };

export function composePromptWithBudget(
  input: ComposePromptWithBudgetInput,
): ComposePromptWithBudgetOutcome {
  const cap = resolveContextBudget(
    input.contextBudget,
    input.parentLoop,
    input.phaseOrPurpose,
  );
  if (cap == null) {
    // Unknown (loop, step) — caller misuse. Fail closed with the same
    // AGC-INVALID classification so the call path is uniform.
    return {
      ok: false,
      reason: "context_budget_truncation",
      detail: `unknown (parent_loop, phase_or_purpose) pair: ${input.parentLoop}.${input.phaseOrPurpose}`,
      cap: null,
      tokenEstimate: 0,
    };
  }
  const instructionOverhead =
    input.extraInstructionTokenEstimate ??
    Math.ceil(
      (input.extraInstruction != null ? input.extraInstruction.length : 0) / 4,
    );
  const baseOverhead = PROMPT_SCAFFOLD_TOKENS + instructionOverhead;

  const entries = [...input.manifest.entries];
  const droppable = sortDroppable(entries);
  let droppedEntries: ManifestEntry[] = [];

  let total = computeTotal(entries, baseOverhead);
  while (total > cap.token_hard_cap && droppable.length > 0) {
    const victim = droppable.shift()!;
    const idx = entries.indexOf(victim);
    if (idx >= 0) entries.splice(idx, 1);
    droppedEntries.push(victim);
    total = computeTotal(entries, baseOverhead);
  }

  if (total > cap.token_hard_cap) {
    return {
      ok: false,
      reason: "context_budget_truncation",
      detail: `context budget overflow after low-priority truncation: ${total} > cap ${cap.token_hard_cap} (loop=${input.parentLoop} step=${input.phaseOrPurpose}, dropped=${droppedEntries.length}, required-remaining=${entries.filter((e) => e.required).length})`,
      cap: cap.token_hard_cap,
      tokenEstimate: total,
    };
  }

  const truncatedManifest: ContextManifest = {
    ...input.manifest,
    entries,
  };
  const body = composePrompt({ ...input, manifest: truncatedManifest });
  return {
    ok: true,
    body,
    manifest: truncatedManifest,
    droppedEntries,
    tokenEstimate: total,
    cap: cap.token_hard_cap,
  };
}

function computeTotal(entries: ManifestEntry[], baseOverhead: number): number {
  let total = baseOverhead;
  for (const e of entries) {
    total += entryTokenCost(e) + ENTRY_FRAMING_TOKENS;
  }
  return total;
}

/**
 * Returns the deterministic token cost for a manifest entry. When
 * `token_estimate` is present (phase 8a manifests) it is used verbatim; when
 * absent (legacy / hand-built manifests) we recompute the same char/4
 * heuristic over the entry header so the budget is never silently bypassed.
 */
function entryTokenCost(entry: ManifestEntry): number {
  if (entry.token_estimate != null) return entry.token_estimate;
  const { token_estimate: _omit, ...header } = entry;
  return estimateTokensFromHeader(header);
}

/**
 * Returns the entries eligible for truncation, ordered lowest-priority
 * first (drop first). Required entries are excluded — overflow with only
 * required entries surfaces as `context_budget_truncation`.
 */
function sortDroppable(entries: ManifestEntry[]): ManifestEntry[] {
  const droppable = entries.filter((e) => !e.required);
  droppable.sort((a, b) => {
    const pa = FETCH_SCOPE_DROP_PRIORITY[a.fetch_scope];
    const pb = FETCH_SCOPE_DROP_PRIORITY[b.fetch_scope];
    if (pa !== pb) return pa - pb;
    // Tiebreaker: drop the larger entry first so each drop maximizes savings.
    return entryTokenCost(b) - entryTokenCost(a);
  });
  return droppable;
}
