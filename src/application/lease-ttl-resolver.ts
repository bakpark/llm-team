/**
 * Lease TTL resolver (TCC-LEASE-CONFIG + RGC-LEASE-KINDS §Lease TTL 정책).
 *
 * Pure function. Deterministic for the same inputs so claim/renew always
 * resolve the same TTL when no operator override fires. Returns both the
 * value and its provenance — the lease record stores `ttl_source` so
 * operators can audit which key fired.
 *
 * Precedence (highest → lowest):
 *   1. worker_override (operator-supplied at claim time)
 *   2. lease.ttl_by_phase[phase]                 (session_lease / slice_lease only — phase from session.purpose)
 *   3. lease.ttl_by_agent_profile[profile]      (turn_lease primarily; also accepted for session_lease)
 *   4. lease.ttl_by_lease_kind[kind]
 *   5. lease.ttl_default_ms
 *   6. HARDCODED_FALLBACK_MS (60_000)
 */
import type { LeaseKind } from "../domain/schema/lease.js";
import type { LeaseConfig } from "../config/target-schema.js";
import type { Lease } from "../domain/schema/lease.js";

export const HARDCODED_FALLBACK_MS = 60_000;

export interface ResolveTtlInput {
  leaseKind: LeaseKind;
  leaseConfig?: LeaseConfig;
  /** Phase string (Discovery / Specification / Planning / Validation / review / tdd_build / merge). */
  phase?: string | null;
  agentProfileId?: string | null;
  /** Operator override (millis). Highest precedence. */
  workerOverrideMs?: number;
}

export interface ResolvedTtl {
  ttlMs: number;
  source: Lease["ttl_source"];
}

export function resolveLeaseTtl(input: ResolveTtlInput): ResolvedTtl {
  // PR #63 review P1-9: worker_override is its own provenance — operator
  // forensic queries cannot distinguish it from `by_phase` if we collapse
  // them. The schema enum now carries `worker_override`.
  if (input.workerOverrideMs != null && input.workerOverrideMs > 0)
    return { ttlMs: input.workerOverrideMs, source: "worker_override" };

  const cfg = input.leaseConfig;
  if (cfg != null) {
    if (input.phase != null && cfg.ttl_by_phase?.[input.phase] != null) {
      return { ttlMs: cfg.ttl_by_phase[input.phase]!, source: "by_phase" };
    }
    if (
      input.agentProfileId != null &&
      cfg.ttl_by_agent_profile?.[input.agentProfileId] != null
    ) {
      return {
        ttlMs: cfg.ttl_by_agent_profile[input.agentProfileId]!,
        source: "by_agent_profile",
      };
    }
    const k = cfg.ttl_by_lease_kind?.[input.leaseKind];
    if (k != null) return { ttlMs: k, source: "by_lease_kind" };
    if (cfg.ttl_default_ms != null)
      return { ttlMs: cfg.ttl_default_ms, source: "ttl_default" };
  }
  return { ttlMs: HARDCODED_FALLBACK_MS, source: "hardcoded_fallback" };
}
