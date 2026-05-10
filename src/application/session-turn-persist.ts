import {
  DialogueSession,
  type DialogueSession as DialogueSessionT,
} from "../domain/schema/dialogue-session.js";
import type { Envelope } from "../domain/schema/envelope.js";
import {
  SessionTurn,
  type SessionTurn as SessionTurnT,
  type CallerRoutingDecision,
} from "../domain/schema/session-turn.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { layout } from "./persistence-layout.js";

/**
 * SessionTurn persistence (SOC-SESSION-LIFECYCLE).
 *
 * Single seam for writing a turn to `sessions/<id>/turns/<n>.json` and
 * advancing the session's `current_turn_index` + workspace_revision_pin.
 * The caller supplies the embedded canonical envelope, the routing
 * decision, the new workspace_commit, and the verification_run_id (or
 * null for non-inner / failure turns).
 *
 * The function is idempotent on the (session_id, turn_index) pair: if a
 * turn file already exists at that path, the write is rejected.
 */

export interface PersistTurnInput {
  session: DialogueSessionT;
  envelope: Envelope;
  callerRoutingDecision: CallerRoutingDecision | null;
  workspaceCommit: string | null;
  verificationRunId: string | null;
  /**
   * Pin override for the session's workspace_revision_pin after this turn.
   * Typically the same as workspaceCommit when present, otherwise unchanged.
   */
  newWorkspaceRevisionPin?: string | null;
  /**
   * Phase 1 (cli-spicy-anchor.md §5): additive pointers — when supplied the
   * persisted SessionTurn records `output_receipt_ref` / `output_intent_ref`.
   * Legacy callers omit both and the fields stay absent.
   */
  outputReceiptRef?: string;
  outputIntentRef?: string;
}

export interface PersistTurnDeps {
  store: StorePort;
  clock: ClockPort;
}

export class TurnAlreadyPersistedError extends Error {
  constructor(readonly sessionId: string, readonly turnIndex: number) {
    super(`turn already persisted: session=${sessionId} turn_index=${turnIndex}`);
    this.name = "TurnAlreadyPersistedError";
  }
}

export async function persistSessionTurn(
  input: PersistTurnInput,
  deps: PersistTurnDeps,
): Promise<{ turn: SessionTurnT; session: DialogueSessionT }> {
  const sessionId = input.session.session_id;
  const turnIndex = input.envelope.turn_index;
  return deps.store.withFileLock(
    layout.sessionMetadata(sessionId),
    async () => {
      const turnPath = layout.sessionTurn(sessionId, turnIndex);
      if (await deps.store.exists(turnPath)) {
        throw new TurnAlreadyPersistedError(sessionId, turnIndex);
      }
      const turn = SessionTurn.parse({
        session_id: sessionId,
        turn_index: turnIndex,
        agent_profile_id: input.envelope.agent_profile_id,
        input_manifest_id: input.envelope.manifest_id,
        input_turn_log_snapshot_ref: null,
        output_envelope: input.envelope,
        next_action_request: input.envelope.next_action_request,
        caller_routing_decision: input.callerRoutingDecision,
        workspace_commit: input.workspaceCommit,
        verification_result_ref: input.verificationRunId,
        ...(input.outputReceiptRef != null
          ? { output_receipt_ref: input.outputReceiptRef }
          : {}),
        ...(input.outputIntentRef != null
          ? { output_intent_ref: input.outputIntentRef }
          : {}),
        recorded_at: deps.clock.isoNow(),
      });
      await deps.store.writeAtomic(turnPath, JSON.stringify(turn, null, 2));
      const updated = DialogueSession.parse({
        ...input.session,
        current_turn_index: turnIndex + 1,
        workspace_revision_pin:
          input.newWorkspaceRevisionPin ?? input.session.workspace_revision_pin,
        updated_at: deps.clock.isoNow(),
      });
      await deps.store.writeAtomic(
        layout.sessionMetadata(sessionId),
        JSON.stringify(updated, null, 2),
      );
      return { turn, session: updated };
    },
  );
}
