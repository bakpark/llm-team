/**
 * Phase 3 contract conformance.
 *
 * Asserts that:
 *   1. The contract README's CONTRACT-CONFORMANCE matrix points at TS
 *      surfaces that exist for every anchor this phase advances.
 *   2. The phase-3 modules expose the documented public functions / types.
 *   3. The DISPATCH_MATRIX has an entry for every (loop, purpose, state,
 *      verdict) tuple phase 3 promises in `caller-dispatch`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_3_ANCHORS = [
  "SOC-DISPATCH-MATRIX",
  "SOC-OPERATIONS",
  "SOC-MERGE-POLICY",
  "KAC-TURN-LOG-COMPACTION",
];

function findRowForAnchor(readme: string, anchor: string): string {
  const re = new RegExp(`\\|\\s*\`${anchor}\`[^\n]*\\|`);
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

describe("Phase 3 — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_3_ANCHORS) {
    it(`${anchor} row references at least one src/**/*.ts surface that exists`, () => {
      const row = findRowForAnchor(readme, anchor);
      const paths = extractTsPaths(row);
      expect(
        paths.length,
        `${anchor} matrix row should cite at least one TS path`,
      ).toBeGreaterThan(0);
      for (const p of paths) {
        expect(existsSync(resolve(REPO_ROOT, p)), `missing file: ${p}`).toBe(
          true,
        );
      }
    });
  }
});

describe("Phase 3 — module surface contract", () => {
  it("dialogue-coordinator exports runOneMiddleReviewTurn + pickReadyMiddleReview", async () => {
    const mod = await import("../../src/application/dialogue-coordinator.js");
    expect(typeof mod.runOneMiddleReviewTurn).toBe("function");
    expect(typeof mod.pickReadyMiddleReview).toBe("function");
  });

  it("termination-evaluator exports evaluateTermination as a pure fn", async () => {
    const mod = await import("../../src/application/termination-evaluator.js");
    expect(typeof mod.evaluateTermination).toBe("function");
  });

  it("caller-dispatch exports dispatchOutcome", async () => {
    const mod = await import("../../src/application/caller-dispatch.js");
    expect(typeof mod.dispatchOutcome).toBe("function");
  });

  it("slice-merge exports promote / integrate / closeRequestChanges / closeBlocked", async () => {
    const mod = await import("../../src/application/slice-merge.js");
    expect(typeof mod.promoteSliceMergeToApproved).toBe("function");
    expect(typeof mod.integrateSliceMerge).toBe("function");
    expect(typeof mod.closeSliceMergeRequestChanges).toBe("function");
    expect(typeof mod.closeSliceMergeBlocked).toBe("function");
  });

  it("agent-workspace exports prepareAgentWorkspace", async () => {
    const mod = await import("../../src/application/agent-workspace.js");
    expect(typeof mod.prepareAgentWorkspace).toBe("function");
  });

  it("turn-log-compaction exports shouldCompactTurnLog", async () => {
    const mod = await import("../../src/application/turn-log-compaction.js");
    expect(typeof mod.shouldCompactTurnLog).toBe("function");
  });

  it("dispatch-matrix exports DISPATCH_MATRIX + lookupDispatch", async () => {
    const mod = await import("../../src/domain/dispatch-matrix.js");
    expect(Array.isArray(mod.DISPATCH_MATRIX)).toBe(true);
    expect(typeof mod.lookupDispatch).toBe("function");
  });
});

describe("Phase 3 — DISPATCH_MATRIX phase-3 coverage", () => {
  it("contains all five (loop, purpose, state, verdict) entries phase 3 promises", async () => {
    const { DISPATCH_MATRIX } = await import("../../src/domain/dispatch-matrix.js");
    const promised: Array<[string, string, string, string | null]> = [
      ["inner", "tdd_build", "CONVERGED", "tests_green"],
      ["inner", "tdd_build", "TIMEOUT", null],
      ["inner", "tdd_build", "ABANDONED", null],
      ["middle", "review", "CONVERGED", "approve"],
      ["middle", "review", "CONVERGED", "request_changes"],
    ];
    for (const [pl, pp, st, fv] of promised) {
      const found = DISPATCH_MATRIX.some(
        (e) =>
          e.parent_loop === pl &&
          e.phase_or_purpose === pp &&
          e.session_state === st &&
          e.final_verdict === fv,
      );
      expect(found, `missing matrix entry for (${pl}, ${pp}, ${st}, ${fv ?? "<null>"})`).toBe(true);
    }
  });
});
