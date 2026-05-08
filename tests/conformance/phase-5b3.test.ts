/**
 * Phase 5b.3 contract conformance.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_5B3_ANCHORS = ["SOC-OPERATIONS", "RGC-HUMAN-CONTRIBUTION"];

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

describe("Phase 5b.3 — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_5B3_ANCHORS) {
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

  it("SOC-OPERATIONS row cites outer-turn + outer-coordinator daemon (5b.3 surfaces)", () => {
    const row = findRowForAnchor(readme, "SOC-OPERATIONS");
    expect(row).toContain("src/application/outer-turn.ts");
    expect(row).toContain("src/cli/daemon.ts");
    expect(row).toContain("outer-coordinator");
  });
});

describe("Phase 5b.3 — module surface contract", () => {
  it("outer-turn exports runOneOuterTurn", async () => {
    const m = await import("../../src/application/outer-turn.js");
    expect(typeof m.runOneOuterTurn).toBe("function");
  });

  it("dispatch-matrix lookup covers each outer phase × CONVERGED verdict", async () => {
    const { lookupDispatch } = await import(
      "../../src/domain/dispatch-matrix.js"
    );
    // Spot-check the new phase-5b.3 dispatch keys runOneOuterTurn relies on.
    expect(
      lookupDispatch({
        parent_loop: "outer",
        phase_or_purpose: "Discovery",
        session_state: "CONVERGED",
        final_verdict: "spec_accept",
      }),
    ).not.toBeNull();
    expect(
      lookupDispatch({
        parent_loop: "outer",
        phase_or_purpose: "Validation",
        session_state: "CONVERGED",
        final_verdict: "validation_pass",
      }),
    ).not.toBeNull();
  });

  it("envelope matrix accepts outer reviewer review_verdict envelopes", async () => {
    const { extendedValidate } = await import(
      "../../src/application/envelope-extended-validator.js"
    );
    const base = {
      session_id: "01HZSE0000000000000000000A",
      turn_index: 1,
      parent_loop: "outer" as const,
      slice_id: null,
      slice_kind: null,
      tdd_phase: null,
      agent_profile_id: "sentinel" as const,
      agent_role_in_session: "reviewer" as const,
      contribution_kind: "review_verdict" as const,
      parent_review_verdict_id: null,
      output_kind: "verdict" as const,
      object_id: "01HZM00000000000000000000A",
      manifest_id: "01HZMA0000000000000000000A",
      input_revision_pins: ["pin-1"],
      summary: "reviewer verdict",
      artifacts: null,
      next_action_request: null,
      failure: null,
      idempotency_key: "k",
      runtime_metadata: {},
    };
    for (const [phase, verdicts] of [
      ["Discovery", ["spec_accept", "spec_reject", "request_changes"]],
      ["Specification", ["spec_accept", "spec_reject", "request_changes"]],
      ["Planning", ["plan_accept", "request_changes"]],
    ] as const) {
      for (const v of verdicts) {
        const r = extendedValidate({
          ...base,
          phase_or_purpose: phase,
          verdict: { result: v, rationale: null },
        });
        expect(r.ok, `${phase}/${v} matrix lookup`).toBe(true);
      }
    }
  });
});
