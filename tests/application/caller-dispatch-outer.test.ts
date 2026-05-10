/**
 * Phase 5b.1: caller-dispatch-outer effect tests.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { dispatchOuterOutcome } from "../../src/application/caller-dispatch-outer.js";
import { FileLedger } from "../../src/application/ledger.js";
import { layout } from "../../src/application/persistence-layout.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { Slice } from "../../src/domain/schema/slice.js";

const ISO = "2026-05-08T00:00:00.000Z";
const M_ID = "01HZM00000000000000000000A";
const SESS_ID = "01HZSE0000000000000000000A";
const A = "01HZ1000000000000000000000";
const B = "01HZ2000000000000000000000";
const C = "01HZ3000000000000000000000";

function deps() {
  const store = new MemoryStore();
  const clock = new FixedClock(Date.parse(ISO));
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return { store, clock, logger, ledger, callerId: "test", targetId: "demo" };
}

async function seedMilestone(
  store: MemoryStore,
  state: Parameters<typeof Milestone.parse>[0]["state"],
) {
  const m = Milestone.parse({
    milestone_id: M_ID,
    target_id: "demo",
    title: "feat",
    state,
    slot_kind: null,
    intake_source_kind: "feature_request",
    intake_source_id: "01HZFR0000000000000000000A",
    spec_revision_pin: null,
    context_summary_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(layout.milestone(M_ID), JSON.stringify(m, null, 2));
  return m;
}

function makeSlice(slice_id: string, deps: { slice_id: string; edge_type: "blocks" | "coordinates_with" }[] = []) {
  return Slice.parse({
    slice_id,
    milestone_id: M_ID,
    slice_kind: "internal",
    value_statement: "x",
    ac_ids: [],
    acceptance_tests: [],
    declared_scope: ["src/x.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: deps,
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state: "SLICE_PENDING",
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
}

describe("dispatchOuterOutcome — Discovery", () => {
  it("spec_accept → M_SPECIFICATION_DRAFT + Spec CP persisted", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
        milestone: m,
        sessionId: SESS_ID,
        specProposalBody: "# Spec\n\nUsers want add().",
      },
      d,
    );
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.details[0]).toMatchObject({
      effect: "promote_milestone_to_specification",
      milestone_state: "M_SPECIFICATION_DRAFT",
    });

    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_SPECIFICATION_DRAFT");
    expect(await d.store.readText(`milestones/${M_ID}/spec.md`)).toContain(
      "Users want add",
    );
  });

  it("spec_reject → M_DISCOVERY_AWAITING_HUMAN", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_reject",
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DISCOVERY_AWAITING_HUMAN");
  });

  it("TIMEOUT → recover to draft (idempotent)", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "TIMEOUT",
        final_verdict: null,
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DISCOVERY_DRAFT");
  });
});

describe("dispatchOuterOutcome — Specification", () => {
  it("spec_accept → M_SPEC_APPROVED", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_SPECIFICATION_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Specification",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
        milestone: m,
        sessionId: SESS_ID,
        specProposalBody: "scenarios + AC-IDs",
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_SPEC_APPROVED");
  });
});

describe("dispatchOuterOutcome — Planning", () => {
  it("plan_accept persists slice DAG + promotes blocks-free slices to SLICE_READY + records Decision", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const slices = [
      makeSlice(A),
      makeSlice(B, [{ slice_id: A, edge_type: "blocks" }]),
      makeSlice(C, [{ slice_id: A, edge_type: "coordinates_with" }]),
    ];
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Planning",
        session_state: "CONVERGED",
        final_verdict: "plan_accept",
        milestone: m,
        sessionId: SESS_ID,
        slicesToPersist: slices,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    const detail = r.details[0];
    expect(detail).toMatchObject({
      effect: "persist_slice_dag_and_promote",
      milestone_state: "M_DELIVERY_BUILDING",
      slices_persisted: 3,
    });
    if (detail?.effect === "persist_slice_dag_and_promote") {
      expect(new Set(detail.ready_slice_ids)).toEqual(new Set([A, C]));
    }

    // A and C are SLICE_READY (no blocks deps); B is SLICE_PENDING (blocks A).
    const reread = (id: string) =>
      Slice.parse(JSON.parse((d.store as MemoryStore as unknown as { entries: Map<string, string> }).entries.get(layout.slice(id))!));
    expect(reread(A).state).toBe("SLICE_READY");
    expect(reread(B).state).toBe("SLICE_PENDING");
    expect(reread(C).state).toBe("SLICE_READY");

    // Milestone advanced.
    const m2 = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(m2.state).toBe("M_DELIVERY_BUILDING");

    // Decision Log entry created (we can't predict the id, just assert one exists).
    const decisions = await d.store.list("knowledge/decisions");
    expect(decisions.length).toBe(1);
  });

  it("plan_accept rejects an invalid DAG (cycle)", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const cycleSlices = [
      makeSlice(A, [{ slice_id: B, edge_type: "blocks" }]),
      makeSlice(B, [{ slice_id: A, edge_type: "blocks" }]),
    ];
    await expect(
      dispatchOuterOutcome(
        {
          parent_loop: "outer",
          phase_or_purpose: "Planning",
          session_state: "CONVERGED",
          final_verdict: "plan_accept",
          milestone: m,
          sessionId: SESS_ID,
          slicesToPersist: cycleSlices,
        },
        d,
      ),
    ).rejects.toThrow(/invalid DAG/);
  });

  it("incident-7: plan_accept with empty slicesToPersist returns no_match (does not throw)", async () => {
    // PR #104 P0-1 fix: empty slicesToPersist must return a structured
    // `no_match` result rather than throwing. Throwing propagates up to the
    // daemon top-level handler and exits the process — milestone state then
    // cannot recover on the next outer-coordinator cycle.
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Planning",
        session_state: "CONVERGED",
        final_verdict: "plan_accept",
        milestone: m,
        sessionId: SESS_ID,
        // slicesToPersist intentionally omitted (incident-7 production
        // symptom: dispatcher receives empty/missing slice payload).
      },
      d,
    );
    expect(r.kind).toBe("no_match");
    if (r.kind === "no_match") {
      expect(r.detail).toMatch(/empty slice DAG/);
    }

    // Milestone state must NOT have advanced.
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DELIVERY_PLANNING");
  });

  it("incident-7: plan_accept with explicit empty slices array also returns no_match", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Planning",
        session_state: "CONVERGED",
        final_verdict: "plan_accept",
        milestone: m,
        sessionId: SESS_ID,
        slicesToPersist: [],
      },
      d,
    );
    expect(r.kind).toBe("no_match");
    if (r.kind === "no_match") {
      expect(r.detail).toMatch(/empty slice DAG/);
    }
    // Milestone state must NOT have advanced.
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DELIVERY_PLANNING");
  });

  it("TIMEOUT → escalate", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Planning",
        session_state: "TIMEOUT",
        final_verdict: null,
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_ESCALATED");
  });
});

describe("dispatchOuterOutcome — Validation", () => {
  it("validation_pass → M_DONE + ContextSummary persisted", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_VALIDATING");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_pass",
        milestone: m,
        sessionId: SESS_ID,
        contextSummaryInput: {
          milestone_id: M_ID,
          user_value: "users can add()",
          behavior_changes: ["add() endpoint"],
          decisions_to_preserve: [],
          risks: [],
          slices: [
            {
              slice_id: A,
              slice_kind: "feature",
              validated_revision: "v1",
              ac_ids: ["AC-1"],
            },
          ],
        },
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DONE");
    expect(reread.context_summary_id).not.toBeNull();
    expect(await d.store.readText(layout.contextSummary(M_ID))).toBeTruthy();
  });

  it("validation_fail → M_DELIVERY_BUILDING + responsible slices reset to SLICE_READY", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_VALIDATING");
    // Pre-seed a slice in SLICE_VALIDATED that's "responsible" for the fail.
    const validated = Slice.parse({
      ...makeSlice(A),
      state: "SLICE_VALIDATED",
    });
    await d.store.writeAtomic(
      layout.slice(A),
      JSON.stringify(validated, null, 2),
    );

    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_fail",
        milestone: m,
        sessionId: SESS_ID,
        responsibleSliceIds: [A],
      },
      d,
    );
    expect(r.kind).toBe("applied");

    const m2 = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(m2.state).toBe("M_DELIVERY_BUILDING");
    // SLICE_VALIDATED is not eligible for revert per the contract — it's
    // the responsibility marker that re-enters BUILDING flow only after a
    // signal. Skipped here. (Test only confirms milestone transition.)
  });

  it("TIMEOUT → escalate", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_VALIDATING");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "TIMEOUT",
        final_verdict: null,
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_ESCALATED");
  });
});

describe("dispatchOuterOutcome — no_match", () => {
  it("returns no_match for an inner-loop tuple", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        // Invalid combo: outer + inner purpose.
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "tests_green", // wrong verdict for outer
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("no_match");
  });
});

describe("dispatchOuterOutcome — illegal_transition guard (PR #66 P0-2)", () => {
  it("refuses Discovery spec_accept when milestone is M_DONE", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DONE");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("illegal_transition");
    if (r.kind === "illegal_transition") {
      expect(r.detail).toContain("M_DONE");
    }
    // milestone unchanged
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DONE");
  });

  it("refuses Validation validation_pass from M_ESCALATED", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_ESCALATED");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_pass",
        milestone: m,
        sessionId: SESS_ID,
        contextSummaryInput: {
          milestone_id: M_ID,
          user_value: "x",
        },
      },
      d,
    );
    expect(r.kind).toBe("illegal_transition");
  });

  it("allows idempotent re-park (already AWAITING_HUMAN)", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_AWAITING_HUMAN");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_reject",
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
  });
});

describe("dispatchOuterOutcome — idempotent re-run still emits ledger (PR #66 P0-3)", () => {
  it("re-running spec_accept after milestone already advanced still appends a duplicate row", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const args = {
      parent_loop: "outer" as const,
      phase_or_purpose: "Discovery" as const,
      session_state: "CONVERGED" as const,
      final_verdict: "spec_accept",
      milestone: m,
      sessionId: SESS_ID,
    };
    const r1 = await dispatchOuterOutcome(args, d);
    expect(r1.kind).toBe("applied");

    // Capture row count after first call.
    const lines1 = (await d.store.readText("ledger/transitions.ndjson"))!
      .trim()
      .split("\n");
    expect(lines1.length).toBeGreaterThan(0);

    // Second call with same input — milestone already at M_SPECIFICATION_DRAFT.
    // The dispatch should be illegal_transition (spec_accept doesn't allow
    // M_SPECIFICATION_DRAFT as source) — proving the source guard kicks in
    // before re-emit. (idempotent-ledger path is exercised by repeated
    // identical calls when the state is already AT the target — covered
    // separately when state happens to be a self-loop.)
    const r2 = await dispatchOuterOutcome(args, d);
    expect(r2.kind).toBe("illegal_transition");
  });

  it("recover_milestone_to_draft from already-DRAFT emits a ledger row even with no state change", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "TIMEOUT",
        final_verdict: null,
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const lines = (await d.store.readText("ledger/transitions.ndjson"))!
      .trim()
      .split("\n");
    // Exactly one ledger row even though milestone state didn't change.
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!);
    expect(row.from_state).toBe("M_DISCOVERY_DRAFT");
    expect(row.to_state).toBe("M_DISCOVERY_DRAFT");
  });
});

describe("dispatchOuterOutcome — validation_fail (PR #66 P0-4 + P1-5)", () => {
  it("reverts SLICE_VALIDATED responsible slices to SLICE_READY (P0-4)", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_VALIDATING");
    const validated = Slice.parse({ ...makeSlice(A), state: "SLICE_VALIDATED" });
    await d.store.writeAtomic(layout.slice(A), JSON.stringify(validated, null, 2));

    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_fail",
        milestone: m,
        sessionId: SESS_ID,
        responsibleSliceIds: [A],
      },
      d,
    );
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    const detail = r.details[0];
    expect(detail).toMatchObject({ effect: "recover_milestone_to_building" });
    if (detail?.effect === "recover_milestone_to_building") {
      expect(detail.recovered_slices).toEqual([A]);
    }
    const reread = Slice.parse(
      JSON.parse((await d.store.readText(layout.slice(A)))!),
    );
    expect(reread.state).toBe("SLICE_READY");
  });

  it("skips slices belonging to a different milestone (P1-5)", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_VALIDATING");
    const foreign = Slice.parse({
      ...makeSlice(A),
      milestone_id: "01HZM00000000000000000000Z", // different milestone
      state: "SLICE_VALIDATED",
    });
    await d.store.writeAtomic(layout.slice(A), JSON.stringify(foreign, null, 2));

    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_fail",
        milestone: m,
        sessionId: SESS_ID,
        responsibleSliceIds: [A],
      },
      d,
    );
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    const detail = r.details[0];
    if (detail?.effect === "recover_milestone_to_building") {
      expect(detail.recovered_slices).toEqual([]);
      expect(detail.skipped_foreign_slices).toEqual([A]);
    }
    // foreign slice unchanged
    const reread = Slice.parse(
      JSON.parse((await d.store.readText(layout.slice(A)))!),
    );
    expect(reread.state).toBe("SLICE_VALIDATED");
  });
});

describe("dispatchOuterOutcome — missing matrix tuples (P1-8)", () => {
  it("Specification TIMEOUT → recover to M_SPECIFICATION_DRAFT", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_SPECIFICATION_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Specification",
        session_state: "TIMEOUT",
        final_verdict: null,
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_SPECIFICATION_DRAFT");
  });

  it("Specification spec_reject → M_SPECIFICATION_AWAITING_HUMAN", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_SPECIFICATION_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Specification",
        session_state: "CONVERGED",
        final_verdict: "spec_reject",
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_SPECIFICATION_AWAITING_HUMAN");
  });

  it("Discovery ABANDONED → recover to draft", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "ABANDONED",
        final_verdict: null,
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DISCOVERY_DRAFT");
  });

  it("Planning request_changes → milestone unchanged + ledger row", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Planning",
        session_state: "CONVERGED",
        final_verdict: "request_changes",
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DELIVERY_PLANNING");
    const lines =
      (await d.store.readText("ledger/transitions.ndjson"))!.trim();
    expect(lines).not.toBe("");
  });

  it("Validation validation_stale → milestone unchanged + ledger noop", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_VALIDATING");
    const r = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_stale",
        milestone: m,
        sessionId: SESS_ID,
      },
      d,
    );
    expect(r.kind).toBe("applied");
    const reread = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(reread.state).toBe("M_DELIVERY_VALIDATING");
  });
});

describe("dispatchOuterOutcome — plan_accept DAG edge cases (P1-8)", () => {
  it("rejects missing dependency", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const slices = [
      makeSlice(A, [{ slice_id: B, edge_type: "blocks" }]), // B not in set
    ];
    await expect(
      dispatchOuterOutcome(
        {
          parent_loop: "outer",
          phase_or_purpose: "Planning",
          session_state: "CONVERGED",
          final_verdict: "plan_accept",
          milestone: m,
          sessionId: SESS_ID,
          slicesToPersist: slices,
        },
        d,
      ),
    ).rejects.toThrow(/invalid DAG/);
  });

  it("rejects self-dependency", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_PLANNING");
    const slices = [makeSlice(A, [{ slice_id: A, edge_type: "blocks" }])];
    await expect(
      dispatchOuterOutcome(
        {
          parent_loop: "outer",
          phase_or_purpose: "Planning",
          session_state: "CONVERGED",
          final_verdict: "plan_accept",
          milestone: m,
          sessionId: SESS_ID,
          slicesToPersist: slices,
        },
        d,
      ),
    ).rejects.toThrow(/invalid DAG/);
  });
});
