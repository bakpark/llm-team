import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapters/llm-runner/fake.js";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { callAgent } from "../../src/application/agent-io.js";
import { ManifestBuilder } from "../../src/application/manifest-builder.js";
import { ContextManifest } from "../../src/domain/schema/manifest.js";
import { FixedClock } from "../../src/ports/clock.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";
const MANIFEST_ID = "01HZMA0000000000000000000A";
const ISO = "2026-05-07T00:00:00.000Z";

function buildManifest() {
  return ContextManifest.parse({
    manifest_id: MANIFEST_ID,
    session_id: SESSION_ID,
    turn_index: 0,
    purpose: "tdd_build",
    target: { object_kind: "slice", object_id: SLICE_ID },
    entries: [
      {
        object_kind: "slice",
        object_id: SLICE_ID,
        fetch_scope: "body",
        revision_pin: "deadbeef",
        required: true,
        purpose: "primary",
      },
    ],
    created_at: ISO,
  });
}

class StaticResolver {
  constructor(private pin: string) {}
  async resolve(): Promise<string> {
    return this.pin;
  }
}

function envelopeFixture(): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    turn_index: 0,
    parent_loop: "inner",
    phase_or_purpose: "tdd_build",
    slice_id: SLICE_ID,
    slice_kind: "internal",
    tdd_phase: "red_green",
    agent_profile_id: "forge",
    agent_role_in_session: "lead",
    contribution_kind: "lead_draft",
    output_kind: "patch",
    object_id: SLICE_ID,
    manifest_id: MANIFEST_ID,
    input_revision_pins: ["deadbeef"],
    summary: "first turn",
  });
}

describe("callAgent", () => {
  it("runs prompt → fake adapter → parse → enrich → validate → pin recheck", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "fixt-"));
    writeFileSync(
      join(fixtureDir, "forge-tdd_build.json"),
      envelopeFixture(),
      "utf8",
    );
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    const adapter = new FakeAdapter({ fixtureDir });
    const runner = new AdapterRunnerPort(adapter);
    const builder = new ManifestBuilder(
      new StaticResolver("deadbeef"),
      new FixedClock(0),
    );
    const out = await callAgent(
      {
        agentProfileId: "forge",
        agentRoleInSession: "lead",
        parentLoop: "inner",
        phaseOrPurpose: "tdd_build",
        sessionId: SESSION_ID,
        turnIndex: 0,
        manifest: buildManifest(),
        workspaceRevisionPin: "deadbeef",
        agentCwd: cwd,
        timeoutSec: 30,
        idempotency: {
          scope: "per_turn",
          parts: {
            session_id: SESSION_ID,
            turn_index: 0,
            agent_profile_id: "forge",
            manifest_id: MANIFEST_ID,
            input_revision_pins: ["deadbeef"],
          },
        },
        runtimeMetadata: { workspace_commit: "deadbeef" },
      },
      { llmRunner: runner, manifestBuilder: builder },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.envelope.idempotency_key.startsWith("per_turn|")).toBe(true);
      expect(out.envelope.runtime_metadata).toEqual({ workspace_commit: "deadbeef" });
      expect(out.stalePins.length).toBe(0);
    }
  });

  it("reports header_echo_mismatch when fixture replays wrong session_id", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "fixt-"));
    const wrong = JSON.parse(envelopeFixture());
    wrong.session_id = "01HZSE0000000000000000000B";
    writeFileSync(
      join(fixtureDir, "forge-tdd_build.json"),
      JSON.stringify(wrong),
      "utf8",
    );
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    const runner = new AdapterRunnerPort(new FakeAdapter({ fixtureDir }));
    const builder = new ManifestBuilder(
      new StaticResolver("deadbeef"),
      new FixedClock(0),
    );
    const out = await callAgent(
      {
        agentProfileId: "forge",
        agentRoleInSession: "lead",
        parentLoop: "inner",
        phaseOrPurpose: "tdd_build",
        sessionId: SESSION_ID,
        turnIndex: 0,
        manifest: buildManifest(),
        workspaceRevisionPin: "deadbeef",
        agentCwd: cwd,
        timeoutSec: 30,
        idempotency: {
          scope: "per_turn",
          parts: {
            session_id: SESSION_ID,
            turn_index: 0,
            agent_profile_id: "forge",
            manifest_id: MANIFEST_ID,
            input_revision_pins: ["deadbeef"],
          },
        },
        runtimeMetadata: {},
      },
      { llmRunner: runner, manifestBuilder: builder },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("envelope_parse");
      expect(out.reason).toBe("header_echo_mismatch");
    }
  });

  it("flags stale pins when the resolver pin diverges from the manifest", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "fixt-"));
    writeFileSync(
      join(fixtureDir, "forge-tdd_build.json"),
      envelopeFixture(),
      "utf8",
    );
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    const runner = new AdapterRunnerPort(new FakeAdapter({ fixtureDir }));
    // Build manifest with pin "deadbeef" but resolver returns "drifted" — a
    // post-build drift that recheckPins must catch.
    const builder = new ManifestBuilder(
      new StaticResolver("drifted"),
      new FixedClock(0),
    );
    const out = await callAgent(
      {
        agentProfileId: "forge",
        agentRoleInSession: "lead",
        parentLoop: "inner",
        phaseOrPurpose: "tdd_build",
        sessionId: SESSION_ID,
        turnIndex: 0,
        manifest: buildManifest(),
        workspaceRevisionPin: "deadbeef",
        agentCwd: cwd,
        timeoutSec: 30,
        idempotency: {
          scope: "per_turn",
          parts: {
            session_id: SESSION_ID,
            turn_index: 0,
            agent_profile_id: "forge",
            manifest_id: MANIFEST_ID,
            input_revision_pins: ["deadbeef"],
          },
        },
        runtimeMetadata: {},
      },
      { llmRunner: runner, manifestBuilder: builder },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.stalePins.length).toBe(1);
      expect(out.stalePins[0]?.recorded_pin).toBe("deadbeef");
    }
  });
});

// Avoid unused-import warnings.
void mkdirSync;

/**
 * incident-1b Bug B — when `deps.store` is provided, `callAgent` resolves
 * manifest body entries and inlines them under `# Inputs` in the composed
 * prompt before invoking the LLM runner.
 */
describe("callAgent — manifest body inline (incident-1b Bug B)", () => {
  const MILESTONE_ID = "01HZMS0000000000000000000A";
  const REQUEST_ID = "01HZFR0000000000000000000A";
  const ISO2 = "2026-05-07T00:00:00.000Z";

  function milestoneManifest() {
    return ContextManifest.parse({
      manifest_id: MANIFEST_ID,
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "design",
      target: { object_kind: "milestone", object_id: MILESTONE_ID },
      entries: [
        {
          object_kind: "milestone",
          object_id: MILESTONE_ID,
          fetch_scope: "body",
          // PR #93 P0-B: revision_pin must match the persisted milestone's
          // updated_at; otherwise resolveManifestEntries throws stale.
          revision_pin: ISO2,
          required: true,
          purpose: "primary input",
        },
      ],
      created_at: ISO2,
    });
  }

  function discoveryEnvelopeFixture(): string {
    return JSON.stringify({
      session_id: SESSION_ID,
      turn_index: 0,
      parent_loop: "outer",
      phase_or_purpose: "Discovery",
      slice_id: null,
      slice_kind: null,
      tdd_phase: null,
      agent_profile_id: "atlas",
      agent_role_in_session: "lead",
      contribution_kind: "lead_draft",
      output_kind: "spec_proposal",
      object_id: MILESTONE_ID,
      manifest_id: MANIFEST_ID,
      input_revision_pins: ["deadbeef"],
      summary: "spec draft summary",
    });
  }

  it("inlines milestone body under `# Inputs` when StorePort is wired", async () => {
    const { MemoryStore } = await import("../../src/adapters/store/memory.js");
    const { layout } = await import(
      "../../src/application/persistence-layout.js"
    );
    const store = new MemoryStore();
    await store.writeAtomic(
      layout.milestone(MILESTONE_ID),
      JSON.stringify({
        milestone_id: MILESTONE_ID,
        target_id: "team-a",
        title: "Add ledger summary CLI",
        state: "M_DISCOVERY_DRAFT",
        slot_kind: "discovery",
        intake_source_kind: "feature_request",
        intake_source_id: REQUEST_ID,
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: ISO2,
        updated_at: ISO2,
      }),
    );
    await store.writeAtomic(
      layout.featureRequest(REQUEST_ID),
      JSON.stringify({
        request_id: REQUEST_ID,
        title: "Add ledger summary CLI",
        body: "operators-want-a-ledger-summary-tool-FEATUREBODY",
        submitted_by: "user@example.com",
        submitted_at: ISO2,
        state: "queued",
        promoted_milestone_id: null,
        processed_at: null,
        rejection_reason: null,
      }),
    );
    const fixtureDir = mkdtempSync(join(tmpdir(), "fixt-"));
    writeFileSync(
      join(fixtureDir, "atlas-Discovery.json"),
      discoveryEnvelopeFixture(),
      "utf8",
    );
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    const runner = new AdapterRunnerPort(new FakeAdapter({ fixtureDir }));
    const builder = new ManifestBuilder(
      new StaticResolver("deadbeef"),
      new FixedClock(0),
    );

    // Capture the rendered prompt by intercepting writePromptTmp via a fs read
    // after the runner is invoked: the FakeAdapter writes the consumed prompt
    // path to its result so we can inspect what was passed.
    const out = await callAgent(
      {
        agentProfileId: "atlas",
        agentRoleInSession: "lead",
        parentLoop: "outer",
        phaseOrPurpose: "Discovery",
        sessionId: SESSION_ID,
        turnIndex: 0,
        manifest: milestoneManifest(),
        workspaceRevisionPin: "deadbeef",
        agentCwd: cwd,
        timeoutSec: 30,
        idempotency: {
          scope: "per_turn",
          parts: {
            session_id: SESSION_ID,
            turn_index: 0,
            agent_profile_id: "atlas",
            manifest_id: MANIFEST_ID,
            input_revision_pins: ["deadbeef"],
          },
        },
        runtimeMetadata: {},
      },
      { llmRunner: runner, manifestBuilder: builder, store },
    );
    expect(out.ok).toBe(true);

    // The runner consumed the prompt file at `runner.invoke({...promptRef})`.
    // FakeAdapter does not capture promptRef, so we recompose the prompt
    // directly via composePrompt to verify the inputs section is present.
    const { composePrompt } = await import(
      "../../src/application/prompt-compose.js"
    );
    const { resolveManifestEntries } = await import(
      "../../src/application/manifest-resolve.js"
    );
    const manifest = milestoneManifest();
    const resolved = await resolveManifestEntries(store, manifest);
    const prompt = composePrompt({
      agentProfileId: "atlas",
      agentRoleInSession: "lead",
      parentLoop: "outer",
      phaseOrPurpose: "Discovery",
      sessionId: SESSION_ID,
      turnIndex: 0,
      manifest,
      workspaceRevisionPin: "deadbeef",
      resolvedEntries: resolved,
    });
    expect(prompt).toContain("## Inputs");
    expect(prompt).toContain("operators-want-a-ledger-summary-tool-FEATUREBODY");
  });

  it("returns prompt_layout_violation when a required milestone entry is for an unsupported kind/scope", async () => {
    const { MemoryStore } = await import("../../src/adapters/store/memory.js");
    const store = new MemoryStore();
    const fixtureDir = mkdtempSync(join(tmpdir(), "fixt-"));
    writeFileSync(
      join(fixtureDir, "atlas-Discovery.json"),
      discoveryEnvelopeFixture(),
      "utf8",
    );
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    const runner = new AdapterRunnerPort(new FakeAdapter({ fixtureDir }));
    const builder = new ManifestBuilder(
      new StaticResolver("deadbeef"),
      new FixedClock(0),
    );
    const manifest = ContextManifest.parse({
      manifest_id: MANIFEST_ID,
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "design",
      target: { object_kind: "milestone", object_id: MILESTONE_ID },
      entries: [
        {
          object_kind: "slice",
          object_id: SLICE_ID,
          fetch_scope: "body",
          revision_pin: "deadbeef",
          required: true,
          purpose: "primary input",
        },
      ],
      created_at: ISO2,
    });
    const out = await callAgent(
      {
        agentProfileId: "atlas",
        agentRoleInSession: "lead",
        parentLoop: "outer",
        phaseOrPurpose: "Discovery",
        sessionId: SESSION_ID,
        turnIndex: 0,
        manifest,
        workspaceRevisionPin: "deadbeef",
        agentCwd: cwd,
        timeoutSec: 30,
        idempotency: {
          scope: "per_turn",
          parts: {
            session_id: SESSION_ID,
            turn_index: 0,
            agent_profile_id: "atlas",
            manifest_id: MANIFEST_ID,
            input_revision_pins: ["deadbeef"],
          },
        },
        runtimeMetadata: {},
      },
      { llmRunner: runner, manifestBuilder: builder, store },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("prompt_compose");
      expect(out.reason).toBe("prompt_layout_violation");
    }
  });

  /**
   * incident-5 — Discovery atlas/sentinel were stuck looping because
   * manifest entries for prior `(session_turn, body)` were silently
   * dropped (resolver only knew `(milestone, body)`). End-to-end check:
   * with the resolver extended, a session_turn body is rendered inline
   * under `## Inputs` so the next turn can read the prior reviewer's
   * `request_changes` rationale.
   */
  it("inlines session_turn body under `## Inputs` when prior turn entry is present", async () => {
    const { MemoryStore } = await import("../../src/adapters/store/memory.js");
    const { layout } = await import(
      "../../src/application/persistence-layout.js"
    );
    const { composePrompt } = await import(
      "../../src/application/prompt-compose.js"
    );
    const { resolveManifestEntries } = await import(
      "../../src/application/manifest-resolve.js"
    );
    const store = new MemoryStore();
    // Seed milestone + feature_request so the milestone entry resolves too.
    await store.writeAtomic(
      layout.milestone(MILESTONE_ID),
      JSON.stringify({
        milestone_id: MILESTONE_ID,
        target_id: "team-a",
        title: "Add ledger summary CLI",
        state: "M_DISCOVERY_DRAFT",
        slot_kind: "discovery",
        intake_source_kind: "feature_request",
        intake_source_id: REQUEST_ID,
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: ISO2,
        updated_at: ISO2,
      }),
    );
    await store.writeAtomic(
      layout.featureRequest(REQUEST_ID),
      JSON.stringify({
        request_id: REQUEST_ID,
        title: "Add ledger summary CLI",
        body: "operators-want-a-ledger-summary-tool-FEATUREBODY",
        submitted_by: "user@example.com",
        submitted_at: ISO2,
        state: "queued",
        promoted_milestone_id: null,
        processed_at: null,
        rejection_reason: null,
      }),
    );
    // Seed a prior reviewer turn with a request_changes verdict.
    const priorTurn = {
      session_id: SESSION_ID,
      turn_index: 1,
      agent_profile_id: "sentinel",
      input_manifest_id: MANIFEST_ID,
      input_turn_log_snapshot_ref: null,
      output_envelope: {
        session_id: SESSION_ID,
        turn_index: 1,
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        slice_id: null,
        slice_kind: null,
        tdd_phase: null,
        agent_profile_id: "sentinel",
        agent_role_in_session: "reviewer",
        contribution_kind: "review_verdict",
        parent_review_verdict_id: null,
        output_kind: "verdict",
        object_id: MILESTONE_ID,
        manifest_id: MANIFEST_ID,
        input_revision_pins: ["deadbeef"],
        summary: "REVIEWER_OBJECTION_SHOULD_BE_VISIBLE",
        artifacts: null,
        verdict: {
          result: "request_changes",
          rationale: "scope must enumerate CLI flags",
        },
        next_action_request: null,
        failure: null,
        idempotency_key: "idemp:prior-turn:1",
        runtime_metadata: {},
      },
      next_action_request: null,
      caller_routing_decision: null,
      workspace_commit: null,
      verification_result_ref: null,
      recorded_at: ISO2,
    };
    const turnRaw = JSON.stringify(priorTurn);
    await store.writeAtomic(layout.sessionTurn(SESSION_ID, 1), turnRaw);
    const turnPin = `len=${turnRaw.length}:${turnRaw.slice(0, 32).replace(/\s+/g, "")}`;

    const manifest = ContextManifest.parse({
      manifest_id: MANIFEST_ID,
      session_id: SESSION_ID,
      turn_index: 2,
      purpose: "design",
      target: { object_kind: "milestone", object_id: MILESTONE_ID },
      entries: [
        {
          object_kind: "milestone",
          object_id: MILESTONE_ID,
          fetch_scope: "body",
          revision_pin: ISO2,
          required: true,
          purpose: "primary input",
        },
        {
          object_kind: "session_turn",
          object_id: SESSION_ID,
          turn_index: 1,
          fetch_scope: "body",
          revision_pin: turnPin,
          required: false,
          purpose: "prior turn 1 (reviewer) (request_changes)",
        },
      ],
      created_at: ISO2,
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(2);
    const prompt = composePrompt({
      agentProfileId: "atlas",
      agentRoleInSession: "lead",
      parentLoop: "outer",
      phaseOrPurpose: "Discovery",
      sessionId: SESSION_ID,
      turnIndex: 2,
      manifest,
      workspaceRevisionPin: "deadbeef",
      resolvedEntries: resolved,
    });
    expect(prompt).toContain("## Inputs");
    expect(prompt).toContain("REVIEWER_OBJECTION_SHOULD_BE_VISIBLE");
    expect(prompt).toContain("scope must enumerate CLI flags");
    expect(prompt).toContain("request_changes");
  });
});
