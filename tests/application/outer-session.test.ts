import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import {
  defaultParticipants,
  defaultTermination,
  openOuterSession,
  outerPhaseForState,
  pickReadyOuterSession,
} from "../../src/application/outer-session.js";
import { FileLedger } from "../../src/application/ledger.js";
import { layout } from "../../src/application/persistence-layout.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";

const ISO = "2026-05-09T00:00:00.000Z";
const M_ID = "01HZM00000000000000000000A";
const M2_ID = "01HZM00000000000000000000B";

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
  updated_at = ISO,
  id = M_ID,
) {
  const m = Milestone.parse({
    milestone_id: id,
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
    updated_at,
  });
  await store.writeAtomic(layout.milestone(id), JSON.stringify(m, null, 2));
  return m;
}

describe("outerPhaseForState", () => {
  it("maps each outer-pickable milestone state to a phase", () => {
    expect(outerPhaseForState("M_DISCOVERY_DRAFT")).toBe("Discovery");
    expect(outerPhaseForState("M_DISCOVERY_AWAITING_HUMAN")).toBe("Discovery");
    expect(outerPhaseForState("M_SPECIFICATION_DRAFT")).toBe("Specification");
    expect(outerPhaseForState("M_SPECIFICATION_AWAITING_HUMAN")).toBe(
      "Specification",
    );
    expect(outerPhaseForState("M_DELIVERY_PLANNING")).toBe("Planning");
    expect(outerPhaseForState("M_DELIVERY_VALIDATING")).toBe("Validation");
  });

  it("returns null for non-outer-pickable states", () => {
    expect(outerPhaseForState("M_INTAKE_QUEUED")).toBeNull();
    expect(outerPhaseForState("M_SPEC_APPROVED")).toBeNull();
    expect(outerPhaseForState("M_DELIVERY_BUILDING")).toBeNull();
    expect(outerPhaseForState("M_DONE")).toBeNull();
    expect(outerPhaseForState("M_ESCALATED")).toBeNull();
  });
});

describe("default presets", () => {
  it("Discovery participants include human required", () => {
    const p = defaultParticipants("Discovery");
    expect(p.some((x) => x.agent_profile_id === "human")).toBe(true);
    expect(p.some((x) => x.agent_profile_id === "atlas" && x.role === "lead")).toBe(true);
  });

  it("Specification participants include human + forge + sentinel", () => {
    const p = defaultParticipants("Specification");
    expect(p.some((x) => x.agent_profile_id === "human")).toBe(true);
    expect(p.some((x) => x.agent_profile_id === "forge")).toBe(true);
    expect(p.some((x) => x.agent_profile_id === "sentinel")).toBe(true);
  });

  it("Planning participants exclude human (no human gate)", () => {
    const p = defaultParticipants("Planning");
    expect(p.some((x) => x.agent_profile_id === "human")).toBe(false);
  });

  it("Validation lead is sentinel + scout observer", () => {
    const p = defaultParticipants("Validation");
    expect(p.some((x) => x.agent_profile_id === "sentinel" && x.role === "lead")).toBe(true);
    expect(p.some((x) => x.agent_profile_id === "scout" && x.role === "observer")).toBe(true);
  });

  it("Discovery termination = quorum_then_lead + finalization_only + quorum=1", () => {
    const t = defaultTermination("Discovery");
    expect(t.finalization_rule).toBe("quorum_then_lead");
    expect(t.composite_rule).toBe("finalization_only");
    expect(t.quorum_min_approvals).toBe(1);
  });

  it("Planning termination = unanimous_approve", () => {
    const t = defaultTermination("Planning");
    expect(t.finalization_rule).toBe("unanimous_approve");
  });

  it("Validation termination = lead_only + verification_green + evidence_only", () => {
    const t = defaultTermination("Validation");
    expect(t.finalization_rule).toBe("lead_only");
    expect(t.composite_rule).toBe("evidence_only");
    expect(t.required_evidence[0]?.kind).toBe("verification_green");
  });
});

describe("openOuterSession", () => {
  it("creates a Discovery session anchored to the milestone", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const session = await openOuterSession(
      { milestone: m, phase: "Discovery", workspaceRevisionPin: "trunk-base" },
      d,
    );
    expect(session.parent_object_kind).toBe("milestone");
    expect(session.parent_object_id).toBe(M_ID);
    expect(session.parent_loop).toBe("outer");
    expect(session.purpose).toBe("design");
    expect(session.state).toBe("SESSION_OPEN");

    const reread = DialogueSession.parse(
      JSON.parse((await d.store.readText(layout.sessionMetadata(session.session_id)))!),
    );
    expect(reread).toEqual(session);

    // Ledger row written
    const lines =
      (await d.store.readText("ledger/transitions.ndjson"))!.trim().split("\n");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!);
    expect(row.loop_kind).toBe("outer");
    expect(row.phase).toBe("Discovery");
  });

  it("Validation session uses sentinel as lead in ledger row", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DELIVERY_VALIDATING");
    await openOuterSession(
      { milestone: m, phase: "Validation", workspaceRevisionPin: "rev-1" },
      d,
    );
    const lines =
      (await d.store.readText("ledger/transitions.ndjson"))!.trim().split("\n");
    const row = JSON.parse(lines[0]!);
    expect(row.agent_profile_id).toBe("sentinel");
  });
});

describe("pickReadyOuterSession", () => {
  it("returns null when no outer-pickable milestones exist", async () => {
    const d = deps();
    await seedMilestone(d.store, "M_INTAKE_QUEUED");
    const r = await pickReadyOuterSession(d);
    expect(r).toBeNull();
  });

  it("picks a M_DISCOVERY_DRAFT milestone", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_DRAFT");
    const r = await pickReadyOuterSession(d);
    expect(r).not.toBeNull();
    expect(r?.milestone.milestone_id).toBe(m.milestone_id);
    expect(r?.phase).toBe("Discovery");
    expect(r?.existingSession).toBeNull();
  });

  it("attaches existing SESSION_OPEN to pickup", async () => {
    const d = deps();
    const m = await seedMilestone(d.store, "M_DISCOVERY_AWAITING_HUMAN");
    const sess = await openOuterSession(
      { milestone: m, phase: "Discovery", workspaceRevisionPin: "rev-x" },
      d,
    );
    const r = await pickReadyOuterSession(d);
    expect(r?.existingSession?.session_id).toBe(sess.session_id);
  });

  it("returns oldest-by-updated_at first (fairness)", async () => {
    const d = deps();
    await seedMilestone(d.store, "M_DISCOVERY_DRAFT", "2026-05-09T02:00:00.000Z", M_ID);
    await seedMilestone(d.store, "M_DELIVERY_PLANNING", "2026-05-09T01:00:00.000Z", M2_ID);
    const r = await pickReadyOuterSession(d);
    expect(r?.milestone.milestone_id).toBe(M2_ID);
    expect(r?.phase).toBe("Planning");
  });

  it("ignores non-outer-pickable milestone states", async () => {
    const d = deps();
    await seedMilestone(d.store, "M_DONE", ISO, M_ID);
    await seedMilestone(d.store, "M_DELIVERY_BUILDING", ISO, M2_ID);
    const r = await pickReadyOuterSession(d);
    expect(r).toBeNull();
  });
});
