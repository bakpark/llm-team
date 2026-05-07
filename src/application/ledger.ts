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
  | {
      scope: Exclude<
        IdempotencyScope,
        "per_turn" | "per_session_outcome" | "per_merge"
      >;
      parts: Record<string, string | number | null | undefined | readonly string[]>;
    };

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
        .map(
          ([k, v]) =>
            [k, Array.isArray(v) ? [...v].sort().join(",") : v ?? ""] as const,
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      return [input.scope, parts].join("|");
    }
  }
}

export class LedgerCorruptError extends Error {
  constructor(
    public readonly transitionId: string | null,
    public readonly reason: string,
  ) {
    super(
      `ledger corrupt at transition_id=${transitionId ?? "<unknown>"}: ${reason}`,
    );
    this.name = "LedgerCorruptError";
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
 * rows whose idempotency_key has already been observed (recording the
 * duplicate as its own ledger row per SOC-IDEMPOTENCY).
 *
 * Concurrency model:
 *   - Every appendTransition acquires a store-level lock on
 *     `LEDGER_TRANSITIONS_PATH`. Inside that lock, the file is re-read so the
 *     audit_hash chain head and seenKeys set always reflect on-disk state,
 *     guaranteeing no fork even when multiple processes share one workdir.
 *   - Replay strict-verifies every row's audit_hash_prev linkage and
 *     re-computes audit_hash; any deviation throws LedgerCorruptError.
 */
export class FileLedger implements LedgerAppender {
  private readonly store: StorePort;
  private readonly logger?: LoggerPort;
  private readonly auditHashSeed?: string;

  constructor(opts: LedgerAppenderOptions) {
    this.store = opts.store;
    this.logger = opts.logger;
    this.auditHashSeed = opts.auditHashSeed;
  }

  async lastAuditHash(): Promise<string> {
    return this.store.withFileLock(LEDGER_TRANSITIONS_PATH, async () => {
      const replay = await this.replay();
      return replay.head;
    });
  }

  async appendTransition(
    rowWithoutHash: Omit<LedgerRow, "audit_hash" | "audit_hash_prev">,
  ): Promise<{ row: LedgerRow; result: "applied" | "duplicate" }> {
    return this.store.withFileLock(LEDGER_TRANSITIONS_PATH, async () => {
      const replay = await this.replay();
      const isDuplicate = replay.appliedKeys.has(rowWithoutHash.idempotency_key);
      const declaredResult = rowWithoutHash.result;
      const effectiveResult = isDuplicate ? "duplicate" : declaredResult;
      const finalRowWithoutHash =
        effectiveResult === declaredResult
          ? rowWithoutHash
          : { ...rowWithoutHash, result: effectiveResult };
      const prev = replay.head;
      const hash = computeAuditHash(
        prev,
        finalRowWithoutHash,
        this.auditHashSeed,
      );
      const row: LedgerRow = LedgerRow.parse({
        ...finalRowWithoutHash,
        audit_hash_prev: prev,
        audit_hash: hash,
      });
      await this.store.appendLine(
        LEDGER_TRANSITIONS_PATH,
        JSON.stringify(row),
      );
      this.logger?.log({
        level: "info",
        event: isDuplicate ? "ledger.duplicate" : "ledger.append",
        fields: {
          transition_id: row.transition_id,
          object_kind: row.object_kind,
          object_id: row.object_id,
          action_kind: row.action_kind,
          result: row.result,
          idempotency_key: row.idempotency_key,
        },
      });
      return { row, result: isDuplicate ? "duplicate" : "applied" };
    });
  }

  /**
   * Strict replay of the ledger ndjson. Verifies:
   *   - each row passes schema parsing
   *   - audit_hash_prev equals the prior row's audit_hash (genesis for first)
   *   - audit_hash equals the recomputed hash
   * Throws LedgerCorruptError on any deviation. The seenKeys set tracks rows
   * with result="applied" (or terminal recovery results) so that retries hit
   * the duplicate path.
   */
  private async replay(): Promise<{ head: string; appliedKeys: Set<string> }> {
    const body = await this.store.readText(LEDGER_TRANSITIONS_PATH);
    const appliedKeys = new Set<string>();
    let head = AUDIT_HASH_GENESIS;
    if (body == null) return { head, appliedKeys };
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line == null || line.length === 0) continue;
      let row: LedgerRow;
      try {
        row = LedgerRow.parse(JSON.parse(line));
      } catch (err) {
        throw new LedgerCorruptError(
          null,
          `line ${i + 1} fails schema parse: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (row.audit_hash_prev !== head)
        throw new LedgerCorruptError(
          row.transition_id,
          `audit_hash_prev mismatch at line ${i + 1}: expected ${head}, got ${
            row.audit_hash_prev
          }`,
        );
      const expected = computeAuditHash(
        head,
        stripHash(row),
        this.auditHashSeed,
      );
      if (expected !== row.audit_hash)
        throw new LedgerCorruptError(
          row.transition_id,
          `audit_hash recompute mismatch at line ${i + 1}: expected ${expected}, got ${row.audit_hash}`,
        );
      head = row.audit_hash;
      if (row.result === "applied") appliedKeys.add(row.idempotency_key);
    }
    return { head, appliedKeys };
  }
}

function stripHash(
  row: LedgerRow,
): Omit<LedgerRow, "audit_hash" | "audit_hash_prev"> {
  const { audit_hash: _h, audit_hash_prev: _p, ...rest } = row;
  void _h;
  void _p;
  return rest;
}
