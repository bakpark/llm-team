/**
 * Phase prod-3 — Stage 3 live 1-shot smoke.
 *
 * Stage 3 issues real LLM completions when the operator opts in via
 * `LLM_TEAM_LIVE_HEALTHCHECK=1`. Every probe is a single, short prompt
 * (tens of tokens) wrapped by per-run + daily USD caps.
 *
 * Probes:
 *   - claude         1-shot:  `claude -p --output-format text --model <m>`
 *   - codex (default) 1-shot: `codex exec --skip-git-repo-check --cd <RUN_DIR>
 *                              --color never <prompt-positional>`
 *   - codex (qwen)    1-shot: same + `--profile qwen`
 *
 * Invariants enforced (also asserted by `tests/cli/healthcheck-stage3.test.ts`):
 *
 *   1. `LLM_TEAM_LIVE_HEALTHCHECK !== "1"` ⇒ every probe SKIP, exit 0,
 *      cost ledger untouched.
 *   2. codex argv contains `--ephemeral`, `--skip-git-repo-check`, and the
 *      RUN_DIR via `--cd`. stdin is `</dev/null` (no pipe) so the codex
 *      positional prompt cannot be confused with a piped stdin payload.
 *   3. cost-cap exceeded ⇒ probe SKIP (NOT a FAIL — the operator decides
 *      whether to lift the cap).
 *   4. qwen Stage 2 ping SKIP/FAIL ⇒ codex-qwen probe auto-SKIP.
 *   5. Every attempt writes `<probe>.stdout`, `.stderr`, `.exit`, `.md`
 *      under `<RUN_DIR>/` regardless of outcome (rollback evidence).
 *   6. On any FAIL, `<RUN_DIR>/healthcheck-failure.md` is generated.
 *   7. After the run, `<RUN_DIR>/verified-auth-model.json` records the
 *      live-probe surfaces.
 *
 * RUN_DIR resolution (in order):
 *   - explicit `LLM_TEAM_HEALTHCHECK_RUN_DIR`
 *   - `<workdir>/healthcheck/<timestamp>/` (workdir from env or `~/.llm-team`)
 *   Created mode 0700; never deleted on failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { redactSecrets } from "../adapters/llm-runner/common/redact.js";
import {
  appendLedger,
  checkCaps,
  readCapsFromEnv,
  readDailyTotalUsd,
  resolveCostLedgerPath,
} from "./healthcheck-cost-ledger.js";
import {
  type CostLedgerEntry,
  type HealthcheckItem,
  type VerifiedAuthModel,
  type VerifiedAuthSurface,
} from "./healthcheck-schema.js";

export type Stage3SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Whether the spawn reported `signal === 'SIGTERM'` (timeout). */
  timedOut?: boolean;
};

export interface Stage3SpawnInput {
  cmd: string;
  args: readonly string[];
  /** Prompt text to send via stdin (claude). codex passes prompt as positional. */
  stdin: string | null;
  cwd: string;
  timeoutMs: number;
  /** Whether spawn must connect stdin to /dev/null (codex). */
  stdinFromDevNull: boolean;
}

/**
 * Spawn implementation injected by the CLI. Tests pass a recording mock so
 * the real claude/codex binaries are never executed. The implementation MUST
 * honor `stdinFromDevNull: true` by attaching `</dev/null` (i.e. pass
 * `stdio: ['ignore', ...]`).
 */
export type Stage3Spawn = (input: Stage3SpawnInput) => Promise<Stage3SpawnResult>;

export interface Stage3Deps {
  env: NodeJS.ProcessEnv;
  spawn: Stage3Spawn;
  /** Stage 2 qwen-ping outcome (gates codex-qwen). */
  qwenPassed: boolean;
  /** Override now() for deterministic tests. */
  now?: () => Date;
  /** Override cost ledger reader (default: read from disk). */
  readLedger?: (path: string) => string;
  /** Override cost ledger appender (default: appendFileSync). */
  appendLedger?: (path: string, line: string) => void;
  /** Override fs.mkdirSync (tests). */
  mkdir?: (path: string, opts: { recursive: true; mode?: number }) => void;
  /** Override fs.writeFileSync (tests). */
  writeFile?: (path: string, content: string) => void;
  /** Override homedir() (tests). */
  home?: string;
  /** Optional explicit workdir (e.g. `--out` parent). */
  workdir?: string;
}

export interface Stage3Outcome {
  items: HealthcheckItem[];
  /** Resolved RUN_DIR (always populated even when probes SKIP). */
  runDir: string;
  /** Path to verified-auth-model.json (if written). */
  verifiedAuthModelPath?: string;
  /** Path to healthcheck-failure.md (if any FAIL occurred). */
  failureMdPath?: string;
}

const SMOKE_PROMPT_DEFAULT =
  "Reply with exactly two words: ok ready.\n";
const PER_PROBE_TIMEOUT_MS = 60_000;

function ts(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function resolveRunDir(deps: Stage3Deps, now: Date): string {
  const env = deps.env;
  if (env.LLM_TEAM_HEALTHCHECK_RUN_DIR && env.LLM_TEAM_HEALTHCHECK_RUN_DIR.length > 0) {
    return resolve(env.LLM_TEAM_HEALTHCHECK_RUN_DIR);
  }
  const root = deps.workdir
    ? deps.workdir
    : resolve(deps.home ?? homedir(), ".llm-team");
  return resolve(root, "healthcheck", ts(now));
}

function ensureRunDir(
  runDir: string,
  deps: Stage3Deps,
): void {
  const mkdir =
    deps.mkdir ?? ((p, o) => mkdirSync(p, { recursive: o.recursive, mode: o.mode }));
  mkdir(runDir, { recursive: true, mode: 0o700 });
}

function writeArtifactSet(
  runDir: string,
  probeId: string,
  result: Stage3SpawnResult,
  promptText: string,
  deps: Stage3Deps,
): void {
  const writeFile =
    deps.writeFile ?? ((p, c) => writeFileSync(p, c, { encoding: "utf8" }));
  // Sink-boundary redaction (phase-prod-2 pattern). Provider CLIs may emit
  // tokens or `Bearer` headers in stderr on auth errors; scrub before any
  // RUN_DIR file is written.
  const stdout = redactSecrets(result.stdout, deps.env);
  const stderr = redactSecrets(result.stderr, deps.env);
  writeFile(resolve(runDir, `${probeId}.stdout`), stdout);
  writeFile(resolve(runDir, `${probeId}.stderr`), stderr);
  writeFile(
    resolve(runDir, `${probeId}.exit`),
    `${result.status ?? "null"}\n`,
  );
  writeFile(
    resolve(runDir, `${probeId}.md`),
    [
      `# ${probeId}`,
      "",
      "## prompt",
      "",
      "```",
      promptText.trimEnd(),
      "```",
      "",
      "## exit",
      "",
      `\`${result.status ?? "null"}\`${result.timedOut ? " (timed out)" : ""}`,
      "",
      "## stdout",
      "",
      "```",
      stdout.trimEnd(),
      "```",
      "",
      "## stderr",
      "",
      "```",
      stderr.trimEnd(),
      "```",
      "",
    ].join("\n"),
  );
}

interface ProbeSpec {
  id: string;
  anchor: string;
  kind: string;
  estimatedUsd: number;
  /** Build the spawn input for this probe. */
  build(runDir: string, prompt: string): Stage3SpawnInput;
  /** Whether this probe is gated SKIP by external state (qwen). */
  gate?: { skip: boolean; reason: string };
}

function buildClaudeArgv(env: NodeJS.ProcessEnv): { cmd: string; args: string[] } {
  // Mirror ClaudeCodeAdapter.buildArgv: support multi-token launchers
  // (e.g. `npx claude`) by splitting on whitespace and passing the tail as
  // leading argv. Without this, `LLM_TEAM_CLAUDE_BIN="npx claude"` would
  // ENOENT because spawn would look for an executable literally named
  // "npx claude".
  const tokens = (env.LLM_TEAM_CLAUDE_BIN || "claude").split(/\s+/).filter(Boolean);
  const cmd = tokens[0] ?? "claude";
  const baseArgs = tokens.slice(1);
  const flags: string[] = ["-p", "--output-format", "text"];
  const model = env.LLM_TEAM_CLAUDE_MODEL;
  if (model) flags.push("--model", model);
  return { cmd, args: [...baseArgs, ...flags] };
}

function buildCodexArgv(
  env: NodeJS.ProcessEnv,
  runDir: string,
  prompt: string,
  profile: string | null,
): { cmd: string; args: string[] } {
  const cmd = env.LLM_TEAM_CODEX_BIN || "codex";
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--cd",
    runDir,
    "--color",
    "never",
  ];
  if (profile) args.push("--profile", profile);
  args.push(prompt);
  return { cmd, args };
}

function probeStatus(result: Stage3SpawnResult): "PASS" | "FAIL" {
  return result.status === 0 && !result.timedOut ? "PASS" : "FAIL";
}

function summarizeFailure(
  probeId: string,
  result: Stage3SpawnResult,
  env: NodeJS.ProcessEnv,
): string {
  if (result.timedOut) return "timed out (60s)";
  if (result.status === null) return "spawn aborted (no status)";
  // Sink-boundary redaction: detail is persisted into result.items (and
  // ultimately healthcheck-failure.md). Apply the same scrubbing as the
  // RUN_DIR artifacts so neither path leaks tokens.
  const raw = (result.stderr || result.stdout).trim().slice(0, 200);
  return `exit ${result.status}: ${redactSecrets(raw, env)}`;
}

function makeSurface(
  status: VerifiedAuthSurface["status"],
  detail?: string,
  cliVersion?: string,
  model?: string,
): VerifiedAuthSurface {
  const s: VerifiedAuthSurface = { status };
  if (detail !== undefined) s.detail = detail;
  if (cliVersion !== undefined) s.cli_version = cliVersion;
  if (model !== undefined) s.model = model;
  return s;
}

export async function runStage3(deps: Stage3Deps): Promise<Stage3Outcome> {
  const now = (deps.now ?? (() => new Date()))();
  const runDir = resolveRunDir(deps, now);
  ensureRunDir(runDir, deps);

  const env = deps.env;
  const items: HealthcheckItem[] = [];
  const optedIn = env.LLM_TEAM_LIVE_HEALTHCHECK === "1";

  // Surface result accumulator (verified-auth-model.json).
  const surfaces: Record<string, VerifiedAuthSurface> = {
    claude: makeSurface("SKIP", "stage 3 not run"),
    codex: makeSurface("SKIP", "stage 3 not run"),
    codex_qwen: makeSurface("SKIP", "stage 3 not run"),
    gh: makeSurface("SKIP", "verified by stage 2"),
  };

  if (!optedIn) {
    items.push({
      id: "M-3-opt-in",
      status: "SKIP",
      detail:
        "LLM_TEAM_LIVE_HEALTHCHECK not set to '1'; all live probes skipped (no cost incurred)",
      anchor: "M-3-0",
    });
    const verifiedPath = writeVerifiedAuthModel(runDir, surfaces, now, deps);
    return { items, runDir, verifiedAuthModelPath: verifiedPath };
  }

  // Cost caps.
  const caps = readCapsFromEnv(env);
  const ledgerPath = resolveCostLedgerPath({ env, workdir: deps.workdir, home: deps.home });
  let dailyTotal = 0;
  if (deps.readLedger) {
    dailyTotal = readDailyTotalUsd(ledgerPath, now, deps.readLedger);
  } else {
    dailyTotal = readDailyTotalUsd(ledgerPath, now);
  }
  // Per-run accumulator — same pattern as dailyTotal but reset every
  // invocation. Increments only after a probe PASSes (matches ledger append).
  let runTotal = 0;

  const prompt = SMOKE_PROMPT_DEFAULT;

  const probes: ProbeSpec[] = [
    {
      id: "claude-attempt1",
      anchor: "M-3-claude",
      kind: "claude.smoke",
      estimatedUsd: 0.005,
      build(_runDir, p) {
        const { cmd, args } = buildClaudeArgv(env);
        return {
          cmd,
          args,
          stdin: p,
          cwd: runDir,
          timeoutMs: PER_PROBE_TIMEOUT_MS,
          stdinFromDevNull: false,
        };
      },
    },
    {
      id: "codex-default-attempt1",
      anchor: "M-3-codex",
      kind: "codex.default.smoke",
      estimatedUsd: 0.005,
      build(rd, p) {
        const { cmd, args } = buildCodexArgv(env, rd, p, null);
        return {
          cmd,
          args,
          stdin: null,
          cwd: rd,
          timeoutMs: PER_PROBE_TIMEOUT_MS,
          stdinFromDevNull: true,
        };
      },
    },
    {
      id: "codex-qwen-attempt1",
      anchor: "M-3-codex-qwen",
      kind: "codex.qwen.smoke",
      estimatedUsd: 0.005,
      gate: deps.qwenPassed
        ? undefined
        : { skip: true, reason: "qwen Stage 2 ping not PASS; codex-qwen smoke skipped" },
      build(rd, p) {
        const profile = env.LLM_TEAM_CODEX_QWEN_PROFILE || "qwen";
        const { cmd, args } = buildCodexArgv(env, rd, p, profile);
        return {
          cmd,
          args,
          stdin: null,
          cwd: rd,
          timeoutMs: PER_PROBE_TIMEOUT_MS,
          stdinFromDevNull: true,
        };
      },
    },
  ];

  for (const probe of probes) {
    if (probe.gate?.skip) {
      items.push({
        id: probe.id,
        status: "SKIP",
        detail: probe.gate.reason,
        anchor: probe.anchor,
      });
      surfaces[surfaceKeyFor(probe.kind)] = makeSurface("SKIP", probe.gate.reason);
      continue;
    }
    const cap = checkCaps({
      estimatedUsd: probe.estimatedUsd,
      perRunUsd: caps.perRunUsd,
      dailyUsd: caps.dailyUsd,
      dailyTotalUsd: dailyTotal,
      runTotalUsd: runTotal,
    });
    if (!cap.ok) {
      items.push({
        id: probe.id,
        status: "SKIP",
        detail: `cost cap (${cap.reason}): ${cap.detail}`,
        anchor: probe.anchor,
      });
      surfaces[surfaceKeyFor(probe.kind)] = makeSurface("SKIP", cap.detail);
      continue;
    }
    const input = probe.build(runDir, prompt);
    const result = await deps.spawn(input);
    writeArtifactSet(runDir, probe.id, result, prompt, deps);

    const status = probeStatus(result);
    items.push({
      id: probe.id,
      status,
      detail:
        status === "PASS"
          ? `argv: ${input.cmd} ${input.args.join(" ")}`
          : summarizeFailure(probe.id, result, env),
      anchor: probe.anchor,
    });
    surfaces[surfaceKeyFor(probe.kind)] = makeSurface(
      status,
      status === "PASS" ? "live 1-shot ok" : summarizeFailure(probe.id, result, env),
    );

    // Append ledger AFTER spawn (only if we actually spawned).
    const entry: CostLedgerEntry = {
      ts: now.toISOString(),
      kind: probe.kind,
      estimated_usd: probe.estimatedUsd,
      run_dir: runDir,
    };
    appendLedger(ledgerPath, entry, { appendFile: deps.appendLedger });
    dailyTotal += probe.estimatedUsd;
    runTotal += probe.estimatedUsd;
  }

  // failure markdown (if any FAIL).
  let failureMdPath: string | undefined;
  if (items.some((it) => it.status === "FAIL")) {
    failureMdPath = writeFailureMd(runDir, items, deps);
  }

  const verifiedAuthModelPath = writeVerifiedAuthModel(runDir, surfaces, now, deps);
  return { items, runDir, verifiedAuthModelPath, failureMdPath };
}

function surfaceKeyFor(kind: string): string {
  if (kind === "claude.smoke") return "claude";
  if (kind === "codex.qwen.smoke") return "codex_qwen";
  return "codex";
}

function writeVerifiedAuthModel(
  runDir: string,
  surfaces: Record<string, VerifiedAuthSurface>,
  now: Date,
  deps: Stage3Deps,
): string {
  const writeFile =
    deps.writeFile ?? ((p, c) => writeFileSync(p, c, { encoding: "utf8" }));
  const path = resolve(runDir, "verified-auth-model.json");
  const value: VerifiedAuthModel = {
    generatedAt: now.toISOString(),
    claude: surfaces.claude!,
    codex: surfaces.codex!,
    codex_qwen: surfaces.codex_qwen!,
    gh: surfaces.gh!,
  };
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeFailureMd(
  runDir: string,
  items: HealthcheckItem[],
  deps: Stage3Deps,
): string {
  const writeFile =
    deps.writeFile ?? ((p, c) => writeFileSync(p, c, { encoding: "utf8" }));
  const path = resolve(runDir, "healthcheck-failure.md");
  const failed = items.filter((it) => it.status === "FAIL");
  const lines: string[] = [
    "# healthcheck stage 3 — FAILURE",
    "",
    `Failed items (${failed.length}):`,
    "",
  ];
  for (const it of failed) {
    lines.push(`- **${it.id}** (${it.anchor}): ${it.detail}`);
    lines.push(`  - artifacts: \`${it.id}.stdout\` / \`${it.id}.stderr\` / \`${it.id}.exit\` / \`${it.id}.md\``);
  }
  lines.push("");
  lines.push("## next steps");
  lines.push("");
  lines.push("1. Inspect the per-probe `<probe>.stderr` for the upstream error.");
  lines.push("2. Re-authenticate the failing CLI (`claude /login`, `codex auth login`).");
  lines.push("3. Re-run with `LLM_TEAM_LIVE_HEALTHCHECK=1 npm run healthcheck:stage3`.");
  lines.push("");
  writeFile(path, lines.join("\n"));
  return path;
}
