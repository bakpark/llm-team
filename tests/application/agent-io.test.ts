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
