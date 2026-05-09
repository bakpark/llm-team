/**
 * Phase 5c — scout observer Validation evidence aggregation.
 *
 * Pre-conditions: a milestone with two SLICE_VALIDATED slices, each with a
 * SM_MERGED SliceMerge → VerificationRun. aggregateValidationEvidence
 * synthesises a single aggregate VerificationRun and the
 * ContextSummarySliceRef[] feeding the PASS-path snapshot.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsStore } from "../../src/adapters/store/fs.js";
import { aggregateValidationEvidence } from "../../src/application/scout-observer.js";
import { layout } from "../../src/application/persistence-layout.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { VerificationRun } from "../../src/domain/schema/verification.js";
import { SystemClock } from "../../src/ports/clock.js";

const ISO = "2026-05-09T00:00:00.000Z";
const MILESTONE_ID = "01HZM00000000000000000000A";
const SLICE_A = "01HZS0000000000000000000A1";
const SLICE_B = "01HZS0000000000000000000B2";
const SLICE_FOREIGN = "01HZS0000000000000000000C3";
const VR_A = "01HZV0000000000000000000A1";
const VR_B = "01HZV0000000000000000000B2";
const SM_A = "01HZSM00000000000000000A11";
const SM_B = "01HZSM00000000000000000B22";

function setup() {
  const workdir = mkdtempSync(join(tmpdir(), "scout-evidence-"));
  const store = new FsStore({ workdir });
  const clock = new SystemClock();
  return { workdir, store, clock };
}

async function seedMilestone(store: FsStore) {
  const m = Milestone.parse({
    milestone_id: MILESTONE_ID,
    target_id: "demo",
    title: "feat",
    state: "M_DELIVERY_VALIDATING",
    slot_kind: "delivery",
    intake_source_kind: "feature_request",
    intake_source_id: "01HZFR0000000000000000000A",
    spec_revision_pin: "spec-1",
    context_summary_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(layout.milestone(MILESTONE_ID), JSON.stringify(m));
}

async function seedSlice(
  store: FsStore,
  sliceId: string,
  state: "SLICE_VALIDATED" | "SLICE_BUILDING",
  milestoneId: string = MILESTONE_ID,
  acIds: readonly string[] = ["AC-1"],
) {
  const s = Slice.parse({
    slice_id: sliceId,
    milestone_id: milestoneId,
    slice_kind: "feature",
    value_statement: `slice ${sliceId.slice(-2)}`,
    ac_ids: [...acIds],
    acceptance_tests: acIds.map((id) => ({
      path: `tests/${id}.test.ts`,
      name: id,
      ac_id: id,
    })),
    declared_scope: ["src/x.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state,
    current_session_id: null,
    spawning_proposal_id: null,
    abandoned_reason: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(layout.slice(sliceId), JSON.stringify(s));
}

async function seedVerification(
  store: FsStore,
  vrId: string,
  result: "pass" | "fail",
  failedTests: { path: string; name: string; message: string | null }[] = [],
  coversAcIds: readonly string[] = ["AC-1"],
) {
  const vr = VerificationRun.parse({
    verification_run_id: vrId,
    target_id: "demo",
    target_revision: `rev-${vrId.slice(-2)}`,
    commands_or_checks: ["npm test"],
    environment_fingerprint: "node-20",
    started_at: ISO,
    finished_at: ISO,
    result,
    failed_tests: failedTests,
    log_ref: null,
    // Phase 8c (KAC-TRACEABILITY): the seeded slice declares ac_ids:["AC-1"],
    // so the VR must record AC-1 coverage to keep the aggregate PASS. The
    // FAIL path tests keep the same coverage — Validation FAIL flows from
    // `result=fail`, not from missing AC coverage.
    covers_ac_ids: coversAcIds,
  });
  await store.writeAtomic(layout.verification(vrId), JSON.stringify(vr));
}

async function seedSliceMerge(
  store: FsStore,
  smId: string,
  sliceId: string,
  vrId: string | null,
) {
  const sm = SliceMerge.parse({
    slice_merge_id: smId,
    slice_id: sliceId,
    target_id: "demo",
    pre_merge_workspace_revision: "pre",
    merge_revision: `merge-${smId.slice(-2)}`,
    inner_session_id: null,
    review_session_id: null,
    verification_run_id: vrId,
    state: "SM_MERGED",
    merged_at: ISO,
    merged_by_caller_id: "caller-1",
    lease_token: null,
    audit_chain_predecessor_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(layout.sliceMerge(smId), JSON.stringify(sm));
}

describe("aggregateValidationEvidence — happy path PASS", () => {
  it("aggregates all SLICE_VALIDATED slices' verification runs into a PASS aggregate", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_VALIDATED");
    await seedSlice(env.store, SLICE_B, "SLICE_VALIDATED");
    await seedVerification(env.store, VR_A, "pass");
    await seedVerification(env.store, VR_B, "pass");
    await seedSliceMerge(env.store, SM_A, SLICE_A, VR_A);
    await seedSliceMerge(env.store, SM_B, SLICE_B, VR_B);

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.derivedVerdict).toBe("PASS");
    expect(out.perSlice).toHaveLength(2);
    expect(out.slicesCovered).toHaveLength(2);
    expect(out.slicesMissing).toHaveLength(0);
    expect(out.aggregate.result).toBe("pass");

    // Persisted under verifications/
    const persisted = await env.store.readText(
      layout.verification(out.aggregate.verification_run_id),
    );
    expect(persisted).not.toBeNull();
    const parsed = VerificationRun.parse(JSON.parse(persisted!));
    expect(parsed.result).toBe("pass");

    // ContextSummarySliceRef carries slice_kind + validated_revision
    const sortedCovered = [...out.slicesCovered].sort((a, b) =>
      a.slice_id.localeCompare(b.slice_id),
    );
    expect(sortedCovered[0]?.slice_kind).toBe("feature");
    expect(sortedCovered[0]?.validated_revision).toMatch(/^merge-/);
  });
});

describe("aggregateValidationEvidence — FAIL when any slice failed", () => {
  it("returns FAIL + collects failed_tests across slices", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_VALIDATED");
    await seedSlice(env.store, SLICE_B, "SLICE_VALIDATED");
    await seedVerification(env.store, VR_A, "pass");
    await seedVerification(env.store, VR_B, "fail", [
      { path: "tests/y.test.ts", name: "y", message: "boom" },
    ]);
    await seedSliceMerge(env.store, SM_A, SLICE_A, VR_A);
    await seedSliceMerge(env.store, SM_B, SLICE_B, VR_B);

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.derivedVerdict).toBe("FAIL");
    expect(out.aggregate.result).toBe("fail");
    expect(out.aggregate.failed_tests).toHaveLength(1);
    expect(out.aggregate.failed_tests[0]?.path).toBe("tests/y.test.ts");
  });
});

describe("aggregateValidationEvidence — STALE on missing evidence", () => {
  it("returns STALE when a SLICE_VALIDATED slice has no SM_MERGED SliceMerge", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_VALIDATED");
    await seedSlice(env.store, SLICE_B, "SLICE_VALIDATED");
    await seedVerification(env.store, VR_A, "pass");
    await seedSliceMerge(env.store, SM_A, SLICE_A, VR_A);
    // No SliceMerge for SLICE_B.

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.derivedVerdict).toBe("STALE");
    expect(out.slicesMissing).toContain(SLICE_B);
  });

  it("returns STALE when the milestone has zero SLICE_VALIDATED slices", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_BUILDING");

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.derivedVerdict).toBe("STALE");
  });
});

describe("aggregateValidationEvidence — STALE does not persist (PR #72 P1-3)", () => {
  it("returns synthetic aggregate without writing a VR file when STALE", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_BUILDING"); // not validated → STALE

    const before = await env.store.list("verifications");
    const out1 = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out1.derivedVerdict).toBe("STALE");
    const after1 = await env.store.list("verifications");
    expect(after1.length).toBe(before.length);
    // Synthetic aggregate body is NOT persisted on STALE.
    const persisted = await env.store.readText(
      layout.verification(out1.aggregate.verification_run_id),
    );
    expect(persisted).toBeNull();

    // Repeated calls must not accumulate VR files either.
    await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    const after3 = await env.store.list("verifications");
    expect(after3.length).toBe(before.length);
  });
});

describe("aggregateValidationEvidence — milestone scoping", () => {
  it("ignores slices belonging to other milestones", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_VALIDATED");
    await seedSlice(
      env.store,
      SLICE_FOREIGN,
      "SLICE_VALIDATED",
      "01HZM00000000000000000000B",
    );
    await seedVerification(env.store, VR_A, "pass");
    await seedSliceMerge(env.store, SM_A, SLICE_A, VR_A);

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.slicesCovered.map((s) => s.slice_id)).toEqual([SLICE_A]);
    expect(out.derivedVerdict).toBe("PASS");
  });
});

// -------------------------- Phase 8c — KAC-TRACEABILITY -------------------

describe("aggregateValidationEvidence — AC-level traceability rows", () => {
  it("emits one row per declared ac_id with PASS status when VR covers it", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_VALIDATED", MILESTONE_ID, [
      "AC-1",
      "AC-2",
    ]);
    await seedVerification(env.store, VR_A, "pass", [], ["AC-1", "AC-2"]);
    await seedSliceMerge(env.store, SM_A, SLICE_A, VR_A);

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.derivedVerdict).toBe("PASS");
    expect(out.acTraceability).toHaveLength(2);
    for (const row of out.acTraceability) {
      expect(row.status).toBe("PASS");
      expect(row.slice_id).toBe(SLICE_A);
      expect(row.slice_merge_id).toBe(SM_A);
      expect(row.latest_vr_id).toBe(VR_A);
    }
    expect(out.acTraceability.map((r) => r.ac_id).sort()).toEqual([
      "AC-1",
      "AC-2",
    ]);
  });

  it("partial AC coverage on a passing slice → row=FAIL → derivedVerdict=FAIL (plan §G2-2)", async () => {
    const env = setup();
    await seedMilestone(env.store);
    // Slice declares AC-1 and AC-2 but VR only covers AC-1.
    await seedSlice(env.store, SLICE_A, "SLICE_VALIDATED", MILESTONE_ID, [
      "AC-1",
      "AC-2",
    ]);
    await seedVerification(env.store, VR_A, "pass", [], ["AC-1"]);
    await seedSliceMerge(env.store, SM_A, SLICE_A, VR_A);

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.derivedVerdict).toBe("FAIL");
    expect(out.acTraceability).toHaveLength(2);
    const byAc = new Map(out.acTraceability.map((r) => [r.ac_id, r]));
    expect(byAc.get("AC-1")?.status).toBe("PASS");
    expect(byAc.get("AC-2")?.status).toBe("FAIL");
    // Aggregate VR result must reflect the FAIL so `evidence_only` gate
    // sees verification_green=false downstream.
    expect(out.aggregate.result).toBe("fail");
  });

  it("non-validated slice surfaces as MISSING rows (one per declared AC)", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_BUILDING", MILESTONE_ID, [
      "AC-1",
      "AC-2",
    ]);

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    // Slice not validated → derived STALE (slice-level absence) but the
    // AC traceability rows are still emitted as MISSING for operator
    // surface.
    expect(out.derivedVerdict).toBe("STALE");
    expect(out.acTraceability).toHaveLength(2);
    for (const row of out.acTraceability) {
      expect(row.status).toBe("MISSING");
      expect(row.slice_merge_id).toBeNull();
      expect(row.latest_vr_id).toBeNull();
    }
  });

  it("VR fail result → all AC rows for that slice = FAIL", async () => {
    const env = setup();
    await seedMilestone(env.store);
    await seedSlice(env.store, SLICE_A, "SLICE_VALIDATED", MILESTONE_ID, [
      "AC-1",
      "AC-2",
    ]);
    // Even though `covers_ac_ids` lists both, `result=fail` propagates
    // FAIL to every declared AC of the slice.
    await seedVerification(
      env.store,
      VR_A,
      "fail",
      [{ path: "tests/x.test.ts", name: "x", message: "boom" }],
      ["AC-1", "AC-2"],
    );
    await seedSliceMerge(env.store, SM_A, SLICE_A, VR_A);

    const out = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(out.derivedVerdict).toBe("FAIL");
    for (const row of out.acTraceability) {
      expect(row.status).toBe("FAIL");
    }
  });
});
