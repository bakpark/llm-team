import { readFile } from "node:fs/promises";
import type { ContextManifest } from "../domain/schema/manifest.js";
import type {
  AgentAuthoredEnvelope,
  Envelope,
} from "../domain/schema/envelope.js";
import type {
  LlmRunnerInput,
  LlmRunnerPort,
  LlmAgentProfileId,
  AgentRole,
  ParentLoop as RunnerParentLoop,
} from "../ports/llm-runner.js";
import {
  enrichEnvelope,
  parseAgentAuthored,
  validateEnvelope,
  type AgcInvalidReason,
} from "./envelope.js";
import type { ManifestBuilder } from "./manifest-builder.js";
import { composePromptWithBudget } from "./prompt-compose.js";
import { resolveManifestEntries } from "./manifest-resolve.js";
import type { ContextBudget } from "../config/target-schema.js";
import type { IdempotencyParts } from "./idempotency.js";
import type { StorePort } from "../ports/store.js";
import {
  checkHeaderEcho as checkHeaderEchoFields,
  writePromptTmp,
  writePromptUnderWorkdir,
} from "./agent-run-orchestrator.js";

/**
 * Phase 2 agent-io pipeline (#AGC-PROMPT-SERIALIZATION + #ARC-CALL-SEMANTICS).
 *
 * Single seam combining prompt assembly, LLM runner invocation, envelope
 * parsing/enrichment/matrix validation, and revision-pin recheck. The
 * caller is responsible for persisting the envelope and turn — agent-io
 * is read-only on the store.
 */

export type AgentIoOutcome =
  | {
      ok: true;
      envelope: Envelope;
      diagnosticsRef: string;
      stalePins: { object_id: string; recorded_pin: string }[];
    }
  | {
      ok: false;
      stage:
        | "prompt_compose"
        | "lr_invoke"
        | "envelope_parse"
        | "envelope_enrich"
        | "matrix_validate";
      reason: AgcInvalidReason | "lr_exit_status";
      detail: string;
      diagnosticsRef: string;
    };

export interface AgentIoInput {
  agentProfileId: LlmAgentProfileId;
  agentRoleInSession: AgentRole;
  parentLoop: RunnerParentLoop;
  phaseOrPurpose: string;
  sessionId: string;
  turnIndex: number;
  manifest: ContextManifest;
  workspaceRevisionPin: string;
  /** Slice-local worktree path for inner; read-only marker for outer/middle. */
  agentCwd: string;
  timeoutSec: number;
  /**
   * Idempotency parts used by enrichEnvelope. The Caller composes these per
   * SOC-IDEMPOTENCY 3-scope rules. agent-io does not invent the parts.
   */
  idempotency: IdempotencyParts;
  /**
   * Runtime metadata bag for AGC-OUTPUT-RUNTIME-ENRICH. Agent-side keys are
   * already rejected upstream (AgentAuthoredEnvelope.strict()).
   */
  runtimeMetadata: Record<string, unknown>;
  /**
   * TCC-CONTEXT-BUDGET / AGC-CONTEXT-BUDGET (phase 8a, G2-1) — optional
   * operator override map. When omitted, `composePromptWithBudget` falls back
   * to the architecture default cap for the (parent_loop, phase_or_purpose)
   * pair. Persistent overflow surfaces as an AGC-INVALID
   * `context_budget_truncation` outcome at the `prompt_compose` stage,
   * before the LLM runner is invoked.
   */
  contextBudget?: ContextBudget;
}

export interface AgentIoDeps {
  llmRunner: LlmRunnerPort;
  manifestBuilder: ManifestBuilder;
  /**
   * Optional StorePort — when supplied, `callAgent` resolves manifest-entry
   * bodies via `resolveManifestEntries` and inlines them under `# Inputs` in
   * the composed prompt (incident-1b Bug B). When omitted, the composer falls
   * back to manifest-header-only inlining; required body entries surface a
   * sentinel placeholder so the LLM is told the body is not present.
   */
  store?: StorePort;
  /**
   * phase-0-stabilization C — absolute path to the workdir root. When
   * provided, the composed prompt body is persisted to
   * `<workdirRoot>/prompts/<sessionId>/<turnIndex>.md` instead of the
   * historical OS-tmp `mkdtempSync` path. Predictable layout enables
   * post-incident replay (`<workdir>/prompts/...` survives daemon restarts
   * and is colocated with `sessions/`, `manifests/`, `ledger/`).
   *
   * When omitted, the legacy tmp behaviour is preserved so callers (single-
   * shot tests, fixtures-only adapters) that have no workdir notion keep
   * working without churn. Production daemon wiring always sets this — see
   * `cli/daemon.ts` and `cli/runner.ts`.
   */
  workdirRoot?: string;
}

export async function callAgent(
  input: AgentIoInput,
  deps: AgentIoDeps,
): Promise<AgentIoOutcome> {
  // AGC-CONTEXT-BUDGET enforcement: build the prompt under the
  // (parent_loop, phase_or_purpose) cap. On persistent overflow surface an
  // AGC-INVALID `context_budget_truncation` outcome before the LLM runner is
  // invoked. The diagnosticsRef is empty here because no runner artefact
  // exists yet — callers persist the invalid envelope from the outcome.
  //
  // incident-1b Bug B: when a StorePort is wired into deps, resolve manifest
  // entries (currently milestone bodies) so `# Inputs` is populated. Required
  // entries that fail to resolve surface as a `prompt_compose` AGC-INVALID
  // outcome; non-required failures are skipped silently.
  let resolvedEntries;
  if (deps.store != null) {
    try {
      resolvedEntries = await resolveManifestEntries(deps.store, input.manifest, {
        strict: true,
      });
    } catch (e) {
      return {
        ok: false,
        stage: "prompt_compose",
        reason: "prompt_layout_violation",
        detail: `manifest body resolution failed: ${(e as Error).message}`,
        diagnosticsRef: "",
      };
    }
  }
  const composeOut = composePromptWithBudget({
    agentProfileId: input.agentProfileId,
    agentRoleInSession: input.agentRoleInSession,
    parentLoop: input.parentLoop,
    phaseOrPurpose: input.phaseOrPurpose,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    manifest: input.manifest,
    workspaceRevisionPin: input.workspaceRevisionPin,
    contextBudget: input.contextBudget,
    resolvedEntries,
  });
  if (!composeOut.ok) {
    return {
      ok: false,
      stage: "prompt_compose",
      reason: composeOut.reason,
      detail: composeOut.detail,
      diagnosticsRef: "",
    };
  }
  const promptBody = composeOut.body;
  const promptRef =
    deps.workdirRoot != null
      ? await writePromptUnderWorkdir(
          deps.workdirRoot,
          input.sessionId,
          input.turnIndex,
          promptBody,
        )
      : await writePromptTmp(input.sessionId, input.turnIndex, promptBody);

  const runnerInput: LlmRunnerInput = {
    agentProfileId: input.agentProfileId,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    parentLoop: input.parentLoop,
    purpose: input.phaseOrPurpose,
    agentRoleInSession: input.agentRoleInSession,
    promptRef,
    sessionContextRef: null,
    manifestId: input.manifest.manifest_id,
    agentCwd: input.agentCwd,
    timeoutSec: input.timeoutSec,
    // The runner uses this as a transport-level dedup key. Envelope-level
    // idempotency_key is composed below by enrichEnvelope.
    idempotencyKey: "",
  };
  const r = await deps.llmRunner.invoke(runnerInput);
  if (r.exitStatus !== "ok") {
    return {
      ok: false,
      stage: "lr_invoke",
      reason: "lr_exit_status",
      detail: `LlmRunner exitStatus=${r.exitStatus}; envelopeRef=${r.envelopeRef}`,
      diagnosticsRef: r.diagnosticsRef,
    };
  }
  const envelopeBody = await readFile(r.envelopeRef, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(envelopeBody);
  } catch (e) {
    return {
      ok: false,
      stage: "envelope_parse",
      reason: "schema_violation",
      detail: `envelope body is not valid JSON: ${(e as Error).message}`,
      diagnosticsRef: r.diagnosticsRef,
    };
  }
  const parsed = parseAgentAuthored(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      stage: "envelope_parse",
      reason: parsed.reason,
      detail: parsed.detail,
      diagnosticsRef: r.diagnosticsRef,
    };
  }
  // Header echo invariant: the agent must replay header fields back. We
  // assert the seven echo fields match the prompt frontmatter.
  const echo = checkHeaderEcho(parsed.value, input);
  if (echo != null) {
    return {
      ok: false,
      stage: "envelope_parse",
      reason: "header_echo_mismatch",
      detail: echo,
      diagnosticsRef: r.diagnosticsRef,
    };
  }
  const enriched = enrichEnvelope(parsed.value, {
    idempotency: input.idempotency,
    runtime_metadata: input.runtimeMetadata,
  });
  if (!enriched.ok) {
    return {
      ok: false,
      stage: "envelope_enrich",
      reason: enriched.reason,
      detail: enriched.detail,
      diagnosticsRef: r.diagnosticsRef,
    };
  }
  const validated = validateEnvelope(enriched.value);
  if (!validated.ok) {
    return {
      ok: false,
      stage: "matrix_validate",
      reason: validated.reason,
      detail: validated.detail,
      diagnosticsRef: r.diagnosticsRef,
    };
  }
  const stale = await deps.manifestBuilder.recheckPins(input.manifest);
  return {
    ok: true,
    envelope: validated.value,
    diagnosticsRef: r.diagnosticsRef,
    stalePins: stale.map((e) => ({
      object_id: e.object_id,
      recorded_pin: e.revision_pin,
    })),
  };
}

/**
 * Phase 0.5 — `writePromptTmp`, `writePromptUnderWorkdir`, and the
 * field-level header-echo check now live in
 * `./agent-run-orchestrator.ts` so the upcoming PR-first system can
 * reuse the LLM-neutral helpers without dragging in envelope schema
 * coupling. Behaviour is unchanged.
 */
function checkHeaderEcho(
  envelope: AgentAuthoredEnvelope,
  input: AgentIoInput,
): string | null {
  return checkHeaderEchoFields(
    {
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      parent_loop: input.parentLoop,
      phase_or_purpose: input.phaseOrPurpose,
      agent_profile_id: input.agentProfileId,
      agent_role_in_session: input.agentRoleInSession,
      manifest_id: input.manifest.manifest_id,
    },
    {
      session_id: envelope.session_id,
      turn_index: envelope.turn_index,
      parent_loop: envelope.parent_loop,
      phase_or_purpose: envelope.phase_or_purpose,
      agent_profile_id: envelope.agent_profile_id,
      agent_role_in_session: envelope.agent_role_in_session,
      manifest_id: envelope.manifest_id,
    },
  );
}
