/**
 * Phase 5b.2 — AWAITING_HUMAN flow integration test.
 *
 * Scenario:
 *   1. Caller dispatches Discovery spec_reject with [human] required →
 *      milestone parks at M_DISCOVERY_AWAITING_HUMAN.
 *   2. Outer session is opened on the parked milestone.
 *   3. Human drops an `approve` signal addressing the milestone.
 *   4. Drain (with binding deps) consumes the signal → human_approval
 *      SessionTurn appended at session.current_turn_index=0.
 *   5. Re-pickup observes the session with the new turn — coordinator can
 *      now re-evaluate finalization.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { dispatchOuterOutcome } from "../../src/application/caller-dispatch-outer.js";
import {
  dropSignal,
  runHumanSignalDrain,
} from "../../src/application/human-signal-drain.js";
import { FsHumanSignal } from "../../src/adapters/human-signal/fs.js";
import { FileLedger } from "../../src/application/ledger.js";
import { openOuterSession } from "../../src/application/outer-session.js";
import { layout } from "../../src/application/persistence-layout.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { HumanSignalEnvelope } from "../../src/domain/schema/human-signal.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { SessionTurn } from "../../src/domain/schema/session-turn.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";

const ISO = "2026-05-09T00:00:00.000Z";
const M_ID = "01HZM00000000000000000000A";
const SESS_DRIVER = "01HZSE00000000000000000099";

function deps() {
  const store = new MemoryStore();
  const clock = new FixedClock(Date.parse(ISO));
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return { store, clock, logger, ledger, callerId: "test", targetId: "demo" };
}

async function seedDraftMilestone(d: ReturnType<typeof deps>) {
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
  return m;
}

describe("AWAITING_HUMAN end-to-end (Phase 5b.2)", () => {
  it("Discovery spec_reject parks → human approve → SessionTurn appended", async () => {
    const d = deps();
    const m = await seedDraftMilestone(d);

    // Step 1: dispatch Discovery spec_reject (driver session id is opaque
    // here — in production the coordinator session that produced the
    // verdict supplies it).
    const dispatched = await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_reject",
        milestone: m,
        sessionId: SESS_DRIVER,
      },
      d,
    );
    expect(dispatched.kind).toBe("applied");

    const parked = Milestone.parse(
      JSON.parse((await d.store.readText(layout.milestone(M_ID)))!),
    );
    expect(parked.state).toBe("M_DISCOVERY_AWAITING_HUMAN");

    // Step 2: open outer session on the parked milestone.
    const session = await openOuterSession(
      { milestone: parked, phase: "Discovery", workspaceRevisionPin: "trunk-base" },
      d,
    );

    // Step 3: human drops an approve signal targeting the milestone.
    const sigStore = new FsHumanSignal(d.store);
    const env = HumanSignalEnvelope.parse({
      signal_id: "human-sig-1",
      signal_type: "approve",
      target_kind: "milestone",
      target_id: M_ID,
      // RGC-SIGNALS: approve requires related_object_id (e.g. Spec CP).
      related_object_id: "01HZSC00000000000000000001",
      actor: "alice",
      created_at: ISO,
      source: "fs_drop",
      rationale: "spec looks great",
    });
    await dropSignal(d.store, env);

    // Step 4: drain with binding.
    const drainOutcomes = await runHumanSignalDrain({
      store: d.store,
      signal: sigStore,
      clock: d.clock,
      binding: {
        store: d.store,
        clock: d.clock,
        ledger: d.ledger,
        callerId: "drain",
        targetId: "demo",
      },
    });
    expect(drainOutcomes.length).toBe(1);
    const drained = drainOutcomes[0]!;
    expect(drained.kind).toBe("applied");
    if (drained.kind !== "applied") return;
    expect(drained.binding?.kind).toBe("appended");
    if (drained.binding?.kind === "appended") {
      expect(drained.binding.session_id).toBe(session.session_id);
      expect(drained.binding.turn_index).toBe(0);
    }

    // Step 5: SessionTurn 0 contains the human_approval verdict; session's
    // current_turn_index advanced to 1.
    const turn = SessionTurn.parse(
      JSON.parse((await d.store.readText(layout.sessionTurn(session.session_id, 0)))!),
    );
    expect(turn.output_envelope.contribution_kind).toBe("human_approval");
    expect(turn.output_envelope.verdict?.result).toBe("approve");

    const updatedSession = DialogueSession.parse(
      JSON.parse((await d.store.readText(layout.sessionMetadata(session.session_id)))!),
    );
    expect(updatedSession.current_turn_index).toBe(1);
    expect(updatedSession.state).toBe("SESSION_OPEN");
  });

  it("milestone target without an open session → drain emits binding=no_session", async () => {
    const d = deps();
    const m = await seedDraftMilestone(d);
    // Park to AWAITING_HUMAN but don't open an outer session.
    await dispatchOuterOutcome(
      {
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_reject",
        milestone: m,
        sessionId: SESS_DRIVER,
      },
      d,
    );

    const sigStore = new FsHumanSignal(d.store);
    await dropSignal(
      d.store,
      HumanSignalEnvelope.parse({
        signal_id: "human-sig-1",
        signal_type: "approve",
        target_kind: "milestone",
        target_id: M_ID,
        related_object_id: "01HZSC00000000000000000001",
        actor: "alice",
        created_at: ISO,
        source: "fs_drop",
      }),
    );

    const out = await runHumanSignalDrain({
      store: d.store,
      signal: sigStore,
      clock: d.clock,
      binding: {
        store: d.store,
        clock: d.clock,
        ledger: d.ledger,
        callerId: "drain",
        targetId: "demo",
      },
    });
    expect(out[0]?.kind).toBe("applied");
    if (out[0]?.kind === "applied") {
      expect(out[0].binding?.kind).toBe("no_session");
    }
  });
});
