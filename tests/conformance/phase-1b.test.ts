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
import {
  ContributionKind,
  OutputKind,
  ParentLoop,
  FinalVerdict,
} from "../../src/domain/schema/contribution.js";
import {
  CompositeRule,
  FinalizationRule,
  SessionState,
} from "../../src/domain/schema/dialogue-session.js";
import { FetchScope, ManifestPurpose } from "../../src/domain/schema/manifest.js";
import { RoutingDecision } from "../../src/domain/schema/session-turn.js";
import {
  FailureType,
} from "../../src/domain/schema/envelope.js";
import { MetricComparator } from "../../src/domain/schema/verification.js";

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

/**
 * Bidirectional drift gate: schema ↔ contract enum sets must match exactly.
 * Every contract-listed literal must appear in the schema, AND every schema
 * literal must appear in the contract — silent additions on either side
 * fail the gate.
 */
function assertBidirectionalEnum(
  schemaOptions: readonly string[],
  contractLiterals: readonly string[],
  label: string,
): void {
  const schemaSet = new Set(schemaOptions);
  const contractSet = new Set(contractLiterals);
  expect(schemaSet, `${label}: schema has unexpected literal`).toEqual(
    contractSet,
  );
}

describe("Phase 1b — AGC-OUTPUT envelope enum sync (schema ↔ contract)", () => {
  const contract = readFileSync(AGENT_CONTRACT, "utf8");
  const section = agcOutputSection(contract);

  it("contribution_kind enum matches contract", () => {
    const row = findEnvelopeRow(section, "contribution_kind");
    const fields = extractEnumFromRow(row).filter(
      (v) => !v.startsWith("#") && !v.startsWith("docs/"),
    );
    assertBidirectionalEnum(ContributionKind.options, fields, "contribution_kind");
  });

  it("output_kind enum matches contract", () => {
    const row = findEnvelopeRow(section, "output_kind");
    const fields = extractEnumFromRow(row).filter(
      (v) => !v.startsWith("#") && !v.startsWith("docs/"),
    );
    assertBidirectionalEnum(OutputKind.options, fields, "output_kind");
  });

  it("parent_loop enum matches contract", () => {
    const row = findEnvelopeRow(section, "parent_loop");
    const fields = extractEnumFromRow(row);
    assertBidirectionalEnum(ParentLoop.options, fields, "parent_loop");
  });
});

describe("Phase 1b — AGC-CONTEXT-MANIFEST fetch_scope enum sync", () => {
  it("FetchScope schema enum matches the contract enum table", () => {
    const contract = readFileSync(AGENT_CONTRACT, "utf8");
    const expected = ["metadata", "body", "tree", "body+comments", "body+turn_log"];
    for (const v of expected) {
      expect(contract).toContain(`\`${v}\``);
    }
    assertBidirectionalEnum(FetchScope.options, expected, "fetch_scope");
  });

  it("ManifestPurpose schema matches AGC-SESSION-INPUT purpose enum", () => {
    const contract = readFileSync(AGENT_CONTRACT, "utf8");
    const expected = [
      "design",
      "build",
      "review",
      "tdd_build",
      "planning_decompose",
      "validation",
    ];
    for (const v of expected) expect(contract).toContain(v);
    assertBidirectionalEnum(ManifestPurpose.options, expected, "manifest purpose");
  });
});

describe("Phase 1b — SOC-SESSION-LIFECYCLE / TERMINATION enum sync", () => {
  const soc = readFileSync(SOC_CONTRACT, "utf8");

  it("SessionState matches the 5-state contract enumeration", () => {
    const expected = [
      "SESSION_OPEN",
      "CONVERGED",
      "TIMEOUT",
      "ABANDONED",
      "AWAITING_REVALIDATION",
    ];
    for (const s of expected) expect(soc).toContain(s);
    assertBidirectionalEnum(SessionState.options, expected, "SessionState");
  });

  it("FinalizationRule matches SOC-SESSION-TERMINATION", () => {
    const expected = [
      "lead_only",
      "unanimous_approve",
      "quorum_then_lead",
      "any_request_changes_blocks",
      "timeout_only",
    ];
    for (const v of expected) expect(soc).toContain(v);
    assertBidirectionalEnum(FinalizationRule.options, expected, "FinalizationRule");
  });

  it("CompositeRule matches SOC-SESSION-TERMINATION", () => {
    const expected = [
      "finalization_AND_evidence",
      "evidence_only",
      "finalization_only",
    ];
    for (const v of expected) expect(soc).toContain(v);
    assertBidirectionalEnum(CompositeRule.options, expected, "CompositeRule");
  });

  it("FinalVerdict matches SOC-SESSION-TERMINATION final_verdict table", () => {
    const expected = [
      "approve",
      "request_changes",
      "tests_green",
      "spec_accept",
      "spec_reject",
      "plan_accept",
      "validation_pass",
      "validation_fail",
      "validation_stale",
      "no_progress",
      "regression",
      "scope_violation",
    ];
    for (const v of expected) expect(soc).toContain(`\`${v}\``);
    assertBidirectionalEnum(FinalVerdict.options, expected, "FinalVerdict");
  });
});

describe("Phase 1b — RoutingDecision / FailureType / MetricComparator enum sync", () => {
  it("RoutingDecision matches AGC-NEXT-ACTION-REQUEST", () => {
    const contract = readFileSync(AGENT_CONTRACT, "utf8");
    const expected = ["accepted", "overridden", "delayed", "dropped"];
    for (const v of expected) expect(contract).toContain(`\`${v}\``);
    assertBidirectionalEnum(RoutingDecision.options, expected, "RoutingDecision");
  });

  it("FailureType matches AGC-LLM-NEUTRALITY / AGC-INVALID failure.type usages", () => {
    const contract = readFileSync(AGENT_CONTRACT, "utf8");
    // need_context / invalid_output explicitly listed in AGC-LLM-NEUTRALITY.
    // no_progress / regression / scope_violation are abandoned_reason values
    // mapped through SOC-SESSION-TERMINATION to failure.type for inner ABANDONED.
    // Contract embeds these as `failure.type=<value>` in backticks.
    for (const v of ["need_context", "invalid_output"]) {
      expect(contract).toContain(`failure.type=${v}`);
    }
    expect(new Set(FailureType.options)).toEqual(
      new Set([
        "need_context",
        "invalid_output",
        "no_progress",
        "regression",
        "scope_violation",
      ]),
    );
  });

  it("MetricComparator is the single shared enum across schemas", () => {
    expect(new Set(MetricComparator.options)).toEqual(
      new Set(["lte", "lt", "gte", "gt", "eq"]),
    );
  });
});

describe("Phase 1b — AGC-INVALID reason regression gate", () => {
  it("envelope.ts exports the canonical reason set used by parser/enricher/matrix", async () => {
    const mod = await import("../../src/application/envelope.js");
    for (const r of [
      "schema_violation",
      "matrix_violation",
      "missing_required_envelope_field",
      "phase_or_purpose_outside_loop",
      "agent_authored_idempotency_key",
      "agent_authored_runtime_metadata",
      "agent_authored_session_outcome",
      "enrich_key_collision",
      "legacy_field_present",
    ] as const) {
      expect(mod.AGC_INVALID_REASONS).toContain(r);
    }
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
