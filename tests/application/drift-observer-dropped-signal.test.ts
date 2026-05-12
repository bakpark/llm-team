/**
 * Phase 3 — dropped review-signal triple dedup helper
 * (cli-spicy-anchor.md §6, PR sequence PR-5).
 *
 * The pr-watcher 5-gate (Phase 4 PR-6) will eventually call into
 * `recordDroppedReviewSignal` when a native PR review fails any of the
 * five correlation gates. The helper guarantees:
 *
 *   - the same (external_review_id, drop_reason, review_surface_id) triple
 *     produces exactly one `review_signal_dropped` ledger row, regardless
 *     of how many times it is invoked within a single process;
 *   - in-process duplicates short-circuit via the in-memory cache;
 *   - cross-process duplicates (daemon restart) short-circuit via the
 *     ledger scan that re-establishes the cache;
 *   - distinct drop reasons or distinct external_review_ids produce
 *     distinct rows.
 *
 * Phase 3 ships the helper only; the actual call-site lands in PR-6.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FixedClock } from "../../src/ports/clock.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  LEDGER_TRANSITIONS_PATH,
} from "../../src/application/persistence-layout.js";
import {
  DroppedReviewSignalCache,
  recordDroppedReviewSignal,
} from "../../src/application/drift-observer.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";

const ISO = "2026-05-08T00:00:00.000Z";
const FIXED_MS = new Date(ISO).valueOf();
const SURFACE_ID = "01HZSU00000000000000000001";
const TARGET_ID = "demo";
const CALLER_ID = "test-caller";

function makeDeps() {
  const store = new MemoryStore();
  const clock = new FixedClock(FIXED_MS);
  const ledger = new FileLedger({ store });
  const cache = new DroppedReviewSignalCache();
  return {
    store,
    clock,
    ledger,
    callerId: CALLER_ID,
    targetId: TARGET_ID,
    cache,
  } as const;
}

async function readDroppedRows(store: MemoryStore) {
  const body = store["entries"].get(LEDGER_TRANSITIONS_PATH) ?? "";
  return body
    .split("\n")
    .filter((s: string) => s.length > 0)
    .map((s: string) => LedgerRow.parse(JSON.parse(s)))
    .filter((r) => r.action_kind === "review_signal_dropped");
}

describe("drift-observer · recordDroppedReviewSignal", () => {
  it("appends exactly one ledger row for the same triple invoked twice in-process", async () => {
    const deps = makeDeps();
    const triple = {
      externalReviewId: "rv-1",
      dropReason: "signature_invalid",
      reviewSurfaceId: SURFACE_ID,
    };
    const r1 = await recordDroppedReviewSignal(triple, deps);
    expect(r1.result).toBe("applied");
    const r2 = await recordDroppedReviewSignal(triple, deps);
    expect(r2.result).toBe("duplicate");
    if (r2.result === "duplicate") expect(r2.reason).toBe("cache_hit");

    const rows = await readDroppedRows(deps.store);
    expect(rows.length).toBe(1);
    expect(rows[0]!.external_review_id).toBe("rv-1");
    expect(rows[0]!.drop_reason).toBe("signature_invalid");
    expect(rows[0]!.surface_ref).toBe(SURFACE_ID);
    expect(rows[0]!.action_kind).toBe("review_signal_dropped");
    expect(rows[0]!.result).toBe("noop");
  });

  it("survives a fresh cache (daemon restart) via ledger scan", async () => {
    const deps1 = makeDeps();
    const triple = {
      externalReviewId: "rv-restart",
      dropReason: "round_mismatch",
      reviewSurfaceId: SURFACE_ID,
    };
    await recordDroppedReviewSignal(triple, deps1);
    // Simulate restart: keep the same store/ledger but reset the cache.
    const deps2 = {
      ...deps1,
      cache: new DroppedReviewSignalCache(),
    };
    const r = await recordDroppedReviewSignal(triple, deps2);
    expect(r.result).toBe("duplicate");
    if (r.result === "duplicate") expect(r.reason).toBe("ledger_hit");
    const rows = await readDroppedRows(deps1.store);
    expect(rows.length).toBe(1);
    // Cache is now warm — a third call short-circuits via cache_hit.
    const r3 = await recordDroppedReviewSignal(triple, deps2);
    expect(r3.result).toBe("duplicate");
    if (r3.result === "duplicate") expect(r3.reason).toBe("cache_hit");
  });

  it("treats different drop_reason values as distinct triples", async () => {
    const deps = makeDeps();
    const base = {
      externalReviewId: "rv-2",
      reviewSurfaceId: SURFACE_ID,
    };
    const r1 = await recordDroppedReviewSignal(
      { ...base, dropReason: "signature_invalid" },
      deps,
    );
    const r2 = await recordDroppedReviewSignal(
      { ...base, dropReason: "round_mismatch" },
      deps,
    );
    expect(r1.result).toBe("applied");
    expect(r2.result).toBe("applied");
    const rows = await readDroppedRows(deps.store);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.drop_reason))).toEqual(
      new Set(["signature_invalid", "round_mismatch"]),
    );
  });

  it("treats different external_review_id values as distinct triples", async () => {
    const deps = makeDeps();
    const reason = "surface_ref_mismatch";
    await recordDroppedReviewSignal(
      {
        externalReviewId: "rv-a",
        dropReason: reason,
        reviewSurfaceId: SURFACE_ID,
      },
      deps,
    );
    await recordDroppedReviewSignal(
      {
        externalReviewId: "rv-b",
        dropReason: reason,
        reviewSurfaceId: SURFACE_ID,
      },
      deps,
    );
    const rows = await readDroppedRows(deps.store);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.external_review_id))).toEqual(
      new Set(["rv-a", "rv-b"]),
    );
  });

  it("cache.size reflects unique triples", async () => {
    const deps = makeDeps();
    await recordDroppedReviewSignal(
      { externalReviewId: "x", dropReason: "r", reviewSurfaceId: SURFACE_ID },
      deps,
    );
    await recordDroppedReviewSignal(
      { externalReviewId: "x", dropReason: "r", reviewSurfaceId: SURFACE_ID },
      deps,
    );
    await recordDroppedReviewSignal(
      { externalReviewId: "y", dropReason: "r", reviewSurfaceId: SURFACE_ID },
      deps,
    );
    expect(deps.cache.size()).toBe(2);
  });
});
