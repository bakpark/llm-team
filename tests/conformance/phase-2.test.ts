/**
 * Phase 2 contract conformance.
 *
 * Asserts that:
 *   1. The contract README's CONTRACT-CONFORMANCE matrix points at TS
 *      surfaces that exist for every anchor this phase is responsible for.
 *   2. The phase-2 modules expose the documented public functions / types.
 *   3. The TurnWorker assembles the inner-cycle 6-step flow without
 *      drifting from the architecture mapping.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_2_ANCHORS = [
  "AGC-PROMPT-SERIALIZATION",
  "AGC-WORKSPACE",
  "SOC-SLICE-LIFECYCLE",
  "SOC-SLICE-MERGE",
  "RGC-VERIFICATION",
  "ARC-CALL-SEMANTICS",
  "ARC-PORT-SIGNATURE",
  "ARC-ADAPTER-PROMPT-CONTRACT",
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

describe("Phase 2 — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_2_ANCHORS) {
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

describe("Phase 2 — module surface contract", () => {
  it("WorkspacePort exposes prepareInnerWorkspace / commit / head", async () => {
    const mod = await import("../../src/ports/workspace.js");
    // The port is an interface; we instead probe the fake adapter to enforce
    // shape via a structural duck-typed assertion.
    const { FakeWorkspace } = await import(
      "../../src/adapters/workspace/fake.js"
    );
    const fw = new FakeWorkspace("/tmp/never");
    expect(typeof fw.prepareInnerWorkspace).toBe("function");
    expect(typeof fw.commit).toBe("function");
    expect(typeof fw.head).toBe("function");
    void mod;
  });

  it("VerificationPort surface — runBuild / runTest / runLint / runMetric", async () => {
    const { ShellVerification } = await import(
      "../../src/adapters/verification/shell.js"
    );
    const { FixedClock } = await import("../../src/ports/clock.js");
    const v = new ShellVerification({ clock: new FixedClock(0) });
    for (const fn of ["runBuild", "runTest", "runLint", "runMetric"] as const) {
      expect(typeof (v as unknown as Record<string, unknown>)[fn]).toBe(
        "function",
      );
    }
  });

  it("agent-io.callAgent is a function (single seam consumer)", async () => {
    const mod = await import("../../src/application/agent-io.js");
    expect(typeof mod.callAgent).toBe("function");
  });

  it("turn-worker.runOneInnerTurn is a function", async () => {
    const mod = await import("../../src/application/turn-worker.js");
    expect(typeof mod.runOneInnerTurn).toBe("function");
  });

  it("verification-runner.runInnerVerification is a function", async () => {
    const mod = await import("../../src/application/verification-runner.js");
    expect(typeof mod.runInnerVerification).toBe("function");
  });

  it("ready-object.pickReadyInnerTurn is a function", async () => {
    const mod = await import("../../src/application/ready-object.js");
    expect(typeof mod.pickReadyInnerTurn).toBe("function");
  });

  it("session-turn-persist.persistSessionTurn is a function", async () => {
    const mod = await import("../../src/application/session-turn-persist.js");
    expect(typeof mod.persistSessionTurn).toBe("function");
  });

  it("CLI runner exports runnerMain (tsx entrypoint)", async () => {
    const mod = await import("../../src/cli/runner.js");
    expect(typeof mod.runnerMain).toBe("function");
  });
});

describe("Phase 2 — turn-worker outcome enum", () => {
  it("documented outcomes are noop / converged / verification_failed / invalid_envelope", async () => {
    // Source-level regression gate: keep the kind union in sync. We grep the
    // module body so a future refactor that drops a kind without updating
    // this list trips the test.
    const body = readFileSync(
      resolve(REPO_ROOT, "src/application/turn-worker.ts"),
      "utf8",
    );
    for (const kind of [
      `kind: "noop"`,
      `kind: "converged"`,
      `kind: "verification_failed"`,
      `kind: "invalid_envelope"`,
    ]) {
      expect(body).toContain(kind);
    }
  });
});
