import { z } from "zod";
import { UlidString } from "../ids.js";
import { AgentProfileId } from "./contribution.js";
import { Envelope, NextActionRequest } from "./envelope.js";

/**
 * SessionTurn schema (SOC-SESSION-LIFECYCLE).
 *
 * Layout choices vs the contract pseudocode:
 *
 * - `output_envelope` is embedded inline (full canonical envelope), not a
 *   separate ref. `docs/architecture/persistence-layout.md` §1 places
 *   the envelope in `sessions/<id>/turns/<n>.json` alongside the SessionTurn
 *   record, so the contract's `output_envelope_ref` slot is satisfied by
 *   embedding rather than introducing a separate `envelopes/` directory.
 *   `(session_id, turn_index)` is globally unique so the envelope does not
 *   need its own id.
 *
 * - `next_action_request` is mirrored at the SessionTurn top level (in
 *   addition to its position inside the envelope) so phase-3
 *   dialogue-coordinator can route without traversing the envelope. It
 *   must agree with `output_envelope.next_action_request` — phase-2
 *   persistence will assert equality on write.
 *
 * - `caller_routing_decision` is required when `next_action_request` is
 *   present (AGC-NEXT-ACTION-REQUEST decision_reason invariant); the
 *   matrix validator in application/envelope-extended-validator enforces
 *   the decision-reason invariant — the schema only models field shapes.
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
    next_action_request: NextActionRequest.nullable().default(null),
    caller_routing_decision: CallerRoutingDecision.nullable().default(null),
    workspace_commit: z.string().min(1).nullable().default(null),
    verification_result_ref: UlidString.nullable().default(null),
    recorded_at: z.string().datetime(),
  })
  .strict();
export type SessionTurn = z.infer<typeof SessionTurn>;
