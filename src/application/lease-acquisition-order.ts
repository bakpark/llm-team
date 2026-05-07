/**
 * RGC-LEASE-KINDS acquisition order enforcement (always_hard).
 *
 * The 4-kind hierarchy is:
 *
 *   slot_lock  (outer)
 *     └── slice_lease
 *           └── session_lease
 *                 └── turn_lease  (inner)
 *
 * Callers must claim outer → inner. Mid-call upgrades are forbidden — a
 * worker holding a slice_lease cannot claim a slot_lock without first
 * releasing the slice_lease.
 *
 * Pure function. Application code calls `assertCanAcquire` immediately
 * before invoking `LeasePort.claim`. The CI gate (RGC-DAEMON-STARTUP) runs
 * the same check on a static graph of every call site as part of daemon
 * startup. A throw here is an invariant violation, not a recoverable
 * error.
 */
import type { LeaseKind } from "../domain/schema/lease.js";

export class LeaseAcquisitionOrderError extends Error {
  constructor(
    public readonly held: readonly LeaseKind[],
    public readonly requested: LeaseKind,
  ) {
    super(
      `lease acquisition order violation: holding [${held.join(", ")}] cannot claim ${requested} (RGC-LEASE-KINDS — outer → inner only)`,
    );
    this.name = "LeaseAcquisitionOrderError";
  }
}

const RANK: Record<LeaseKind, number> = {
  slot_lock: 0,
  slice_lease: 1,
  session_lease: 2,
  turn_lease: 3,
};

/**
 * Throws if the requested lease cannot be claimed while holding `heldKinds`.
 * `heldKinds` is the multiset of lease kinds the worker currently holds; the
 * application supplies it from its own bookkeeping (no shared registry — the
 * port is intentionally stateless).
 */
export function assertCanAcquire(
  heldKinds: readonly LeaseKind[],
  requested: LeaseKind,
): void {
  const requestedRank = RANK[requested];
  for (const held of heldKinds) {
    const heldRank = RANK[held];
    if (heldRank >= requestedRank) {
      throw new LeaseAcquisitionOrderError(heldKinds, requested);
    }
  }
}

/**
 * Same as `assertCanAcquire` but returns a structured result instead of
 * throwing. Used by the CI gate to collect every violation in one pass.
 */
export function checkCanAcquire(
  heldKinds: readonly LeaseKind[],
  requested: LeaseKind,
):
  | { ok: true }
  | { ok: false; held: readonly LeaseKind[]; requested: LeaseKind } {
  const requestedRank = RANK[requested];
  for (const held of heldKinds) {
    const heldRank = RANK[held];
    if (heldRank >= requestedRank) {
      return { ok: false, held: heldKinds, requested };
    }
  }
  return { ok: true };
}

export const LEASE_ORDER_RANK = RANK;
