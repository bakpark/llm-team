/**
 * Phase 9a (G2-4) — TCC-GOVERNANCE actor verification end-to-end.
 *
 * Scenario:
 *   - Outer session is open on a parked milestone (AWAITING_HUMAN).
 *   - Human drops an approve signal addressing the milestone.
 *   - Drain runs with binding deps + a `TeamMembershipPort` configured to
 *     a known `human_team`.
 *
 * Expected:
 *   - Member actor: human_approval contribution appended (legacy phase-5b
 *     behaviour preserved).
 *   - Non-member actor: no contribution; signal markProcessed=invalid;
 *     `signal_apply` ledger row with `result=invalid` and
 *     `result_detail=actor_not_in_human_team`.
 *   - Unreachable lookup with `block` policy: same as non-member but
 *     `result_detail=actor_team_lookup_unreachable`.
 *   - Unreachable lookup with `warn` policy: contribution IS appended,
 *     but a separate audit-only invalid ledger row records the gap.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import {
  FsMirrorTeamMembership,
  writeFsMirrorTeam,
  writeFsMirrorTeamUnreachable,
} from "../../src/adapters/team-membership/fs-mirror.js";
import { FsHumanSignal } from "../../src/adapters/human-signal/fs.js";
import {
  ACTOR_NOT_IN_HUMAN_TEAM,
  bindHumanSignalToSession,
} from "../../src/application/human-signal-binding.js";
import {
  dropSignal,
  runHumanSignalDrain,
} from "../../src/application/human-signal-drain.js";
import { FileLedger } from "../../src/application/ledger.js";
import { openOuterSession } from "../../src/application/outer-session.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { HumanSignalEnvelope } from "../../src/domain/schema/human-signal.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";
import { HumanSignalRecord } from "../../src/domain/schema/human-signal.js";

const ISO = "2026-05-09T00:00:00.000Z";
const M_ID = "01HZM00000000000000000000A";
const TEAM = "acme/reviewers";

function deps() {
  const store = new MemoryStore();
  const clock = new FixedClock(Date.parse(ISO));
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return { store, clock, logger, ledger, callerId: "test", targetId: "demo" };
}

async function seedMilestoneAndOpenSession(d: ReturnType<typeof deps>) {
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

function approveEnvelope(actor: string, signalId = "sig-1"): HumanSignalEnvelope {
  return HumanSignalEnvelope.parse({
    signal_id: signalId,
    signal_type: "approve",
    target_kind: "milestone",
    target_id: M_ID,
    related_object_id: "01HZSC00000000000000000001",
    actor,
    created_at: ISO,
    source: "fs_drop",
    rationale: "lgtm",
  });
}

async function readLedgerRows(
  store: MemoryStore,
): Promise<LedgerRow[]> {
  const body = (await store.readText(LEDGER_TRANSITIONS_PATH)) ?? "";
  return body
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => LedgerRow.parse(JSON.parse(l)));
}

describe("team-membership actor verification (Phase 9a, G2-4)", () => {
  it("member actor → human_approval contribution appended", async () => {
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    await writeFsMirrorTeam(d.store, TEAM, ["alice"]);
    const teamPort = new FsMirrorTeamMembership(d.store);

    const r = await bindHumanSignalToSession(approveEnvelope("alice"), {
      ...d,
      teamMembership: teamPort,
      humanTeam: TEAM,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("appended");
  });

  it("non-member actor → invalid; ledger row result=invalid actor_not_in_human_team", async () => {
    const d = deps();
    const { session } = await seedMilestoneAndOpenSession(d);
    await writeFsMirrorTeam(d.store, TEAM, ["alice"]);
    const teamPort = new FsMirrorTeamMembership(d.store);

    const r = await bindHumanSignalToSession(approveEnvelope("mallory"), {
      ...d,
      teamMembership: teamPort,
      humanTeam: TEAM,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.reason).toBe(ACTOR_NOT_IN_HUMAN_TEAM);
    }

    // No SessionTurn was written.
    const turn = await d.store.readText(layout.sessionTurn(session.session_id, 0));
    expect(turn).toBeNull();

    const rows = await readLedgerRows(d.store);
    const rejection = rows.find(
      (row) =>
        row.action_kind === "signal_apply" &&
        row.result === "invalid" &&
        row.result_detail === ACTOR_NOT_IN_HUMAN_TEAM,
    );
    expect(rejection).toBeDefined();
    expect(rejection?.object_id).toBe("sig-1");
  });

  it("unreachable + block policy → invalid actor_team_lookup_unreachable", async () => {
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    await writeFsMirrorTeam(d.store, TEAM, ["alice"]);
    await writeFsMirrorTeamUnreachable(d.store, TEAM);
    const teamPort = new FsMirrorTeamMembership(d.store);

    const r = await bindHumanSignalToSession(approveEnvelope("alice"), {
      ...d,
      teamMembership: teamPort,
      humanTeam: TEAM,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.reason).toBe("actor_team_lookup_unreachable");
    }
  });

  it("unreachable + warn policy → contribution appended + audit-only invalid row", async () => {
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    await writeFsMirrorTeamUnreachable(d.store, TEAM);
    const teamPort = new FsMirrorTeamMembership(d.store);

    const r = await bindHumanSignalToSession(approveEnvelope("alice"), {
      ...d,
      teamMembership: teamPort,
      humanTeam: TEAM,
      unreachablePolicy: "warn",
    });
    expect(r.kind).toBe("appended");

    const rows = await readLedgerRows(d.store);
    const auditRow = rows.find(
      (row) =>
        row.action_kind === "signal_apply" &&
        row.result === "invalid" &&
        row.result_detail === "actor_team_lookup_unreachable",
    );
    expect(auditRow).toBeDefined();
    // Plus the normal applied signal_apply row from the appended turn.
    const appliedRow = rows.find(
      (row) =>
        row.action_kind === "signal_apply" &&
        row.result === "applied" &&
        row.contribution_kind === "human_approval",
    );
    expect(appliedRow).toBeDefined();
  });

  it("humanTeam=null → check is bypassed (legacy phase-5b behaviour)", async () => {
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    const teamPort = new FsMirrorTeamMembership(d.store);

    const r = await bindHumanSignalToSession(approveEnvelope("anyone"), {
      ...d,
      teamMembership: teamPort,
      humanTeam: null,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("appended");
  });
});

describe("drain integration with team-membership rejection (Phase 9a)", () => {
  it("drain markProcessed=invalid + emits ledger row + signal not re-emitted", async () => {
    const d = deps();
    const { session } = await seedMilestoneAndOpenSession(d);
    await writeFsMirrorTeam(d.store, TEAM, ["alice"]);
    const teamPort = new FsMirrorTeamMembership(d.store);
    const sigStore = new FsHumanSignal(d.store);
    await dropSignal(d.store, approveEnvelope("mallory", "drain-sig"));

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
        teamMembership: teamPort,
        humanTeam: TEAM,
        unreachablePolicy: "block",
      },
    });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("invalid");
    if (out[0]?.kind === "invalid") {
      expect(out[0].reason).toBe(ACTOR_NOT_IN_HUMAN_TEAM);
    }

    // Signal removed from pending list (markProcessed=invalid wrote a record).
    const pending = await sigStore.listPending();
    expect(pending.length).toBe(0);

    // Processed record reflects the rejection reason.
    const processedBody = await d.store.readText(
      `human_signals/processed/drain-sig.json`,
    );
    expect(processedBody).not.toBeNull();
    const processed = HumanSignalRecord.parse(JSON.parse(processedBody!));
    expect(processed.processing_state).toBe("invalid");
    expect(processed.reason).toBe(ACTOR_NOT_IN_HUMAN_TEAM);

    // No SessionTurn appended.
    const turn = await d.store.readText(layout.sessionTurn(session.session_id, 0));
    expect(turn).toBeNull();
    // Session's current_turn_index untouched.
    const live = DialogueSession.parse(
      JSON.parse((await d.store.readText(layout.sessionMetadata(session.session_id)))!),
    );
    expect(live.current_turn_index).toBe(0);

    // Ledger contains the rejection row.
    const rows = await readLedgerRows(d.store);
    const rejection = rows.find(
      (row) =>
        row.action_kind === "signal_apply" &&
        row.result === "invalid" &&
        row.result_detail === ACTOR_NOT_IN_HUMAN_TEAM &&
        row.object_id === "drain-sig",
    );
    expect(rejection).toBeDefined();
  });
});
