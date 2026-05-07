/**
 * Phase 1a contract conformance.
 *
 * Asserts that the contract README's CONTRACT-CONFORMANCE matrix points at
 * implementation_surface paths that actually exist for every anchor this
 * phase is responsible for. Per the plan, each phase updates only its own
 * surface entries — this test enforces that this phase's surfaces have not
 * regressed.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");
const PERSISTENCE_LAYOUT = resolve(
  REPO_ROOT,
  "docs/architecture/persistence-layout.md",
);

/** Anchors this phase 1a is responsible for. */
const PHASE_1A_ANCHORS = ["RGC-LEDGER", "TCC-IDENTITY", "SOC-IDEMPOTENCY"];

function readReadme(): string {
  return readFileSync(README, "utf8");
}

function findRowForAnchor(readme: string, anchor: string): string {
  const re = new RegExp(`\\|\\s*\`${anchor}\`[^\n]*\\|`);
  const match = readme.match(re);
  if (!match) throw new Error(`anchor ${anchor} not found in README matrix`);
  return match[0];
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

describe("Phase 1a — contract conformance matrix", () => {
  const readme = readReadme();

  for (const anchor of PHASE_1A_ANCHORS) {
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

describe("Phase 1a — persistence layout authority", () => {
  const layout = readFileSync(PERSISTENCE_LAYOUT, "utf8");

  it("declares Milestone / Slice / SliceMerge authoritative paths", () => {
    expect(layout).toMatch(/milestones\/\s*\n\s*<milestone_id>\.json/);
    expect(layout).toMatch(/slices\/\s*\n\s*<slice_id>\.json/);
    expect(layout).toMatch(/slice_merges\/\s*\n\s*<slice_merge_id>\.json/);
  });

  it("declares the lease record path (record schema only — acquisition in phase 4)", () => {
    expect(layout).toMatch(/leases\/\s*\n\s*<lease_id>\.json/);
  });
});

describe("Phase 1a — legacy phase-model imports forbidden", () => {
  const fg = require("node:fs");
  const path = require("node:path");

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of fg.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fg.statSync(full);
      if (stat.isDirectory()) out.push(...walk(full));
      else if (full.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("no src/ file imports from docs/history/legacy-phase-model/", () => {
    const tsFiles = walk(resolve(REPO_ROOT, "src"));
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const body = readFileSync(file, "utf8");
      if (/legacy-phase-model/.test(body)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Phase 1a — ledger row schema includes target_id (TCC-IDENTITY)", () => {
  it("schema file mentions target_id as required", () => {
    const body = readFileSync(
      resolve(REPO_ROOT, "src/domain/schema/ledger.ts"),
      "utf8",
    );
    expect(body).toMatch(/target_id:\s*z\.string\(\)\.min\(1\)/);
    expect(body).toMatch(/audit_hash:\s*z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{64\}\$\//);
    expect(body).toMatch(
      /audit_hash_prev:\s*z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{64\}\$\//,
    );
  });
});
