import { z } from "zod";
import { UlidString } from "../ids.js";
import { ParentLoop } from "./contribution.js";
import { LeaseKind } from "./lease.js";
import { SliceKind } from "./slice.js";

export const LedgerObjectKind = z.enum([
  "milestone",
  "slice",
  "dialogue_session",
  "session_turn",
  "slice_merge",
  "verification_run",
  "metric_run",
  "system",
]);
export type LedgerObjectKind = z.infer<typeof LedgerObjectKind>;

/**
 * The ledger row's `loop_kind` field uses the same {outer, middle, inner}
 * enum as `AGC-OUTPUT.parent_loop`. Re-exported as `LedgerLoopKind` to
 * preserve the existing import surface.
 */
export const LedgerLoopKind = ParentLoop;
export type LedgerLoopKind = z.infer<typeof LedgerLoopKind>;

export const LedgerOuterPhase = z.enum([
  "Discovery",
  "Specification",
  "Planning",
  "Validation",
]);
export type LedgerOuterPhase = z.infer<typeof LedgerOuterPhase>;

export const LedgerActionKind = z.enum([
  "intake",
  "slot_promotion",
  "session_progress",
  "session_finalize",
  "slice_merge",
  "verification",
  "recover",
  "pause_resume",
  "signal_apply",
  "external_observation",
  // Phase 1 (cli-spicy-anchor.md §7-1): outbox 2-phase + PRR signal events.
  // Legacy readers must use union-read semantics (unknown action_kind →
  // ignore the row) so older daemons keep functioning during rollout.
  "outbox_pending",
  "outbox_posted",
  "outbox_failed",
  "outbox_recovered",
  "review_signal_applied",
  "review_signal_dropped",
]);
export type LedgerActionKind = z.infer<typeof LedgerActionKind>;

export const LedgerResult = z.enum([
  "applied",
  "noop",
  "claim_failed",
  "duplicate",
  "invalid",
  "stale",
  "error",
  "recovered",
  "rolled_back",
  "escalated",
]);
export type LedgerResult = z.infer<typeof LedgerResult>;

export const LedgerSlotKind = z.enum(["discovery", "delivery"]);
export type LedgerSlotKind = z.infer<typeof LedgerSlotKind>;

export const LedgerRow = z
  .object({
    transition_id: UlidString,
    target_id: z.string().min(1),
    object_id: z.string().min(1),
    object_kind: LedgerObjectKind,
    from_state: z.string().nullable(),
    to_state: z.string(),
    loop_kind: LedgerLoopKind.nullable(),
    phase: LedgerOuterPhase.nullable(),
    slice_id: UlidString.nullable(),
    slice_kind: SliceKind.nullable(),
    dod_revision: z.string().min(1).nullable(),
    session_id: UlidString.nullable(),
    turn_index: z.number().int().nonnegative().nullable(),
    slot_kind: LedgerSlotKind.nullable(),
    agent_profile_id: z.string().min(1).nullable(),
    contribution_kind: z.string().min(1).nullable(),
    action_kind: LedgerActionKind,
    final_verdict: z.string().min(1).nullable(),
    caller_id: z.string().min(1),
    manifest_id: UlidString.nullable(),
    input_revision_pins: z.array(z.string().min(1)),
    output_hash: z.string().min(1).nullable(),
    verification_run_id: UlidString.nullable(),
    metric_run_id: UlidString.nullable(),
    idempotency_key: z.string().min(1),
    lease_token: z.string().min(1).nullable(),
    lease_kind: LeaseKind.nullable(),
    result: LedgerResult,
    result_detail: z.string().min(1).nullable(),
    timestamp: z.string().datetime(),
    audit_hash: z.string().regex(/^[0-9a-f]{64}$/),
    audit_hash_prev: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * Phase 1 additive optional fields (cli-spicy-anchor.md §7-1, §6).
     * Legacy rows omit these. Strict mode + .optional() makes legacy parses
     * pass while new outbox / PRR rows can carry the extra correlation.
     */
    surface_ref: z.string().min(1).optional(),
    external_review_id: z.string().min(1).optional(),
    diagnostics_ref: z.string().min(1).optional(),
    op_kind: z.string().min(1).optional(),
    drop_reason: z.string().min(1).optional(),
    nonce: z.string().min(1).optional(),
  })
  .strict();

export type LedgerRow = z.infer<typeof LedgerRow>;
