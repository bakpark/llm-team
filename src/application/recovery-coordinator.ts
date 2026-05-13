/**
 * Phase 4 recovery-coordinator (#122 P1-B) — wire-up between
 * `outbox.scanRecoveryCandidatesFromLedger` and the per-invoker
 * `backfill*ReceiptFromRecovery` helpers.
 *
 * Authority: `cli-spicy-anchor.md` §7-3 (outbox crash recovery, two cases),
 * issue #122 (PR-121 review P1-B: recovery-coordinator sweep wire-up).
 *
 * Execution shape (daemon boot + periodic):
 *
 *   1. `outbox.scanRecoveryCandidatesFromLedger({ hasMatchingReceipt })`
 *      yields candidates partitioned by mode:
 *
 *        - Case A `pending_without_posted`
 *          - outbox_pending row exists; no posted/failed/recovered for the
 *            same (op_kind, key).
 *          - On `outbox.recover` success: ledger emits `outbox_recovered`
 *            + `outbox_posted` so the canonical state matches a normal
 *            happy path, then we backfill the AgentRunReceipt.
 *
 *        - Case B `posted_without_receipt`
 *          - outbox_posted exists; no matching AgentRunReceipt persists.
 *          - On `outbox.recover` success: only `outbox_recovered` is
 *            appended (no duplicate `outbox_posted`). The 5-gate ② full-
 *            tuple correlation is restored by the receipt backfill.
 *
 *   2. Per candidate we delegate to `outbox.recover(...)` with the right
 *      probe context (caller-supplied resolver — the recovery-coordinator
 *      cannot fabricate ports / surface ids out of thin air, so the host
 *      daemon plugs in a `probeBuilder` that converts a candidate to a
 *      `ProbeContext`).
 *
 *   3. On `recovered=true` we look up the matching pending outbox row to
 *      retrieve the session/turn/profile/role tuple, then call the proper
 *      `backfillLead*` or `backfillReviewer*` helper.
 *
 * Receipt-presence detection: `hasMatchingReceipt(key)` reads
 * `intents/<session>-<turn>.receipt.json` blobs and compares
 * `receipt.idempotency_key === key`. The scan walks the receipts directory
 * once; results are cached for the duration of one sweep.
 */

import {
  AgentRunReceipt,
  type AgentRunReceipt as AgentRunReceiptT,
} from "../domain/schema/agent-run-receipt.js";
import {
  LedgerRow,
  type LedgerRow as LedgerRowT,
} from "../domain/schema/ledger.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import type { LlmAgentProfileId } from "../ports/llm-runner.js";
import {
  backfillLeadReceiptFromRecovery,
} from "./lead-invoker.js";
import type { LedgerAppender } from "./ledger.js";
import {
  Outbox,
  type OutboxOpKind,
  type OutboxRecoveryCandidate,
  type ProbeContext,
} from "./outbox.js";
import {
  LEDGER_TRANSITIONS_PATH,
} from "./persistence-layout.js";
import {
  backfillReviewerReceiptFromRecovery,
} from "./reviewer-invoker.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface RecoveryCoordinatorCfg {
  callerId: string;
  targetId: string;
}

/**
 * Caller-supplied probe builder. The coordinator does not know how to
 * construct provider-specific contexts (workspace.findCommitByTrailer
 * needs a slice id, gitHost.findReviewByMachineKey needs a PR ref). The
 * host daemon wires this once at startup; the implementation typically
 * reads SliceMerge / ReviewSurface state to resolve the right port shape.
 */
export type ProbeBuilder = (
  candidate: OutboxRecoveryCandidate,
  pending: PendingOutboxRow | null,
) => Promise<ProbeContext | null>;

export interface PendingOutboxRow {
  opKind: OutboxOpKind;
  idempotencyKey: string;
  surfaceRef: string | null;
  sessionId: string | null;
  turnIndex: number | null;
  agentProfileId: string | null;
  loopKind: "outer" | "middle" | "inner" | null;
  callerId: string;
  targetId: string;
  objectId: string;
  manifestId: string | null;
  /**
   * Raw `result_detail` from the pending ledger row. Issue #126: production
   * probe routing for label/dismiss op_kinds reads `{ label }` /
   * `{ externalReviewId }` from this field once Phase 6+ invokers populate
   * it via `Outbox.begin({ payload })`. Null for current invokers.
   */
  resultDetail: string | null;
}

export interface RecoveryCoordinatorDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  outbox: Outbox;
  /** Caller wires this to the daemon's port resolution table. */
  buildProbe: ProbeBuilder;
  /**
   * Resolve the (agent_profile_id, agent_role_in_session) for a backfilled
   * receipt when the pending outbox row's `agent_profile_id` is null. Most
   * pending rows include the profile via the ledger; this hook is a fallback
   * for legacy seeds.
   */
  resolveAgentIdentity?: (
    pending: PendingOutboxRow,
  ) => Promise<
    | {
        agentProfileId: string;
        agentRoleInSession: "lead" | "reviewer";
      }
    | null
  >;
}

export type RecoveryItemOutcome =
  | {
      kind: "recovered_backfilled";
      candidate: OutboxRecoveryCandidate;
      externalId: string;
      receiptPath: string;
    }
  | {
      kind: "recovered_skipped";
      candidate: OutboxRecoveryCandidate;
      reason: "missing_pending_row" | "no_probe" | "no_identity" | "no_receipt_slot";
    }
  | {
      kind: "probe_negative";
      candidate: OutboxRecoveryCandidate;
    };

export interface RecoverySweepResult {
  scanned: number;
  items: RecoveryItemOutcome[];
}

// --------------------------------------------------------------------------
// Coordinator
// --------------------------------------------------------------------------

export class RecoveryCoordinator {
  private buildProbe: ProbeBuilder;

  constructor(
    private readonly cfg: RecoveryCoordinatorCfg,
    private readonly deps: RecoveryCoordinatorDeps,
  ) {
    this.buildProbe = deps.buildProbe;
  }

  /**
   * Issue #126: late-bound probe builder. `buildPrFirstWiring` constructs
   * the coordinator with a stub probe builder so non-recovery daemon
   * roles can still receive the wiring without paying the production
   * probe construction cost. The recovery role calls this once per sweep
   * to install the role-specific routing.
   */
  setProbeBuilder(builder: ProbeBuilder): void {
    this.buildProbe = builder;
  }

  /**
   * One sweep. Daemon invokes this at boot and on a periodic timer.
   * Idempotent — re-running after a partial crash absorbs as duplicates
   * via the outbox's ledger-applied-keys cache + receipt-exists check in
   * `backfill*ReceiptFromRecovery`.
   */
  async runOnce(): Promise<RecoverySweepResult> {
    // Cache receipts once per sweep.
    const { keys: receiptKeys, slots: receiptSlots } = await this.indexReceipts();
    const candidates = await this.deps.outbox.scanRecoveryCandidatesFromLedger({
      hasMatchingReceipt: async (k) => receiptKeys.has(k),
      // PR #127 review P1-2: turn-scoped fallback so commit_op/push_op
      // posted rows aren't re-listed forever just because the live lead
      // receipt only stores the terminal pr_open_op key.
      hasReceiptForSlot: async (sessionId, turnIndex) =>
        receiptSlots.has(`${sessionId}::${turnIndex}`),
    });
    const items: RecoveryItemOutcome[] = [];
    const pendingRows = await this.indexPendingOutboxRows();
    for (const candidate of candidates) {
      const pending = pendingRows.get(
        outboxRowKey(candidate.opKind, candidate.idempotencyKey),
      ) ?? null;
      const outcome = await this.recoverOne(candidate, pending);
      items.push(outcome);
    }
    return { scanned: candidates.length, items };
  }

  // -------------------------------------------------------------
  // Per-candidate handler
  // -------------------------------------------------------------

  private async recoverOne(
    candidate: OutboxRecoveryCandidate,
    pending: PendingOutboxRow | null,
  ): Promise<RecoveryItemOutcome> {
    if (pending == null) {
      return {
        kind: "recovered_skipped",
        candidate,
        reason: "missing_pending_row",
      };
    }
    const probe = await this.buildProbe(candidate, pending);
    if (probe == null) {
      return { kind: "recovered_skipped", candidate, reason: "no_probe" };
    }
    const result = await this.deps.outbox.recover({
      opKind: candidate.opKind,
      idempotencyKey: candidate.idempotencyKey,
      mode: candidate.mode,
      probe,
      callerId: pending.callerId,
      targetId: pending.targetId,
      objectId: pending.objectId,
      manifestId: pending.manifestId,
      ...(pending.surfaceRef ? { surfaceRef: pending.surfaceRef } : {}),
    });
    if (!result.recovered) {
      return { kind: "probe_negative", candidate };
    }
    if (pending.sessionId == null || pending.turnIndex == null) {
      return {
        kind: "recovered_skipped",
        candidate,
        reason: "no_receipt_slot",
      };
    }
    // Resolve the agent identity. Prefer the pending row's
    // `agent_profile_id` (always populated by Phase 2/3 invokers). Fall
    // back to caller-supplied resolver only when pending row omits it.
    let agentProfileId = pending.agentProfileId;
    let agentRoleInSession: "lead" | "reviewer" =
      isReviewerOp(candidate.opKind) ? "reviewer" : "lead";
    if (agentProfileId == null) {
      const resolved = this.deps.resolveAgentIdentity != null
        ? await this.deps.resolveAgentIdentity(pending)
        : null;
      if (resolved == null) {
        return {
          kind: "recovered_skipped",
          candidate,
          reason: "no_identity",
        };
      }
      agentProfileId = resolved.agentProfileId;
      agentRoleInSession = resolved.agentRoleInSession;
    }

    const parentLoop = pending.loopKind ?? defaultLoopForOp(candidate.opKind);
    const externalId = result.externalId ?? "";

    if (isReviewerOp(candidate.opKind)) {
      const backfill = await backfillReviewerReceiptFromRecovery(
        {
          sessionId: pending.sessionId,
          turnIndex: pending.turnIndex,
          parentLoop,
          agentProfileId: agentProfileId as LlmAgentProfileId,
          agentRoleInSession: "reviewer",
          idempotencyKey: candidate.idempotencyKey,
          externalReviewId: externalId,
          surfaceRef: pending.surfaceRef ?? null,
        },
        {
          store: this.deps.store,
          clock: this.deps.clock,
          ledger: this.deps.ledger,
          callerId: this.cfg.callerId,
          targetId: this.cfg.targetId,
        },
      );
      return {
        kind: "recovered_backfilled",
        candidate,
        externalId,
        receiptPath: backfill.receiptPath,
      };
    }

    // Lead-side op.
    const backfill = await backfillLeadReceiptFromRecovery(
      {
        sessionId: pending.sessionId,
        turnIndex: pending.turnIndex,
        parentLoop,
        agentProfileId: agentProfileId as LlmAgentProfileId,
        agentRoleInSession,
        idempotencyKey: candidate.idempotencyKey,
        externalId,
        surfaceRef: pending.surfaceRef ?? null,
        commitSha: candidate.opKind === "commit_op" ? externalId : null,
      },
      {
        store: this.deps.store,
        clock: this.deps.clock,
        ledger: this.deps.ledger,
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
      },
    );
    return {
      kind: "recovered_backfilled",
      candidate,
      externalId,
      receiptPath: backfill.receiptPath,
    };
  }

  // -------------------------------------------------------------
  // Ledger introspection helpers
  // -------------------------------------------------------------

  private async indexReceipts(): Promise<{
    keys: Set<string>;
    slots: Set<string>;
  }> {
    const keys = new Set<string>();
    const slots = new Set<string>();
    let names: string[];
    try {
      names = await this.deps.store.list("intents");
    } catch {
      return { keys, slots };
    }
    for (const n of names) {
      if (!n.endsWith(".receipt.json")) continue;
      const body = await this.deps.store.readText(`intents/${n}`);
      if (body == null || body.length === 0) continue;
      let receipt: AgentRunReceiptT;
      try {
        receipt = AgentRunReceipt.parse(JSON.parse(body));
      } catch {
        continue;
      }
      keys.add(receipt.idempotency_key);
      // PR #127 review P1-2: index by `(session_id, turn_index)` slot so
      // the Case B scan can recognise a turn as covered even when the
      // pending row's per-op key doesn't match the receipt's key.
      slots.add(`${receipt.session_id}::${receipt.turn_index}`);
    }
    return { keys, slots };
  }

  /**
   * Walk the ledger once and build a `(op_kind, decoded_key) → row` map.
   * We need the *pending* row (the one carrying session/turn/profile) since
   * the outbox does not echo those fields onto subsequent posted/recovered
   * rows.
   */
  private async indexPendingOutboxRows(): Promise<Map<string, PendingOutboxRow>> {
    const map = new Map<string, PendingOutboxRow>();
    const body = await this.deps.store.readText(LEDGER_TRANSITIONS_PATH);
    if (body == null || body.length === 0) return map;
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      let row: LedgerRowT;
      try {
        row = LedgerRow.parse(JSON.parse(line));
      } catch {
        continue;
      }
      if (row.action_kind !== "outbox_pending") continue;
      const decoded = decodeOutboxKey(row.idempotency_key);
      if (decoded == null) continue;
      // Skip "outbox_pending" rows that aren't the `:begin` suffix — those
      // are mid-cycle markers, never end with /complete:*. Outbox.begin()
      // writes only the `:begin` suffix so this filter is a defensive
      // re-check.
      const key = outboxRowKey(decoded.opKind, decoded.key);
      if (map.has(key)) continue; // first pending wins; later begins are duplicates
      map.set(key, {
        opKind: decoded.opKind,
        idempotencyKey: decoded.key,
        surfaceRef: row.surface_ref ?? null,
        sessionId: row.session_id,
        turnIndex: row.turn_index,
        agentProfileId: row.agent_profile_id,
        loopKind: row.loop_kind,
        callerId: row.caller_id,
        targetId: row.target_id,
        objectId: row.object_id,
        manifestId: row.manifest_id,
        resultDetail: row.result_detail,
      });
    }
    return map;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function isReviewerOp(op: OutboxOpKind): boolean {
  return op === "submit_review_op" || op === "dismiss_review_op";
}

function defaultLoopForOp(op: OutboxOpKind): "middle" | "outer" | "inner" {
  // Best-effort fallback when the pending row's `loop_kind` is null.
  // Reviewer ops default to `middle` (slice middle review). Lead ops
  // default to `inner` (slice tdd_build) — outer-loop callers always
  // populate `loop_kind` explicitly, so the inner default is safe.
  return isReviewerOp(op) ? "middle" : "inner";
}

function decodeOutboxKey(
  key: string,
): { opKind: OutboxOpKind; key: string } | null {
  // Same decoder shape as outbox.ts (kept private there) — the key format
  // is `outbox/<op>/<key>/<suffix>`. We want the (op, key) prefix.
  if (!key.startsWith("outbox/")) return null;
  const rest = key.slice("outbox/".length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash < 0) return null;
  const opKind = rest.slice(0, firstSlash) as OutboxOpKind;
  const afterOp = rest.slice(firstSlash + 1);
  const lastSlash = afterOp.lastIndexOf("/");
  if (lastSlash < 0) return null;
  return { opKind, key: afterOp.slice(0, lastSlash) };
}

function outboxRowKey(opKind: OutboxOpKind, key: string): string {
  return `${opKind}::${key}`;
}
