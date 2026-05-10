import { z } from "zod";
import { UlidString } from "../ids.js";
import { AgentProfileId, AgentRoleInSession, ParentLoop } from "./contribution.js";

/**
 * AgentRunReceipt — invocation receipt persisted alongside SessionTurn.
 *
 * Authority: `cli-spicy-anchor.md` §5.
 *
 * Each agent invocation produces exactly one receipt. The PR-watcher 5-gate
 * full-tuple correlation references the `idempotency_key` and
 * `external_review_id` fields here.
 */

export const AgentRunReceiptExitStatus = z.enum([
  "ok",
  "timeout",
  "transport_error",
  "adapter_unavailable",
  "malformed_output",
]);
export type AgentRunReceiptExitStatus = z.infer<
  typeof AgentRunReceiptExitStatus
>;

export const AgentRunReceipt = z
  .object({
    session_id: UlidString,
    turn_index: z.number().int().nonnegative(),
    parent_loop: ParentLoop,
    agent_profile_id: AgentProfileId,
    agent_role_in_session: AgentRoleInSession,
    /** Caller-issued ULID; mirrored into PR / review machine block. */
    idempotency_key: z.string().min(1),
    /** Diagnostics blob ref (transcript, stderr, etc.). */
    diagnostics_ref: z.string().min(1),
    /** Provider-local review id once submit_review_op completes (reviewer only). */
    external_review_id: z.string().min(1).nullable().default(null),
    /** Provider-local PR id (lead/reviewer both reference). */
    external_pr_id: z.string().min(1).nullable().default(null),
    /** Commit SHA produced by lead.commit (lead only). */
    commit_sha: z.string().min(1).nullable().default(null),
    exit_status: AgentRunReceiptExitStatus,
    /** Wall-clock ISO timestamp at receipt persistence. */
    recorded_at: z.string().datetime(),
  })
  .strict();

export type AgentRunReceipt = z.infer<typeof AgentRunReceipt>;
