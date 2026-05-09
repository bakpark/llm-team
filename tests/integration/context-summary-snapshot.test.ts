/**
 * Phase 5c — KAC-CONTEXT-SUMMARY snapshot wiring.
 *
 * Validation PASS path: scout aggregateValidationEvidence supplies the
 * `slices` field for snapshotContextSummary, audit_hash chain remains
 * verifiable (body sha256 matches stored audit_hash).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { FsStore } from "../../src/adapters/store/fs.js";
import { canonicalJson } from "../../src/domain/audit-hash.js";
import { snapshotContextSummary } from "../../src/application/knowledge.js";
import { aggregateValidationEvidence } from "../../src/application/scout-observer.js";
import { layout } from "../../src/application/persistence-layout.js";
import { ContextSummary } from "../../src/domain/schema/knowledge.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { VerificationRun } from "../../src/domain/schema/verification.js";
import { SystemClock } from "../../src/ports/clock.js";

const ISO = "2026-05-09T00:00:00.000Z";
const MILESTONE_ID = "01HZM00000000000000000000A";
const SLICE_A = "01HZS0000000000000000000A1";
const VR_A = "01HZV0000000000000000000A1";
const SM_A = "01HZSM00000000000000000A11";

function setup() {
  const workdir = mkdtempSync(join(tmpdir(), "ctx-summary-"));
  return {
    workdir,
    store: new FsStore({ workdir }),
    clock: new SystemClock(),
  };
}

async function seedValidatedSlice(store: FsStore) {
  const s = Slice.parse({
    slice_id: SLICE_A,
    milestone_id: MILESTONE_ID,
    slice_kind: "feature",
    value_statement: "v",
    ac_ids: ["AC-1"],
    acceptance_tests: [{ path: "tests/x.test.ts", name: "x", ac_id: "AC-1" }],
    declared_scope: ["src/x.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "trunk",
    dod_revision_pin: "dod",
    state: "SLICE_VALIDATED",
    current_session_id: null,
    spawning_proposal_id: null,
    abandoned_reason: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(layout.slice(SLICE_A), JSON.stringify(s));
  await store.writeAtomic(
    layout.verification(VR_A),
    JSON.stringify(
      VerificationRun.parse({
        verification_run_id: VR_A,
        target_id: "demo",
        target_revision: "rev-A1",
        commands_or_checks: ["t"],
        environment_fingerprint: "env",
        started_at: ISO,
        finished_at: ISO,
        result: "pass",
        failed_tests: [],
        log_ref: null,
        // Phase 8c (KAC-TRACEABILITY): slice declares ac_ids:["AC-1"], so
        // the VR must record AC-1 coverage to keep AC-level aggregation PASS.
        covers_ac_ids: ["AC-1"],
      }),
    ),
  );
  await store.writeAtomic(
    layout.sliceMerge(SM_A),
    JSON.stringify(
      SliceMerge.parse({
        slice_merge_id: SM_A,
        slice_id: SLICE_A,
        target_id: "demo",
        pre_merge_workspace_revision: "pre",
        merge_revision: "merged-rev",
        inner_session_id: null,
        review_session_id: null,
        verification_run_id: VR_A,
        state: "SM_MERGED",
        merged_at: ISO,
        merged_by_caller_id: "caller-1",
        lease_token: null,
        audit_chain_predecessor_id: null,
        external_refs: [],
        created_at: ISO,
        updated_at: ISO,
      }),
    ),
  );
}

describe("context-summary-snapshot — Validation PASS wires evidence slices", () => {
  it("snapshot includes the ContextSummarySliceRef supplied by scout aggregation", async () => {
    const env = setup();
    await seedValidatedSlice(env.store);

    const evidence = await aggregateValidationEvidence(
      { milestoneId: MILESTONE_ID },
      { store: env.store, clock: env.clock, targetId: "demo" },
    );
    expect(evidence.derivedVerdict).toBe("PASS");

    const summary = await snapshotContextSummary(
      { store: env.store, clock: env.clock },
      {
        milestone_id: MILESTONE_ID,
        user_value: "feature delivered",
        behavior_changes: ["new endpoint"],
        decisions_to_preserve: [],
        risks: [],
        slices: [...evidence.slicesCovered],
        architectural_debt_indicators: [],
      },
    );
    expect(summary.slices).toHaveLength(1);
    expect(summary.slices[0]?.slice_id).toBe(SLICE_A);
    expect(summary.slices[0]?.validated_revision).toBe("merged-rev");

    // audit_hash chain — body sha256 must equal the stored audit_hash.
    const persisted = await env.store.readText(
      layout.contextSummary(MILESTONE_ID),
    );
    expect(persisted).not.toBeNull();
    const parsed = ContextSummary.parse(JSON.parse(persisted!));
    const { audit_hash, ...body } = parsed;
    const expected = createHash("sha256")
      .update(canonicalJson(body))
      .digest("hex");
    expect(audit_hash).toBe(expected);
  });
});

describe("context-summary-snapshot — empty slices still produces a valid snapshot", () => {
  it("snapshotContextSummary with no slices works (back-compat)", async () => {
    const env = setup();
    const summary = await snapshotContextSummary(
      { store: env.store, clock: env.clock },
      {
        milestone_id: MILESTONE_ID,
        user_value: "done",
      },
    );
    expect(summary.slices).toEqual([]);
  });
});
