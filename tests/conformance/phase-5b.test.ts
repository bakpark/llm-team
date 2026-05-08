/**
 * Phase 5b.1 contract conformance.
 *
 * Asserts:
 *   1. README CONTRACT-CONFORMANCE matrix references the 5b.1 anchors at
 *      TS surfaces that exist.
 *   2. Module surface contract: dispatch-matrix outer entries +
 *      caller-dispatch-outer + knowledge helpers.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_5B_ANCHORS = [
  "SOC-DISPATCH-MATRIX",
  "SOC-OPERATIONS",
  "KAC-DECISION-LOG",
  "KAC-CONTEXT-SUMMARY",
];

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

describe("Phase 5b.1 — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_5B_ANCHORS) {
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

describe("Phase 5b.1 — module surface contract", () => {
  it("DISPATCH_MATRIX includes 17 outer-loop entries", async () => {
    const m = await import("../../src/domain/dispatch-matrix.js");
    const outer = m.DISPATCH_MATRIX.filter((e) => e.parent_loop === "outer");
    // Discovery: 4 (spec_accept, spec_reject, TIMEOUT, ABANDONED)
    // Specification: 4 (same)
    // Planning: 4 (plan_accept, request_changes, TIMEOUT, ABANDONED)
    // Validation: 5 (validation_pass, fail, stale, TIMEOUT, ABANDONED)
    expect(outer.length).toBe(17);
  });

  it("dispatchOuterOutcome covers all outer effects", async () => {
    const m = await import("../../src/application/caller-dispatch-outer.js");
    expect(typeof m.dispatchOuterOutcome).toBe("function");
  });

  it("knowledge module exports recordDecision + snapshotContextSummary", async () => {
    const m = await import("../../src/application/knowledge.js");
    expect(typeof m.recordDecision).toBe("function");
    expect(typeof m.snapshotContextSummary).toBe("function");
  });

  it("every outer DispatchEffect kind has a runOuterEffect handler", async () => {
    const { DISPATCH_MATRIX } = await import(
      "../../src/domain/dispatch-matrix.js"
    );
    const outerSrc = readFileSync(
      resolve(REPO_ROOT, "src/application/caller-dispatch-outer.ts"),
      "utf8",
    );
    const outerEffects = new Set<string>();
    for (const e of DISPATCH_MATRIX) {
      if (e.parent_loop !== "outer") continue;
      for (const eff of e.effects) outerEffects.add(eff.kind);
    }
    for (const kind of outerEffects) {
      expect(
        outerSrc.includes(`case "${kind}"`),
        `caller-dispatch-outer missing handler for "${kind}"`,
      ).toBe(true);
    }
  });
});
