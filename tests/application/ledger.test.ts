import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import {
  FileLedger,
  idempotencyKey,
} from "../../src/application/ledger.js";
import { LEDGER_TRANSITIONS_PATH } from "../../src/application/persistence-layout.js";
import { AUDIT_HASH_GENESIS } from "../../src/domain/audit-hash.js";
import type { LedgerRow } from "../../src/domain/schema/ledger.js";
import { CollectingLogger } from "../../src/ports/logger.js";

const TX_ID_1 = "01HZTX0000000000000000000A";
const TX_ID_2 = "01HZTX0000000000000000000B";
const TX_ID_3 = "01HZTX0000000000000000000C";
const M_ID = "01HZM00000000000000000000A";
const ISO = "2026-05-07T00:00:00.000Z";

function baseRow(
  overrides: Partial<Omit<LedgerRow, "audit_hash" | "audit_hash_prev">>,
): Omit<LedgerRow, "audit_hash" | "audit_hash_prev"> {
  return {
    transition_id: TX_ID_1,
    target_id: "demo",
    object_id: M_ID,
    object_kind: "milestone",
    from_state: null,
    to_state: "M_INTAKE_QUEUED",
    loop_kind: null,
    phase: null,
    slice_id: null,
    slice_kind: null,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "intake",
    final_verdict: null,
    caller_id: "caller-1",
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: "intake|kind=human_seed&id=issue:1",
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: ISO,
    ...overrides,
  };
}

describe("idempotencyKey — SOC-IDEMPOTENCY 3-scope", () => {
  it("per_turn key is order-invariant under input_revision_pins", () => {
    const a = idempotencyKey({
      scope: "per_turn",
      parts: {
        session_id: "S1",
        turn_index: 0,
        agent_profile_id: "forge",
        manifest_id: "MAN1",
        input_revision_pins: ["b", "a"],
      },
    });
    const b = idempotencyKey({
      scope: "per_turn",
      parts: {
        session_id: "S1",
        turn_index: 0,
        agent_profile_id: "forge",
        manifest_id: "MAN1",
        input_revision_pins: ["a", "b"],
      },
    });
    expect(a).toBe(b);
    expect(a.startsWith("per_turn|S1|0|forge|MAN1|")).toBe(true);
  });

  it("per_session_outcome key changes when verdict differs", () => {
    const a = idempotencyKey({
      scope: "per_session_outcome",
      parts: {
        session_id: "S1",
        final_verdict: "tests_green",
        finalization_decision: "evidence",
        workspace_revision_pin_at_convergence: "abc",
      },
    });
    const b = idempotencyKey({
      scope: "per_session_outcome",
      parts: {
        session_id: "S1",
        final_verdict: "request_changes",
        finalization_decision: "evidence",
        workspace_revision_pin_at_convergence: "abc",
      },
    });
    expect(a).not.toBe(b);
  });

  it("per_merge key includes trunk_base_revision_at_merge_attempt", () => {
    const a = idempotencyKey({
      scope: "per_merge",
      parts: {
        slice_merge_id: "SM1",
        pre_merge_workspace_revision: "P1",
        trunk_base_revision_at_merge_attempt: "T1",
      },
    });
    const b = idempotencyKey({
      scope: "per_merge",
      parts: {
        slice_merge_id: "SM1",
        pre_merge_workspace_revision: "P1",
        trunk_base_revision_at_merge_attempt: "T2",
      },
    });
    expect(a).not.toBe(b);
  });
});

describe("FileLedger", () => {
  it("appends a row, computes audit_hash chained from genesis", async () => {
    const store = new MemoryStore();
    const logger = new CollectingLogger();
    const ledger = new FileLedger({ store, logger });
    const r = await ledger.appendTransition(baseRow({}));
    expect(r.result).toBe("applied");
    expect(r.row.audit_hash_prev).toBe(AUDIT_HASH_GENESIS);
    expect(r.row.audit_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await ledger.lastAuditHash()).toBe(r.row.audit_hash);
    expect(logger.events.find((e) => e.event === "ledger.append")).toBeTruthy();
  });

  it("chains prev → curr across rows", async () => {
    const store = new MemoryStore();
    const ledger = new FileLedger({ store });
    const r1 = await ledger.appendTransition(baseRow({}));
    const r2 = await ledger.appendTransition(
      baseRow({ transition_id: TX_ID_2, idempotency_key: "k2" }),
    );
    expect(r2.row.audit_hash_prev).toBe(r1.row.audit_hash);
    expect(r2.row.audit_hash).not.toBe(r1.row.audit_hash);
  });

  it("incident-2 P0: duplicate idempotency_key is NOT persisted to disk", async () => {
    const store = new MemoryStore();
    const ledger = new FileLedger({ store });
    const r1 = await ledger.appendTransition(baseRow({}));
    expect(r1.result).toBe("applied");
    expect(r1.row.result).toBe("applied");
    const r2 = await ledger.appendTransition(
      baseRow({ transition_id: TX_ID_2 }),
    );
    expect(r2.result).toBe("duplicate");
    expect(r2.row.result).toBe("duplicate");
    expect(r2.row.idempotency_key).toBe(r1.row.idempotency_key);
    // Synthesized duplicate row's audit_hash_prev still points at the
    // current head (r1) for caller diagnostics, but the row itself is
    // never written.
    expect(r2.row.audit_hash_prev).toBe(r1.row.audit_hash);
    const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    expect(body.split("\n").filter(Boolean).length).toBe(1);
  });

  it("incident-2 P0: subsequent applied rows chain off the last APPLIED row, not the duplicate", async () => {
    const store = new MemoryStore();
    const ledger = new FileLedger({ store });
    const r1 = await ledger.appendTransition(baseRow({}));
    const r2 = await ledger.appendTransition(
      baseRow({ transition_id: TX_ID_2 }),
    );
    expect(r2.result).toBe("duplicate");
    const r3 = await ledger.appendTransition(
      baseRow({ transition_id: TX_ID_3, idempotency_key: "k3" }),
    );
    expect(r3.result).toBe("applied");
    expect(r3.row.audit_hash_prev).toBe(r1.row.audit_hash);
    // File has exactly r1 + r3 (duplicate r2 was not persisted).
    const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    expect(body.split("\n").filter(Boolean).length).toBe(2);
  });

  it("PR #94 P1-D: emits ledger.duplicate log event exactly once per duplicate append", async () => {
    const store = new MemoryStore();
    const logger = new CollectingLogger();
    const ledger = new FileLedger({ store, logger });
    const r1 = await ledger.appendTransition(baseRow({}));
    expect(r1.result).toBe("applied");
    const r2 = await ledger.appendTransition(
      baseRow({ transition_id: TX_ID_2 }),
    );
    expect(r2.result).toBe("duplicate");
    const dupEvents = logger.events.filter(
      (e) => e.event === "ledger.duplicate",
    );
    expect(dupEvents.length).toBe(1);
    expect(dupEvents[0]?.fields).toMatchObject({
      idempotency_key: r1.row.idempotency_key,
      result: "duplicate",
    });
  });

  it("PR #94 P0-1: same-byte external content swap forces re-replay (tail fingerprint)", async () => {
    const store = new MemoryStore();
    const a = new FileLedger({ store });
    // Prime a's cache with a single applied row.
    const ra = await a.appendTransition(baseRow({}));
    const bodyAfterA = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    // External writer (sibling FileLedger b) replaces the ndjson with a
    // *different* row whose serialized byte length matches ra's exactly.
    // Without the tail fingerprint, a's cache would short-circuit on the
    // (still-equal) lastReplayedSize and chain its next applied row off
    // the now-stale cachedHead, corrupting the audit_hash chain.
    const b = new FileLedger({ store });
    // Build an alternate single-row body; pick fields so the serialized
    // length matches bodyAfterA. transition_id and idempotency_key both
    // have fixed lengths in baseRow, so we can simply re-prime b on a
    // fresh store with a different idempotency_key/transition_id and
    // swap b's body in for a's.
    const altStore = new MemoryStore();
    const bSeed = new FileLedger({ store: altStore });
    // Alt idempotency_key is chosen to match the original key's byte length
    // exactly so the serialized row's overall length is identical (the only
    // other variable-length field is audit_hash[_prev] which is fixed at
    // 64 hex chars). This is the worst-case input for the size-only cache:
    // an external writer swap that is byte-equivalent in size.
    const altKey = "intake|kind=human_seed&id=issue:9";
    expect(altKey.length).toBe(
      "intake|kind=human_seed&id=issue:1".length,
    );
    const rb = await bSeed.appendTransition(
      baseRow({ transition_id: TX_ID_2, idempotency_key: altKey }),
    );
    const bodyAlt = (await altStore.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    // Sanity: same byte length, different content (different audit_hash
    // line means same-size swap is realistic).
    expect(bodyAlt.length).toBe(bodyAfterA.length);
    expect(bodyAlt).not.toBe(bodyAfterA);
    await store.writeAtomic(LEDGER_TRANSITIONS_PATH, bodyAlt);
    // a's next append must observe the swap: audit_hash_prev should be
    // rb's audit_hash (the new tail), NOT ra's stale cachedHead.
    void b;
    const ra2 = await a.appendTransition(
      baseRow({ transition_id: TX_ID_3, idempotency_key: "k3" }),
    );
    expect(ra2.result).toBe("applied");
    expect(ra2.row.audit_hash_prev).toBe(rb.row.audit_hash);
  });

  it("PR #94 P0-2: concurrent runDaemonPrelude calls for the same role emit exactly one noop row", async () => {
    // Singleflight regression: two callers from the same role race into
    // the gate simultaneously; both observe non-RUNNING + miss memo;
    // without the in-flight registry both would appendTransition. With
    // the singleflight, the second call awaits the first's promise and
    // returns its outcome.
    const { FsStore } = await import("../../src/adapters/store/fs.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const {
      __resetDaemonPreludeMemo,
      applyControlSignal,
      runDaemonPrelude,
    } = await import("../../src/application/control-state.js");
    const { HumanSignalEnvelope } = await import(
      "../../src/domain/schema/human-signal.js"
    );
    const { FixedClock } = await import("../../src/ports/clock.js");
    __resetDaemonPreludeMemo();
    const store = new FsStore({ workdir: mkdtempSync(join(tmpdir(), "p94-")) });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    const ledger = new FileLedger({ store, auditHashSeed: "seed-94" });
    await applyControlSignal(
      store,
      clock,
      HumanSignalEnvelope.parse({
        target_kind: "system",
        target_id: "system",
        actor: "operator",
        created_at: "2026-05-09T00:00:00.000Z",
        source: "fs_drop",
        signal_id: "sig-pause",
        signal_type: "pause",
      }),
    );
    const deps = {
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "test-target",
      role: "turn-worker",
    };
    const [a, b] = await Promise.all([
      runDaemonPrelude(deps),
      runDaemonPrelude(deps),
    ]);
    expect(a.action).toBe("paused");
    expect(b.action).toBe("paused");
    const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    const lines = body.split("\n").filter((s) => s.length > 0);
    expect(lines.length).toBe(1);
  });

  it("incident-2 P0: 1000 same-key duplicate appends grow the file exactly once (cache smoke)", async () => {
    const store = new MemoryStore();
    const ledger = new FileLedger({ store });
    await ledger.appendTransition(baseRow({}));
    for (let i = 0; i < 1000; i++) {
      const out = await ledger.appendTransition(
        baseRow({ transition_id: TX_ID_2 }),
      );
      expect(out.result).toBe("duplicate");
    }
    const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    expect(body.split("\n").filter(Boolean).length).toBe(1);
  });

  it("incident-2 P0: external writer (sibling FileLedger) invalidates the cache on next append", async () => {
    const store = new MemoryStore();
    const a = new FileLedger({ store });
    const b = new FileLedger({ store });
    // Prime a's cache.
    const ra = await a.appendTransition(baseRow({}));
    // b writes through the same store while a still holds a stale cache.
    const rb = await b.appendTransition(
      baseRow({ transition_id: TX_ID_2, idempotency_key: "k2" }),
    );
    expect(rb.row.audit_hash_prev).toBe(ra.row.audit_hash);
    // a's next append must observe b's row (file size diverged from
    // a.lastReplayedSize → forced re-replay).
    const ra2 = await a.appendTransition(
      baseRow({ transition_id: TX_ID_3, idempotency_key: "k3" }),
    );
    expect(ra2.result).toBe("applied");
    expect(ra2.row.audit_hash_prev).toBe(rb.row.audit_hash);
  });

  it("auditHashSeed alters the chain", async () => {
    const a = new FileLedger({ store: new MemoryStore() });
    const b = new FileLedger({
      store: new MemoryStore(),
      auditHashSeed: "seed-1",
    });
    const ra = await a.appendTransition(baseRow({}));
    const rb = await b.appendTransition(baseRow({}));
    expect(ra.row.audit_hash).not.toBe(rb.row.audit_hash);
  });

  it("recovers chain head and idempotency set from existing ndjson on first call", async () => {
    const store = new MemoryStore();
    const ledger1 = new FileLedger({ store });
    const r1 = await ledger1.appendTransition(baseRow({}));
    const ledger2 = new FileLedger({ store });
    expect(await ledger2.lastAuditHash()).toBe(r1.row.audit_hash);
    const dup = await ledger2.appendTransition(baseRow({}));
    expect(dup.result).toBe("duplicate");
    // incident-2 P0: duplicate is not persisted, head does NOT advance.
    expect(await ledger2.lastAuditHash()).toBe(r1.row.audit_hash);
    const r3 = await ledger2.appendTransition(
      baseRow({ transition_id: TX_ID_3, idempotency_key: "k3" }),
    );
    expect(r3.row.audit_hash_prev).toBe(r1.row.audit_hash);
  });

  it("multi-instance writers see the latest head via withFileLock (no fork)", async () => {
    const store = new MemoryStore();
    const a = new FileLedger({ store });
    const b = new FileLedger({ store });
    const ra = await a.appendTransition(baseRow({}));
    const rb = await b.appendTransition(
      baseRow({ transition_id: TX_ID_2, idempotency_key: "k2" }),
    );
    // b reads file, sees a's row, chains forward.
    expect(rb.row.audit_hash_prev).toBe(ra.row.audit_hash);
  });

  it("replay throws LedgerCorruptError when audit_hash_prev is tampered", async () => {
    const store = new MemoryStore();
    const ledger1 = new FileLedger({ store });
    await ledger1.appendTransition(baseRow({}));
    await ledger1.appendTransition(
      baseRow({ transition_id: TX_ID_2, idempotency_key: "k2" }),
    );
    // Tamper: rewrite the second row's audit_hash_prev.
    const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    const lines = body.split("\n").filter(Boolean);
    const r2 = JSON.parse(lines[1]!) as LedgerRow;
    const tampered = { ...r2, audit_hash_prev: "0".repeat(64) };
    await store.writeAtomic(
      LEDGER_TRANSITIONS_PATH,
      `${lines[0]}\n${JSON.stringify(tampered)}\n`,
    );
    const ledger2 = new FileLedger({ store });
    await expect(ledger2.lastAuditHash()).rejects.toThrow(
      /audit_hash_prev mismatch/,
    );
  });

  it("replay throws when audit_hash itself does not match recompute", async () => {
    const store = new MemoryStore();
    const ledger1 = new FileLedger({ store });
    const r1 = await ledger1.appendTransition(baseRow({}));
    const tampered = { ...r1.row, audit_hash: "f".repeat(64) };
    await store.writeAtomic(
      LEDGER_TRANSITIONS_PATH,
      `${JSON.stringify(tampered)}\n`,
    );
    const ledger2 = new FileLedger({ store });
    await expect(ledger2.lastAuditHash()).rejects.toThrow(
      /audit_hash recompute mismatch/,
    );
  });

  it("serializes concurrent appends so audit_hash chain stays linear", async () => {
    const store = new MemoryStore();
    const ledger = new FileLedger({ store });
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const txId = `01HZTX000000000000000000${i.toString().padStart(2, "0")}`;
      tasks.push(
        ledger.appendTransition(
          baseRow({
            transition_id: txId,
            idempotency_key: `key-${i}`,
          }),
        ),
      );
    }
    await Promise.all(tasks);
    const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    const rows = body
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s) as LedgerRow);
    expect(rows.length).toBe(10);
    let prev = AUDIT_HASH_GENESIS;
    for (const row of rows) {
      expect(row.audit_hash_prev).toBe(prev);
      prev = row.audit_hash;
    }
  });
});
