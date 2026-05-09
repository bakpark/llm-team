/**
 * Phase prod-5 — middle review approve path mock smoke.
 *
 * Default-pass (no LLM_TEAM_E2E gate). Reuses the phase-prod-4 e2e harness
 * to spin a sandbox workdir, seeds a SLICE_REVIEWING + SM_READY_FOR_REVIEW
 * fixture, and drives `runOneMiddleReviewTurn` with a stamping FakeAdapter
 * that emits a sentinel `approve` verdict. Confirms the SM_READY_FOR_REVIEW
 * → SM_APPROVED → SM_MERGED transition + slice promotion to SLICE_VALIDATED.
 *
 * Mirrors `tests/integration/middle-review-cycle.test.ts` for the
 * application-layer transitions while exercising the e2e harness wiring
 * (sandbox tmpdir + chmod 0700) so the round-trip is covered end-to-end.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createE2eRun } from "../helpers/e2e-harness.js";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { runOneMiddleReviewTurn } from "../../src/application/dialogue-coordinator.js";
import { FileLedger } from "../../src/application/ledger.js";
import { layout } from "../../src/application/persistence-layout.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { SystemClock } from "../../src/ports/clock.js";
import type {
  LlmAdapterInput,
  LlmAdapterResult,
} from "../../src/adapters/llm-runner/types.js";

const SLICE_ID = "01HZS00000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const SLICE_MERGE_ID = "01HZSM0000000000000000000A";
const VERIFICATION_RUN_ID = "01HZVR0000000000000000000A";
const ISO = "2026-05-10T00:00:00.000Z";

function envelopeApprove(): Record<string, unknown> {
  return {
    parent_loop: "middle",
    phase_or_purpose: "review",
    slice_id: SLICE_ID,
    slice_kind: "internal",
    agent_profile_id: "sentinel",
    agent_role_in_session: "lead",
    contribution_kind: "review_verdict",
    output_kind: "verdict",
    object_id: SLICE_MERGE_ID,
    summary: "sentinel verdict=approve",
    verdict: { result: "approve", rationale: null },
    artifacts: null,
  };
}

class StampingFakeAdapter {
  readonly id = "fake" as const;
  constructor(private readonly envelope: Record<string, unknown>) {}
  async run(input: LlmAdapterInput): Promise<LlmAdapterResult> {
    const headers = parseFrontmatter(input.stdin);
    const env = { ...this.envelope };
    env.session_id = headers.session_id;
    env.turn_index = Number(headers.turn_index ?? 0);
    env.manifest_id = headers.manifest_id;
    env.input_revision_pins = extractManifestPins(input.stdin);
    return {
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: "```json\n" + JSON.stringify(env) + "\n```\n",
      stderr: "",
    };
  }
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

function seedReviewing(workdir: string, targetId: string): void {
  mkdirSync(join(workdir, "slices"), { recursive: true });
  mkdirSync(join(workdir, "slice_merges"), { recursive: true });
  mkdirSync(join(workdir, "verifications"), { recursive: true });
  const slice = Slice.parse({
    slice_id: SLICE_ID,
    milestone_id: MILESTONE_ID,
    slice_kind: "internal",
    value_statement: "add() function",
    ac_ids: ["AC-1"],
    acceptance_tests: [{ path: "tests/add.test.ts", name: "add", ac_id: "AC-1" }],
    declared_scope: ["src/add.ts", "tests/add.test.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state: "SLICE_REVIEWING",
    current_session_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  writeFileSync(join(workdir, layout.slice(SLICE_ID)), JSON.stringify(slice), "utf8");
  const sm = SliceMerge.parse({
    slice_merge_id: SLICE_MERGE_ID,
    slice_id: SLICE_ID,
    target_id: targetId,
    pre_merge_workspace_revision: "inner-commit-1",
    merge_revision: null,
    inner_session_id: "01HZSE0000000000000000000A",
    review_session_id: null,
    verification_run_id: VERIFICATION_RUN_ID,
    state: "SM_READY_FOR_REVIEW",
    merged_at: null,
    merged_by_caller_id: null,
    lease_token: null,
    audit_chain_predecessor_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  writeFileSync(
    join(workdir, layout.sliceMerge(SLICE_MERGE_ID)),
    JSON.stringify(sm),
    "utf8",
  );
  const vr = {
    verification_run_id: VERIFICATION_RUN_ID,
    target_id: targetId,
    target_revision: "inner-commit-1",
    commands_or_checks: ["true"],
    environment_fingerprint: "vitest",
    started_at: ISO,
    finished_at: ISO,
    result: "pass",
    failed_tests: [],
    log_ref: null,
  };
  writeFileSync(
    join(workdir, layout.verification(VERIFICATION_RUN_ID)),
    JSON.stringify(vr),
    "utf8",
  );
}

describe("Phase prod-5 — middle review approve mock smoke (default-pass)", () => {
  it("sentinel approve drives SM_READY_FOR_REVIEW → SM_MERGED + SLICE_VALIDATED", async () => {
    const handle = createE2eRun();
    try {
      const targetId = handle.target.identity.target_id;
      seedReviewing(handle.workdir, targetId);

      const store = new FsStore({ workdir: handle.workdir });
      const clock = new SystemClock();
      const ledger = new FileLedger({ store });
      const workspace = new FakeWorkspace(join(handle.agentCwd, "workspaces"));
      await workspace.prepareInnerWorkspace({
        sliceId: SLICE_ID,
        trunkBaseRevision: "trunk-base",
      });
      await workspace.commit({
        sliceId: SLICE_ID,
        message: "initial",
        files: [{ path: "src/add.ts", content: "export const add = (a:number,b:number)=>a+b;\n" }],
      });
      const verification = new FakeVerification(clock, { test: { result: "pass" } });
      const llmRunner = new AdapterRunnerPort(new StampingFakeAdapter(envelopeApprove()));

      const out = await runOneMiddleReviewTurn({
        store,
        clock,
        llmRunner,
        workspace,
        verification,
        ledger,
        callerId: "e2e-caller",
        targetId,
        environmentFingerprint: "e2e-sandbox",
        reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
      });

      expect(out.kind).toBe("turn_persisted");
      if (out.kind !== "turn_persisted") return;
      expect(out.decision.converged).toBe(true);
      expect(out.dispatch?.kind).toBe("applied");

      const sliceRaw = await store.readText(layout.slice(SLICE_ID));
      const slice = Slice.parse(JSON.parse(sliceRaw!));
      expect(slice.state).toBe("SLICE_VALIDATED");

      const smRaw = await store.readText(layout.sliceMerge(SLICE_MERGE_ID));
      const sm = SliceMerge.parse(JSON.parse(smRaw!));
      expect(sm.state).toBe("SM_MERGED");
      expect(sm.target_id).toBe(targetId);
    } finally {
      handle.cleanup();
    }
  });

  it("noop when no SLICE_REVIEWING fixture is seeded", async () => {
    const handle = createE2eRun();
    try {
      const store = new FsStore({ workdir: handle.workdir });
      const clock = new SystemClock();
      const ledger = new FileLedger({ store });
      const workspace = new FakeWorkspace(join(handle.agentCwd, "workspaces"));
      const verification = new FakeVerification(clock, { test: { result: "pass" } });
      const llmRunner = new AdapterRunnerPort(new StampingFakeAdapter(envelopeApprove()));

      const out = await runOneMiddleReviewTurn({
        store,
        clock,
        llmRunner,
        workspace,
        verification,
        ledger,
        callerId: "e2e-caller",
        targetId: handle.target.identity.target_id,
        environmentFingerprint: "e2e-sandbox",
        reverifyTestCommands: (cwd) => [{ argv: ["true"], cwd }],
      });
      expect(out.kind).toBe("noop");
    } finally {
      handle.cleanup();
    }
  });
});
