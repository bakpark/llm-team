/**
 * Phase 1 outbox 2-phase + dedup probe coordinator.
 *
 * Authority: `cli-spicy-anchor.md` §7 (외부 write outbox).
 *
 * The outbox itself manages only the (op_kind, idempotency_key) lifecycle
 * via append-only ledger events. Receipt / SessionTurn backfill is the
 * caller's (lead-invoker / reviewer-invoker / recovery-coordinator)
 * responsibility — see plan §7-3.
 *
 * Phase 1 ships the module wiring; actual call-sites (lead-invoker,
 * reviewer-invoker, pr-watcher) land in Phase 2/3/4.
 */

import { newId } from "../domain/ids.js";
import type {
  LedgerActionKind,
  LedgerRow,
} from "../domain/schema/ledger.js";
import type { GitHostPort } from "../ports/git-host.js";
import type { ExternalRefHandle } from "../ports/issue-tracker.js";
import type { StorePort } from "../ports/store.js";
import type { WorkspacePort } from "../ports/workspace.js";
import type { LedgerAppender } from "./ledger.js";
import { LEDGER_TRANSITIONS_PATH } from "./persistence-layout.js";

export type OutboxOpKind =
  | "commit_op"
  | "push_op"
  | "pr_open_op"
  | "pr_update_op"
  | "submit_review_op"
  | "merge_op"
  | "add_label_op"
  | "remove_label_op"
  | "dismiss_review_op";

export type OutboxStatus = "posted" | "failed";

export type OutboxRecoveryMode =
  | "pending_without_posted"
  | "posted_without_receipt";

export interface OutboxBeginInput {
  opKind: OutboxOpKind;
  /** Caller-issued idempotency key (typically a ULID). */
  idempotencyKey: string;
  /** Free-form payload — opaque to outbox; persisted via ledger result_detail. */
  payload?: Record<string, unknown>;
  /** Caller id required by the LedgerRow schema. */
  callerId: string;
  /** Object identity for the ledger row (e.g. surface_ref or slice id). */
  targetId: string;
  objectId: string;
  manifestId: string | null;
  surfaceRef?: string;
  /**
   * PR-123 review P0-1 (gpt5.5): receipt tuple persisted onto the
   * `outbox_pending` ledger row so `RecoveryCoordinator` can backfill an
   * `AgentRunReceipt` from the canonical pending row (no separate side
   * channel). All four fields together identify the receipt slot
   * (`intents/<session>-<turn>.receipt.json`) plus the parent_loop the
   * receipt records. Invokers (lead/reviewer) always set these; recovery
   * tests previously seeded a side-loaded `outbox_pending` row directly to
   * compensate for the missing fields.
   */
  sessionId?: string;
  turnIndex?: number;
  agentProfileId?: string;
  loopKind?: "outer" | "middle" | "inner";
}

export interface OutboxCompleteInput {
  opKind: OutboxOpKind;
  idempotencyKey: string;
  status: OutboxStatus;
  /** Provider-local id captured from the external write (PR#, review id, sha). */
  externalId?: string;
  callerId: string;
  targetId: string;
  objectId: string;
  manifestId: string | null;
  surfaceRef?: string;
  externalReviewId?: string;
}

export interface OutboxRecoverInput<P = unknown> {
  opKind: OutboxOpKind;
  idempotencyKey: string;
  mode: OutboxRecoveryMode;
  /** Probe payload; required fields depend on op_kind (see probe table). */
  probe: ProbeContextFor<OutboxOpKind, P>;
  callerId: string;
  targetId: string;
  objectId: string;
  manifestId: string | null;
  surfaceRef?: string;
}

/** Per-op probe context. The router below is structurally typed. */
export interface ProbeContextCommitOp {
  workspace: WorkspacePort;
  branch: string;
  trailerKey: string;
  value: string;
  depth?: number;
}
export interface ProbeContextPushOp {
  workspace: WorkspacePort;
  remote: string;
  branch: string;
  expectedSha: string;
}
export interface ProbeContextPrOpenOp {
  gitHost: GitHostPort;
  headBranch: string;
}
export interface ProbeContextPrUpdateOp {
  gitHost: GitHostPort;
  prRef: ExternalRefHandle;
}
export interface ProbeContextSubmitReviewOp {
  gitHost: GitHostPort;
  prRef: ExternalRefHandle;
}
export interface ProbeContextMergeOp {
  gitHost: GitHostPort;
  prRef: ExternalRefHandle;
}
export interface ProbeContextLabelOp {
  gitHost: GitHostPort;
  prRef: ExternalRefHandle;
  label: string;
  /** "add" → expect label present; "remove" → expect absent. */
  expect: "present" | "absent";
}
export interface ProbeContextDismissReviewOp {
  gitHost: GitHostPort;
  prRef: ExternalRefHandle;
  externalReviewId: string;
}

export type ProbeContext =
  | ({ opKind: "commit_op" } & ProbeContextCommitOp)
  | ({ opKind: "push_op" } & ProbeContextPushOp)
  | ({ opKind: "pr_open_op" } & ProbeContextPrOpenOp)
  | ({ opKind: "pr_update_op" } & ProbeContextPrUpdateOp)
  | ({ opKind: "submit_review_op" } & ProbeContextSubmitReviewOp)
  | ({ opKind: "merge_op" } & ProbeContextMergeOp)
  | ({ opKind: "add_label_op" } & ProbeContextLabelOp)
  | ({ opKind: "remove_label_op" } & ProbeContextLabelOp)
  | ({ opKind: "dismiss_review_op" } & ProbeContextDismissReviewOp);

// Helper: keep TS happy when we let callers pass any ProbeContext shape.
type ProbeContextFor<K extends OutboxOpKind, _P> = ProbeContext;

export interface OutboxRecoveryResult {
  recovered: boolean;
  externalId: string | null;
  externalState: Record<string, unknown> | null;
}

export interface OutboxRecoveryCandidate {
  opKind: OutboxOpKind;
  idempotencyKey: string;
  mode: OutboxRecoveryMode;
}

export interface OutboxScanInput {
  /**
   * `(idempotencyKey) → boolean` predicate the caller uses to decide
   * whether a matching AgentRunReceipt exists. Outbox doesn't know
   * receipt schema; receipt knowledge stays in the caller (plan §7-3).
   */
  hasMatchingReceipt: (idempotencyKey: string) => Promise<boolean>;
  /**
   * PR #127 review P1-2 (gpt5.5): slot-scoped receipt check.
   *
   * Live lead receipt records only the terminal `pr_open_op` / `pr_update_op`
   * idempotency key (`k3`), not the per-step `commit_op` (`k1`) or `push_op`
   * (`k2`) keys. Without this hook, every normally-completed lead turn
   * resurfaces its commit/push posted rows as `posted_without_receipt`
   * candidates on every sweep (the live receipt does not match `k1`/`k2`).
   * The receipt's `(session_id, turn_index)` slot is the canonical
   * "turn covered" marker — if any receipt exists for the slot tied to a
   * pending outbox row, the lead/reviewer chain is considered covered and
   * we skip the duplicate Case B candidate.
   *
   * Optional: callers that only have the key→presence index can omit this
   * (legacy behaviour preserved).
   */
  hasReceiptForSlot?: (
    sessionId: string,
    turnIndex: number,
  ) => Promise<boolean>;
}

export interface OutboxDeps {
  store: StorePort;
  ledger: LedgerAppender;
}

/**
 * Run a port probe for the given op_kind. Returns `recovered=true` plus
 * an `externalId` whenever the external surface confirms the write
 * happened.
 */
export async function runOutboxProbe(
  ctx: ProbeContext,
): Promise<OutboxRecoveryResult> {
  switch (ctx.opKind) {
    case "commit_op": {
      const sha = await ctx.workspace.findCommitByTrailer({
        branch: ctx.branch,
        trailerKey: ctx.trailerKey,
        value: ctx.value,
        depth: ctx.depth,
      });
      return sha == null
        ? { recovered: false, externalId: null, externalState: null }
        : {
            recovered: true,
            externalId: sha,
            externalState: { commit_sha: sha },
          };
    }
    case "push_op": {
      const sha = await ctx.workspace.getRemoteHeadSha({
        remote: ctx.remote,
        branch: ctx.branch,
      });
      const ok = sha === ctx.expectedSha;
      return ok
        ? {
            recovered: true,
            externalId: sha,
            externalState: { remote_sha: sha },
          }
        : { recovered: false, externalId: sha, externalState: null };
    }
    case "pr_open_op": {
      // The idempotency key sits in the canonical machine block; this probe
      // path is fed via the outer recovery coordinator which passes the key
      // explicitly into `outbox.recover`. We rely on the caller to embed
      // the same key in the PR body so this probe matches.
      const handle = await ctx.gitHost.findOpenPullRequestByMachineKey(
        ctx.headBranch,
        // The shared idempotency_key lives in the outer recover() input.
        // Encoded into ProbeContext via the structurally-typed wrapper
        // below — see `recoverWithProbeKey`.
        (ctx as unknown as { idempotencyKey: string }).idempotencyKey,
      );
      return handle == null
        ? { recovered: false, externalId: null, externalState: null }
        : {
            recovered: true,
            externalId: handle.id,
            externalState: { pr_ref: handle },
          };
    }
    case "pr_update_op": {
      const handle = await ctx.gitHost.findPullRequestByBodyMachineKey(
        ctx.prRef,
        (ctx as unknown as { idempotencyKey: string }).idempotencyKey,
      );
      return handle == null
        ? { recovered: false, externalId: null, externalState: null }
        : {
            recovered: true,
            externalId: handle.id,
            externalState: { pr_ref: handle },
          };
    }
    case "submit_review_op": {
      const review = await ctx.gitHost.findReviewByMachineKey(
        ctx.prRef,
        (ctx as unknown as { idempotencyKey: string }).idempotencyKey,
      );
      return review == null
        ? { recovered: false, externalId: null, externalState: null }
        : {
            recovered: true,
            externalId: review.externalReviewId,
            externalState: { review_state: review.state },
          };
    }
    case "merge_op": {
      const state = await ctx.gitHost.getPullRequestMergeState(ctx.prRef);
      const ok = state.state === "merged" && state.mergeCommitSha != null;
      return ok
        ? {
            recovered: true,
            externalId: state.mergeCommitSha,
            externalState: { merge_commit_sha: state.mergeCommitSha },
          }
        : { recovered: false, externalId: null, externalState: null };
    }
    case "add_label_op":
    case "remove_label_op": {
      const labels = await ctx.gitHost.listLabels(ctx.prRef);
      const present = labels.includes(ctx.label);
      const ok = ctx.expect === "present" ? present : !present;
      return ok
        ? {
            recovered: true,
            externalId: ctx.label,
            externalState: { labels },
          }
        : { recovered: false, externalId: null, externalState: { labels } };
    }
    case "dismiss_review_op": {
      const review = await ctx.gitHost.getReview(
        ctx.prRef,
        ctx.externalReviewId,
      );
      const ok = review != null && review.state === "dismissed";
      return ok
        ? {
            recovered: true,
            externalId: ctx.externalReviewId,
            externalState: { review_state: review.state },
          }
        : { recovered: false, externalId: null, externalState: null };
    }
    default: {
      const _exhaustive: never = ctx;
      void _exhaustive;
      return { recovered: false, externalId: null, externalState: null };
    }
  }
}

/**
 * Outbox — minimal coordinator. Each call appends ledger events; no
 * Receipt/SessionTurn knowledge. The caller is responsible for using
 * scoped idempotency keys (`outbox/<op_kind>/<key>`) so the ledger's
 * applied-keys cache treats different ops independently.
 */
export class Outbox {
  constructor(private readonly deps: OutboxDeps) {}

  private outboxKey(opKind: OutboxOpKind, key: string, suffix: string): string {
    return `outbox/${opKind}/${key}/${suffix}`;
  }

  async begin(input: OutboxBeginInput): Promise<{ result: "applied" | "duplicate" }> {
    return appendOutboxRow(this.deps.ledger, {
      action: "outbox_pending",
      result: "applied",
      callerId: input.callerId,
      targetId: input.targetId,
      objectId: input.objectId,
      manifestId: input.manifestId,
      idempotencyKey: this.outboxKey(input.opKind, input.idempotencyKey, "begin"),
      opKind: input.opKind,
      surfaceRef: input.surfaceRef,
      // PR-123 P0-1: receipt tuple onto the pending row.
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      agentProfileId: input.agentProfileId,
      loopKind: input.loopKind,
      detail: input.payload ? safeJson(input.payload) : null,
    });
  }

  async complete(
    input: OutboxCompleteInput,
  ): Promise<{ result: "applied" | "duplicate" }> {
    const action: LedgerActionKind =
      input.status === "posted" ? "outbox_posted" : "outbox_failed";
    const result = input.status === "posted" ? "applied" : "error";
    return appendOutboxRow(this.deps.ledger, {
      action,
      result,
      callerId: input.callerId,
      targetId: input.targetId,
      objectId: input.objectId,
      manifestId: input.manifestId,
      idempotencyKey: this.outboxKey(
        input.opKind,
        input.idempotencyKey,
        `complete:${input.status}`,
      ),
      opKind: input.opKind,
      surfaceRef: input.surfaceRef,
      externalReviewId: input.externalReviewId,
      detail: input.externalId ?? null,
    });
  }

  async recover(input: OutboxRecoverInput): Promise<OutboxRecoveryResult> {
    // Inject idempotencyKey into the probe context so probes that need it
    // (pr_open_op / pr_update_op / submit_review_op) can read it.
    const probeWithKey = {
      ...input.probe,
      idempotencyKey: input.idempotencyKey,
    } as unknown as ProbeContext;
    const probeResult = await runOutboxProbe(probeWithKey);

    if (!probeResult.recovered) {
      return probeResult;
    }

    // Always emit `outbox_recovered`. For pending_without_posted we *also*
    // emit `outbox_posted` so the canonical state matches a normal happy
    // path. For posted_without_receipt the `outbox_posted` row already
    // exists — recovery only needs the marker.
    await appendOutboxRow(this.deps.ledger, {
      action: "outbox_recovered",
      result: "recovered",
      callerId: input.callerId,
      targetId: input.targetId,
      objectId: input.objectId,
      manifestId: input.manifestId,
      idempotencyKey: this.outboxKey(
        input.opKind,
        input.idempotencyKey,
        `recovered:${input.mode}`,
      ),
      opKind: input.opKind,
      surfaceRef: input.surfaceRef,
      detail: probeResult.externalId,
    });

    if (input.mode === "pending_without_posted") {
      await appendOutboxRow(this.deps.ledger, {
        action: "outbox_posted",
        result: "applied",
        callerId: input.callerId,
        targetId: input.targetId,
        objectId: input.objectId,
        manifestId: input.manifestId,
        idempotencyKey: this.outboxKey(
          input.opKind,
          input.idempotencyKey,
          "complete:posted",
        ),
        opKind: input.opKind,
        surfaceRef: input.surfaceRef,
        detail: probeResult.externalId,
      });
    }

    return probeResult;
  }

  /**
   * Walks the ledger and returns recovery candidates. Two cases (cli-spicy-anchor.md
   * §7-3):
   *   (a) pending_without_posted: `outbox_pending` exists but no
   *       `outbox_posted` / `outbox_failed` / `outbox_recovered` for the
   *       same (op_kind, key) is present.
   *   (b) posted_without_receipt: `outbox_posted` is present but the
   *       caller's `hasMatchingReceipt(idempotencyKey)` returns false.
   *
   * Receipt-presence detection is delegated via the input callback; the
   * outbox does not know AgentRunReceipt's storage path.
   */
  async scanRecoveryCandidatesFromLedger(
    input: OutboxScanInput,
  ): Promise<OutboxRecoveryCandidate[]> {
    const rows = await readAllLedgerRows(this.deps.store);

    /** key = `<op_kind>::<idempotency_key>` */
    const status = new Map<
      string,
      {
        opKind: OutboxOpKind;
        key: string;
        hasPending: boolean;
        hasPosted: boolean;
        hasFailed: boolean;
        hasRecovered: boolean;
        // PR #127 review P1-2: slot tuple captured from the pending row so
        // the Case B scan can fall back to a turn-scoped receipt check when
        // the per-op key (k1/k2) doesn't match the live receipt's k3.
        sessionId: string | null;
        turnIndex: number | null;
      }
    >();

    for (const row of rows) {
      const opKind = row.op_kind as OutboxOpKind | undefined;
      if (opKind == null) continue;
      // Outbox idempotency keys follow `outbox/<op>/<key>/<suffix>`. We need
      // the original key to scan receipts. Decode here.
      const decoded = decodeOutboxKey(row.idempotency_key);
      if (decoded == null) continue;
      if (decoded.opKind !== opKind) continue;
      const mapKey = `${opKind}::${decoded.key}`;
      const cur = status.get(mapKey) ?? {
        opKind,
        key: decoded.key,
        hasPending: false,
        hasPosted: false,
        hasFailed: false,
        hasRecovered: false,
        sessionId: null,
        turnIndex: null,
      };
      switch (row.action_kind) {
        case "outbox_pending":
          cur.hasPending = true;
          // Only the pending row carries the receipt slot tuple (invokers
          // populate session_id / turn_index on outbox.begin). Capture once.
          if (cur.sessionId == null && row.session_id != null) {
            cur.sessionId = row.session_id;
          }
          if (cur.turnIndex == null && row.turn_index != null) {
            cur.turnIndex = row.turn_index;
          }
          break;
        case "outbox_posted":
          cur.hasPosted = true;
          break;
        case "outbox_failed":
          cur.hasFailed = true;
          break;
        case "outbox_recovered":
          cur.hasRecovered = true;
          break;
        default:
          break;
      }
      status.set(mapKey, cur);
    }

    const candidates: OutboxRecoveryCandidate[] = [];
    for (const v of status.values()) {
      if (
        v.hasPending &&
        !v.hasPosted &&
        !v.hasFailed &&
        !v.hasRecovered
      ) {
        candidates.push({
          opKind: v.opKind,
          idempotencyKey: v.key,
          mode: "pending_without_posted",
        });
      } else if (v.hasPosted) {
        // PR #127 review P1-2 (gpt5.5): dedup — once a recovery sweep has
        // emitted `outbox_recovered` for this (op_kind, key), do not re-list
        // it as a Case B candidate on subsequent sweeps. The
        // RecoveryCoordinator handles the receipt backfill itself; further
        // sweeps would only repeat that no-op.
        if (v.hasRecovered) continue;
        const receiptOk = await input.hasMatchingReceipt(v.key);
        if (receiptOk) continue;
        // Slot-scoped fallback: lead-invoker writes one receipt per turn
        // keyed by the terminal `k3` (pr_open/pr_update). The earlier
        // `commit_op` / `push_op` posted rows carry distinct keys (`k1`/`k2`)
        // and never match `hasMatchingReceipt`. If any receipt exists for
        // the same `(session_id, turn_index)` slot as the pending row, the
        // turn is covered and we skip the duplicate candidate.
        if (
          input.hasReceiptForSlot != null &&
          v.sessionId != null &&
          v.turnIndex != null
        ) {
          const slotOk = await input.hasReceiptForSlot(
            v.sessionId,
            v.turnIndex,
          );
          if (slotOk) continue;
        }
        candidates.push({
          opKind: v.opKind,
          idempotencyKey: v.key,
          mode: "posted_without_receipt",
        });
      }
    }
    return candidates;
  }
}

interface AppendOutboxArgs {
  action: LedgerActionKind;
  result: LedgerRow["result"];
  callerId: string;
  targetId: string;
  objectId: string;
  manifestId: string | null;
  idempotencyKey: string;
  opKind: OutboxOpKind;
  surfaceRef?: string;
  externalReviewId?: string;
  detail: string | null;
  // PR-123 P0-1: receipt tuple — populated only on `outbox_pending` rows.
  sessionId?: string;
  turnIndex?: number;
  agentProfileId?: string;
  loopKind?: "outer" | "middle" | "inner";
}

async function appendOutboxRow(
  ledger: LedgerAppender,
  args: AppendOutboxArgs,
): Promise<{ result: "applied" | "duplicate" }> {
  const r = await ledger.appendTransition({
    transition_id: newId(),
    target_id: args.targetId,
    object_id: args.objectId,
    object_kind: "system",
    from_state: null,
    to_state: args.action,
    loop_kind: args.loopKind ?? null,
    phase: null,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: args.sessionId ?? null,
    turn_index: args.turnIndex ?? null,
    slot_kind: null,
    agent_profile_id: args.agentProfileId ?? null,
    contribution_kind: null,
    action_kind: args.action,
    final_verdict: null,
    caller_id: args.callerId,
    manifest_id: args.manifestId,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: args.idempotencyKey,
    lease_token: null,
    lease_kind: null,
    result: args.result,
    result_detail: args.detail,
    timestamp: new Date().toISOString(),
    op_kind: args.opKind,
    ...(args.surfaceRef ? { surface_ref: args.surfaceRef } : {}),
    ...(args.externalReviewId
      ? { external_review_id: args.externalReviewId }
      : {}),
  });
  return { result: r.result };
}

function decodeOutboxKey(key: string): { opKind: OutboxOpKind; key: string } | null {
  // outbox/<op>/<key>/<suffix>  — we want <op> and <key>.
  if (!key.startsWith("outbox/")) return null;
  const rest = key.slice("outbox/".length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash < 0) return null;
  const opKind = rest.slice(0, firstSlash) as OutboxOpKind;
  const afterOp = rest.slice(firstSlash + 1);
  const lastSlash = afterOp.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const decoded = afterOp.slice(0, lastSlash);
  return { opKind, key: decoded };
}

async function readAllLedgerRows(store: StorePort): Promise<LedgerRow[]> {
  const body = await store.readText(LEDGER_TRANSITIONS_PATH);
  if (body == null || body.length === 0) return [];
  const out: LedgerRow[] = [];
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    try {
      // Use a permissive parse: legacy rows lacking phase 1 optional fields
      // round-trip through `JSON.parse` cleanly. We do not run zod here —
      // the outbox scan only reads `action_kind`, `op_kind`, and
      // `idempotency_key`, all of which exist on every row schema variant.
      out.push(JSON.parse(line) as LedgerRow);
    } catch {
      // Skip malformed line — caller's ledger replay layer surfaces
      // corruption separately.
    }
  }
  return out;
}

function safeJson(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "<unserializable>";
  }
}
