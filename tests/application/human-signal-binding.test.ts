import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { bindHumanSignalToSession } from "../../src/application/human-signal-binding.js";
import { FileLedger } from "../../src/application/ledger.js";
import { openOuterSession } from "../../src/application/outer-session.js";
import { layout } from "../../src/application/persistence-layout.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { SessionTurn } from "../../src/domain/schema/session-turn.js";
import { HumanSignalEnvelope } from "../../src/domain/schema/human-signal.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";

const ISO = "2026-05-09T00:00:00.000Z";
const M_ID = "01HZM00000000000000000000A";

function deps() {
  const store = new MemoryStore();
  const clock = new FixedClock(Date.parse(ISO));
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return { store, clock, logger, ledger, callerId: "test", targetId: "demo" };
}

async function seedMilestoneAndSession(d: ReturnType<typeof deps>) {
  const m = Milestone.parse({
    milestone_id: M_ID,
    target_id: "demo",
    title: "feat",
    state: "M_DISCOVERY_AWAITING_HUMAN",
    slot_kind: null,
    intake_source_kind: "feature_request",
    intake_source_id: "01HZFR0000000000000000000A",
    spec_revision_pin: "rev-1",
    context_summary_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await d.store.writeAtomic(layout.milestone(M_ID), JSON.stringify(m, null, 2));
  const session = await openOuterSession(
    { milestone: m, phase: "Discovery", workspaceRevisionPin: "rev-1" },
    d,
  );
  return { milestone: m, session };
}

function envelope(
  partial: Partial<HumanSignalEnvelope> & {
    signal_id: string;
    signal_type: HumanSignalEnvelope["signal_type"];
    target_id: string;
  },
): HumanSignalEnvelope {
  return HumanSignalEnvelope.parse({
    target_kind: "milestone",
    actor: "alice",
    created_at: ISO,
    source: "fs_drop",
    rationale: "looks good",
    ...partial,
  });
}

describe("bindHumanSignalToSession — milestone target", () => {
  it("approve → human_approval verdict appended at current_turn_index", async () => {
    const d = deps();
    const { session } = await seedMilestoneAndSession(d);
    const r = await bindHumanSignalToSession(
      envelope({ signal_id: "sig-1", signal_type: "approve", target_id: M_ID }),
      d,
    );
    expect(r.kind).toBe("appended");
    if (r.kind !== "appended") return;
    expect(r.verdict).toBe("approve");
    expect(r.turn_index).toBe(0);

    // SessionTurn persisted at turns/0.json
    const turnBody = await d.store.readText(
      layout.sessionTurn(session.session_id, 0),
    );
    expect(turnBody).not.toBeNull();
    const turn = SessionTurn.parse(JSON.parse(turnBody!));
    expect(turn.agent_profile_id).toBe("human");
    expect(turn.output_envelope.contribution_kind).toBe("human_approval");
    expect(turn.output_envelope.verdict?.result).toBe("approve");

    // current_turn_index advanced
    const meta = DialogueSession.parse(
      JSON.parse((await d.store.readText(layout.sessionMetadata(session.session_id)))!),
    );
    expect(meta.current_turn_index).toBe(1);
  });

  it("reject signal → reject verdict", async () => {
    const d = deps();
    await seedMilestoneAndSession(d);
    const r = await bindHumanSignalToSession(
      envelope({ signal_id: "sig-2", signal_type: "reject", target_id: M_ID }),
      d,
    );
    expect(r.kind).toBe("appended");
    if (r.kind === "appended") expect(r.verdict).toBe("reject");
  });

  it("request_rework → reject verdict (mapped per RGC-SIGNALS)", async () => {
    const d = deps();
    await seedMilestoneAndSession(d);
    const r = await bindHumanSignalToSession(
      envelope({
        signal_id: "sig-3",
        signal_type: "request_rework",
        target_id: M_ID,
      }),
      d,
    );
    expect(r.kind).toBe("appended");
    if (r.kind === "appended") expect(r.verdict).toBe("reject");
  });

  it("returns no_session when milestone has no SESSION_OPEN outer session", async () => {
    const d = deps();
    // Milestone exists but no session opened.
    const m = Milestone.parse({
      milestone_id: M_ID,
      target_id: "demo",
      title: "feat",
      state: "M_DISCOVERY_DRAFT",
      slot_kind: null,
      intake_source_kind: "feature_request",
      intake_source_id: "01HZFR0000000000000000000A",
      spec_revision_pin: null,
      context_summary_id: null,
      external_refs: [],
      created_at: ISO,
      updated_at: ISO,
    });
    await d.store.writeAtomic(layout.milestone(M_ID), JSON.stringify(m, null, 2));

    const r = await bindHumanSignalToSession(
      envelope({ signal_id: "sig-1", signal_type: "approve", target_id: M_ID }),
      d,
    );
    expect(r.kind).toBe("no_session");
  });

  it("returns unsupported for non-bindable signal_type", async () => {
    const d = deps();
    await seedMilestoneAndSession(d);
    const r = await bindHumanSignalToSession(
      envelope({ signal_id: "sig-1", signal_type: "pause", target_id: "system" }),
      d,
    );
    // pause has no VERDICT_FOR mapping → unsupported.
    expect(r.kind).toBe("unsupported");
  });

  it("appends two consecutive turns with monotonic turn_index", async () => {
    const d = deps();
    await seedMilestoneAndSession(d);
    const r1 = await bindHumanSignalToSession(
      envelope({ signal_id: "s1", signal_type: "approve", target_id: M_ID }),
      d,
    );
    const r2 = await bindHumanSignalToSession(
      envelope({ signal_id: "s2", signal_type: "approve", target_id: M_ID }),
      d,
    );
    expect(r1.kind).toBe("appended");
    expect(r2.kind).toBe("appended");
    if (r1.kind === "appended" && r2.kind === "appended") {
      expect(r1.turn_index).toBe(0);
      expect(r2.turn_index).toBe(1);
    }
  });
});

describe("bindHumanSignalToSession — dialogue_session target", () => {
  it("binds directly via session id", async () => {
    const d = deps();
    const { session } = await seedMilestoneAndSession(d);
    const r = await bindHumanSignalToSession(
      envelope({
        signal_id: "sig-1",
        signal_type: "approve",
        target_kind: "dialogue_session",
        target_id: session.session_id,
      }),
      d,
    );
    expect(r.kind).toBe("appended");
    if (r.kind === "appended") expect(r.session_id).toBe(session.session_id);
  });
});
