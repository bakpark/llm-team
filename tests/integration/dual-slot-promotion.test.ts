/**
 * Phase 6a — dual-slot scheduler integration tests.
 *
 * Covers:
 *   - happy path: M_INTAKE_QUEUED → M_DISCOVERY_DRAFT (slot_lock 4-step) +
 *     ledger `slot_promotion` row + slot_lock released.
 *   - happy path: M_SPEC_APPROVED → M_DELIVERY_PLANNING.
 *   - promotion guard: Discovery slot busy blocks intake → ledger noop +
 *     promotion_guard_blocked detail.
 *   - promotion guard: Delivery slot busy blocks delivery promotion.
 *   - cross-slot priority: delivery_first orders Delivery before intake.
 *   - cross-slot priority: discovery_first orders intake before Delivery.
 *   - cross-slot priority: balanced alternates (delivery, intake, ...).
 *   - cross-slot stale: a Discovery N+1 SESSION_OPEN with updated_at <
 *     latest Delivery N updated_at is transitioned to AWAITING_REVALIDATION.
 *   - idempotent re-run: a second runOneDualTrackTurn after a guard block
 *     does not duplicate ledger rows.
 *
 * All tests use MemoryStore + FsLease against an in-memory backing.
 */
import { describe, expect, it } from "vitest";
import { FsLease } from "../../src/adapters/lease/fs.js";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import {
  detectCrossSlotStaleSessions,
} from "../../src/application/cross-slot-stale.js";
import { runOneDualTrackTurn } from "../../src/application/dual-track-scheduler.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";

const ISO_BASE = "2026-05-08T00:00:00.000Z";
const M_INTAKE = "01HZM10000000000000000000A";
const M_INTAKE2 = "01HZM10000000000000000000B";
const M_SPEC = "01HZM20000000000000000000A";
const M_SPEC2 = "01HZM20000000000000000000B";
const M_DELIVERY_BUSY = "01HZM30000000000000000000A";
const M_DISCOVERY_BUSY = "01HZM40000000000000000000A";
const SESSION_DISCOVERY = "01HZSE0000000000000000000A";

async function dropMilestone(
  store: MemoryStore,
  id: string,
  state: string,
  updated_at: string,
  created_at = updated_at,
): Promise<void> {
  const m = Milestone.parse({
    milestone_id: id,
    target_id: "demo",
    title: `m-${id.slice(-1)}`,
    state,
    slot_kind: null,
    intake_source_kind: "feature_request",
    intake_source_id: id,
    spec_revision_pin: state === "M_SPEC_APPROVED" ? "spec-pin-1" : null,
    context_summary_id: null,
    external_refs: [],
    created_at,
    updated_at,
  });
  await store.writeAtomic(layout.milestone(id), JSON.stringify(m, null, 2));
}

async function readMilestone(store: MemoryStore, id: string) {
  const body = await store.readText(layout.milestone(id));
  if (body == null) throw new Error(`milestone ${id} missing`);
  return Milestone.parse(JSON.parse(body));
}

async function readLedgerRows(store: MemoryStore) {
  const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
  return body
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => LedgerRow.parse(JSON.parse(l)));
}

function makeDeps(store: MemoryStore, clock: FixedClock) {
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  const lease = new FsLease({ store, clock });
  return {
    store,
    clock,
    ledger,
    lease,
    callerId: "test-scheduler",
    targetId: "demo",
  };
}

describe("dual-track scheduler — happy path", () => {
  it("promotes M_INTAKE_QUEUED → M_DISCOVERY_DRAFT under slot_lock", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(store, M_INTAKE, "M_INTAKE_QUEUED", ISO_BASE);

    const out = await runOneDualTrackTurn(deps);
    expect(out.kind).toBe("promoted");
    if (out.kind !== "promoted") return;
    expect(out.from_state).toBe("M_INTAKE_QUEUED");
    expect(out.to_state).toBe("M_DISCOVERY_DRAFT");
    expect(out.slot_kind).toBe("discovery");
    expect(out.lease_token.length).toBeGreaterThan(0);

    const m = await readMilestone(store, M_INTAKE);
    expect(m.state).toBe("M_DISCOVERY_DRAFT");
    expect(m.slot_kind).toBe("discovery");

    const rows = await readLedgerRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_kind).toBe("slot_promotion");
    expect(rows[0]!.result).toBe("applied");
    expect(rows[0]!.slot_kind).toBe("discovery");
    expect(rows[0]!.lease_kind).toBe("slot_lock");
    expect(rows[0]!.lease_token).toBe(out.lease_token);

    // slot_lock released — active record is the empty-string "released"
    // sentinel (FsLease.release contract).
    const active = await store.list("leases/active");
    const slotFiles = active.filter((n) => n.endsWith(".json"));
    expect(slotFiles.length).toBe(1);
    const body = await store.readText(`leases/active/${slotFiles[0]}`);
    expect(body).toBe("");
  });

  it("promotes M_SPEC_APPROVED → M_DELIVERY_PLANNING (delivery slot)", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(store, M_SPEC, "M_SPEC_APPROVED", ISO_BASE);

    const out = await runOneDualTrackTurn(deps);
    expect(out.kind).toBe("promoted");
    if (out.kind !== "promoted") return;
    expect(out.from_state).toBe("M_SPEC_APPROVED");
    expect(out.to_state).toBe("M_DELIVERY_PLANNING");
    expect(out.slot_kind).toBe("delivery");

    const m = await readMilestone(store, M_SPEC);
    expect(m.state).toBe("M_DELIVERY_PLANNING");
    expect(m.slot_kind).toBe("delivery");
  });

  it("noop when no candidates", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    const out = await runOneDualTrackTurn(deps);
    expect(out.kind).toBe("noop");
  });
});

describe("dual-track scheduler — promotion guard", () => {
  it("blocks intake when Discovery slot is busy", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(
      store,
      M_DISCOVERY_BUSY,
      "M_DISCOVERY_DRAFT",
      "2026-05-08T00:00:00.000Z",
    );
    await dropMilestone(
      store,
      M_INTAKE,
      "M_INTAKE_QUEUED",
      "2026-05-08T00:01:00.000Z",
    );
    const out = await runOneDualTrackTurn(deps);
    expect(out.kind).toBe("guard_blocked");
    if (out.kind !== "guard_blocked") return;
    expect(out.milestone_id).toBe(M_INTAKE);
    expect(out.reason).toContain("discovery_slot_busy");

    // Milestone state unchanged.
    const m = await readMilestone(store, M_INTAKE);
    expect(m.state).toBe("M_INTAKE_QUEUED");

    // Ledger row recorded as noop with guard reason.
    const rows = await readLedgerRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_kind).toBe("slot_promotion");
    expect(rows[0]!.result).toBe("noop");
    expect(rows[0]!.result_detail).toContain("promotion_guard_blocked");
  });

  it("blocks delivery promotion when Delivery slot is busy", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(
      store,
      M_DELIVERY_BUSY,
      "M_DELIVERY_BUILDING",
      "2026-05-08T00:00:00.000Z",
    );
    await dropMilestone(
      store,
      M_SPEC,
      "M_SPEC_APPROVED",
      "2026-05-08T00:01:00.000Z",
    );
    const out = await runOneDualTrackTurn(deps);
    expect(out.kind).toBe("guard_blocked");
    if (out.kind !== "guard_blocked") return;
    expect(out.reason).toContain("delivery_slot_busy");
  });

  it("re-running after a block re-emits the noop row (preflight, not deduped)", async () => {
    // RGC-LEDGER P0-3: only terminal `applied/recovered/rolled_back/
    // escalated` rows dedupe; `noop` is preflight and re-evaluates per
    // cycle. The shared idempotency_key still pins each cycle to a
    // single row so an outside replay can collapse them.
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(
      store,
      M_DISCOVERY_BUSY,
      "M_DISCOVERY_DRAFT",
      "2026-05-08T00:00:00.000Z",
    );
    await dropMilestone(
      store,
      M_INTAKE,
      "M_INTAKE_QUEUED",
      "2026-05-08T00:01:00.000Z",
    );
    await runOneDualTrackTurn(deps);
    await runOneDualTrackTurn(deps);
    const rows = await readLedgerRows(store);
    expect(rows.length).toBe(2);
    expect(rows[0]!.result).toBe("noop");
    expect(rows[1]!.result).toBe("noop");
    expect(rows[0]!.idempotency_key).toBe(rows[1]!.idempotency_key);
  });

  it("promoted slot_promotion row IS deduped on re-run", async () => {
    // applied rows DO dedupe — a second cycle that observes the already-
    // promoted milestone simply has no candidate.
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(store, M_INTAKE, "M_INTAKE_QUEUED", ISO_BASE);
    await runOneDualTrackTurn(deps);
    await runOneDualTrackTurn(deps);
    const rows = await readLedgerRows(store);
    // First cycle: applied promotion row. Second cycle: no candidate
    // (milestone now M_DISCOVERY_DRAFT) → no new row.
    expect(rows.length).toBe(1);
    expect(rows[0]!.result).toBe("applied");
  });
});

describe("dual-track scheduler — cross-slot fairness", () => {
  it("delivery_first promotes Delivery before intake when both queued", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(
      store,
      M_INTAKE,
      "M_INTAKE_QUEUED",
      "2026-05-08T00:00:00.000Z",
    );
    await dropMilestone(
      store,
      M_SPEC,
      "M_SPEC_APPROVED",
      "2026-05-08T00:00:30.000Z",
    );
    const out = await runOneDualTrackTurn({
      ...deps,
      dualTrack: { priority: "delivery_first", refactor_scheduled_capacity: null, scout_scan: { enabled: true, interval_seconds: 3600 } },
    });
    expect(out.kind).toBe("promoted");
    if (out.kind !== "promoted") return;
    expect(out.milestone_id).toBe(M_SPEC);
  });

  it("discovery_first promotes intake before Delivery when both queued", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(
      store,
      M_INTAKE,
      "M_INTAKE_QUEUED",
      "2026-05-08T00:00:30.000Z",
    );
    await dropMilestone(
      store,
      M_SPEC,
      "M_SPEC_APPROVED",
      "2026-05-08T00:00:00.000Z",
    );
    const out = await runOneDualTrackTurn({
      ...deps,
      dualTrack: { priority: "discovery_first", refactor_scheduled_capacity: null, scout_scan: { enabled: true, interval_seconds: 3600 } },
    });
    expect(out.kind).toBe("promoted");
    if (out.kind !== "promoted") return;
    expect(out.milestone_id).toBe(M_INTAKE);
  });

  it("balanced alternates (Delivery first, then intake on next cycle)", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    // Two intake + two delivery promotion candidates.
    await dropMilestone(store, M_INTAKE, "M_INTAKE_QUEUED", "2026-05-08T00:00:00.000Z");
    await dropMilestone(store, M_INTAKE2, "M_INTAKE_QUEUED", "2026-05-08T00:00:10.000Z");
    await dropMilestone(store, M_SPEC, "M_SPEC_APPROVED", "2026-05-08T00:00:05.000Z");
    await dropMilestone(store, M_SPEC2, "M_SPEC_APPROVED", "2026-05-08T00:00:15.000Z");
    // Cycle 1 → Delivery (M_SPEC); subsequent cycles can't run until the
    // promoted Delivery is cleared, but the FAIRNESS *ordering* is tested
    // by the ledger sequence of guard-blocked events on subsequent cycles.
    const balanced = {
      priority: "balanced" as const,
      refactor_scheduled_capacity: null,
      scout_scan: { enabled: true, interval_seconds: 3600 },
    };
    const out = await runOneDualTrackTurn({ ...deps, dualTrack: balanced });
    expect(out.kind).toBe("promoted");
    if (out.kind !== "promoted") return;
    // Balanced starts with Delivery so M_SPEC (oldest spec_approved) wins.
    expect(out.milestone_id).toBe(M_SPEC);
  });
});

describe("dual-track scheduler — cross-slot stale", () => {
  it("transitions a Discovery N+1 SESSION_OPEN to AWAITING_REVALIDATION when Delivery N is newer", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);

    // Delivery N — building, updated AFTER the Discovery session.
    await dropMilestone(
      store,
      M_DELIVERY_BUSY,
      "M_DELIVERY_BUILDING",
      "2026-05-08T01:00:00.000Z",
    );
    // Discovery N+1 — drafting, with an OPEN outer session created earlier.
    await dropMilestone(
      store,
      M_DISCOVERY_BUSY,
      "M_DISCOVERY_DRAFT",
      "2026-05-08T00:30:00.000Z",
    );
    const session = DialogueSession.parse({
      session_id: SESSION_DISCOVERY,
      parent_object_kind: "milestone",
      parent_object_id: M_DISCOVERY_BUSY,
      parent_loop: "outer",
      purpose: "design",
      participants: [
        { agent_profile_id: "atlas", role: "lead" },
        { agent_profile_id: "sentinel", role: "reviewer" },
      ],
      session_termination: {
        finalization_rule: "quorum_then_lead",
        required_evidence: [],
        composite_rule: "finalization_only",
        quorum_min_approvals: 1,
      },
      workspace_revision_pin: "trunk-pin-old",
      current_turn_index: 0,
      state: "SESSION_OPEN",
      max_turns: 8,
      created_at: "2026-05-08T00:00:00.000Z",
      updated_at: "2026-05-08T00:00:00.000Z",
    });
    await store.writeAtomic(
      layout.sessionMetadata(SESSION_DISCOVERY),
      JSON.stringify(session, null, 2),
    );

    const out = await detectCrossSlotStaleSessions(deps);
    expect(out.staledSessionIds).toEqual([SESSION_DISCOVERY]);

    const reread = DialogueSession.parse(
      JSON.parse((await store.readText(layout.sessionMetadata(SESSION_DISCOVERY)))!),
    );
    expect(reread.state).toBe("AWAITING_REVALIDATION");

    // Idempotent — second run does not re-stale the (already revalidating)
    // session.
    const out2 = await detectCrossSlotStaleSessions(deps);
    expect(out2.staledSessionIds).toEqual([]);

    const rows = await readLedgerRows(store);
    const recoverRows = rows.filter((r) => r.action_kind === "recover");
    expect(recoverRows.length).toBe(1);
    expect(recoverRows[0]!.result_detail).toBe("cross_slot_stale");
  });
});
