/**
 * Phase 5b.3 — runOneOuterTurn integration tests.
 *
 * Drives the outer-loop turn orchestrator through each phase's headline
 * paths:
 *   1. Discovery quorum_then_lead converges on spec_accept (lead +
 *      reviewer) → milestone promotes to M_SPECIFICATION_DRAFT.
 *   2. Discovery reviewer request_changes re-engages the lead.
 *   3. Specification spec_reject parks at M_SPECIFICATION_AWAITING_HUMAN
 *      (the matrix's `park_milestone_awaiting_human` effect).
 *   4. Planning unanimous_approve persists slice DAG and promotes the
 *      milestone to M_DELIVERY_BUILDING.
 *   5. Validation lead_only + evidence_only converges on validation_pass
 *      and finalizes M_DONE with a ContextSummary.
 *
 * The fake adapter rewrites session_id / turn_index / manifest_id from
 * the runtime prompt frontmatter so the agent-io header-echo check
 * succeeds.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FileLedger } from "../../src/application/ledger.js";
import { runOneOuterTurn } from "../../src/application/outer-turn.js";
import { layout } from "../../src/application/persistence-layout.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { CollectingLogger } from "../../src/ports/logger.js";
import { SystemClock } from "../../src/ports/clock.js";

const ISO = "2026-05-09T00:00:00.000Z";
const MILESTONE_ID = "01HZM00000000000000000000A";
const SLICE_A = "01HZS0000000000000000000A1";
const SLICE_B = "01HZS0000000000000000000B2";

interface Stub {
  readonly id: "fake";
  envelopesByProfile: Record<string, Record<string, unknown>[]>;
  cursor: Record<string, number>;
}

function makeStub(envelopes: Record<string, Record<string, unknown>[]>): {
  adapter: {
    id: "fake";
    run: (input: { stdin: string; agentCwd: string; timeoutSec: number }) => Promise<{
      rawCode: number;
      signal: null;
      timedOut: false;
      stdout: string;
      stderr: string;
    }>;
  };
  cursor: Record<string, number>;
} {
  const stub: Stub = {
    id: "fake",
    envelopesByProfile: envelopes,
    cursor: {},
  };
  return {
    adapter: {
      id: "fake",
      async run(input) {
        const headers = parseFrontmatter(input.stdin);
        const profile = headers.agent_profile_id ?? "atlas";
        const idx = stub.cursor[profile] ?? 0;
        const queue = stub.envelopesByProfile[profile] ?? [];
        const envelope = { ...(queue[idx] ?? queue[queue.length - 1] ?? {}) };
        stub.cursor[profile] = idx + 1;
        envelope.session_id = headers.session_id;
        envelope.turn_index = Number(headers.turn_index);
        envelope.manifest_id = headers.manifest_id;
        envelope.parent_loop = headers.parent_loop;
        envelope.phase_or_purpose = headers.phase_or_purpose;
        envelope.agent_profile_id = profile;
        envelope.agent_role_in_session = headers.agent_role_in_session;
        envelope.input_revision_pins = extractManifestPins(input.stdin);
        void input.timeoutSec;
        void input.agentCwd;
        return {
          rawCode: 0,
          signal: null,
          timedOut: false,
          stdout: "```json\n" + JSON.stringify(envelope) + "\n```\n",
          stderr: "",
        };
      },
    },
    cursor: stub.cursor,
  };
}

function specProposalDraft(milestoneId: string, body: string) {
  return {
    slice_id: null,
    slice_kind: null,
    tdd_phase: null,
    contribution_kind: "lead_draft",
    output_kind: "spec_proposal",
    object_id: milestoneId,
    summary: "lead spec draft",
    artifacts: { spec_proposal_body: body },
    verdict: null,
    next_action_request: null,
    failure: null,
  };
}

function reviewerVerdict(
  milestoneId: string,
  result: string,
  rationale: string | null = null,
) {
  return {
    slice_id: null,
    slice_kind: null,
    tdd_phase: null,
    contribution_kind: "review_verdict",
    output_kind: "verdict",
    object_id: milestoneId,
    summary: `reviewer verdict=${result}`,
    artifacts: null,
    verdict: { result, rationale },
    next_action_request: null,
    failure: null,
  };
}

function planningDraft(milestoneId: string, slices: unknown[]) {
  return {
    slice_id: null,
    slice_kind: null,
    tdd_phase: null,
    contribution_kind: "lead_draft",
    output_kind: "slice_decomposition",
    object_id: milestoneId,
    summary: "planning slice decomposition",
    artifacts: { slices },
    verdict: null,
    next_action_request: null,
    failure: null,
  };
}

function validationLead(milestoneId: string, result: "PASS" | "FAIL" | "STALE") {
  return {
    slice_id: null,
    slice_kind: null,
    tdd_phase: null,
    contribution_kind: "lead_draft",
    output_kind: "milestone_package",
    object_id: milestoneId,
    summary: `validation ${result}`,
    artifacts:
      result === "PASS"
        ? {
            context_summary: {
              user_value: "feature delivered",
              behavior_changes: ["adds add()"],
              risks: [],
              architectural_debt_indicators: [],
            },
          }
        : {},
    verdict: { result, rationale: null },
    next_action_request: null,
    failure: null,
  };
}

async function seedMilestone(
  store: FsStore,
  state: Parameters<typeof Milestone.parse>[0]["state"],
  opts: { specPin?: string | null } = {},
) {
  const m = Milestone.parse({
    milestone_id: MILESTONE_ID,
    target_id: "demo",
    title: "feat",
    state,
    slot_kind: state.startsWith("M_DELIVERY") ? "delivery" : "discovery",
    intake_source_kind: "feature_request",
    intake_source_id: "01HZFR0000000000000000000A",
    spec_revision_pin: opts.specPin ?? null,
    context_summary_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(layout.milestone(MILESTONE_ID), JSON.stringify(m));
  return m;
}

function planningSliceFixture(sliceId: string, deps: string[] = []) {
  return {
    slice_id: sliceId,
    milestone_id: MILESTONE_ID,
    slice_kind: "internal",
    value_statement: `slice ${sliceId.slice(-2)}`,
    ac_ids: ["AC-1"],
    acceptance_tests: [{ path: "tests/x.test.ts", name: "x", ac_id: "AC-1" }],
    declared_scope: ["src/x.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: deps.map((d) => ({ slice_id: d, edge_type: "blocks" })),
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state: "SLICE_PENDING",
    current_session_id: null,
    spawning_proposal_id: null,
    abandoned_reason: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  };
}

function setup() {
  const workdir = mkdtempSync(join(tmpdir(), "outer-turn-"));
  const store = new FsStore({ workdir });
  const clock = new SystemClock();
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return { workdir, store, clock, logger, ledger };
}

/**
 * PR #69 P0-3 fix consequence: Discovery / Specification quorum_then_lead
 * now requires the registered `human` reviewer to vote approve before
 * convergence. The 5b.2 human-signal-binding pipeline appends the
 * synthetic SessionTurn at runtime; in unit tests we inject it directly
 * via the store so we don't have to wire the entire signal-drain path.
 */
async function appendHumanApproveTurn(
  store: FsStore,
  sessionId: string,
  turnIndex: number,
  result: string,
): Promise<void> {
  const sessionMeta = DialogueSession.parse(
    JSON.parse((await store.readText(layout.sessionMetadata(sessionId)))!),
  );
  const turn = {
    session_id: sessionId,
    turn_index: turnIndex,
    agent_profile_id: "human",
    input_manifest_id: null,
    input_turn_log_snapshot_ref: null,
    output_envelope: {
      session_id: sessionId,
      turn_index: turnIndex,
      parent_loop: "outer",
      phase_or_purpose: "Discovery",
      agent_profile_id: "human",
      agent_role_in_session: "reviewer",
      manifest_id: null,
      contribution_kind: "review_verdict",
      output_kind: "verdict",
      object_id: MILESTONE_ID,
      summary: `human verdict=${result}`,
      artifacts: null,
      verdict: { result, rationale: null },
      next_action_request: null,
      failure: null,
    },
    next_action_request: null,
    caller_routing_decision: {
      decision: "dropped",
      decision_reason: "human signal turn",
      resolved_addressed_to: null,
    },
    workspace_commit: null,
    verification_result_ref: null,
    recorded_at: ISO,
  };
  await store.writeAtomic(
    layout.sessionTurn(sessionId, turnIndex),
    JSON.stringify(turn, null, 2),
  );
  const updated = DialogueSession.parse({
    ...sessionMeta,
    current_turn_index: Math.max(sessionMeta.current_turn_index, turnIndex + 1),
    updated_at: ISO,
  });
  await store.writeAtomic(
    layout.sessionMetadata(sessionId),
    JSON.stringify(updated, null, 2),
  );
}

describe("runOneOuterTurn — Discovery quorum_then_lead spec_accept", () => {
  it("lead draft → reviewer approves → lead spec_accept → milestone → SPECIFICATION_DRAFT", async () => {
    const env = setup();
    await seedMilestone(env.store, "M_DISCOVERY_DRAFT");
    const { adapter } = makeStub({
      atlas: [
        // 1st atlas turn: lead draft
        specProposalDraft(MILESTONE_ID, "# Spec Draft\nproblem framing"),
        // 2nd atlas turn (post-quorum, lead reissues with spec_accept)
        {
          ...specProposalDraft(MILESTONE_ID, "# Spec Draft\nfinal"),
          contribution_kind: "review_verdict",
          output_kind: "verdict",
          verdict: { result: "spec_accept", rationale: null },
        },
      ],
      sentinel: [reviewerVerdict(MILESTONE_ID, "spec_accept")],
    });
    const llmRunner = new AdapterRunnerPort(adapter);
    const baseDeps = {
      store: env.store,
      clock: env.clock,
      llmRunner,
      ledger: env.ledger,
      callerId: "test",
      targetId: "demo",
    };

    // Turn 0: lead draft
    const t0 = await runOneOuterTurn(baseDeps);
    expect(t0.kind).toBe("turn_persisted");
    if (t0.kind !== "turn_persisted") return;
    expect(t0.decision.converged).toBe(false);

    // Turn 1: sentinel reviewer approves (quorum=1).
    const t1 = await runOneOuterTurn(baseDeps);
    expect(t1.kind).toBe("turn_persisted");
    if (t1.kind !== "turn_persisted") return;

    // Turn 2: lead emits spec_accept verdict — but human reviewer hasn't
    // approved yet (PR #69 P0-3), so the session continues.
    const t2 = await runOneOuterTurn(baseDeps);
    expect(t2.kind).toBe("turn_persisted");
    if (t2.kind !== "turn_persisted") return;
    expect(t2.decision.converged).toBe(false);

    // PR #69 P0-3: Discovery has a `human` reviewer registered — inject the
    // synthetic human-approve turn (5b.2 signal binding) so the next cycle
    // converges via the pre-eval path.
    await appendHumanApproveTurn(env.store, t2.sessionId, 3, "spec_accept");

    const t3 = await runOneOuterTurn(baseDeps);
    expect(t3.kind).toBe("turn_persisted");
    if (t3.kind !== "turn_persisted") return;
    expect(t3.decision.converged).toBe(true);
    if (!t3.decision.converged) return;
    expect(t3.decision.final_verdict).toBe("spec_accept");
    expect(t3.dispatch?.kind).toBe("applied");

    const m = Milestone.parse(
      JSON.parse((await env.store.readText(layout.milestone(MILESTONE_ID)))!),
    );
    expect(m.state).toBe("M_SPECIFICATION_DRAFT");

    const specBody = await env.store.readText(layout.milestoneSpec(MILESTONE_ID));
    expect(specBody).toContain("Spec Draft");

    const session = DialogueSession.parse(
      JSON.parse(
        (await env.store.readText(layout.sessionMetadata(t3.sessionId)))!,
      ),
    );
    expect(session.state).toBe("CONVERGED");
    expect(session.final_verdict).toBe("spec_accept");
  });
});

describe("runOneOuterTurn — Discovery reviewer request_changes re-engages lead", () => {
  it("lead → reviewer request_changes → lead reissues (continue, no convergence yet)", async () => {
    const env = setup();
    await seedMilestone(env.store, "M_DISCOVERY_DRAFT");
    const { adapter } = makeStub({
      atlas: [
        specProposalDraft(MILESTONE_ID, "draft v1"),
        specProposalDraft(MILESTONE_ID, "draft v2 (addresses RC)"),
      ],
      sentinel: [reviewerVerdict(MILESTONE_ID, "request_changes", "needs more detail")],
    });
    const llmRunner = new AdapterRunnerPort(adapter);
    const baseDeps = {
      store: env.store,
      clock: env.clock,
      llmRunner,
      ledger: env.ledger,
      callerId: "test",
      targetId: "demo",
    };

    const t0 = await runOneOuterTurn(baseDeps);
    expect(t0.kind).toBe("turn_persisted");
    const t1 = await runOneOuterTurn(baseDeps);
    expect(t1.kind).toBe("turn_persisted");
    const t2 = await runOneOuterTurn(baseDeps);
    expect(t2.kind).toBe("turn_persisted");
    if (t2.kind !== "turn_persisted") return;
    // Lead re-engaged after request_changes — spec_accept lead vote still
    // missing, session continues.
    expect(t2.decision.converged).toBe(false);

    // Turn 2 should be a lead turn (atlas).
    const turn2Body = await env.store.readText(
      layout.sessionTurn(t2.sessionId, 2),
    );
    expect(turn2Body).not.toBeNull();
    const turn2 = JSON.parse(turn2Body!);
    expect(turn2.output_envelope.agent_role_in_session).toBe("lead");
  });
});

describe("runOneOuterTurn — Specification quorum=2 spec_accept", () => {
  it("two reviewer approves + lead verdict → converges spec_accept → M_SPEC_APPROVED", async () => {
    const env = setup();
    await seedMilestone(env.store, "M_SPECIFICATION_DRAFT", {
      specPin: "spec-rev-1",
    });
    const { adapter } = makeStub({
      atlas: [
        specProposalDraft(MILESTONE_ID, "specification body"),
        {
          ...specProposalDraft(MILESTONE_ID, "specification body"),
          contribution_kind: "review_verdict",
          output_kind: "verdict",
          verdict: { result: "spec_accept", rationale: null },
        },
      ],
      forge: [reviewerVerdict(MILESTONE_ID, "spec_accept")],
      sentinel: [reviewerVerdict(MILESTONE_ID, "spec_accept")],
    });
    const llmRunner = new AdapterRunnerPort(adapter);
    const baseDeps = {
      store: env.store,
      clock: env.clock,
      llmRunner,
      ledger: env.ledger,
      callerId: "test",
      targetId: "demo",
    };

    // Specification needs quorum_min=2 reviewers + lead.
    // PR #69 P0-3 fix: Specification has a `human` reviewer on the roster;
    // we drive 3 LLM turns (lead draft + forge + sentinel), then inject the
    // human approve turn, then drive the lead's final verdict.
    let last;
    for (let i = 0; i < 5; i++) {
      last = await runOneOuterTurn(baseDeps);
      if (
        last.kind === "awaiting_human" ||
        (last.kind === "turn_persisted" &&
          "decision" in last &&
          last.decision.converged)
      ) {
        break;
      }
    }
    expect(last?.kind).toBe("awaiting_human");
    if (last?.kind !== "awaiting_human") return;
    // 4 turns persisted (lead draft + forge + sentinel + lead final verdict);
    // human approve turn fills index 4 so the next cycle's pre-eval converges.
    await appendHumanApproveTurn(env.store, last.sessionId, 4, "spec_accept");
    last = await runOneOuterTurn(baseDeps);
    expect(last?.kind).toBe("turn_persisted");
    if (last?.kind !== "turn_persisted") return;
    expect(last.decision.converged).toBe(true);
    if (!last.decision.converged) return;
    expect(last.decision.final_verdict).toBe("spec_accept");

    const m = Milestone.parse(
      JSON.parse((await env.store.readText(layout.milestone(MILESTONE_ID)))!),
    );
    expect(m.state).toBe("M_SPEC_APPROVED");
  });
});

describe("runOneOuterTurn — Planning unanimous_approve persists slice DAG", () => {
  it("lead emits decomposition → all reviewers approve → SLICE_PENDING/SLICE_READY persisted", async () => {
    const env = setup();
    await seedMilestone(env.store, "M_DELIVERY_PLANNING");
    const { adapter } = makeStub({
      atlas: [
        planningDraft(MILESTONE_ID, [
          planningSliceFixture(SLICE_A),
          planningSliceFixture(SLICE_B, [SLICE_A]),
        ]),
      ],
      forge: [reviewerVerdict(MILESTONE_ID, "plan_accept")],
      sentinel: [reviewerVerdict(MILESTONE_ID, "plan_accept")],
    });
    const llmRunner = new AdapterRunnerPort(adapter);
    const baseDeps = {
      store: env.store,
      clock: env.clock,
      llmRunner,
      ledger: env.ledger,
      callerId: "test",
      targetId: "demo",
    };

    let last;
    for (let i = 0; i < 4; i++) {
      last = await runOneOuterTurn(baseDeps);
      if (
        last.kind === "turn_persisted" &&
        "decision" in last &&
        last.decision.converged
      ) {
        break;
      }
    }
    expect(last?.kind).toBe("turn_persisted");
    if (last?.kind !== "turn_persisted") return;
    expect(last.decision.converged).toBe(true);
    if (!last.decision.converged) return;
    expect(last.decision.final_verdict).toBe("plan_accept");

    const m = Milestone.parse(
      JSON.parse((await env.store.readText(layout.milestone(MILESTONE_ID)))!),
    );
    expect(m.state).toBe("M_DELIVERY_BUILDING");

    const sliceA = Slice.parse(
      JSON.parse((await env.store.readText(layout.slice(SLICE_A)))!),
    );
    const sliceB = Slice.parse(
      JSON.parse((await env.store.readText(layout.slice(SLICE_B)))!),
    );
    expect(sliceA.state).toBe("SLICE_READY"); // no deps → ready
    expect(sliceB.state).toBe("SLICE_PENDING"); // blocked by SLICE_A
  });
});

describe("runOneOuterTurn — Validation lead_only PASS finalizes M_DONE", () => {
  it("sentinel lead emits milestone_package PASS → ContextSummary persisted, milestone M_DONE", async () => {
    const env = setup();
    await seedMilestone(env.store, "M_DELIVERY_VALIDATING", { specPin: "spec-rev-1" });
    const { adapter } = makeStub({
      sentinel: [validationLead(MILESTONE_ID, "PASS")],
    });
    const llmRunner = new AdapterRunnerPort(adapter);
    const baseDeps = {
      store: env.store,
      clock: env.clock,
      llmRunner,
      ledger: env.ledger,
      callerId: "test",
      targetId: "demo",
    };

    const out = await runOneOuterTurn(baseDeps);
    expect(out.kind).toBe("turn_persisted");
    if (out.kind !== "turn_persisted") return;
    expect(out.decision.converged).toBe(true);
    if (!out.decision.converged) return;
    expect(out.decision.final_verdict).toBe("PASS");
    expect(out.dispatch?.kind).toBe("applied");

    const m = Milestone.parse(
      JSON.parse((await env.store.readText(layout.milestone(MILESTONE_ID)))!),
    );
    expect(m.state).toBe("M_DONE");
    expect(m.context_summary_id).not.toBeNull();
  });

  it("sentinel lead FAIL → converges validation_fail → milestone reverts to M_DELIVERY_BUILDING (PR #69 P0-4)", async () => {
    const env = setup();
    await seedMilestone(env.store, "M_DELIVERY_VALIDATING", { specPin: "spec-rev-1" });
    const { adapter } = makeStub({
      sentinel: [validationLead(MILESTONE_ID, "FAIL")],
    });
    const llmRunner = new AdapterRunnerPort(adapter);
    const baseDeps = {
      store: env.store,
      clock: env.clock,
      llmRunner,
      ledger: env.ledger,
      callerId: "test",
      targetId: "demo",
    };
    const out = await runOneOuterTurn(baseDeps);
    expect(out.kind).toBe("turn_persisted");
    if (out.kind !== "turn_persisted") return;
    // PR #69 P0-4 fix: Validation FAIL now bypasses the evidence_only +
    // verification_green gate (which would otherwise block FAIL/STALE
    // forever) and converges directly on the lead's explicit verdict so the
    // dispatch matrix's `validation_fail` row runs.
    expect(out.decision.converged).toBe(true);
    if (!out.decision.converged) return;
    expect(out.decision.final_verdict).toBe("FAIL");
    expect(out.dispatch?.kind).toBe("applied");

    const m = Milestone.parse(
      JSON.parse((await env.store.readText(layout.milestone(MILESTONE_ID)))!),
    );
    expect(m.state).toBe("M_DELIVERY_BUILDING");
  });
});

describe("runOneOuterTurn — empty pickup", () => {
  it("returns noop when no outer-pickable milestone exists", async () => {
    const env = setup();
    await seedMilestone(env.store, "M_DONE");
    const { adapter } = makeStub({});
    const llmRunner = new AdapterRunnerPort(adapter);
    const out = await runOneOuterTurn({
      store: env.store,
      clock: env.clock,
      llmRunner,
      ledger: env.ledger,
      callerId: "test",
      targetId: "demo",
    });
    expect(out.kind).toBe("noop");
  });
});

// ---------------------------------------------------------------- helpers

function parseFrontmatter(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body.startsWith("---\n")) return out;
  const end = body.indexOf("\n---\n", 4);
  if (end < 0) return out;
  const fm = body.slice(4, end);
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function extractManifestPins(prompt: string): string[] {
  const re = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const body = m[1] ?? "";
    try {
      const obj = JSON.parse(body) as { entries?: Array<{ revision_pin?: string }> };
      if (Array.isArray(obj.entries)) {
        return obj.entries
          .map((e) => e.revision_pin)
          .filter((p): p is string => typeof p === "string" && p.length > 0);
      }
    } catch {
      // continue
    }
  }
  return [];
}
