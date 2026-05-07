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

function baseRow(
  overrides: Partial<Omit<LedgerRow, "audit_hash" | "audit_hash_prev">>,
): Omit<LedgerRow, "audit_hash" | "audit_hash_prev"> {
  return {
    transition_id: "TX1",
    target_id: "demo",
    object_id: "M1",
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
    timestamp: "2026-05-07T00:00:00Z",
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
      baseRow({ transition_id: "TX2", idempotency_key: "k2" }),
    );
    expect(r2.row.audit_hash_prev).toBe(r1.row.audit_hash);
    expect(r2.row.audit_hash).not.toBe(r1.row.audit_hash);
  });

  it("rejects rows with duplicate idempotency_key (returns duplicate)", async () => {
    const store = new MemoryStore();
    const ledger = new FileLedger({ store });
    const r1 = await ledger.appendTransition(baseRow({}));
    expect(r1.result).toBe("applied");
    const r2 = await ledger.appendTransition(
      baseRow({ transition_id: "TX2" }),
    );
    expect(r2.result).toBe("duplicate");
    const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
    expect(body.split("\n").filter(Boolean).length).toBe(1);
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
    const r3 = await ledger2.appendTransition(
      baseRow({ transition_id: "TX2", idempotency_key: "k2" }),
    );
    expect(r3.row.audit_hash_prev).toBe(r1.row.audit_hash);
  });

  it("serializes concurrent appends so audit_hash chain stays linear", async () => {
    const store = new MemoryStore();
    const ledger = new FileLedger({ store });
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(
        ledger.appendTransition(
          baseRow({
            transition_id: `TX${i}`,
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
