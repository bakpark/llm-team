/**
 * Phase 4 pr-watcher — 5-gate PR review filter + ledger `review_signal_applied`
 * append.
 *
 * Authority: `cli-spicy-anchor.md` §1 step 4 (cycle prelude poll), §6
 * (review-signal triple dedup), §11 (machine-block).
 *
 * The watcher polls a `ReviewSurface`'s native PR reviews via
 * `GitHostPort.listPullRequestReviews(pr_ref)` and decides, per review, whether
 * it is the canonical machine signal authored by the orchestrator's reviewer
 * agent. Five gates, all must pass:
 *
 *   ① last-match `<!-- llm-team:review-machine ... -->` block parses + nonce
 *      verifies (machine-block.parseLastMatch + verifyNonce)
 *   ② full-tuple correlation: every field in the parsed block matches the
 *      outbox submit_review_op `posted` row, the persisted AgentRunReceipt,
 *      and the ReviewSurface ledger fingerprint
 *   ③ machine.review_round === ReviewSurface.review_round
 *      AND machine.parent_phase === ReviewSurface.parent_phase
 *   ④ author bind: review.author === expectedBotAccount
 *      AND machine.agent_profile_id ∈ knownAgentProfileIds + receipt's role
 *      reads as `reviewer`/`lead`
 *   ⑤ no prior `review_signal_applied` ledger row for the same
 *      `external_review_id`
 *
 * A passing review → `review_signal_applied` ledger row (idempotent per
 * external_review_id).
 *
 * A failing review → drift-observer.recordDroppedReviewSignal({external_review_id,
 * drop_reason, review_surface_id}) with the gate label as `drop_reason`.
 *
 * The watcher does **not** mutate ReviewSurface / Slice / Milestone — that is
 * `caller-dispatch`'s responsibility. The watcher only classifies and records.
 */

import {
  AgentRunReceipt,
  type AgentRunReceipt as AgentRunReceiptT,
} from "../domain/schema/agent-run-receipt.js";
import { newMonotonicId } from "../domain/ids.js";
import { LedgerRow, type LedgerRow as LedgerRowT } from "../domain/schema/ledger.js";
import type { ReviewSurface as ReviewSurfaceT } from "../domain/schema/review-surface.js";
import type { ClockPort } from "../ports/clock.js";
import type {
  GitHostPort,
  ListedReview,
} from "../ports/git-host.js";
import type { StorePort } from "../ports/store.js";
import {
  DroppedReviewSignalCache,
  recordDroppedReviewSignal,
} from "./drift-observer.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import {
  parseLastMatch,
  verifyNonce,
  type ReviewCanonicalFields,
} from "./machine-block.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "./persistence-layout.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/** Gate label — emitted as `drop_reason` on drift-observer + ledger. */
export type PrWatcherDropReason =
  | "signature_invalid"
  | "tuple_mismatch"
  | "round_mismatch"
  | "author_unauthorized"
  | "agent_profile_unknown"
  | "receipt_role_mismatch"
  | "already_applied";

export interface PrWatcherCfg {
  callerId: string;
  targetId: string;
  /** HMAC secret for `<!-- llm-team:review-machine ... -->` verification. */
  machineBlockSecret: string;
  /**
   * Authorized GitHub bot account (review.author) for the orchestrator's
   * reviewer surface. Required for gate ④ (a). Optional only so legacy
   * test seeds can opt-out; production wiring MUST set this — see plan §11.
   */
  expectedBotAccount?: string;
  /**
   * Whitelist of `agent_profile_id` values that may author the canonical
   * machine review. e.g. `["sentinel", "scout"]`. Defaults to a permissive
   * non-empty check when unset (PR-119 P1a — never silently accept).
   */
  knownAgentProfileIds?: readonly string[];
}

export interface PrWatcherDeps {
  store: StorePort;
  clock: ClockPort;
  gitHost: GitHostPort;
  ledger: LedgerAppender;
  /**
   * Shared cache for the drift-observer triple-dedup helper. The daemon
   * constructs one cache at startup and threads it through so a single
   * `(external_review_id, drop_reason, review_surface_id)` triple writes
   * exactly one `review_signal_dropped` ledger row even across many poll
   * cycles.
   */
  droppedSignalCache: DroppedReviewSignalCache;
}

export type PollOutcomePerReview =
  | {
      kind: "applied";
      externalReviewId: string;
      verdict: "approve" | "request_changes" | "comment";
      /** Parsed canonical fields used by caller-dispatch for the next step. */
      fields: ReviewCanonicalFields;
      /** AgentRunReceipt that matched gate ②. Caller may consume `agent_role_in_session`. */
      receipt: AgentRunReceiptT;
    }
  | {
      kind: "dropped";
      externalReviewId: string;
      dropReason: PrWatcherDropReason;
    }
  | {
      kind: "duplicate_applied";
      externalReviewId: string;
    };

export interface PollResult {
  reviewSurfaceId: string;
  reviews: PollOutcomePerReview[];
}

// --------------------------------------------------------------------------
// PrWatcher
// --------------------------------------------------------------------------

export class PrWatcher {
  constructor(
    private readonly cfg: PrWatcherCfg,
    private readonly deps: PrWatcherDeps,
  ) {}

  /**
   * Poll a single ReviewSurface — one call per surface per cycle. Returns
   * the per-review classification; the caller (dispatcher) consumes the
   * `applied` entries to drive caller-dispatch.
   */
  async pollReviewSurface(surface: ReviewSurfaceT): Promise<PollResult> {
    const handle = {
      provider: surface.pr_ref.provider,
      id: surface.pr_ref.id,
      url: surface.pr_ref.url,
    };
    const reviews = await this.deps.gitHost.listPullRequestReviews(handle);
    const out: PollOutcomePerReview[] = [];
    // PR-119 P1a (gpt5.5): build the prior-applied set once per poll so a
    // pre-existing `review_signal_applied` row short-circuits gate ⑤ without
    // re-reading the ledger per review.
    const priorApplied = await this.loadPriorAppliedSet();
    for (const review of reviews) {
      const decision = await this.classify(surface, review, priorApplied);
      out.push(decision);
    }
    return { reviewSurfaceId: surface.review_surface_id, reviews: out };
  }

  // ------------------------------------------------------------------
  // Internal — gate machinery
  // ------------------------------------------------------------------

  private async classify(
    surface: ReviewSurfaceT,
    review: ListedReview,
    priorApplied: Set<string>,
  ): Promise<PollOutcomePerReview> {
    // Gate ⑤ first — fast short-circuit if already applied.
    if (priorApplied.has(review.externalReviewId)) {
      return { kind: "duplicate_applied", externalReviewId: review.externalReviewId };
    }

    // Gate ① — last-match parse + nonce verify.
    const parsed = parseLastMatch(review.body, "review");
    if (parsed == null) {
      await this.drop(surface, review, "signature_invalid");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "signature_invalid",
      };
    }
    if (
      !verifyNonce(
        this.cfg.machineBlockSecret,
        "review",
        parsed.fields,
        parsed.nonce,
      )
    ) {
      await this.drop(surface, review, "signature_invalid");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "signature_invalid",
      };
    }

    // Gate ③ — round + parent_phase check (read tags out of the parsed block).
    const expectedPhase = surface.parent_phase ?? "n/a";
    if (
      parsed.fields.review_round !== String(surface.review_round) ||
      parsed.fields.parent_phase !== expectedPhase
    ) {
      await this.drop(surface, review, "round_mismatch");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "round_mismatch",
      };
    }

    // Gate ② — full-tuple correlation with AgentRunReceipt + outbox row.
    // PR-123 P0-2 (gpt5.5): bind the live `review.externalReviewId` so the
    // canonical id participates in the 10-field tuple. Without this, the
    // gate cannot detect a posted row whose `external_review_id` belongs to
    // a different review than the one currently being classified.
    const correlation = await this.correlateTuple(
      surface,
      parsed.fields,
      review.externalReviewId,
    );
    if (correlation == null) {
      await this.drop(surface, review, "tuple_mismatch");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "tuple_mismatch",
      };
    }

    // Gate ④a — author bind. When `expectedBotAccount` is configured the
    // review's author must match it exactly. When omitted (test seeds /
    // legacy), we require any non-empty author to avoid silently allowing a
    // forged review.
    const expectedAuthor = this.cfg.expectedBotAccount;
    if (expectedAuthor != null && review.author !== expectedAuthor) {
      await this.drop(surface, review, "author_unauthorized");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "author_unauthorized",
      };
    }
    if (review.author.length === 0) {
      await this.drop(surface, review, "author_unauthorized");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "author_unauthorized",
      };
    }

    // Gate ④b — agent_profile_id known + receipt role is reviewer/lead.
    const known = this.cfg.knownAgentProfileIds;
    if (known != null && !known.includes(parsed.fields.agent_profile_id)) {
      await this.drop(surface, review, "agent_profile_unknown");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "agent_profile_unknown",
      };
    }
    if (
      correlation.receipt.agent_role_in_session !== "reviewer" &&
      correlation.receipt.agent_role_in_session !== "lead"
    ) {
      await this.drop(surface, review, "receipt_role_mismatch");
      return {
        kind: "dropped",
        externalReviewId: review.externalReviewId,
        dropReason: "receipt_role_mismatch",
      };
    }

    // All gates passed → append ledger `review_signal_applied`.
    await this.appendApplied(surface, parsed.fields, review);

    // Update the prior-applied set so a second review in the same poll
    // cycle with the same external_review_id (rare, but possible if the
    // host returns duplicates) is reported as duplicate_applied.
    priorApplied.add(review.externalReviewId);

    return {
      kind: "applied",
      externalReviewId: review.externalReviewId,
      verdict: mapReviewState(review.state),
      fields: parsed.fields,
      receipt: correlation.receipt,
    };
  }

  /**
   * Gate ② — read the persisted AgentRunReceipt for the parsed
   * (session_id, turn_index) and confirm every canonical field matches:
   *
   *   - receipt.idempotency_key === parsed.idempotency_key
   *   - receipt.agent_profile_id === parsed.agent_profile_id
   *   - receipt.external_review_id === review.externalReviewId
   *     (when receipt is present; for the recovery `Case B` path the receipt
   *     may have been written *after* the review was posted but the backfill
   *     wires the field in either order)
   *
   * Plus the outbox `submit_review_op` posted row in the ledger must carry
   * the same `idempotency_key` and `surface_ref`.
   */
  private async correlateTuple(
    surface: ReviewSurfaceT,
    fields: ReviewCanonicalFields,
    reviewExternalId: string,
  ): Promise<{ receipt: AgentRunReceiptT } | null> {
    // ReviewSurface bind: parent_kind / parent_id / parent_phase must all match.
    if (
      fields.review_surface_id !== surface.review_surface_id ||
      fields.parent_kind !== surface.parent_kind ||
      fields.parent_id !== surface.parent_id ||
      fields.parent_phase !== (surface.parent_phase ?? "n/a")
    ) {
      return null;
    }
    const turnIndex = Number.parseInt(fields.turn_index, 10);
    if (!Number.isFinite(turnIndex) || turnIndex < 0) return null;
    const receiptPath = layout.agentRunReceipt(fields.session_id, turnIndex);
    const body = await this.deps.store.readText(receiptPath);
    if (body == null) return null;
    let receipt: AgentRunReceiptT;
    try {
      receipt = AgentRunReceipt.parse(JSON.parse(body));
    } catch {
      return null;
    }
    if (receipt.idempotency_key !== fields.idempotency_key) return null;
    if (receipt.agent_profile_id !== fields.agent_profile_id) return null;
    if (receipt.session_id !== fields.session_id) return null;
    if (receipt.turn_index !== turnIndex) return null;
    // PR-123 P0-2: when the receipt records `external_review_id`, it MUST
    // match the live review's id. (Receipt may be null when the host write
    // raced ahead of receipt persist — the recovery-coordinator backfill
    // path writes the id; a real reviewer-invoker pass always sets it.)
    if (
      receipt.external_review_id != null &&
      receipt.external_review_id !== reviewExternalId
    ) {
      return null;
    }

    // outbox submit_review_op posted row authority.
    const outboxOk = await this.scanOutboxPosted(
      fields.idempotency_key,
      surface.review_surface_id,
      reviewExternalId,
    );
    if (!outboxOk) return null;

    return { receipt };
  }

  private async scanOutboxPosted(
    idempotencyKey: string,
    surfaceRef: string,
    reviewExternalId: string,
  ): Promise<boolean> {
    const body = await this.deps.store.readText(LEDGER_TRANSITIONS_PATH);
    if (body == null || body.length === 0) return false;
    const target = `outbox/submit_review_op/${idempotencyKey}/complete:posted`;
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      let parsed: LedgerRowT;
      try {
        parsed = LedgerRow.parse(JSON.parse(line));
      } catch {
        continue;
      }
      if (parsed.action_kind !== "outbox_posted") continue;
      if (parsed.op_kind !== "submit_review_op") continue;
      if (parsed.idempotency_key !== target) continue;
      // PR-123 P0-2: gate ② now requires `surface_ref` to be present on the
      // posted row (no silent fall-through for legacy rows that omit it) and
      // to equal the active surface. Posted row's `external_review_id` must
      // equal the live review id — this is the field whose absence let
      // forged or stale machine blocks slip through.
      if (parsed.surface_ref == null) continue;
      if (parsed.surface_ref !== surfaceRef) continue;
      if (parsed.external_review_id == null) continue;
      if (parsed.external_review_id !== reviewExternalId) continue;
      return true;
    }
    return false;
  }

  private async loadPriorAppliedSet(): Promise<Set<string>> {
    const out = new Set<string>();
    const body = await this.deps.store.readText(LEDGER_TRANSITIONS_PATH);
    if (body == null || body.length === 0) return out;
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      let parsed: LedgerRowT;
      try {
        parsed = LedgerRow.parse(JSON.parse(line));
      } catch {
        continue;
      }
      if (parsed.action_kind !== "review_signal_applied") continue;
      if (parsed.external_review_id == null) continue;
      out.add(parsed.external_review_id);
    }
    return out;
  }

  private async drop(
    surface: ReviewSurfaceT,
    review: ListedReview,
    dropReason: PrWatcherDropReason,
  ): Promise<void> {
    await recordDroppedReviewSignal(
      {
        externalReviewId: review.externalReviewId,
        dropReason,
        reviewSurfaceId: surface.review_surface_id,
      },
      {
        store: this.deps.store,
        clock: this.deps.clock,
        ledger: this.deps.ledger,
        callerId: this.cfg.callerId,
        targetId: this.cfg.targetId,
        cache: this.deps.droppedSignalCache,
      },
    );
  }

  private async appendApplied(
    surface: ReviewSurfaceT,
    fields: ReviewCanonicalFields,
    review: ListedReview,
  ): Promise<void> {
    const now = this.deps.clock.isoNow();
    const key = idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: "review_signal_applied",
        external_review_id: review.externalReviewId,
        review_surface_id: surface.review_surface_id,
      },
    });
    await this.deps.ledger.appendTransition({
      transition_id: newMonotonicId(this.deps.clock.now()),
      target_id: this.cfg.targetId,
      object_id: surface.review_surface_id,
      object_kind: "system",
      from_state: null,
      to_state: "review_signal_applied",
      loop_kind:
        surface.parent_kind === "milestone"
          ? "outer"
          : surface.parent_kind === "slice"
            ? "middle"
            : null,
      phase: null,
      slice_id: surface.parent_kind === "slice" ? surface.parent_id : null,
      slice_kind: null,
      dod_revision: null,
      session_id: fields.session_id,
      turn_index: Number.parseInt(fields.turn_index, 10),
      slot_kind: null,
      agent_profile_id: fields.agent_profile_id,
      contribution_kind: null,
      action_kind: "review_signal_applied",
      final_verdict: mapReviewState(review.state),
      caller_id: this.cfg.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: key,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: review.author,
      timestamp: now,
      surface_ref: surface.review_surface_id,
      external_review_id: review.externalReviewId,
    });
  }
}

function mapReviewState(state: ListedReview["state"]): "approve" | "request_changes" | "comment" {
  switch (state) {
    case "approved":
      return "approve";
    case "changes_requested":
      return "request_changes";
    case "commented":
      return "comment";
    case "dismissed":
    case "pending":
    default:
      return "comment";
  }
}
