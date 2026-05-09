/**
 * Phase 8b — KAC-SLICE-TELEMETRY emit + Discovery N+1 manifest inject +
 * RGC-CROSS-SLOT-STALE pin drift integration tests.
 *
 * Covers (G2-3 verification):
 *   1. emitSliceTelemetry(milestoneId) builds in_progress / validated /
 *      blocked partitions from live Slices and persists a pointer keyed by
 *      milestone_id. Audit hash is the body-only sha256 of the canonical
 *      record minus audit_hash.
 *   2. emitSliceTelemetry is idempotent — a second call with no slice
 *      partition change reuses the prior record (no second file written,
 *      no second ledger row).
 *   3. integrateSliceMerge → SLICE_VALIDATED emits new telemetry whose
 *      audit_hash differs from the pre-merge telemetry — proving the
 *      slice-merge.ts wiring.
 *   4. detectCrossSlotStaleSessions transitions a Discovery session whose
 *      latest manifest's slice_telemetry pin no longer matches the live
 *      Delivery telemetry → AWAITING_REVALIDATION (pin drift trigger).
 *   5. detectCrossSlotStaleSessions is a no-op when the pin matches the
 *      live telemetry, even if the Delivery milestone's `updated_at`
 *      moved forward (the conservative phase-6a trigger is suppressed
 *      once a real pin is available — pin equality is the authoritative
 *      "no drift" signal).
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { detectCrossSlotStaleSessions } from "../../src/application/cross-slot-stale.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import {
  emitSliceTelemetry,
  loadLatestSliceTelemetry,
} from "../../src/application/slice-telemetry.js";
import { promoteSliceMergeToApproved } from "../../src/application/slice-merge.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import {
  ContextManifest,
  type ContextManifest as ContextManifestT,
} from "../../src/domain/schema/manifest.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";

const ISO_BASE = "2026-05-08T00:00:00.000Z";
const TARGET_ID = "demo";
const M_DELIVERY = "01HZM30000000000000000000A";
const M_DISCOVERY = "01HZM40000000000000000000A";
const SLICE_A = "01HZS00000000000000000000A";
const SLICE_B = "01HZS00000000000000000000B";
const SLICE_C = "01HZS00000000000000000000C";
const SM_ID = "01HZSM0000000000000000000A";
const SESSION_REVIEW = "01HZSE0000000000000000000Z";
const SESSION_DISCOVERY = "01HZSE0000000000000000000A";
const MANIFEST_INJECT = "01HZMN0000000000000000000A";
const VERIF_ID = "01HZVR0000000000000000000A";

function makeDeps(store: MemoryStore, clock: FixedClock) {
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return {
    store,
    clock,
    ledger,
    callerId: "test-telemetry",
    targetId: TARGET_ID,
  };
}

async function dropMilestone(
  store: MemoryStore,
  id: string,
  state: string,
  updated_at: string,
): Promise<void> {
  const m = Milestone.parse({
    milestone_id: id,
    target_id: TARGET_ID,
    title: `m-${id.slice(-1)}`,
    state,
    slot_kind: null,
    intake_source_kind: "feature_request",
    intake_source_id: id,
    spec_revision_pin: null,
    context_summary_id: null,
    external_refs: [],
    created_at: ISO_BASE,
    updated_at,
  });
  await store.writeAtomic(layout.milestone(id), JSON.stringify(m, null, 2));
}

async function dropSlice(
  store: MemoryStore,
  id: string,
  milestoneId: string,
  state:
    | "SLICE_PENDING"
    | "SLICE_READY"
    | "SLICE_BUILDING"
    | "SLICE_REVIEWING"
    | "SLICE_INTEGRATING"
    | "SLICE_VALIDATED"
    | "SLICE_BLOCKED",
  abandoned_reason: string | null = null,
): Promise<void> {
  const s = Slice.parse({
    slice_id: id,
    milestone_id: milestoneId,
    slice_kind: "feature",
    value_statement: `slice ${id.slice(-1)}`,
    ac_ids: [],
    acceptance_tests: [],
    declared_scope: [],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "trunk-pin",
    dod_revision_pin: `dod-${id.slice(-1)}`,
    state,
    current_session_id: null,
    spawning_proposal_id: null,
    abandoned_reason,
    external_refs: [],
    created_at: ISO_BASE,
    updated_at: ISO_BASE,
  });
  await store.writeAtomic(layout.slice(id), JSON.stringify(s, null, 2));
}

async function readLedgerRows(store: MemoryStore) {
  const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
  return body
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => LedgerRow.parse(JSON.parse(l)));
}

describe("emitSliceTelemetry — partition + persistence", () => {
  it("partitions slices by state and writes a pointer keyed by milestone_id", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);

    await dropMilestone(store, M_DELIVERY, "M_DELIVERY_BUILDING", ISO_BASE);
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_BUILDING");
    await dropSlice(store, SLICE_B, M_DELIVERY, "SLICE_VALIDATED");
    await dropSlice(store, SLICE_C, M_DELIVERY, "SLICE_BLOCKED", "rebase exhausted");

    const out = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);
    expect(out.persisted).toBe(true);
    expect(out.telemetry.in_progress_slices.map((s) => s.slice_id)).toEqual([
      SLICE_A,
    ]);
    expect(out.telemetry.validated_slices.map((s) => s.slice_id)).toEqual([
      SLICE_B,
    ]);
    expect(out.telemetry.blocked_slices.map((s) => s.slice_id)).toEqual([
      SLICE_C,
    ]);
    expect(out.telemetry.audit_hash).toMatch(/^[0-9a-f]{64}$/);

    // Pointer file resolves to the same telemetry.
    const reread = await loadLatestSliceTelemetry(store, M_DELIVERY);
    expect(reread?.telemetry_id).toBe(out.telemetry.telemetry_id);
    expect(reread?.audit_hash).toBe(out.telemetry.audit_hash);

    // One ledger row recorded the emit.
    const rows = await readLedgerRows(store);
    const emitRows = rows.filter(
      (r) =>
        r.action_kind === "external_observation" &&
        r.idempotency_key.includes("kind=slice_telemetry_emit"),
    );
    expect(emitRows.length).toBe(1);
  });

  it("idempotent re-emit with same partition does not write a second file or ledger row", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(store, M_DELIVERY, "M_DELIVERY_BUILDING", ISO_BASE);
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_BUILDING");

    const first = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);
    expect(first.persisted).toBe(true);

    clock.advance(1000);
    const second = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);
    expect(second.persisted).toBe(false);
    // Same telemetry returned (audit_hash equal).
    expect(second.telemetry.audit_hash).toBe(first.telemetry.audit_hash);
    expect(second.telemetry.telemetry_id).toBe(first.telemetry.telemetry_id);

    // Only one telemetry file under the directory.
    const files = await store.list("knowledge/slice_telemetry");
    const telemFiles = files.filter((n) => n.endsWith(".json"));
    expect(telemFiles.length).toBe(1);

    // Only one emit ledger row.
    const rows = await readLedgerRows(store);
    const emitRows = rows.filter(
      (r) =>
        r.action_kind === "external_observation" &&
        r.idempotency_key.includes("kind=slice_telemetry_emit"),
    );
    expect(emitRows.length).toBe(1);
  });

  it("partition shape change triggers a fresh persisted telemetry with a new audit_hash", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);
    await dropMilestone(store, M_DELIVERY, "M_DELIVERY_BUILDING", ISO_BASE);
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_BUILDING");

    const first = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);

    // Slice A flips to SLICE_VALIDATED.
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_VALIDATED");
    clock.advance(2000);
    const second = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);
    expect(second.persisted).toBe(true);
    expect(second.telemetry.audit_hash).not.toBe(first.telemetry.audit_hash);
    expect(second.telemetry.in_progress_slices).toEqual([]);
    expect(second.telemetry.validated_slices.map((s) => s.slice_id)).toEqual([
      SLICE_A,
    ]);
  });
});

describe("slice-merge.ts wiring — emit on transition", () => {
  it("promoteSliceMergeToApproved emits a fresh SliceTelemetry for the slice's milestone", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);

    await dropMilestone(store, M_DELIVERY, "M_DELIVERY_BUILDING", ISO_BASE);
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_REVIEWING");
    const sm = SliceMerge.parse({
      slice_merge_id: SM_ID,
      slice_id: SLICE_A,
      target_id: TARGET_ID,
      state: "SM_READY_FOR_REVIEW",
      inner_session_id: SESSION_REVIEW,
      review_session_id: null,
      verification_run_id: VERIF_ID,
      pre_merge_workspace_revision: "pre-merge-revision",
      merge_revision: null,
      merged_at: null,
      merged_by_caller_id: null,
      lease_token: null,
      created_at: ISO_BASE,
      updated_at: ISO_BASE,
    });
    await store.writeAtomic(
      layout.sliceMerge(SM_ID),
      JSON.stringify(sm, null, 2),
    );

    expect(await loadLatestSliceTelemetry(store, M_DELIVERY)).toBeNull();
    await promoteSliceMergeToApproved(
      { sliceMerge: sm, reviewSessionId: SESSION_REVIEW, sliceKind: "feature" },
      deps,
    );
    const telem = await loadLatestSliceTelemetry(store, M_DELIVERY);
    expect(telem).not.toBeNull();
    expect(telem!.in_progress_slices.map((s) => s.slice_id)).toContain(SLICE_A);
  });
});

describe("RGC-CROSS-SLOT-STALE — pin drift detection", () => {
  /**
   * Build a Discovery session whose latest SessionTurn references a manifest
   * carrying a slice_telemetry entry with `revision_pin = pinAuditHash`.
   * The session's `current_turn_index = 1` so loadInjectedTelemetryPin
   * resolves turn index 0.
   */
  async function seedDiscoveryWithPin(
    store: MemoryStore,
    milestoneIdToPin: string,
    pinAuditHash: string,
  ): Promise<void> {
    const session = DialogueSession.parse({
      session_id: SESSION_DISCOVERY,
      parent_object_kind: "milestone",
      parent_object_id: M_DISCOVERY,
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
      workspace_revision_pin: "trunk-pin",
      current_turn_index: 1,
      state: "SESSION_OPEN",
      max_turns: 8,
      created_at: ISO_BASE,
      updated_at: ISO_BASE,
    });
    await store.writeAtomic(
      layout.sessionMetadata(SESSION_DISCOVERY),
      JSON.stringify(session, null, 2),
    );

    const manifest: ContextManifestT = ContextManifest.parse({
      manifest_id: MANIFEST_INJECT,
      session_id: SESSION_DISCOVERY,
      turn_index: 0,
      purpose: "design",
      target: { object_kind: "milestone", object_id: M_DISCOVERY },
      entries: [
        {
          object_kind: "milestone",
          object_id: M_DISCOVERY,
          fetch_scope: "body",
          revision_pin: ISO_BASE,
          required: true,
          purpose: "primary input",
        },
        {
          object_kind: "slice_telemetry",
          object_id: "01HZTM0000000000000000000A",
          fetch_scope: "body",
          revision_pin: pinAuditHash,
          required: false,
          purpose: `Delivery N=${milestoneIdToPin} live slice telemetry (read-only)`,
        },
      ],
      created_at: ISO_BASE,
    });
    await store.writeAtomic(
      layout.manifest(MANIFEST_INJECT),
      JSON.stringify(manifest, null, 2),
    );

    // Minimal SessionTurn referencing the manifest.
    const turnBody = {
      session_id: SESSION_DISCOVERY,
      turn_index: 0,
      input_manifest_id: MANIFEST_INJECT,
    };
    await store.writeAtomic(
      layout.sessionTurn(SESSION_DISCOVERY, 0),
      JSON.stringify(turnBody, null, 2),
    );
  }

  it("transitions Discovery session to AWAITING_REVALIDATION when telemetry audit_hash drifts", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);

    await dropMilestone(store, M_DELIVERY, "M_DELIVERY_BUILDING", ISO_BASE);
    await dropMilestone(store, M_DISCOVERY, "M_DISCOVERY_DRAFT", ISO_BASE);
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_BUILDING");

    // Initial telemetry — Discovery session pins to this audit_hash.
    const t0 = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);
    await seedDiscoveryWithPin(store, M_DELIVERY, t0.telemetry.audit_hash);

    // Delivery progresses — slice flips to SLICE_VALIDATED, new emit
    // produces a different audit_hash.
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_VALIDATED");
    clock.advance(60_000);
    await dropMilestone(
      store,
      M_DELIVERY,
      "M_DELIVERY_BUILDING",
      "2026-05-08T00:01:00.000Z",
    );
    const t1 = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);
    expect(t1.telemetry.audit_hash).not.toBe(t0.telemetry.audit_hash);

    const out = await detectCrossSlotStaleSessions(deps);
    expect(out.staledSessionIds).toEqual([SESSION_DISCOVERY]);

    const reread = DialogueSession.parse(
      JSON.parse((await store.readText(layout.sessionMetadata(SESSION_DISCOVERY)))!),
    );
    expect(reread.state).toBe("AWAITING_REVALIDATION");

    const rows = await readLedgerRows(store);
    const recover = rows.find((r) => r.action_kind === "recover");
    expect(recover?.result_detail).toBe("cross_slot_stale");
    // Drift kind recorded in idempotency key.
    expect(recover?.idempotency_key).toContain("drift_kind=telemetry_pin_drift");
  });

  it("no-op when injected pin matches the live Delivery telemetry, even if Delivery updated_at moved", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const deps = makeDeps(store, clock);

    // Discovery session created BEFORE the latest Delivery update — under
    // the phase-6a conservative trigger this would flag stale. With a
    // matching telemetry pin, the new authoritative signal suppresses it.
    await dropMilestone(
      store,
      M_DELIVERY,
      "M_DELIVERY_BUILDING",
      "2026-05-08T01:00:00.000Z",
    );
    await dropMilestone(
      store,
      M_DISCOVERY,
      "M_DISCOVERY_DRAFT",
      "2026-05-08T00:30:00.000Z",
    );
    await dropSlice(store, SLICE_A, M_DELIVERY, "SLICE_BUILDING");

    const t0 = await emitSliceTelemetry({ milestone_id: M_DELIVERY }, deps);
    await seedDiscoveryWithPin(store, M_DELIVERY, t0.telemetry.audit_hash);

    const out = await detectCrossSlotStaleSessions(deps);
    expect(out.staledSessionIds).toEqual([]);
  });
});
