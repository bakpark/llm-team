/**
 * RGC-LEASE-KINDS Lease port (4-kind hierarchy + acquisition order).
 *
 * Single seam for claim / release / renew / sweepStale. The port surface is
 * agnostic to lease_kind — kind-specific invariants (e.g. slot_lock is short
 * transaction only) are enforced at the application layer
 * (`application/lease-acquisition-order.ts`). Adapters guarantee:
 *
 *   - **CAS**: `claim` succeeds for at most one caller per `object_id`.
 *     Concurrent claims must surface `claim_failed`, not throw.
 *   - **Monotonic token**: every successful claim returns a `lease_token`
 *     strictly greater than every prior token issued for the same
 *     `object_id`. Operational writes cite the token; the ledger rejects
 *     writes citing a smaller token (`stale`).
 *   - **TTL honored**: `expires_at = claimed_at + ttl_ms`. `renew` extends
 *     `expires_at` by re-stamping the lease record. `sweepStale` returns
 *     leases whose `expires_at < now`.
 *   - **Idempotent release**: releasing an already-released or unknown lease
 *     returns `released=false` rather than throwing.
 */
import type { Lease, LeaseKind } from "../domain/schema/lease.js";

export interface ClaimInput {
  /** Discriminator — drives which auxiliary fields are recorded on the lease. */
  leaseKind: LeaseKind;
  /** Canonical key the lease protects. Composite keys are serialized by the caller. */
  objectId: string;
  /** Identifies the worker / process holding the lease. */
  workerId: string;
  /** Resolved TTL (millis). The lease-ttl-resolver is the canonical source. */
  ttlMs: number;
  /** Provenance of the resolved TTL — recorded on the lease for telemetry. */
  ttlSource: Lease["ttl_source"];
  /** target.identity.target_id — every lease records its owning target. */
  targetId: string;
  /** Variant-specific auxiliaries. Validated against leaseKind by the adapter. */
  aux: ClaimAux;
}

export type ClaimAux =
  | { kind: "slot_lock"; milestone_id: string; slot_kind: "discovery" | "delivery" }
  | { kind: "slice_lease"; slice_id: string }
  | { kind: "session_lease"; session_id: string; agent_profile_id: string }
  | {
      kind: "turn_lease";
      session_id: string;
      turn_index: number;
      agent_profile_id: string;
    };

export type ClaimResult =
  | { result: "acquired"; lease: Lease }
  | { result: "claim_failed"; existingHolder: string; existingLeaseId: string };

export interface ReleaseInput {
  leaseId: string;
  leaseToken: string;
}

export interface RenewInput {
  leaseId: string;
  leaseToken: string;
  newTtlMs: number;
}

export interface SweepStaleInput {
  /** Logical now. Adapters use clock.now() if omitted. */
  now?: Date;
  /** Optional kind filter — phase-4 daemon sweeper passes all kinds. */
  kinds?: readonly LeaseKind[];
}

export interface LeasePort {
  claim(input: ClaimInput): Promise<ClaimResult>;
  release(input: ReleaseInput): Promise<{ released: boolean }>;
  renew(input: RenewInput): Promise<{ renewed: boolean; newExpiresAt: string | null }>;
  /** Returns expired leases. Sweeper consumers do the actual recovery dispatch. */
  sweepStale(input?: SweepStaleInput): Promise<Lease[]>;
  /** Diagnostic — list active leases (post-sweep snapshot). */
  list(): Promise<Lease[]>;
}
