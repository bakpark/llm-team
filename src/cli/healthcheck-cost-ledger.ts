/**
 * Phase prod-3 — Stage 3 cost ledger.
 *
 * Stage 3 of the healthcheck CLI may issue live LLM calls when the operator
 * opts in via `LLM_TEAM_LIVE_HEALTHCHECK=1`. Two USD caps gate cost:
 *
 *   1. per-run cap  — `LLM_TEAM_LIVE_COST_CAP_USD`        (default 0.10)
 *   2. daily   cap  — `LLM_TEAM_LIVE_DAILY_COST_CAP_USD`  (default 1.00)
 *
 * Each successful live call appends one line to a ndjson ledger. The ledger
 * lives outside the trunk working tree so `git status` never surfaces it.
 *
 * Default path:
 *   `${LLM_TEAM_HEALTHCHECK_COST_LEDGER}` if set, otherwise
 *   `${workdir}/healthcheck/cost-ledger.ndjson` if `workdir` provided,
 *   otherwise `~/.llm-team/healthcheck-cost-ledger.ndjson`.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { CostLedgerEntry } from "./healthcheck-schema.js";

export const DEFAULT_PER_RUN_CAP_USD = 0.1;
export const DEFAULT_DAILY_CAP_USD = 1.0;

export interface CostLedgerPathOpts {
  /** Operator-supplied workdir (e.g. RUN_DIR parent). */
  workdir?: string;
  /** Process env (used to honor `LLM_TEAM_HEALTHCHECK_COST_LEDGER`). */
  env?: NodeJS.ProcessEnv;
  /** Override `os.homedir()` for tests. */
  home?: string;
}

export function resolveCostLedgerPath(opts: CostLedgerPathOpts = {}): string {
  const env = opts.env ?? process.env;
  const explicit = env.LLM_TEAM_HEALTHCHECK_COST_LEDGER;
  if (explicit && explicit.length > 0) return resolve(explicit);
  if (opts.workdir) {
    return resolve(opts.workdir, "healthcheck", "cost-ledger.ndjson");
  }
  const home = opts.home ?? homedir();
  return resolve(home, ".llm-team", "healthcheck-cost-ledger.ndjson");
}

export interface ParsedCaps {
  perRunUsd: number;
  dailyUsd: number;
}

export function readCapsFromEnv(env: NodeJS.ProcessEnv): ParsedCaps {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    perRunUsd: parse(env.LLM_TEAM_LIVE_COST_CAP_USD, DEFAULT_PER_RUN_CAP_USD),
    dailyUsd: parse(env.LLM_TEAM_LIVE_DAILY_COST_CAP_USD, DEFAULT_DAILY_CAP_USD),
  };
}

/** Reads the ledger and sums entries whose `ts` falls within [day, day+24h). */
export function readDailyTotalUsd(
  ledgerPath: string,
  now: Date,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): number {
  let raw: string;
  try {
    raw = readFile(ledgerPath);
  } catch {
    return 0;
  }
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  let total = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const r = CostLedgerEntry.safeParse(parsed);
    if (!r.success) continue;
    const ts = Date.parse(r.data.ts);
    if (Number.isNaN(ts)) continue;
    if (ts >= dayStart && ts < dayEnd) total += r.data.estimated_usd;
  }
  return total;
}

export interface CapCheckInput {
  estimatedUsd: number;
  perRunUsd: number;
  dailyUsd: number;
  dailyTotalUsd: number;
}

export type CapCheckResult =
  | { ok: true }
  | { ok: false; reason: "per_run" | "daily"; detail: string };

export function checkCaps(input: CapCheckInput): CapCheckResult {
  if (input.estimatedUsd > input.perRunUsd) {
    return {
      ok: false,
      reason: "per_run",
      detail: `estimated $${input.estimatedUsd.toFixed(4)} > per-run cap $${input.perRunUsd.toFixed(2)}`,
    };
  }
  if (input.dailyTotalUsd + input.estimatedUsd > input.dailyUsd) {
    return {
      ok: false,
      reason: "daily",
      detail: `daily $${input.dailyTotalUsd.toFixed(4)} + $${input.estimatedUsd.toFixed(4)} > daily cap $${input.dailyUsd.toFixed(2)}`,
    };
  }
  return { ok: true };
}

export interface AppendLedgerDeps {
  appendFile?: (path: string, line: string) => void;
}

export function appendLedger(
  ledgerPath: string,
  entry: CostLedgerEntry,
  deps: AppendLedgerDeps = {},
): void {
  CostLedgerEntry.parse(entry);
  const append =
    deps.appendFile ??
    ((p: string, line: string) => {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, line, { encoding: "utf8" });
    });
  append(ledgerPath, `${JSON.stringify(entry)}\n`);
}
