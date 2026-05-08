/**
 * Phase 5a contract conformance.
 *
 * Asserts:
 *   1. The README CONTRACT-CONFORMANCE matrix references each phase-5a anchor
 *      at a TS surface that exists.
 *   2. The phase-5a modules expose the documented public functions / types.
 *   3. The InternalEscalationRules schema parses with no input (defaults all
 *      6 rules to enabled), reflecting the contract's "default-on" guarantee.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_5A_ANCHORS = [
  "SOC-INTAKE",
  "SOC-SLICE-DEPENDENCIES",
  "SOC-SLICE-CLASS",
  "RGC-SIGNALS",
  "RGC-HUMAN-CONTRIBUTION",
  "KAC-DECISION-LOG",
  "KAC-CONTEXT-SUMMARY",
  "KAC-REFACTOR-BACKLOG",
  "KAC-SLICE-TELEMETRY",
  "TCC-SLICE-CLASS-RULES",
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

describe("Phase 5a — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_5A_ANCHORS) {
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

describe("Phase 5a — module surface contract", () => {
  it("knowledge schema exports DecisionEntry / ContextSummary / RefactorBacklogItem / SliceTelemetry", async () => {
    const m = await import("../../src/domain/schema/knowledge.js");
    expect(typeof m.DecisionEntry.parse).toBe("function");
    expect(typeof m.ContextSummary.parse).toBe("function");
    expect(typeof m.RefactorBacklogItem.parse).toBe("function");
    expect(typeof m.SliceTelemetry.parse).toBe("function");
    expect(m.DecisionKind.options.length).toBe(6);
    expect(m.RefactorBacklogState.options.length).toBe(6);
  });

  it("human-signal schema exports HumanSignalEnvelope + HumanSignalRecord", async () => {
    const m = await import("../../src/domain/schema/human-signal.js");
    expect(typeof m.HumanSignalEnvelope.parse).toBe("function");
    expect(typeof m.HumanSignalRecord.parse).toBe("function");
    expect(m.SignalType.options.length).toBe(11);
  });

  it("feature-request schema exports FeatureRequest 4-state (incl. promoting per PR#65 P1-3)", async () => {
    const m = await import("../../src/domain/schema/feature-request.js");
    expect(typeof m.FeatureRequest.parse).toBe("function");
    expect(m.FeatureRequestState.options).toEqual([
      "queued",
      "promoting",
      "promoted",
      "rejected",
    ]);
  });

  it("feature-request-intake exports runFeatureRequestIntake", async () => {
    const m = await import(
      "../../src/application/feature-request-intake.js"
    );
    expect(typeof m.runFeatureRequestIntake).toBe("function");
  });

  it("human-signal port + adapter + drain exports", async () => {
    const port = await import("../../src/ports/human-signal.js");
    void port; // type-only
    const adapter = await import("../../src/adapters/human-signal/fs.js");
    expect(typeof adapter.FsHumanSignal).toBe("function");
    const drain = await import("../../src/application/human-signal-drain.js");
    expect(typeof drain.runHumanSignalDrain).toBe("function");
    expect(typeof drain.dropSignal).toBe("function");
  });

  it("slice-dag exports validateSliceDag + topologicalOrder + computeReadySlices", async () => {
    const m = await import("../../src/application/slice-dag.js");
    expect(typeof m.validateSliceDag).toBe("function");
    expect(typeof m.topologicalOrder).toBe("function");
    expect(typeof m.computeReadySlices).toBe("function");
  });

  it("slice-class exports classifySlice", async () => {
    const m = await import("../../src/application/slice-class.js");
    expect(typeof m.classifySlice).toBe("function");
  });

  it("target-schema exports InternalEscalationRules with default-on 6 rules", async () => {
    const m = await import("../../src/config/target-schema.js");
    const defaults = m.InternalEscalationRules.parse({});
    expect(defaults.interface_break.enabled).toBe(true);
    expect(defaults.schema_or_migration_change.enabled).toBe(true);
    expect(defaults.security_sensitive_path.enabled).toBe(true);
    expect(defaults.perf_critical_path.enabled).toBe(true);
    expect(defaults.existing_test_coverage_below_threshold.enabled).toBe(true);
    expect(defaults.metric_runner_unavailable.enabled).toBe(true);
  });

  it("persistence-layout exposes phase-5a paths", async () => {
    const { layout } = await import(
      "../../src/application/persistence-layout.js"
    );
    expect(typeof layout.sliceTelemetry).toBe("function");
    expect(typeof layout.featureRequest).toBe("function");
    expect(typeof layout.humanSignal).toBe("function");
    expect(typeof layout.humanSignalProcessed).toBe("function");
    expect(typeof layout.release).toBe("function");
  });
});
