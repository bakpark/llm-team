/**
 * Phase prod-3 — Stage 2 live-network preflight.
 *
 * Stage 2 issues low-cost HTTP probes that are not LLM completions:
 *
 *   - qwen endpoint  ping  (`<base>/ping`, fallback `/models`).
 *       URL from `LLM_TEAM_QWEN_BASE_URL`. Empty → SKIP.
 *       200=PASS, 401=FAIL(auth), 429=PASS-with-warning, 5xx=FAIL(upstream),
 *       other non-2xx=FAIL.
 *
 *   - GitHub `rate_limit` — fetched via the host `gh api rate_limit`.
 *       remaining < `LLM_TEAM_GH_RATE_LIMIT_WARN_AT` (default 100) → WARN
 *       (PASS w/ warning detail). remaining == 0 → FAIL.
 *
 * Stage 2 has a 5s per-probe timeout (matching Stage 1 fail-fast budget).
 */
import type { SpawnSyncOptions } from "node:child_process";
import type { HealthcheckItem } from "./healthcheck-schema.js";

export type Stage2Fetch = (
  url: string,
  init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; text: () => Promise<string> }>;

export type Stage2RunCmd = (
  cmd: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

export interface Stage2Opts {
  env: NodeJS.ProcessEnv;
  fetch?: Stage2Fetch;
  run: Stage2RunCmd;
  /** Timeout per probe in ms. Defaults to 5_000. */
  timeoutMs?: number;
  /** Override now() for deterministic tests. */
  now?: () => Date;
}

export interface Stage2Outcome {
  items: HealthcheckItem[];
  /** Whether qwen ping resolved as PASS (used by Stage 3 qwen-smoke gating). */
  qwenPassed: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_GH_WARN_AT = 100;

async function fetchWithTimeout(
  doFetch: Stage2Fetch,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; text: string } | { error: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await doFetch(url, { signal: ac.signal });
    const text = await r.text().catch(() => "");
    return { status: r.status, text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

async function probeQwen(opts: Stage2Opts): Promise<HealthcheckItem & { ok: boolean }> {
  const base = (opts.env.LLM_TEAM_QWEN_BASE_URL ?? "").trim();
  if (base.length === 0) {
    return {
      id: "M-2-qwen.ping",
      status: "SKIP",
      detail: "LLM_TEAM_QWEN_BASE_URL not set; skipping qwen ping",
      anchor: "M-2-qwen",
      ok: false,
    };
  }
  if (!opts.fetch) {
    return {
      id: "M-2-qwen.ping",
      status: "SKIP",
      detail: "fetch not available; skipping qwen ping",
      anchor: "M-2-qwen",
      ok: false,
    };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = base.replace(/\/+$/, "") + "/ping";
  let r = await fetchWithTimeout(opts.fetch, url, timeoutMs);
  // If /ping is unreachable in a non-network way (404), try /models fallback.
  if ("status" in r && r.status === 404) {
    const fallbackUrl = base.replace(/\/+$/, "") + "/models";
    r = await fetchWithTimeout(opts.fetch, fallbackUrl, timeoutMs);
  }
  if ("error" in r) {
    return {
      id: "M-2-qwen.ping",
      status: "FAIL",
      detail: `qwen ping network error: ${r.error.slice(0, 160)}`,
      anchor: "M-2-qwen",
      ok: false,
    };
  }
  if (r.status >= 200 && r.status < 300) {
    return {
      id: "M-2-qwen.ping",
      status: "PASS",
      detail: `qwen ping ${r.status} ok`,
      anchor: "M-2-qwen",
      ok: true,
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      id: "M-2-qwen.ping",
      status: "FAIL",
      detail: `qwen ping ${r.status} auth (check API key)`,
      anchor: "M-2-qwen",
      ok: false,
    };
  }
  if (r.status === 429) {
    return {
      id: "M-2-qwen.ping",
      status: "PASS",
      detail: `qwen ping ${r.status} rate-limited (treated as reachable)`,
      anchor: "M-2-qwen",
      ok: true,
    };
  }
  if (r.status >= 500 && r.status < 600) {
    return {
      id: "M-2-qwen.ping",
      status: "FAIL",
      detail: `qwen ping ${r.status} upstream`,
      anchor: "M-2-qwen",
      ok: false,
    };
  }
  return {
    id: "M-2-qwen.ping",
    status: "FAIL",
    detail: `qwen ping unexpected status ${r.status}`,
    anchor: "M-2-qwen",
    ok: false,
  };
}

interface GhRateLimitJson {
  rate?: { remaining?: number; limit?: number; reset?: number };
  resources?: { core?: { remaining?: number; limit?: number; reset?: number } };
}

function parseGhRateLimit(stdout: string): {
  remaining: number;
  limit: number;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const j = parsed as GhRateLimitJson;
  const core = j.resources?.core ?? j.rate;
  if (!core || typeof core.remaining !== "number") return null;
  return {
    remaining: core.remaining,
    limit: typeof core.limit === "number" ? core.limit : 0,
  };
}

function probeGhRateLimit(opts: Stage2Opts): HealthcheckItem {
  const warnAt = (() => {
    const raw = opts.env.LLM_TEAM_GH_RATE_LIMIT_WARN_AT;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GH_WARN_AT;
  })();
  const r = opts.run("gh", ["api", "rate_limit"], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (r.status !== 0) {
    return {
      id: "M-2-gh.rate-limit",
      status: "FAIL",
      detail: `gh api rate_limit failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}`,
      anchor: "M-2-gh",
    };
  }
  const parsed = parseGhRateLimit(r.stdout);
  if (!parsed) {
    return {
      id: "M-2-gh.rate-limit",
      status: "FAIL",
      detail: "gh api rate_limit: unparsable response",
      anchor: "M-2-gh",
    };
  }
  if (parsed.remaining === 0) {
    return {
      id: "M-2-gh.rate-limit",
      status: "FAIL",
      detail: `gh rate limit exhausted (0/${parsed.limit})`,
      anchor: "M-2-gh",
    };
  }
  if (parsed.remaining < warnAt) {
    return {
      id: "M-2-gh.rate-limit",
      status: "PASS",
      detail: `gh rate limit low: ${parsed.remaining}/${parsed.limit} (warn < ${warnAt})`,
      anchor: "M-2-gh",
    };
  }
  return {
    id: "M-2-gh.rate-limit",
    status: "PASS",
    detail: `gh rate limit ${parsed.remaining}/${parsed.limit}`,
    anchor: "M-2-gh",
  };
}

export async function runStage2(opts: Stage2Opts): Promise<Stage2Outcome> {
  const items: HealthcheckItem[] = [];
  const qwen = await probeQwen(opts);
  const { ok, ...qwenItem } = qwen;
  items.push(qwenItem);
  items.push(probeGhRateLimit(opts));
  return { items, qwenPassed: ok };
}
