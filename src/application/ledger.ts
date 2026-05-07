import {
  AUDIT_HASH_GENESIS,
  computeAuditHash,
} from "../domain/audit-hash.js";
import { LedgerRow } from "../domain/schema/ledger.js";
import type { LoggerPort } from "../ports/logger.js";
import type { StorePort } from "../ports/store.js";
import { LEDGER_TRANSITIONS_PATH } from "./persistence-layout.js";

export type IdempotencyScope =
  | "per_turn"
  | "per_session_outcome"
  | "per_merge"
  | "intake"
  | "slot_promotion"
  | "verification"
  | "recover"
  | "external_observation"
  | "signal_apply"
  | "pause_resume";

export interface PerTurnIdempotencyParts {
  session_id: string;
  turn_index: number;
  agent_profile_id: string;
  manifest_id: string;
  input_revision_pins: readonly string[];
}

export interface PerSessionOutcomeIdempotencyParts {
  session_id: string;
  final_verdict: string;
  finalization_decision: string;
  workspace_revision_pin_at_convergence: string | null;
}

export interface PerMergeIdempotencyParts {
  slice_merge_id: string;
  pre_merge_workspace_revision: string;
  trunk_base_revision_at_merge_attempt: string;
}

export type IdempotencyParts =
  | { scope: "per_turn"; parts: PerTurnIdempotencyParts }
  | { scope: "per_session_outcome"; parts: PerSessionOutcomeIdempotencyParts }
  | { scope: "per_merge"; parts: PerMergeIdempotencyParts }
  | { scope: Exclude<IdempotencyScope, "per_turn" | "per_session_outcome" | "per_merge">; parts: Record<string, string | number | null | undefined | readonly string[]> };

/**
 * SOC-IDEMPOTENCY 3-scope idempotency key compositor.
 * Caller enrichment is the single authority that produces these keys.
 */
export function idempotencyKey(input: IdempotencyParts): string {
  switch (input.scope) {
    case "per_turn": {
      const p = input.parts;
      const pins = [...p.input_revision_pins].sort().join(",");
      return [
        "per_turn",
        p.session_id,
        p.turn_index,
        p.agent_profile_id,
        p.manifest_id,
        pins,
      ].join("|");
    }
    case "per_session_outcome": {
      const p = input.parts;
      return [
        "per_session_outcome",
        p.session_id,
        p.final_verdict,
        p.finalization_decision,
        p.workspace_revision_pin_at_convergence ?? "",
      ].join("|");
    }
    case "per_merge": {
      const p = input.parts;
      return [
        "per_merge",
        p.slice_merge_id,
        p.pre_merge_workspace_revision,
        p.trunk_base_revision_at_merge_attempt,
      ].join("|");
    }
    default: {
      const parts = Object.entries(input.parts)
        .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort().join(",") : v ?? ""] as const)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      return [input.scope, parts].join("|");
    }
  }
}

export interface LedgerAppender {
  appendTransition(
    rowWithoutHash: Omit<LedgerRow, "audit_hash" | "audit_hash_prev">,
  ): Promise<{ row: LedgerRow; result: "applied" | "duplicate" }>;
  /** Visible for tests / recovery. */
  lastAuditHash(): Promise<string>;
}

export interface LedgerAppenderOptions {
  store: StorePort;
  logger?: LoggerPort;
  /** TCC-IDENTITY.audit_hash_seed (optional). */
  auditHashSeed?: string;
}

/**
 * Append-only ledger writer that maintains the audit_hash chain and rejects
 * rows whose idempotency_key has already been observed.
 *
 * Single-process: the in-memory chain head + idempotency set is rebuilt from
 * the ndjson on first call. Multi-process safety relies on the store's
 * appendLine lock — Phase 4 will tighten this with leases.
 */
export class FileLedger implements LedgerAppender {
  private readonly store: StorePort;
  private readonly logger?: LoggerPort;
  private readonly auditHashSeed?: string;
  private chain: Promise<void> = Promise.resolve();
  private head: string | null = null;
  private seenKeys: Set<string> | null = null;

  constructor(opts: LedgerAppenderOptions) {
    this.store = opts.store;
    this.logger = opts.logger;
    this.auditHashSeed = opts.auditHashSeed;
  }

  async lastAuditHash(): Promise<string> {
    await this.ensureLoaded();
    return this.head ?? AUDIT_HASH_GENESIS;
  }

  async appendTransition(
    rowWithoutHash: Omit<LedgerRow, "audit_hash" | "audit_hash_prev">,
  ): Promise<{ row: LedgerRow; result: "applied" | "duplicate" }> {
    return this.serial(() => this.doAppend(rowWithoutHash));
  }

  private async doAppend(
    rowWithoutHash: Omit<LedgerRow, "audit_hash" | "audit_hash_prev">,
  ): Promise<{ row: LedgerRow; result: "applied" | "duplicate" }> {
    await this.ensureLoaded();
    const seen = this.seenKeys ?? new Set<string>();
    if (seen.has(rowWithoutHash.idempotency_key)) {
      this.logger?.log({
        level: "info",
        event: "ledger.duplicate",
        fields: {
          idempotency_key: rowWithoutHash.idempotency_key,
          object_kind: rowWithoutHash.object_kind,
          object_id: rowWithoutHash.object_id,
        },
      });
      return { row: this.lastEqualOrSynthesized(rowWithoutHash), result: "duplicate" };
    }
    const prev = this.head ?? AUDIT_HASH_GENESIS;
    const hash = computeAuditHash(prev, rowWithoutHash, this.auditHashSeed);
    const row: LedgerRow = LedgerRow.parse({
      ...rowWithoutHash,
      audit_hash_prev: prev,
      audit_hash: hash,
    });
    await this.store.appendLine(LEDGER_TRANSITIONS_PATH, JSON.stringify(row));
    this.head = hash;
    seen.add(row.idempotency_key);
    this.seenKeys = seen;
    this.logger?.log({
      level: "info",
      event: "ledger.append",
      fields: {
        transition_id: row.transition_id,
        object_kind: row.object_kind,
        object_id: row.object_id,
        action_kind: row.action_kind,
        result: row.result,
      },
    });
    return { row, result: "applied" };
  }

  private lastEqualOrSynthesized(
    rowWithoutHash: Omit<LedgerRow, "audit_hash" | "audit_hash_prev">,
  ): LedgerRow {
    return LedgerRow.parse({
      ...rowWithoutHash,
      audit_hash_prev: AUDIT_HASH_GENESIS,
      audit_hash: AUDIT_HASH_GENESIS,
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.seenKeys != null) return;
    const body = await this.store.readText(LEDGER_TRANSITIONS_PATH);
    const seen = new Set<string>();
    let head: string | null = null;
    if (body != null) {
      const lines = body.split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          const row = LedgerRow.parse(JSON.parse(line));
          seen.add(row.idempotency_key);
          head = row.audit_hash;
        } catch {
          this.logger?.log({
            level: "warn",
            event: "ledger.replay.invalid_row",
          });
        }
      }
    }
    this.seenKeys = seen;
    this.head = head;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
