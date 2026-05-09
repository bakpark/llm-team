/**
 * Phase 9c contract conformance — TCC-ENFORCEMENT call-site audit (G4-5).
 *
 * Anchors:
 *   - TCC-ENFORCEMENT (matrix row references the audit appendix + records the
 *     only currently wired call-site).
 *   - TCC-ENFORCEMENT-AUDIT (new appendix; call-site matrix lives here).
 *
 * Scope: this phase audits — it does not wire additional call-sites.
 * The conformance bar therefore is:
 *   1. Stage 5 default behavior (every documented stage_graded invariant
 *      resolves to `block` at Stage 5; warn at Stage <5).
 *   2. README references the audit anchor + lists `actor_team_membership_unreachable`
 *      as the wired call-site under the TCC-ENFORCEMENT row.
 *   3. The audit appendix exists and enumerates every stage_graded invariant
 *      from `target-config-contract.md` defaults.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");
const TCC = resolve(REPO_ROOT, "docs/contracts/target-config-contract.md");

/**
 * Mirrors `target.invariant_enforcement.stage_graded` defaults from
 * `target-config-contract.md#TCC-ENFORCEMENT` (Default block).
 */
const DEFAULT_STAGE_GRADED = [
  "dual_slot_fairness",
  "telemetry_enrichment_missing",
  "turn_log_compaction_delay",
  "refactor_metric_missing",
  "required_evidence_unmet",
  // Inv #5 (phase 9a) — defaults to block but lives in stage_graded.
  "actor_team_membership_unreachable",
  // scope_violation is referenced as stage_graded in the AGC-WORKSPACE row.
  "scope_violation",
  // fairness_violation is referenced as stage_graded in the RGC-FAIRNESS row.
  "fairness_violation",
] as const;

describe("Phase 9c — TCC-ENFORCEMENT Stage 5 default behavior", () => {
  it("every documented stage_graded invariant resolves to block at Stage 5", async () => {
    const { resolveEnforcementLevel } = await import(
      "../../src/application/invariant-enforcement.js"
    );
    // All warn at config time — Stage 5 must promote them all to block.
    const cfg = {
      always_hard: [],
      stage_graded: Object.fromEntries(
        DEFAULT_STAGE_GRADED.map((name) => [name, "warn" as const]),
      ),
    };
    for (const name of DEFAULT_STAGE_GRADED) {
      expect(
        resolveEnforcementLevel(cfg, name, 5),
        `Stage 5 must force ${name} to block`,
      ).toBe("block");
    }
  });

  it("stage_graded warn entries remain warn at Stage <5", async () => {
    const { resolveEnforcementLevel } = await import(
      "../../src/application/invariant-enforcement.js"
    );
    const cfg = {
      always_hard: [],
      stage_graded: { dual_slot_fairness: "warn" as const },
    };
    expect(resolveEnforcementLevel(cfg, "dual_slot_fairness", 2)).toBe("warn");
    expect(resolveEnforcementLevel(cfg, "dual_slot_fairness", 3)).toBe("warn");
    expect(resolveEnforcementLevel(cfg, "dual_slot_fairness", 4)).toBe("warn");
    expect(resolveEnforcementLevel(cfg, "dual_slot_fairness", 5)).toBe("block");
  });

  it("Stage 5 default-block applies even to unwired invariants (fail closed)", async () => {
    const { resolveEnforcementLevel } = await import(
      "../../src/application/invariant-enforcement.js"
    );
    // When a call-site is *not* yet routed through resolveEnforcementLevel,
    // the safety net comes from (a) the function defaulting stage=5 and
    // (b) unknown invariants returning block. Both must hold.
    expect(resolveEnforcementLevel(undefined, "any_unwired_name")).toBe(
      "block",
    );
    expect(resolveEnforcementLevel(null, "any_unwired_name", 5)).toBe("block");
  });
});

describe("Phase 9c — README audit appendix references", () => {
  const readme = readFileSync(README, "utf8");
  const tcc = readFileSync(TCC, "utf8");

  it("README contains the TCC-ENFORCEMENT-AUDIT anchor", () => {
    expect(readme).toContain('<a id="TCC-ENFORCEMENT-AUDIT"></a>');
    expect(readme).toContain("TCC-ENFORCEMENT-AUDIT: Call-site Matrix");
  });

  it("TCC-ENFORCEMENT row references the audit appendix + the wired call-site", () => {
    const re = /^\|\s*`TCC-ENFORCEMENT`[^\n]*\|/m;
    const match = readme.match(re);
    expect(match, "TCC-ENFORCEMENT row missing").not.toBeNull();
    const row = match![0];
    // Audit anchor link.
    expect(row).toContain("TCC-ENFORCEMENT-AUDIT");
    // Wired call-site (phase 9a).
    expect(row).toContain("src/cli/daemon.ts");
    expect(row).toContain("actor_team_membership_unreachable");
  });

  it("audit appendix enumerates every stage_graded invariant from the contract default", () => {
    // Slice out the appendix section so we don't accidentally match the row
    // in the conformance matrix above.
    const start = readme.indexOf('<a id="TCC-ENFORCEMENT-AUDIT"></a>');
    expect(start).toBeGreaterThan(-1);
    const appendix = readme.slice(start);
    for (const name of DEFAULT_STAGE_GRADED) {
      expect(appendix, `audit appendix missing row for ${name}`).toContain(
        name,
      );
    }
  });

  it("target-config-contract links to the call-site audit appendix", () => {
    expect(tcc).toContain("TCC-ENFORCEMENT-AUDIT");
  });
});
