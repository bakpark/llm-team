import { z } from "zod";
import { UlidString } from "../ids.js";
import { AgentProfileId } from "./contribution.js";
import { Envelope } from "./envelope.js";

/**
 * SessionTurn schema (SOC-SESSION-LIFECYCLE).
 *
 * `caller_routing_decision` is required when `next_action_request` is present
 * in the envelope (AGC-NEXT-ACTION-REQUEST decision_reason invariant); the
 * matrix validator in application/envelope-extended-validator enforces the
 * decision-reason invariant — the schema only models the field shape.
 */

export const RoutingDecision = z.enum([
  "accepted",
  "overridden",
  "delayed",
  "dropped",
]);
export type RoutingDecision = z.infer<typeof RoutingDecision>;

export const CallerRoutingDecision = z
  .object({
    decision: RoutingDecision,
    decision_reason: z.string().min(1),
    resolved_addressed_to: z.string().min(1).nullable().default(null),
  })
  .strict();
export type CallerRoutingDecision = z.infer<typeof CallerRoutingDecision>;

export const SessionTurn = z
  .object({
    session_id: UlidString,
    turn_index: z.number().int().nonnegative(),
    agent_profile_id: AgentProfileId,
    input_manifest_id: UlidString,
    input_turn_log_snapshot_ref: UlidString.nullable().default(null),
    output_envelope: Envelope,
    caller_routing_decision: CallerRoutingDecision.nullable().default(null),
    workspace_commit: z.string().min(1).nullable().default(null),
    verification_result_ref: UlidString.nullable().default(null),
    recorded_at: z.string().datetime(),
  })
  .strict();
export type SessionTurn = z.infer<typeof SessionTurn>;
