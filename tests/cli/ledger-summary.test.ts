/**
 * Phase prod-5 — ledger-summary CLI mock tests.
 *
 * Drives the CLI with synthetic LedgerRow ndjson and asserts:
 *   - result distribution + verdict distribution match the input
 *   - retry_count counts `result === "duplicate"` rows
 *   - parse_errors increments on malformed lines without aborting
 *   - --format text path emits human-readable lines
 *   - argv parser rejects unknown flags / missing --ledger
 */
import { describe, expect, it } from "vitest";
import {
  formatText,
  parseArgs,
  runMain,
  summarizeLedger,
  type LedgerSummary,
} from "../../src/cli/ledger-summary.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const ONE_HASH = "1111111111111111111111111111111111111111111111111111111111111111";
const TWO_HASH = "2222222222222222222222222222222222222222222222222222222222222222";
const THREE_HASH = "3333333333333333333333333333333333333333333333333333333333333333";
const FOUR_HASH = "4444444444444444444444444444444444444444444444444444444444444444";

function row(
  overrides: Partial<Parameters<typeof LedgerRow.parse>[0]> & {
    transition_id: string;
    audit_hash: string;
    audit_hash_prev: string;
  },
): string {
  const base = {
    target_id: "demo",
    object_id: "01HZS00000000000000000000A",
    object_kind: "slice" as const,
    from_state: null,
    to_state: "SLICE_REVIEWING",
    loop_kind: "inner" as const,
    phase: null,
    slice_id: "01HZS00000000000000000000A",
    slice_kind: "internal" as const,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: null,
    contribution_kind: null,
    action_kind: "session_progress" as const,
    final_verdict: null,
    caller_id: "test",
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: "k-1",
    lease_token: null,
    lease_kind: null,
    result: "applied" as const,
    result_detail: null,
    timestamp: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
  return JSON.stringify(LedgerRow.parse(base));
}

function fixtureNdjson(): string {
  return [
    row({
      transition_id: "01HZT0000000000000000000A1",
      audit_hash_prev: ZERO_HASH,
      audit_hash: ONE_HASH,
      result: "applied",
      final_verdict: "spec_accept",
    }),
    row({
      transition_id: "01HZT0000000000000000000A2",
      audit_hash_prev: ONE_HASH,
      audit_hash: TWO_HASH,
      result: "duplicate",
      idempotency_key: "k-1",
    }),
    row({
      transition_id: "01HZT0000000000000000000A3",
      audit_hash_prev: TWO_HASH,
      audit_hash: THREE_HASH,
      result: "noop",
      idempotency_key: "k-2",
    }),
    row({
      transition_id: "01HZT0000000000000000000A4",
      audit_hash_prev: THREE_HASH,
      audit_hash: FOUR_HASH,
      result: "applied",
      idempotency_key: "k-3",
      final_verdict: "spec_accept",
    }),
  ].join("\n") + "\n";
}

describe("ledger-summary parseArgs", () => {
  it("requires --ledger", () => {
    expect(() => parseArgs([])).toThrow(/--ledger/);
  });
  it("rejects unknown flag", () => {
    expect(() => parseArgs(["--what"])).toThrow(/unknown flag/);
  });
  it("rejects unknown format", () => {
    expect(() => parseArgs(["--ledger", "x", "--format", "yaml"])).toThrow(/--format/);
  });
  it("parses ledger/out/format", () => {
    const a = parseArgs([
      "--ledger",
      "ledger.ndjson",
      "--out",
      "summary.json",
      "--format",
      "text",
    ]);
    expect(a.ledgerPath).toBe("ledger.ndjson");
    expect(a.outPath).toBe("summary.json");
    expect(a.format).toBe("text");
  });
});

describe("summarizeLedger", () => {
  it("aggregates result + verdict distributions and retry count", () => {
    const summary = summarizeLedger("/virtual/ledger.ndjson", {
      readFile: () => fixtureNdjson(),
      now: () => new Date("2026-05-10T00:00:00.000Z"),
    });
    expect(summary.total_rows).toBe(4);
    expect(summary.parse_errors).toBe(0);
    expect(summary.result_distribution).toEqual({
      applied: 2,
      duplicate: 1,
      noop: 1,
    });
    expect(summary.verdict_distribution).toEqual({ spec_accept: 2 });
    expect(summary.retry_count).toBe(1);
    expect(summary.cost_estimate_usd).toBeNull();
    expect(summary.cost_source).toBe("n/a");
    expect(summary.generated_at).toBe("2026-05-10T00:00:00.000Z");
  });

  it("counts malformed lines as parse_errors and continues", () => {
    const body =
      row({
        transition_id: "01HZT0000000000000000000A1",
        audit_hash_prev: ZERO_HASH,
        audit_hash: ONE_HASH,
      }) +
      "\n{not-json}\n" +
      row({
        transition_id: "01HZT0000000000000000000A2",
        audit_hash_prev: ONE_HASH,
        audit_hash: TWO_HASH,
        result: "error",
      }) +
      "\n";
    const summary = summarizeLedger("/virtual/ledger.ndjson", {
      readFile: () => body,
    });
    expect(summary.total_rows).toBe(2);
    expect(summary.parse_errors).toBe(1);
    expect(summary.result_distribution).toEqual({ applied: 1, error: 1 });
  });

  it("returns zeroed summary on empty ledger", () => {
    const summary = summarizeLedger("/virtual/ledger.ndjson", {
      readFile: () => "",
    });
    expect(summary.total_rows).toBe(0);
    expect(summary.result_distribution).toEqual({});
    expect(summary.verdict_distribution).toEqual({});
    expect(summary.retry_count).toBe(0);
  });

  it("throws on unreadable ledger", () => {
    expect(() =>
      summarizeLedger("/virtual/ledger.ndjson", {
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/cannot read ledger/);
  });
});

describe("formatText", () => {
  it("renders empty distributions with `(none)` markers", () => {
    const summary: LedgerSummary = {
      total_rows: 0,
      parse_errors: 0,
      result_distribution: {},
      verdict_distribution: {},
      retry_count: 0,
      cost_estimate_usd: null,
      cost_source: "n/a",
      generated_at: "2026-05-10T00:00:00.000Z",
    };
    const text = formatText(summary);
    expect(text).toContain("total_rows: 0");
    expect(text).toContain("retry_count (duplicate rows): 0");
    expect(text).toContain("cost_estimate_usd: n/a");
    expect(text).toContain("(none)");
  });

  it("sorts distribution keys alphabetically", () => {
    const summary: LedgerSummary = {
      total_rows: 3,
      parse_errors: 0,
      result_distribution: { noop: 1, applied: 2 },
      verdict_distribution: { spec_accept: 1, plan_accept: 1 },
      retry_count: 0,
      cost_estimate_usd: null,
      cost_source: "n/a",
      generated_at: "2026-05-10T00:00:00.000Z",
    };
    const text = formatText(summary);
    const appliedIdx = text.indexOf("applied: 2");
    const noopIdx = text.indexOf("noop: 1");
    expect(appliedIdx).toBeGreaterThan(-1);
    expect(noopIdx).toBeGreaterThan(appliedIdx);
    const planIdx = text.indexOf("plan_accept");
    const specIdx = text.indexOf("spec_accept");
    expect(planIdx).toBeLessThan(specIdx);
  });
});

describe("ledger-summary runMain", () => {
  it("writes JSON to stdout when --out is omitted", () => {
    const out: string[] = [];
    const code = runMain(["--ledger", "/virtual/ledger.ndjson"], {
      readFile: () => fixtureNdjson(),
      now: () => new Date("2026-05-10T00:00:00.000Z"),
      stdout: (s) => out.push(s),
      stderr: () => {},
      writeFile: () => {
        throw new Error("writeFile must not be called");
      },
      cwd: "/",
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.total_rows).toBe(4);
    expect(parsed.retry_count).toBe(1);
  });

  it("writes to --out when provided and emits nothing on stdout", () => {
    const writes: Record<string, string> = {};
    const out: string[] = [];
    const code = runMain(
      [
        "--ledger",
        "/virtual/ledger.ndjson",
        "--out",
        "/virtual/summary.json",
        "--format",
        "json",
      ],
      {
        readFile: () => fixtureNdjson(),
        now: () => new Date("2026-05-10T00:00:00.000Z"),
        stdout: (s) => out.push(s),
        stderr: () => {},
        writeFile: (p, c) => {
          writes[p] = c;
        },
        cwd: "/",
      },
    );
    expect(code).toBe(0);
    expect(out.length).toBe(0);
    const parsed = JSON.parse(writes["/virtual/summary.json"]!);
    expect(parsed.result_distribution.applied).toBe(2);
  });

  it("returns exit code 1 when ledger is unreadable", () => {
    const errs: string[] = [];
    const code = runMain(["--ledger", "/virtual/missing.ndjson"], {
      readFile: () => {
        throw new Error("ENOENT");
      },
      stdout: () => {},
      stderr: (s) => errs.push(s),
      cwd: "/",
    });
    expect(code).toBe(1);
    expect(errs.join("")).toMatch(/cannot read ledger/);
  });

  it("returns exit code 2 on argv error", () => {
    const errs: string[] = [];
    const code = runMain([], {
      stdout: () => {},
      stderr: (s) => errs.push(s),
    });
    expect(code).toBe(2);
    expect(errs.join("")).toMatch(/--ledger/);
  });
});
