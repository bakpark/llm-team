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
import type { ResolvedEntry } from "./manifest-resolve.js";

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

/**
 * Forbidden top-level container keys at the AGC-OUTPUT envelope root. Shared
 * between `renderOutputSchema` (prompt directive) and the regression test so
 * both reference the same source of truth.
 */
export const OUTPUT_SCHEMA_FORBIDDEN_KEYS = [
  "header",
  "target",
  "agc_output_version",
  "next_action_hint",
  "input_status",
  "spec_proposal",
  "task_plan",
  "slice_decomposition",
  "patch",
  "milestone_package",
  "proposal_artifact",
] as const;

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
  /**
   * Resolved manifest-entry bodies (incident-1b Bug B). When provided, the
   * composer renders a `# Inputs` section right after `## Manifest` containing
   * each body verbatim, keyed to its manifest entry. When omitted or empty,
   * required `body` entries surface a sentinel placeholder so the LLM is told
   * the body was NOT inlined (no silent degradation).
   */
  resolvedEntries?: ResolvedEntry[];
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
  const inputsSection = renderInputsSection(input);
  const contextLines = [
    "# Context",
    "",
    "## Manifest",
    "",
    "```json",
    manifestJson,
    "```",
    "",
  ];
  if (inputsSection != null) {
    contextLines.push(inputsSection, "");
  }
  contextLines.push(`workspace_revision_pin: ${input.workspaceRevisionPin}`);
  const context = contextLines.join("\n");
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
 * Render `# Inputs` — verbatim bodies for manifest entries that have been
 * resolved through `resolveManifestEntries`. When a `required=true` entry
 * with `fetch_scope=body` is NOT resolved, emit a sentinel placeholder so the
 * LLM is told the body was not inlined (rather than silently producing an
 * empty prompt). Returns null when the section would be empty (no resolved
 * entries AND no required-body sentinels needed).
 */
function renderInputsSection(input: ComposePromptInput): string | null {
  const resolvedByIndex = new Map<number, string>();
  for (const r of input.resolvedEntries ?? []) {
    resolvedByIndex.set(r.manifest_entry_index, r.body);
  }
  const blocks: string[] = [];
  for (let i = 0; i < input.manifest.entries.length; i++) {
    const entry = input.manifest.entries[i]!;
    const body = resolvedByIndex.get(i);
    if (body != null) {
      blocks.push(
        [
          `### entry[${i}] ${entry.object_kind}/${entry.object_id} (fetch_scope=${entry.fetch_scope})`,
          "",
          body,
        ].join("\n"),
      );
      continue;
    }
    if (entry.required && entry.fetch_scope === "body") {
      blocks.push(
        [
          `### entry[${i}] ${entry.object_kind}/${entry.object_id} (fetch_scope=${entry.fetch_scope})`,
          "",
          "[BODY NOT INLINED — resolution layer did not provide this entry's body. Do NOT fabricate; if the body is essential, return failure.type=need_context with a rationale citing this entry.]",
        ].join("\n"),
      );
    }
  }
  if (blocks.length === 0) return null;
  return ["## Inputs", "", ...blocks].join("\n\n");
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
    "Conditionally required top-level fields — set to null only when the",
    "loop/output_kind permits it (post-enrichment validator enforces these):",
    "- `slice_id` (ULID): REQUIRED when `parent_loop` ∈ {middle, inner};",
    "  may be null only for `parent_loop=outer`.",
    "- `slice_kind` (\"feature\" | \"internal\"): REQUIRED when `parent_loop` ∈",
    "  {middle, inner}; may be null only for `parent_loop=outer`.",
    "- `tdd_phase` (\"red_green\" | \"refactor\"): REQUIRED when",
    "  `parent_loop=inner`; null otherwise.",
    "- `verdict` ({ result, rationale }): REQUIRED when `output_kind=verdict`",
    "  or `output_kind=milestone_package`; null otherwise.",
    "- `failure` ({ type, rationale }): REQUIRED when `output_kind=failure`;",
    "  null otherwise. The loop-conditional fields above still apply.",
    "  `failure.type` MUST be exactly one of: `need_context`, `invalid_output`,",
    "  `no_progress`, `regression`, `scope_violation`. Do NOT invent other",
    "  values (e.g. `missing_required_input`) — pick `need_context` when the",
    "  manifest declares a required body that is not inlined or otherwise",
    "  unavailable, `invalid_output` when prior turns produced malformed",
    "  artefacts, `no_progress` when retries cannot advance the goal,",
    "  `regression` when a prior verdict was undone, and `scope_violation`",
    "  when the requested change exceeds the declared slice scope. Free-text",
    "  context goes in `failure.rationale`.",
    "",
    "Optional top-level fields (use null when not applicable — never omit a key):",
    "- `parent_review_verdict_id` (ULID | null)",
    "- `artifacts` (record<string, unknown> | null — encode structured details such as",
    "  problem framing, scenarios, scope_boundary, etc. INSIDE this bag, not at root)",
    "- `next_action_request` ({ addressed_to, intent, evidence_request[], proposal_artifact_ref? } | null)",
    "",
    `Forbidden keys at the root: ${OUTPUT_SCHEMA_FORBIDDEN_KEYS.map((k) => "`" + k + "`").join(", ")}.`,
    "Encode artifact details inside the `artifacts` record and the human",
    "narrative inside `summary`.",
    "",
    "When you need a follow-up turn from another agent, populate",
    "`next_action_request` as `{ addressed_to: <recipient>, intent: <short",
    "string>, evidence_request: [{ kind, scope }, …], proposal_artifact_ref:",
    "<string|null> }`. `addressed_to` MUST be exactly one of: `atlas`,",
    "`forge`, `sentinel`, `scout`, `caller`. Otherwise set the whole field",
    "to `null`.",
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
  const PLACEHOLDER_SLICE_ID = "01HZS00000000000000000000A";
  const role = input.agentRoleInSession;
  const loop = input.parentLoop;
  const phase = input.phaseOrPurpose;

  // For middle/inner loops, slice_id + slice_kind are required by the
  // post-enrichment validator. Pre-fill placeholders so the example shape
  // survives `parseAgentAuthored -> enrichEnvelope -> validateEnvelope`.
  const sliceConditional =
    loop === "middle" || loop === "inner"
      ? { slice_id: PLACEHOLDER_SLICE_ID, slice_kind: "internal" }
      : { slice_id: null, slice_kind: null };

  const base: Record<string, unknown> = {
    session_id: input.sessionId,
    turn_index: input.turnIndex,
    parent_loop: loop,
    phase_or_purpose: phase,
    slice_id: sliceConditional.slice_id,
    slice_kind: sliceConditional.slice_kind,
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

  // outer reviewer verdicts (Discovery / Specification / Planning).
  if (
    loop === "outer" &&
    role !== "lead" &&
    role !== "observer" &&
    (phase === "Discovery" || phase === "Specification" || phase === "Planning")
  ) {
    base.output_kind = "verdict";
    base.contribution_kind = "review_verdict";
    base.verdict = {
      result: phase === "Planning" ? "request_changes" : "request_changes",
      rationale: "<concrete reason — cite the spec section or AC-ID>",
    };
    base.summary =
      "Reviewer verdict on the proposed Spec/Plan: request_changes / accept / reject.";
    return base;
  }

  if (loop === "outer" && role === "lead") {
    if (phase === "Discovery" || phase === "Specification") {
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
    if (phase === "Planning") {
      base.output_kind = "slice_decomposition";
      base.contribution_kind = "lead_draft";
      base.artifacts = {
        slices: [
          {
            slice_id: PLACEHOLDER_SLICE_ID,
            slice_kind: "internal",
            value_statement: "<what user/internal value this slice delivers>",
            ac_ids: ["<AC-ID>"],
            acceptance_tests: [{ path: "<path>", name: "<name>" }],
            declared_scope: ["<path>"],
            dependencies: [],
          },
        ],
      };
      base.summary =
        "Slice DAG: <count> slices decomposing the approved spec; acyclic.";
      return base;
    }
    if (phase === "Validation") {
      base.output_kind = "milestone_package";
      base.contribution_kind = "lead_draft";
      base.verdict = {
        result: "PASS",
        rationale: "<aggregate evidence summary across slices and AC-IDs>",
      };
      base.artifacts = {
        per_slice_evidence: [
          { slice_id: PLACEHOLDER_SLICE_ID, status: "<verification outcome>" },
        ],
      };
      base.summary =
        "Validation milestone_package: PASS / FAIL / STALE based on AC coverage.";
      return base;
    }
  }

  if (loop === "middle" && phase === "review") {
    base.output_kind = "verdict";
    base.contribution_kind = "review_verdict";
    base.verdict = {
      result: "approve",
      rationale: "<concrete reason — cite the slice AC-ID or test outcome>",
    };
    base.summary =
      "Middle review verdict: approve / request_changes for the slice patch.";
    return base;
  }

  if (loop === "middle" && phase === "merge") {
    // middle.merge has no AGC-CONTRIBUTION-OUTPUTS row for agents — observers
    // only, and Caller-side merge envelopes go through `session_outcome`.
    // Provide a generic lead_draft skeleton with placeholder slice fields so
    // the example shape still parses.
    base.output_kind = "spec_proposal";
    base.contribution_kind = "lead_draft";
    base.summary =
      "Middle merge observer note: <what merge state was observed>";
    return base;
  }

  if (loop === "inner" && phase === "tdd_build") {
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
 * Fixed prompt scaffolding (frontmatter + section headers + role-specific
 * instruction body + Output Schema directives + minimal-valid example
 * envelope). After the AGC-OUTPUT envelope contract was inlined the
 * empirical scaffold across all (parent_loop, phase_or_purpose, role)
 * combinations measured 920–1150 tokens (chars/4) on an empty manifest;
 * 1200 is the conservative round-up so `composePromptWithBudget` no longer
 * undercounts and risks bypassing `token_hard_cap`.
 */
const PROMPT_SCAFFOLD_TOKENS = 1200;

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

/** Multiplier applied to a manifest entry's `token_estimate` when validating
 * the resolved body length (chars/4). Resolved bodies that exceed this bound
 * surface as `context_budget_truncation` so the runner is never invoked with
 * a silently bloated prompt. Conservative — `token_estimate` is itself a
 * char/4 heuristic over the entry header only. */
const RESOLVED_BODY_SAFETY_MARGIN = 2;

export function composePromptWithBudget(
  input: ComposePromptWithBudgetInput,
): ComposePromptWithBudgetOutcome {
  // Validate resolved-body sizes against per-entry token_estimate before any
  // truncation work — surfacing a clear AGC-INVALID is preferable to silently
  // bloating the prompt past the runner cap.
  const oversize = checkResolvedBodyBudget(input);
  if (oversize != null) {
    return {
      ok: false,
      reason: "context_budget_truncation",
      detail: oversize,
      cap: null,
      tokenEstimate: 0,
    };
  }
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
  // Remap `resolvedEntries.manifest_entry_index` against the (possibly
  // truncated) entry list — original indices shift when low-priority entries
  // are dropped. Entries whose source was dropped are skipped (the body is no
  // longer needed since the corresponding manifest header is gone too).
  const remappedResolved =
    input.resolvedEntries != null && droppedEntries.length > 0
      ? remapResolvedEntries(
          input.resolvedEntries,
          input.manifest.entries,
          entries,
        )
      : input.resolvedEntries;
  const body = composePrompt({
    ...input,
    manifest: truncatedManifest,
    resolvedEntries: remappedResolved,
  });
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

/**
 * Validates that each `ResolvedEntry.body` fits within
 * `manifest.entries[i].token_estimate * RESOLVED_BODY_SAFETY_MARGIN` (chars/4
 * heuristic). Returns the first violation as a detail string, or null when
 * everything is within bounds.
 */
function checkResolvedBodyBudget(
  input: ComposePromptWithBudgetInput,
): string | null {
  const resolved = input.resolvedEntries;
  if (resolved == null || resolved.length === 0) return null;
  for (const r of resolved) {
    const entry = input.manifest.entries[r.manifest_entry_index];
    if (entry == null) continue;
    if (entry.token_estimate == null) continue;
    const actualTokens = Math.ceil(r.body.length / 4);
    const cap = entry.token_estimate * RESOLVED_BODY_SAFETY_MARGIN;
    if (actualTokens > cap) {
      return `resolved body for entry[${r.manifest_entry_index}] (${entry.object_kind}/${entry.object_id}) exceeds token_estimate × ${RESOLVED_BODY_SAFETY_MARGIN}: ${actualTokens} > ${cap}`;
    }
  }
  return null;
}

/**
 * After truncation drops a subset of manifest entries, the remaining entries
 * keep their relative order but their absolute indices change. Map each
 * `ResolvedEntry` from the original index space to the truncated one,
 * dropping resolved entries whose source manifest entry was removed.
 */
function remapResolvedEntries(
  resolved: ResolvedEntry[],
  originalEntries: ManifestEntry[],
  truncatedEntries: ManifestEntry[],
): ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const r of resolved) {
    const original = originalEntries[r.manifest_entry_index];
    if (original == null) continue;
    const newIndex = truncatedEntries.indexOf(original);
    if (newIndex < 0) continue;
    out.push({ manifest_entry_index: newIndex, body: r.body });
  }
  return out;
}
