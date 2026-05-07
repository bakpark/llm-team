import { ZodError } from "zod";
import {
  AgentAuthoredEnvelope,
  Envelope,
  type AgentAuthoredEnvelope as AgentAuthoredEnvelopeT,
  type Envelope as EnvelopeT,
} from "../domain/schema/envelope.js";
import { extendedValidate } from "./envelope-extended-validator.js";

/**
 * AGC-OUTPUT envelope parser, runtime enricher, and post-enrichment matrix
 * validator. Together with `envelope-extended-validator.ts` this module is
 * the single seam that classifies AGC-INVALID reasons.
 *
 * Flow per AGC-OUTPUT-RUNTIME-ENRICH:
 *   raw_text → parseAgentAuthored
 *            → enrichEnvelope({idempotency_key, runtime_metadata})
 *            → validateEnvelope (matrix lookup)
 */

export const AGC_INVALID_REASONS = [
  "schema_violation",
  "manifest_outside_read",
  "missing_required_envelope_field",
  "missing_revision_pins",
  "enum_outside",
  "matrix_violation",
  "phase_or_purpose_outside_loop",
  "session_turn_collision",
  "scope_violation",
  "tdd_strict_violation",
  "legacy_field_present",
  "operational_side_effect",
  "secret_leak",
  "enrich_key_collision",
  "issue_body_layer_mixed",
  "prompt_layout_violation",
  "header_echo_mismatch",
  "decision_reason_missing",
  "turn_ordering_violation",
  "verdict_overwrite",
  "context_budget_truncation",
  "agent_authored_runtime_metadata",
  "agent_authored_idempotency_key",
] as const;
export type AgcInvalidReason = (typeof AGC_INVALID_REASONS)[number];

export class AgcInvalidError extends Error {
  readonly reason: AgcInvalidReason;
  readonly detail: string;
  constructor(reason: AgcInvalidReason, detail: string) {
    super(`AGC-INVALID:${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

export type Ok<T> = { ok: true; value: T };
export type Fail = { ok: false; reason: AgcInvalidReason; detail: string };
export type ParseOutcome<T> = Ok<T> | Fail;

const LEGACY_FIELDS = ["agent_role", "operation", "phase_run_id"] as const;
const CALLER_ONLY_FIELDS = ["idempotency_key", "runtime_metadata"] as const;

/**
 * Pre-enrichment parser. Validates Agent-authored shape and rejects envelopes
 * containing Caller-only fields or deprecated legacy fields.
 */
export function parseAgentAuthored(
  raw: unknown,
): ParseOutcome<AgentAuthoredEnvelopeT> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      reason: "schema_violation",
      detail: "envelope must be a JSON object",
    };
  }
  const obj = raw as Record<string, unknown>;
  for (const f of CALLER_ONLY_FIELDS) {
    if (f in obj) {
      return {
        ok: false,
        reason:
          f === "idempotency_key"
            ? "agent_authored_idempotency_key"
            : "agent_authored_runtime_metadata",
        detail: `Agent must not produce \`${f}\` (AGC-OUTPUT-RUNTIME-ENRICH)`,
      };
    }
  }
  for (const f of LEGACY_FIELDS) {
    if (f in obj) {
      return {
        ok: false,
        reason: "legacy_field_present",
        detail: `legacy field \`${f}\` is forbidden`,
      };
    }
  }
  const parsed = AgentAuthoredEnvelope.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_violation",
      detail: zodMessage(parsed.error),
    };
  }
  return { ok: true, value: parsed.data };
}

export interface EnrichmentInputs {
  idempotency_key: string;
  runtime_metadata: Record<string, unknown>;
}

/**
 * Caller enrichment. Adds idempotency_key + runtime_metadata, and runs
 * post-enrichment schema validation.
 *
 * Caller-side construction means key-collision with Agent fields is
 * impossible (Agent envelope was already rejected if those keys were
 * present). However the caller may still pass a runtime_metadata key that
 * shadows a top-level envelope field name — we surface that as
 * `enrich_key_collision`.
 */
export function enrichEnvelope(
  agent: AgentAuthoredEnvelopeT,
  inputs: EnrichmentInputs,
): ParseOutcome<EnvelopeT> {
  const reservedKeys = new Set(Object.keys(agent));
  reservedKeys.add("idempotency_key");
  reservedKeys.add("runtime_metadata");
  for (const key of Object.keys(inputs.runtime_metadata)) {
    if (reservedKeys.has(key)) {
      return {
        ok: false,
        reason: "enrich_key_collision",
        detail: `runtime_metadata key \`${key}\` collides with an envelope field`,
      };
    }
  }
  const parsed = Envelope.safeParse({
    ...agent,
    idempotency_key: inputs.idempotency_key,
    runtime_metadata: inputs.runtime_metadata,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_violation",
      detail: zodMessage(parsed.error),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Post-enrichment matrix validator. Pairs with `parseAgentAuthored` +
 * `enrichEnvelope` to give the full AGC-INVALID classification surface.
 */
export function validateEnvelope(env: EnvelopeT): ParseOutcome<EnvelopeT> {
  const r = extendedValidate(env);
  if (r.ok) return { ok: true, value: env };
  return { ok: false, reason: r.reason, detail: r.detail };
}

function zodMessage(err: ZodError): string {
  return err.errors
    .map((e) => `${e.path.join(".") || "<root>"}: ${e.message}`)
    .join("; ");
}
