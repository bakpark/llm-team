import { z } from "zod";
import { UlidString } from "../ids.js";

/**
 * RGC-LEASE-KINDS Lease record schema.
 *
 * Field names follow the contract directly:
 *   lease_id, lease_kind, object_id, worker_id, claimed_at, expires_at,
 *   lease_token, agent_profile_id (turn / session lease only).
 *
 * `object_id` is the canonical key the lease protects. For composite keys
 * (slot_lock = (milestone_id, slot_kind), turn_lease = (session_id, turn_index))
 * the caller serializes them into a single string. Variant-specific fields are
 * preserved as auxiliary metadata for ergonomic dispatch — they must agree
 * with `object_id` (enforced by validation in caller code).
 */

export const LeaseKind = z.enum([
  "slot_lock",
  "slice_lease",
  "session_lease",
  "turn_lease",
]);
export type LeaseKind = z.infer<typeof LeaseKind>;

const baseLeaseShape = {
  lease_id: UlidString,
  lease_token: z.string().min(1),
  target_id: z.string().min(1),
  object_id: z.string().min(1),
  worker_id: z.string().min(1),
  claimed_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  ttl_ms: z.number().int().positive(),
  ttl_source: z.enum([
    "worker_override",
    "by_phase",
    "by_agent_profile",
    "by_lease_kind",
    "ttl_default",
    "hardcoded_fallback",
  ]),
};

export const SlotLockLease = z
  .object({
    ...baseLeaseShape,
    lease_kind: z.literal("slot_lock"),
    slot_kind: z.enum(["discovery", "delivery"]),
    milestone_id: UlidString,
  })
  .strict();

export const SliceLease = z
  .object({
    ...baseLeaseShape,
    lease_kind: z.literal("slice_lease"),
    slice_id: UlidString,
  })
  .strict();

export const SessionLease = z
  .object({
    ...baseLeaseShape,
    lease_kind: z.literal("session_lease"),
    session_id: UlidString,
    agent_profile_id: z.string().min(1),
  })
  .strict();

export const TurnLease = z
  .object({
    ...baseLeaseShape,
    lease_kind: z.literal("turn_lease"),
    session_id: UlidString,
    turn_index: z.number().int().nonnegative(),
    agent_profile_id: z.string().min(1),
  })
  .strict();

export const Lease = z.discriminatedUnion("lease_kind", [
  SlotLockLease,
  SliceLease,
  SessionLease,
  TurnLease,
]);

export type Lease = z.infer<typeof Lease>;
export type SlotLockLease = z.infer<typeof SlotLockLease>;
export type SliceLease = z.infer<typeof SliceLease>;
export type SessionLease = z.infer<typeof SessionLease>;
export type TurnLease = z.infer<typeof TurnLease>;
