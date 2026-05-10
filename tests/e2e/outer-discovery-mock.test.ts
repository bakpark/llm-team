/**
 * Phase prod-5 — outer Discovery phase mock smoke.
 *
 * Default-pass. Reuses the phase-prod-4 e2e harness (sandbox tmpdir +
 * chmod 0700) and drives `runOneOuterTurn` through the Discovery
 * `quorum_then_lead` round trip:
 *   1. atlas lead draft → SESSION_OPEN
 *   2. sentinel reviewer approve
 *   3. atlas lead spec_accept
 *   4. (PR #69 P0-3) human reviewer approve injected via store
 *   5. converge → milestone promotes to M_SPECIFICATION_DRAFT
 *
 * The flow mirrors `tests/integration/outer-turn.test.ts` Discovery test
 * but uses the e2e sandbox harness so PR-build / nightly e2e exercises
 * the same wiring.
 */
import { describe, expect, it } from "vitest";

import { createE2eRun } from "../helpers/e2e-harness.js";
import { resolve } from "node:path";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FileLedger } from "../../src/application/ledger.js";
import { runOneOuterTurn } from "../../src/application/outer-turn.js";
import { layout } from "../../src/application/persistence-layout.js";
import { DialogueSession } from "../../src/domain/schema/dialogue-session.js";
import { Milestone } from "../../src/domain/schema/milestone.js";
import { SystemClock } from "../../src/ports/clock.js";
import type {
  LlmAdapterInput,
  LlmAdapterResult,
} from "../../src/adapters/llm-runner/types.js";

const ISO = "2026-05-10T00:00:00.000Z";
const MILESTONE_ID = "01HZM00000000000000000000A";

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

function reviewerVerdict(milestoneId: string, result: string) {
  return {
    slice_id: null,
    slice_kind: null,
    tdd_phase: null,
    contribution_kind: "review_verdict",
    output_kind: "verdict",
    object_id: milestoneId,
    summary: `reviewer verdict=${result}`,
    artifacts: null,
    verdict: { result, rationale: null },
    next_action_request: null,
    failure: null,
  };
}

interface QueueAdapter {
  readonly id: "fake";
  run(input: LlmAdapterInput): Promise<LlmAdapterResult>;
}

function makeQueueAdapter(envelopes: Record<string, Record<string, unknown>[]>): QueueAdapter {
  const cursor: Record<string, number> = {};
  return {
    id: "fake",
    async run(input) {
      const headers = parseFrontmatter(input.stdin);
      const profile = headers.agent_profile_id ?? "atlas";
      const idx = cursor[profile] ?? 0;
      const queue = envelopes[profile] ?? [];
      const envelope: Record<string, unknown> = {
        ...(queue[idx] ?? queue[queue.length - 1] ?? {}),
      };
      cursor[profile] = idx + 1;
      envelope.session_id = headers.session_id;
      envelope.turn_index = Number(headers.turn_index);
      envelope.manifest_id = headers.manifest_id;
      envelope.parent_loop = headers.parent_loop;
      envelope.phase_or_purpose = headers.phase_or_purpose;
      envelope.agent_profile_id = profile;
      envelope.agent_role_in_session = headers.agent_role_in_session;
      envelope.input_revision_pins = extractManifestPins(input.stdin);
      return {
        rawCode: 0,
        signal: null,
        timedOut: false,
        stdout: "```json\n" + JSON.stringify(envelope) + "\n```\n",
        stderr: "",
      };
    },
  };
}

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

async function seedMilestone(store: FsStore, targetId: string): Promise<void> {
  const m = Milestone.parse({
    milestone_id: MILESTONE_ID,
    target_id: targetId,
    title: "feat",
    state: "M_DISCOVERY_DRAFT",
    slot_kind: "discovery",
    intake_source_kind: "feature_request",
    intake_source_id: "01HZFR0000000000000000000A",
    spec_revision_pin: null,
    context_summary_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  await store.writeAtomic(layout.milestone(MILESTONE_ID), JSON.stringify(m));
}

describe("Phase prod-5 — outer Discovery mock smoke (default-pass)", () => {
  it("Discovery quorum_then_lead converges spec_accept → M_SPECIFICATION_DRAFT", async () => {
    const handle = createE2eRun();
    try {
      const targetId = handle.target.identity.target_id;
      const store = new FsStore({ workdir: handle.workdir });
      const clock = new SystemClock();
      const ledger = new FileLedger({ store });
      await seedMilestone(store, targetId);

      const adapter = makeQueueAdapter({
        atlas: [
          specProposalDraft(MILESTONE_ID, "# Spec Draft\nproblem framing"),
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
      // incident-8: deterministic workspace adapter so the session_open
      // path resolves a real-looking trunk HEAD instead of crashing on the
      // legacy placeholder fallback.
      const workspace = new FakeWorkspace(resolve(handle.workdir, "workspaces"));
      const baseDeps = {
        store,
        clock,
        llmRunner,
        ledger,
        callerId: "e2e-caller",
        targetId,
        workspace,
      };

      // Turn 0: lead draft.
      const t0 = await runOneOuterTurn(baseDeps);
      expect(t0.kind).toBe("turn_persisted");
      // Turn 1: sentinel approve.
      const t1 = await runOneOuterTurn(baseDeps);
      expect(t1.kind).toBe("turn_persisted");
      // Turn 2: lead emits spec_accept verdict (still awaiting human).
      const t2 = await runOneOuterTurn(baseDeps);
      expect(t2.kind).toBe("turn_persisted");
      if (t2.kind !== "turn_persisted") return;
      expect(t2.decision.converged).toBe(false);

      // Inject the human-approve turn (PR #69 P0-3 — Discovery requires
      // a human reviewer vote before convergence).
      await appendHumanApproveTurn(store, t2.sessionId, 3, "spec_accept");

      const t3 = await runOneOuterTurn(baseDeps);
      expect(t3.kind).toBe("turn_persisted");
      if (t3.kind !== "turn_persisted") return;
      expect(t3.decision.converged).toBe(true);
      if (!t3.decision.converged) return;
      expect(t3.decision.final_verdict).toBe("spec_accept");

      const m = Milestone.parse(
        JSON.parse((await store.readText(layout.milestone(MILESTONE_ID)))!),
      );
      expect(m.state).toBe("M_SPECIFICATION_DRAFT");
    } finally {
      handle.cleanup();
    }
  });
});
