import { z } from "zod";

export const LeaseKind = z.enum([
  "slot_lock",
  "slice_lease",
  "session_lease",
  "turn_lease",
]);
export type LeaseKind = z.infer<typeof LeaseKind>;

const baseLease = {
  lease_id: z.string().min(1),
  lease_token: z.string().min(1),
  target_id: z.string().min(1),
  worker_id: z.string().min(1),
  acquired_at: z.string().min(1),
  expires_at: z.string().min(1),
  ttl_ms: z.number().int().positive(),
  ttl_source: z.enum([
    "by_phase",
    "by_agent_profile",
    "by_lease_kind",
    "ttl_default",
    "hardcoded_fallback",
  ]),
};

export const SlotLockLease = z
  .object({
    ...baseLease,
    kind: z.literal("slot_lock"),
    slot_kind: z.enum(["discovery", "delivery"]),
  })
  .strict();

export const SliceLease = z
  .object({
    ...baseLease,
    kind: z.literal("slice_lease"),
    slice_id: z.string().min(1),
  })
  .strict();

export const SessionLease = z
  .object({
    ...baseLease,
    kind: z.literal("session_lease"),
    session_id: z.string().min(1),
  })
  .strict();

export const TurnLease = z
  .object({
    ...baseLease,
    kind: z.literal("turn_lease"),
    session_id: z.string().min(1),
    turn_index: z.number().int().nonnegative(),
    agent_profile_id: z.string().min(1),
  })
  .strict();

export const Lease = z.discriminatedUnion("kind", [
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
