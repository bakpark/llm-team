#!/usr/bin/env -S node --enable-source-maps
/**
 * Phase prod-5 — ledger summary CLI.
 *
 * Reads a `ledger.ndjson` (the FileLedger transitions stream) and emits an
 * aggregate of:
 *   - `result` distribution (LedgerResult enum: applied / noop / duplicate /
 *     error / invalid / stale / claim_failed / recovered / rolled_back /
 *     escalated)
 *   - `final_verdict` distribution (free-form strings, only counted when
 *     non-null)
 *   - retry indicator: count of `result === "duplicate"` rows. The ledger
 *     records duplicates as their own row (FileLedger.appendTransition) so
 *     this is a faithful proxy for "retries replayed against an existing
 *     idempotency_key".
 *   - cost estimate: the `LedgerRow` schema does not carry per-call cost
 *     today, so the summary records `cost_estimate_usd: null` and emits a
 *     `cost_source: "n/a"` marker. Future cost fields can extend this
 *     without changing the CLI surface.
 *
 * Usage:
 *   tsx src/cli/ledger-summary.ts --ledger <path> [--out <path>]
 *     [--format json|text]
 *
 * Mirrors the healthcheck CLI entry pattern: argv parser, JSON output by
 * default, exit code 0 on success / non-zero on read or parse failure.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LedgerRow } from "../domain/schema/ledger.js";

export interface LedgerSummaryArgs {
  ledgerPath: string;
  outPath?: string;
  format: "json" | "text";
}

export interface LedgerSummary {
  total_rows: number;
  parse_errors: number;
  result_distribution: Record<string, number>;
  verdict_distribution: Record<string, number>;
  retry_count: number;
  cost_estimate_usd: number | null;
  cost_source: "n/a" | "ledger";
  generated_at: string;
}

export function parseArgs(argv: readonly string[]): LedgerSummaryArgs {
  const a = [...argv];
  let ledgerPath: string | undefined;
  let outPath: string | undefined;
  let format: "json" | "text" = "json";
  while (a.length > 0) {
    const flag = a.shift()!;
    switch (flag) {
      case "--ledger":
        ledgerPath = a.shift();
        break;
      case "--out":
        outPath = a.shift();
        break;
      case "--format": {
        const v = a.shift();
        if (v !== "json" && v !== "text")
          throw new Error(`--format must be json|text (got ${v ?? "<missing>"})`);
        format = v;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!ledgerPath || ledgerPath.length === 0)
    throw new Error("--ledger <path> is required");
  return { ledgerPath, outPath, format };
}

export interface SummarizeOptions {
  /** ISO timestamp captured into the summary (tests inject a fixed value). */
  now?: () => Date;
  /** Override readFileSync for tests. */
  readFile?: (path: string) => string;
}

export function summarizeLedger(
  ledgerPath: string,
  options: SummarizeOptions = {},
): LedgerSummary {
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const now = options.now ?? (() => new Date());
  let raw: string;
  try {
    raw = readFile(ledgerPath);
  } catch (err) {
    throw new Error(
      `cannot read ledger at ${ledgerPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const result_distribution: Record<string, number> = {};
  const verdict_distribution: Record<string, number> = {};
  let total_rows = 0;
  let parse_errors = 0;
  let retry_count = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let row;
    try {
      row = LedgerRow.parse(JSON.parse(line));
    } catch {
      parse_errors += 1;
      continue;
    }
    total_rows += 1;
    result_distribution[row.result] = (result_distribution[row.result] ?? 0) + 1;
    if (row.result === "duplicate") retry_count += 1;
    if (row.final_verdict != null && row.final_verdict.length > 0) {
      verdict_distribution[row.final_verdict] =
        (verdict_distribution[row.final_verdict] ?? 0) + 1;
    }
  }
  return {
    total_rows,
    parse_errors,
    result_distribution,
    verdict_distribution,
    retry_count,
    cost_estimate_usd: null,
    cost_source: "n/a",
    generated_at: now().toISOString(),
  };
}

export function formatText(s: LedgerSummary): string {
  const lines: string[] = [];
  lines.push(`ledger summary (generated_at=${s.generated_at})`);
  lines.push(`  total_rows: ${s.total_rows}`);
  lines.push(`  parse_errors: ${s.parse_errors}`);
  lines.push(`  retry_count (duplicate rows): ${s.retry_count}`);
  lines.push(`  cost_estimate_usd: ${s.cost_estimate_usd ?? "n/a"} (source=${s.cost_source})`);
  lines.push(`  result_distribution:`);
  const rs = Object.entries(s.result_distribution).sort((a, b) => a[0].localeCompare(b[0]));
  if (rs.length === 0) lines.push(`    (none)`);
  for (const [k, v] of rs) lines.push(`    ${k}: ${v}`);
  lines.push(`  verdict_distribution:`);
  const vs = Object.entries(s.verdict_distribution).sort((a, b) => a[0].localeCompare(b[0]));
  if (vs.length === 0) lines.push(`    (none)`);
  for (const [k, v] of vs) lines.push(`    ${k}: ${v}`);
  return lines.join("\n") + "\n";
}

export interface MainDeps extends SummarizeOptions {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  writeFile?: (path: string, contents: string) => void;
  cwd?: string;
}

export function runMain(
  argv: readonly string[],
  deps: MainDeps = {},
): number {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const writeFile =
    deps.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c, "utf8");
    });
  let args: LedgerSummaryArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const cwd = deps.cwd ?? process.cwd();
  let summary: LedgerSummary;
  try {
    summary = summarizeLedger(resolve(cwd, args.ledgerPath), {
      now: deps.now,
      readFile: deps.readFile,
    });
  } catch (err) {
    stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const body =
    args.format === "json" ? JSON.stringify(summary, null, 2) + "\n" : formatText(summary);
  if (args.outPath) {
    writeFile(resolve(cwd, args.outPath), body);
  } else {
    stdout(body);
  }
  return 0;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const code = runMain(process.argv.slice(2));
  process.exit(code);
}
