import {
  AUDIT_HASH_GENESIS,
  computeAuditHash,
} from "../domain/audit-hash.js";
import { LedgerRow } from "../domain/schema/ledger.js";
import type { LoggerPort } from "../ports/logger.js";
import type { StorePort } from "../ports/store.js";
import {
  idempotencyKey as composeIdempotencyKey,
  type IdempotencyParts,
  type IdempotencyScope,
  type PerMergeIdempotencyParts,
  type PerSessionOutcomeIdempotencyParts,
  type PerTurnIdempotencyParts,
} from "./idempotency.js";
import { LEDGER_TRANSITIONS_PATH } from "./persistence-layout.js";

// Re-exports preserve the historical import surface (`from "./ledger.js"`)
// for code that already depends on it. The single authority is
// `application/idempotency.ts`.
export {
  composeIdempotencyKey as idempotencyKey,
  type IdempotencyScope,
  type PerTurnIdempotencyParts,
  type PerSessionOutcomeIdempotencyParts,
  type PerMergeIdempotencyParts,
  type IdempotencyParts,
};

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
 * rows whose idempotency_key has already been observed.
 *
 * Concurrency model:
 *   - Every appendTransition acquires a store-level lock on
 *     `LEDGER_TRANSITIONS_PATH`. Inside that lock, the chain head and
 *     appliedKeys set are kept consistent with on-disk state via an
 *     in-memory cache invalidated when the file's byte length diverges from
 *     the cached `lastReplayedSize` (e.g. a sibling process appended).
 *   - Replay strict-verifies every row's audit_hash_prev linkage and
 *     re-computes audit_hash; any deviation throws LedgerCorruptError.
 *
 * Idempotency policy (incident-2 P0): when an incoming row's idempotency_key
 * was already applied, the file append is **skipped entirely**. The function
 * still resolves with a synthesized row (result="duplicate", chained from
 * the current head) and emits a `ledger.duplicate` log event for
 * observability, but the audit chain head does not advance — duplicates are
 * not persisted and therefore cannot affect the next applied row's
 * `audit_hash_prev`.
 */
export class FileLedger implements LedgerAppender {
  private readonly store: StorePort;
  private readonly logger?: LoggerPort;
  private readonly auditHashSeed?: string;
  /**
   * Per-process cache of the last replay result. Avoids O(n) re-parse per
   * append in steady state. Invalidated when the file's byte length diverges
   * from `lastReplayedSize` — covers external writers and absent files.
   */
  private cachedHead: string | null = null;
  private cachedAppliedKeys: Set<string> | null = null;
  private lastReplayedSize: number | null = null;

  constructor(opts: LedgerAppenderOptions) {
    this.store = opts.store;
    this.logger = opts.logger;
    this.auditHashSeed = opts.auditHashSeed;
  }

  async lastAuditHash(): Promise<string> {
    return this.store.withFileLock(LEDGER_TRANSITIONS_PATH, async () => {
      const replay = await this.replayCached();
      return replay.head;
    });
  }

  async appendTransition(
    rowWithoutHash: Omit<LedgerRow, "audit_hash" | "audit_hash_prev">,
  ): Promise<{ row: LedgerRow; result: "applied" | "duplicate" }> {
    return this.store.withFileLock(LEDGER_TRANSITIONS_PATH, async () => {
      const replay = await this.replayCached();
      const isDuplicate = replay.appliedKeys.has(rowWithoutHash.idempotency_key);
      const prev = replay.head;
      if (isDuplicate) {
        // Synthesize a duplicate row representation for the caller without
        // persisting. Chain head does NOT advance — the next applied row
        // still chains off the last applied row.
        const dupRowWithoutHash = { ...rowWithoutHash, result: "duplicate" as const };
        const dupHash = computeAuditHash(prev, dupRowWithoutHash, this.auditHashSeed);
        const dupRow: LedgerRow = LedgerRow.parse({
          ...dupRowWithoutHash,
          audit_hash_prev: prev,
          audit_hash: dupHash,
        });
        this.logger?.log({
          level: "info",
          event: "ledger.duplicate",
          fields: {
            transition_id: dupRow.transition_id,
            object_kind: dupRow.object_kind,
            object_id: dupRow.object_id,
            action_kind: dupRow.action_kind,
            result: dupRow.result,
            idempotency_key: dupRow.idempotency_key,
          },
        });
        return { row: dupRow, result: "duplicate" };
      }
      const hash = computeAuditHash(prev, rowWithoutHash, this.auditHashSeed);
      const row: LedgerRow = LedgerRow.parse({
        ...rowWithoutHash,
        audit_hash_prev: prev,
        audit_hash: hash,
      });
      const serialized = JSON.stringify(row);
      await this.store.appendLine(LEDGER_TRANSITIONS_PATH, serialized);
      // Advance the in-memory cache after a successful applied write. The
      // appendLine implementation adds a trailing newline iff missing, so
      // size delta is serialized.length + 1.
      this.cachedHead = row.audit_hash;
      if (
        row.result === "applied" ||
        row.result === "recovered" ||
        row.result === "rolled_back" ||
        row.result === "escalated"
      )
        replay.appliedKeys.add(row.idempotency_key);
      this.cachedAppliedKeys = replay.appliedKeys;
      if (this.lastReplayedSize != null)
        this.lastReplayedSize += serialized.length + 1;
      this.logger?.log({
        level: "info",
        event: "ledger.append",
        fields: {
          transition_id: row.transition_id,
          object_kind: row.object_kind,
          object_id: row.object_id,
          action_kind: row.action_kind,
          result: row.result,
          idempotency_key: row.idempotency_key,
        },
      });
      return { row, result: "applied" };
    });
  }

  /**
   * Returns the cached replay result if the on-disk file size matches the
   * cached size; otherwise re-reads and re-replays. Cache is per-instance so
   * separate FileLedger objects (even pointed at the same store) each see a
   * fresh replay until they prime their cache.
   */
  private async replayCached(): Promise<{
    head: string;
    appliedKeys: Set<string>;
  }> {
    const body = await this.store.readText(LEDGER_TRANSITIONS_PATH);
    const currentSize = body == null ? 0 : Buffer.byteLength(body, "utf8");
    if (
      this.cachedHead != null &&
      this.cachedAppliedKeys != null &&
      this.lastReplayedSize === currentSize
    ) {
      return { head: this.cachedHead, appliedKeys: this.cachedAppliedKeys };
    }
    const result = body == null ? this.emptyReplay() : this.replayBody(body);
    this.cachedHead = result.head;
    this.cachedAppliedKeys = result.appliedKeys;
    this.lastReplayedSize = currentSize;
    return result;
  }

  private emptyReplay(): { head: string; appliedKeys: Set<string> } {
    return { head: AUDIT_HASH_GENESIS, appliedKeys: new Set<string>() };
  }

  /**
   * Strict replay of the ledger ndjson. Verifies:
   *   - each row passes schema parsing
   *   - audit_hash_prev equals the prior row's audit_hash (genesis for first)
   *   - audit_hash equals the recomputed hash
   * Throws LedgerCorruptError on any deviation. The appliedKeys set tracks
   * rows with result="applied" (or terminal recovery results) so retries hit
   * the duplicate path. Note: as of incident-2 P0, duplicate rows are no
   * longer persisted, so they cannot appear during replay; if a legacy
   * `result="duplicate"` row is encountered (older ledgers), it advances the
   * chain head exactly as it did historically but does not re-add to
   * appliedKeys (the original applied row already did).
   */
  private replayBody(body: string): { head: string; appliedKeys: Set<string> } {
    const appliedKeys = new Set<string>();
    let head = AUDIT_HASH_GENESIS;
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
      // PR #63 review P0-3: terminal results that represent successful
      // recovery / rollback / escalation must also dedupe their
      // idempotency_key. Otherwise a recurring sweep would re-emit the
      // same `recover` row forever (concurrent daemons + the
      // sweep-clear-after-ledger ordering both produce repeats).
      if (
        row.result === "applied" ||
        row.result === "recovered" ||
        row.result === "rolled_back" ||
        row.result === "escalated"
      )
        appliedKeys.add(row.idempotency_key);
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
