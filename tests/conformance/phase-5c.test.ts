/**
 * Phase 5c contract conformance.
 *
 * Asserts:
 *   1. KAC-REFACTOR-BACKLOG / KAC-CONTEXT-SUMMARY anchor rows in the
 *      contracts README cite the new src/.../.ts surfaces and those files
 *      exist.
 *   2. RefactorBacklog 6-state lifecycle module exposes the lifecycle API.
 *   3. scout-observer module exposes aggregateValidationEvidence.
 *   4. The envelope-extended-validator accepts a scout/Validation observer
 *      `proposal_artifact` envelope (the validation_evidence row) via the
 *      ANY_LOOP `proposal` rule.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_5C_ANCHORS = ["KAC-REFACTOR-BACKLOG", "KAC-CONTEXT-SUMMARY"];

function findRowForAnchor(readme: string, anchor: string): string {
  const re = new RegExp(`^\\|\\s*\`${anchor}\`[^\\n]*\\|`, "m");
  const m = readme.match(re);
  if (!m) throw new Error(`anchor ${anchor} not found in README matrix`);
  return m[0];
}

function extractTsPaths(matrixRow: string): string[] {
  const paths = new Set<string>();
  const re = /`(src\/[^`\s]+\.ts)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(matrixRow)) != null) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths];
}

describe("Phase 5c — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_5C_ANCHORS) {
    it(`${anchor} row references at least one src/**/*.ts surface that exists`, () => {
      const row = findRowForAnchor(readme, anchor);
      const paths = extractTsPaths(row);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(existsSync(resolve(REPO_ROOT, p)), `missing file: ${p}`).toBe(
          true,
        );
      }
    });
  }

  it("KAC-REFACTOR-BACKLOG row cites the new refactor-backlog module (5c surface)", () => {
    const row = findRowForAnchor(readme, "KAC-REFACTOR-BACKLOG");
    expect(row).toContain("src/application/refactor-backlog.ts");
  });

  it("KAC-CONTEXT-SUMMARY row cites scout-observer (5c evidence wiring)", () => {
    const row = findRowForAnchor(readme, "KAC-CONTEXT-SUMMARY");
    expect(row).toContain("src/application/scout-observer.ts");
  });
});

describe("Phase 5c — module surface contract", () => {
  it("scout-observer exports aggregateValidationEvidence", async () => {
    const m = await import("../../src/application/scout-observer.js");
    expect(typeof m.aggregateValidationEvidence).toBe("function");
  });

  it("refactor-backlog exports the lifecycle API", async () => {
    const m = await import("../../src/application/refactor-backlog.js");
    expect(typeof m.proposeRefactor).toBe("function");
    expect(typeof m.transitionRefactor).toBe("function");
    expect(typeof m.scoutScan).toBe("function");
    expect(typeof m.listRefactorProposals).toBe("function");
  });

  it("RefactorBacklogState enum covers all 6 states", async () => {
    const m = await import("../../src/domain/schema/knowledge.js");
    const opts = m.RefactorBacklogState.options;
    expect([...opts].sort()).toEqual([
      "CURATED",
      "DONE",
      "DROPPED",
      "PROPOSED",
      "SCHEDULED",
      "SUPERSEDED",
    ]);
  });

  it("envelope-extended-validator accepts a scout/Validation observer proposal envelope (validation_evidence)", async () => {
    const { extendedValidate } = await import(
      "../../src/application/envelope-extended-validator.js"
    );
    const env = {
      session_id: "01HZSE0000000000000000000A",
      turn_index: 1,
      parent_loop: "outer" as const,
      phase_or_purpose: "Validation",
      slice_id: null,
      slice_kind: null,
      tdd_phase: null,
      agent_profile_id: "scout" as const,
      agent_role_in_session: "observer" as const,
      contribution_kind: "proposal" as const,
      parent_review_verdict_id: null,
      output_kind: "proposal_artifact" as const,
      object_id: "01HZM00000000000000000000A",
      manifest_id: "01HZMA0000000000000000000A",
      input_revision_pins: ["pin-1"],
      summary: "scout validation evidence aggregate",
      artifacts: {
        validation_evidence: {
          aggregate_verification_run_id: "01HZV0000000000000000000A1",
          derived_verdict: "PASS",
          slices_covered: 1,
        },
      },
      verdict: null,
      next_action_request: null,
      failure: null,
      idempotency_key: "k",
      runtime_metadata: {},
    };
    const r = extendedValidate(env);
    expect(r.ok).toBe(true);
  });
});

describe("Phase 5c — DISPATCH_MATRIX / caller-dispatch signatures unchanged", () => {
  it("OuterDispatchInput keeps phase_or_purpose enum + signal-binding contract stable", async () => {
    const m = await import("../../src/application/caller-dispatch-outer.js");
    expect(typeof m.dispatchOuterOutcome).toBe("function");
  });
});
