/**
 * Phase prod-4 — mock-based inner tdd_build smoke.
 *
 * Runs in default `npm test` (no LLM_TEAM_E2E gate). Exercises the
 * harness round-trip wired with the test-only stamping FakeAdapter so
 * regressions to `runInnerTddBuild` surface without the live LLM call.
 *
 * Verifies the SliceMerge SM_DRAFT → SM_READY_FOR_REVIEW transition the
 * Phase prod-4 gate calls out (planning §4 acceptance #4).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createE2eRun, runInnerTddBuild } from "../helpers/e2e-harness.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";
import { layout } from "../../src/application/persistence-layout.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import type { LlmAdapterInput, LlmAdapterResult } from "../../src/adapters/llm-runner/types.js";

const SLICE_ID = "01HZS00000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const ISO = "2026-05-09T00:00:00.000Z";

function envelopeFixture(): Record<string, unknown> {
  return {
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
    summary: "e2e mock smoke — implement add()",
    artifacts: {
      files: [
        {
          path: "src/add.ts",
          content: "export const add = (a:number,b:number)=>a+b;\n",
        },
        {
          path: "tests/add.test.ts",
          content:
            "import { add } from '../src/add';\nimport { test, expect } from 'vitest';\ntest('add', () => expect(add(1,2)).toBe(3));\n",
        },
      ],
    },
  };
}

/**
 * Stamping FakeAdapter — re-implements the inner-cycle test helper inline
 * so we don't import test-private utilities. Echoes runtime session/turn
 * ids back into the envelope so the header-echo check passes.
 */
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
      const obj = JSON.parse(body) as {
        entries?: Array<{ revision_pin?: string }>;
      };
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

function seedSliceReady(workdir: string): void {
  const slice = Slice.parse({
    slice_id: SLICE_ID,
    milestone_id: MILESTONE_ID,
    slice_kind: "internal",
    value_statement: "add() function",
    ac_ids: ["AC-1"],
    acceptance_tests: [
      { path: "tests/add.test.ts", name: "add", ac_id: "AC-1" },
    ],
    declared_scope: ["src/add.ts", "tests/add.test.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state: "SLICE_READY",
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  mkdirSync(join(workdir, "slices"), { recursive: true });
  writeFileSync(
    join(workdir, layout.slice(SLICE_ID)),
    JSON.stringify(slice),
    "utf8",
  );
}

describe("Phase prod-4 — inner tdd_build mock smoke (default-pass)", () => {
  it("forge round-trip drives SLICE_READY → SLICE_REVIEWING + SM_DRAFT → SM_READY_FOR_REVIEW", async () => {
    const handle = createE2eRun();
    try {
      seedSliceReady(handle.workdir);

      const llmRunner = new AdapterRunnerPort(
        new StampingFakeAdapter(envelopeFixture()),
      );

      const outcome = await runInnerTddBuild({ handle, llmRunner });
      expect(outcome.kind).toBe("converged");
      if (outcome.kind !== "converged") return;

      // SliceMerge ended SM_READY_FOR_REVIEW (transitively confirms SM_DRAFT
      // creation via runOneInnerTurn — there is no other constructor).
      const store = new FsStore({ workdir: handle.workdir });
      const smRaw = await store.readText(layout.sliceMerge(outcome.sliceMergeId));
      expect(smRaw).not.toBeNull();
      const sm = SliceMerge.parse(JSON.parse(smRaw!));
      expect(sm.state).toBe("SM_READY_FOR_REVIEW");
      expect(sm.slice_id).toBe(SLICE_ID);
      expect(sm.target_id).toBe("e2e-sandbox");

      // Slice transitioned to SLICE_REVIEWING.
      const sliceRaw = await store.readText(layout.slice(SLICE_ID));
      const slice = Slice.parse(JSON.parse(sliceRaw!));
      expect(slice.state).toBe("SLICE_REVIEWING");
    } finally {
      handle.cleanup();
    }
  });

  it("noop when sandbox workdir has no SLICE_READY rows", async () => {
    const handle = createE2eRun();
    try {
      const llmRunner = new AdapterRunnerPort(
        new StampingFakeAdapter(envelopeFixture()),
      );
      const outcome = await runInnerTddBuild({ handle, llmRunner });
      expect(outcome.kind).toBe("noop");
    } finally {
      handle.cleanup();
    }
  });
});
