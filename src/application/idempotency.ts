/**
 * SOC-IDEMPOTENCY 3-scope idempotency-key compositor — single authority.
 *
 * Used by both:
 *   - `application/ledger.ts` when appending transition rows.
 *   - `application/envelope.ts` when enriching an Agent envelope into the
 *     canonical AGC-OUTPUT envelope (the envelope's `idempotency_key`
 *     field is required by AGC-OUTPUT-RUNTIME-ENRICH).
 *
 * Determinism: given the same `IdempotencyParts`, this function returns the
 * same string, byte-for-byte. Callers must NOT pass arbitrary strings as
 * idempotency keys — that would skip the canonical composition and break
 * the SOC-IDEMPOTENCY guarantees.
 */

export type IdempotencyScope =
  | "per_turn"
  | "per_session_outcome"
  | "per_merge"
  | "intake"
  | "slot_promotion"
  | "verification"
  | "recover"
  | "external_observation"
  | "signal_apply"
  | "pause_resume";

export interface PerTurnIdempotencyParts {
  session_id: string;
  turn_index: number;
  agent_profile_id: string;
  manifest_id: string;
  input_revision_pins: readonly string[];
}

export interface PerSessionOutcomeIdempotencyParts {
  session_id: string;
  final_verdict: string;
  finalization_decision: string;
  workspace_revision_pin_at_convergence: string | null;
}

export interface PerMergeIdempotencyParts {
  slice_merge_id: string;
  pre_merge_workspace_revision: string;
  trunk_base_revision_at_merge_attempt: string;
}

export type IdempotencyParts =
  | { scope: "per_turn"; parts: PerTurnIdempotencyParts }
  | { scope: "per_session_outcome"; parts: PerSessionOutcomeIdempotencyParts }
  | { scope: "per_merge"; parts: PerMergeIdempotencyParts }
  | {
      scope: Exclude<
        IdempotencyScope,
        "per_turn" | "per_session_outcome" | "per_merge"
      >;
      parts: Record<string, string | number | null | undefined | readonly string[]>;
    };

export function idempotencyKey(input: IdempotencyParts): string {
  switch (input.scope) {
    case "per_turn": {
      const p = input.parts;
      const pins = [...p.input_revision_pins].sort().join(",");
      return [
        "per_turn",
        p.session_id,
        p.turn_index,
        p.agent_profile_id,
        p.manifest_id,
        pins,
      ].join("|");
    }
    case "per_session_outcome": {
      const p = input.parts;
      return [
        "per_session_outcome",
        p.session_id,
        p.final_verdict,
        p.finalization_decision,
        p.workspace_revision_pin_at_convergence ?? "",
      ].join("|");
    }
    case "per_merge": {
      const p = input.parts;
      return [
        "per_merge",
        p.slice_merge_id,
        p.pre_merge_workspace_revision,
        p.trunk_base_revision_at_merge_attempt,
      ].join("|");
    }
    default: {
      const parts = Object.entries(input.parts)
        .map(
          ([k, v]) =>
            [k, Array.isArray(v) ? [...v].sort().join(",") : v ?? ""] as const,
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      return [input.scope, parts].join("|");
    }
  }
}
