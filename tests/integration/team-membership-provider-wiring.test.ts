/**
 * Phase 9d — `governance.human_team_provider` factory routing.
 *
 * PR #79 P0 #1 (codex review) flagged the GitHubTeamMembership adapter as
 * dead code: the daemon hardcoded `FsMirrorTeamMembership` regardless of
 * target config. This test pins the follow-up: `buildTeamMembership` MUST
 * route to the right adapter based on `cfg.governance.human_team_provider`,
 * and the github branch MUST consult the injected `GhExec` (no real
 * network calls — the stub records argv and returns canned JSON).
 *
 * Coverage:
 *   1. provider="fs-mirror" (default) → FsMirrorTeamMembership.
 *   2. provider="github" → GitHubTeamMembership; isMember consults GhExec
 *      and returns `member` / `non_member` per the gh-api contract.
 *   3. provider="github" + bindHumanSignalToSession routes through the
 *      same exec (proves the production wiring path is alive).
 *   4. governance block absent → defaults to fs-mirror (backward compat).
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { buildTeamMembership } from "../../src/adapters/team-membership/factory.js";
import { FsMirrorTeamMembership, writeFsMirrorTeam } from "../../src/adapters/team-membership/fs-mirror.js";
import { GitHubTeamMembership } from "../../src/adapters/team-membership/github.js";
import {
  bindHumanSignalToSession,
} from "../../src/application/human-signal-binding.js";
import { FileLedger } from "../../src/application/ledger.js";
import { openOuterSession } from "../../src/application/outer-session.js";
import { layout } from "../../src/application/persistence-layout.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { HumanSignalEnvelope } from "../../src/domain/schema/human-signal.js";
import { Governance } from "../../src/config/target-schema.js";
import type { GhExec } from "../../src/adapters/issue-tracker/github.js";
import { FixedClock } from "../../src/ports/clock.js";
import { CollectingLogger } from "../../src/ports/logger.js";

const ISO = "2026-05-09T00:00:00.000Z";
const M_ID = "01HZM00000000000000000000A";
const TEAM = "acme/reviewers";

class StubGhExec implements GhExec {
  readonly calls: string[][] = [];
  constructor(private readonly handler: (args: string[]) => Promise<{ stdout: string }>) {}
  run(args: string[]): Promise<{ stdout: string }> {
    this.calls.push([...args]);
    return this.handler(args);
  }
}

function deps() {
  const store = new MemoryStore();
  const clock = new FixedClock(Date.parse(ISO));
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return { store, clock, logger, ledger, callerId: "test", targetId: "demo" };
}

function parseGovernance(provider: "fs-mirror" | "github"): Governance {
  return Governance.parse({
    human_team: TEAM,
    control_issue_number: 100,
    contract_change_issue_number: 101,
    human_team_provider: provider,
  });
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

describe("Phase 9d — buildTeamMembership routes by governance.human_team_provider", () => {
  it("provider='fs-mirror' returns FsMirrorTeamMembership instance", () => {
    const d = deps();
    const port = buildTeamMembership(parseGovernance("fs-mirror"), {
      store: d.store,
      clock: d.clock,
    });
    expect(port).toBeInstanceOf(FsMirrorTeamMembership);
  });

  it("provider='github' returns GitHubTeamMembership instance", () => {
    const d = deps();
    const exec = new StubGhExec(async () => ({ stdout: "{}" }));
    const port = buildTeamMembership(parseGovernance("github"), {
      store: d.store,
      clock: d.clock,
      ghExec: exec,
    });
    expect(port).toBeInstanceOf(GitHubTeamMembership);
  });

  it("governance undefined defaults to fs-mirror (backward compat)", () => {
    const d = deps();
    const port = buildTeamMembership(undefined, { store: d.store, clock: d.clock });
    expect(port).toBeInstanceOf(FsMirrorTeamMembership);
  });

  it("github provider: isMember invokes the gh-api endpoint with org/team/user", async () => {
    const d = deps();
    const exec = new StubGhExec(async () => ({
      stdout: JSON.stringify({ state: "active" }),
    }));
    const port = buildTeamMembership(parseGovernance("github"), {
      store: d.store,
      clock: d.clock,
      ghExec: exec,
    });
    const r = await port.isMember(TEAM, "alice");
    expect(r.kind).toBe("member");
    expect(exec.calls.length).toBe(1);
    expect(exec.calls[0]).toEqual([
      "api",
      "/orgs/acme/teams/reviewers/memberships/alice",
    ]);
  });

  it("github provider: 404 from gh-api → non_member (binding rejects with actor_not_in_human_team)", async () => {
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    const exec = new StubGhExec(async () => {
      throw new Error("gh exited 1: HTTP 404: Not Found");
    });
    const port = buildTeamMembership(parseGovernance("github"), {
      store: d.store,
      clock: d.clock,
      ghExec: exec,
    });
    const r = await bindHumanSignalToSession(approveEnvelope("mallory"), {
      ...d,
      teamMembership: port,
      humanTeam: TEAM,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("invalid");
    expect(exec.calls.length).toBe(1);
  });

  it("github provider: transport error → unreachable_retry (phase-9a P0 #2 backoff)", async () => {
    // PR #82 review (P1, both models): exercise the unreachable arm of
    // `GitHubTeamMembership.isMember()` together with the binding's
    // `unreachable + block → unreachable_retry` contract from phase-9a.
    // A non-404 gh failure (transport / auth) MUST keep the signal
    // pending so the outer-coordinator backoff can retry instead of
    // permanently consuming the approval.
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    const exec = new StubGhExec(async () => {
      throw new Error("gh exited 1: socket hang up");
    });
    const port = buildTeamMembership(parseGovernance("github"), {
      store: d.store,
      clock: d.clock,
      ghExec: exec,
    });
    const direct = await port.isMember(TEAM, "alice");
    expect(direct.kind).toBe("unreachable");
    const r = await bindHumanSignalToSession(approveEnvelope("alice"), {
      ...d,
      teamMembership: port,
      humanTeam: TEAM,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("unreachable_retry");
    expect(exec.calls.length).toBe(2);
  });

  it("github provider: active state → binding appends contribution (production-wiring smoke)", async () => {
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    const exec = new StubGhExec(async () => ({
      stdout: JSON.stringify({ state: "active" }),
    }));
    const port = buildTeamMembership(parseGovernance("github"), {
      store: d.store,
      clock: d.clock,
      ghExec: exec,
    });
    const r = await bindHumanSignalToSession(approveEnvelope("alice"), {
      ...d,
      teamMembership: port,
      humanTeam: TEAM,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("appended");
  });

  it("legacy fs-mirror path still works via factory (regression guard)", async () => {
    const d = deps();
    await seedMilestoneAndOpenSession(d);
    await writeFsMirrorTeam(d.store, TEAM, ["alice"]);
    const port = buildTeamMembership(parseGovernance("fs-mirror"), {
      store: d.store,
      clock: d.clock,
    });
    const r = await bindHumanSignalToSession(approveEnvelope("alice"), {
      ...d,
      teamMembership: port,
      humanTeam: TEAM,
      unreachablePolicy: "block",
    });
    expect(r.kind).toBe("appended");
  });
});
