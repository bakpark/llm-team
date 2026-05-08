/**
 * Phase 5b.2 contract conformance.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_5B2_ANCHORS = ["SOC-OPERATIONS", "RGC-HUMAN-CONTRIBUTION"];

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

describe("Phase 5b.2 — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_5B2_ANCHORS) {
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

  it("SOC-OPERATIONS row cites outer-session + human-signal-binding (5b.2 surfaces)", () => {
    const row = findRowForAnchor(readme, "SOC-OPERATIONS");
    expect(row).toContain("src/application/outer-session.ts");
    expect(row).toContain("src/application/human-signal-binding.ts");
  });
});

describe("Phase 5b.2 — module surface contract", () => {
  it("outer-session exports openOuterSession + pickReadyOuterSession + helpers", async () => {
    const m = await import("../../src/application/outer-session.js");
    expect(typeof m.openOuterSession).toBe("function");
    expect(typeof m.pickReadyOuterSession).toBe("function");
    expect(typeof m.outerPhaseForState).toBe("function");
    expect(typeof m.defaultParticipants).toBe("function");
    expect(typeof m.defaultTermination).toBe("function");
  });

  it("human-signal-binding exports bindHumanSignalToSession", async () => {
    const m = await import("../../src/application/human-signal-binding.js");
    expect(typeof m.bindHumanSignalToSession).toBe("function");
  });

  it("human-signal-drain accepts optional binding deps", async () => {
    const m = await import("../../src/application/human-signal-drain.js");
    expect(typeof m.runHumanSignalDrain).toBe("function");
    expect(typeof m.dropSignal).toBe("function");
  });

  it("Discovery/Specification participants include human (TCC-LOOP-POLICIES default)", async () => {
    const { defaultParticipants } = await import(
      "../../src/application/outer-session.js"
    );
    for (const phase of ["Discovery", "Specification"] as const) {
      const p = defaultParticipants(phase);
      expect(p.some((x) => x.agent_profile_id === "human")).toBe(true);
    }
  });

  it("Validation termination requires verification_green evidence", async () => {
    const { defaultTermination } = await import(
      "../../src/application/outer-session.js"
    );
    const t = defaultTermination("Validation");
    expect(t.composite_rule).toBe("evidence_only");
    expect(t.required_evidence[0]?.kind).toBe("verification_green");
  });
});
