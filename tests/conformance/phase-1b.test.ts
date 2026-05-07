/**
 * Phase 1b contract conformance.
 *
 * Asserts that:
 * 1. The contract README's CONTRACT-CONFORMANCE matrix points at TS surfaces
 *    that exist for every anchor this phase is responsible for.
 * 2. The schema enums (AGC-OUTPUT.output_kind, AGC-CONTRIBUTION.contribution_kind,
 *    AGC-CONTEXT-MANIFEST.fetch_scope, SOC-SESSION-LIFECYCLE.SessionState)
 *    contain exactly the enum literals enumerated in the contract markdown.
 *    Drift in either direction is a contract↔code mismatch.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ContributionKind, OutputKind } from "../../src/domain/schema/contribution.js";
import { SessionState } from "../../src/domain/schema/dialogue-session.js";
import { FetchScope } from "../../src/domain/schema/manifest.js";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");
const AGENT_CONTRACT = resolve(
  REPO_ROOT,
  "docs/contracts/agent-and-context-contract.md",
);
const SOC_CONTRACT = resolve(
  REPO_ROOT,
  "docs/contracts/state-and-operation-contract.md",
);

const PHASE_1B_ANCHORS = [
  "AGC-CONTRIBUTION",
  "AGC-CONTEXT-MANIFEST",
  "AGC-OUTPUT",
  "AGC-OUTPUT-RUNTIME-ENRICH",
  "AGC-CONTRIBUTION-OUTPUTS",
  "AGC-INVALID",
  "SOC-SESSION-LIFECYCLE",
  "SOC-SESSION-TERMINATION",
  "RGC-VERIFICATION",
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

describe("Phase 1b — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_1B_ANCHORS) {
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

/**
 * Extract a slash-separated enum list from a markdown table row whose
 * third column matches `<value> / <value> / ... 중 하나` style.
 * Returns the list of values (with surrounding backticks stripped).
 */
function extractEnumFromRow(rowText: string): string[] {
  const cols = rowText.split("|").map((c) => c.trim());
  // typical table row layout: ['', field, 'yes', body, '']
  const body = cols[3] ?? "";
  // values are wrapped in backticks: `lead_draft` / `review_verdict` / ...
  const out = new Set<string>();
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) != null) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/**
 * Extract the AGC-OUTPUT section (between its anchor and the next anchor) so
 * we can locate the canonical envelope-field rows without hitting the
 * `AGC-CONTRIBUTION` table-header row earlier in the file.
 */
function agcOutputSection(contract: string): string {
  const re = /<a id="AGC-OUTPUT"><\/a>[\s\S]*?(?=<a id="AGC-OUTPUT-RUNTIME-ENRICH">)/;
  const m = contract.match(re);
  if (!m) throw new Error("AGC-OUTPUT section not found");
  return m[0];
}

function findEnvelopeRow(section: string, field: string): string {
  // Envelope rows have shape: `| \`<field>\` | (yes|conditional|caller-enriched yes) | <body> |`
  const re = new RegExp(
    `\\|\\s*\`${field}\`\\s*\\|\\s*(?:yes|conditional|caller-enriched yes)\\s*\\|[^\\n]+`,
  );
  const m = section.match(re);
  if (!m) throw new Error(`envelope row for ${field} not found in AGC-OUTPUT`);
  return m[0];
}

describe("Phase 1b — AGC-OUTPUT envelope enum sync (schema ↔ contract)", () => {
  const contract = readFileSync(AGENT_CONTRACT, "utf8");
  const section = agcOutputSection(contract);

  it("contribution_kind enum matches contract", () => {
    const row = findEnvelopeRow(section, "contribution_kind");
    const fields = extractEnumFromRow(row).filter(
      (v) => !v.startsWith("#") && !v.startsWith("docs/"),
    );
    const expected = [
      "lead_draft",
      "review_verdict",
      "human_approval",
      "session_outcome",
      "proposal",
    ];
    for (const v of expected) {
      expect(fields, `contribution_kind missing literal ${v}`).toContain(v);
    }
    expect(new Set(ContributionKind.options)).toEqual(new Set(expected));
  });

  it("output_kind enum matches contract", () => {
    const row = findEnvelopeRow(section, "output_kind");
    const fields = extractEnumFromRow(row).filter(
      (v) => !v.startsWith("#") && !v.startsWith("docs/"),
    );
    const expected = [
      "spec_proposal",
      "task_plan",
      "slice_decomposition",
      "patch",
      "verdict",
      "milestone_package",
      "proposal_artifact",
      "failure",
    ];
    for (const v of expected) {
      expect(fields, `output_kind missing literal ${v}`).toContain(v);
    }
    expect(new Set(OutputKind.options)).toEqual(new Set(expected));
  });
});

describe("Phase 1b — AGC-CONTEXT-MANIFEST fetch_scope enum sync", () => {
  it("FetchScope schema enum matches the contract enum table", () => {
    const contract = readFileSync(AGENT_CONTRACT, "utf8");
    // Contract Fetch Scope table rows:
    //   | `metadata` | ... | `body` | ... | `tree` | ... | `body+comments` | ... | `body+turn_log` | ...
    const expected = ["metadata", "body", "tree", "body+comments", "body+turn_log"];
    for (const v of expected) {
      // Each value appears wrapped in backticks in the table
      expect(contract).toContain(`\`${v}\``);
    }
    expect(new Set(FetchScope.options)).toEqual(new Set(expected));
  });
});

describe("Phase 1b — SOC-SESSION-LIFECYCLE state enum sync", () => {
  it("SessionState schema matches the 5-state contract enumeration", () => {
    const soc = readFileSync(SOC_CONTRACT, "utf8");
    for (const s of [
      "SESSION_OPEN",
      "CONVERGED",
      "TIMEOUT",
      "ABANDONED",
      "AWAITING_REVALIDATION",
    ]) {
      expect(soc).toContain(s);
    }
    expect(new Set(SessionState.options)).toEqual(
      new Set([
        "SESSION_OPEN",
        "CONVERGED",
        "TIMEOUT",
        "ABANDONED",
        "AWAITING_REVALIDATION",
      ]),
    );
  });
});

describe("Phase 1b — agent envelope module forbids legacy field names", () => {
  it("src/application/envelope.ts lists agent_role / operation / phase_run_id as legacy", () => {
    const body = readFileSync(
      resolve(REPO_ROOT, "src/application/envelope.ts"),
      "utf8",
    );
    expect(body).toContain("agent_role");
    expect(body).toContain("operation");
    expect(body).toContain("phase_run_id");
  });
});
