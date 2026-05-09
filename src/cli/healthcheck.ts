#!/usr/bin/env -S node --enable-source-maps
/**
 * Phase prod-1 — Non-Live Preflight Healthcheck CLI.
 *
 * Stage 1 fail-fast (~5s, no live LLM) probes for:
 *   - required binaries (claude, codex, gh, git, node; jq optional)
 *   - git worktree support (>= 2.5)
 *   - node engine match against package.json#engines.node (>= 20)
 *   - vitest list (project tests are runnable)
 *   - gh auth status / gh api user (network)
 *   - GH_TOKEN or `gh auth token` presence
 *   - timeout / gtimeout availability
 *   - claude/codex non-live auth subcommand probe
 *
 * Stage 1 records `npm run typecheck` / `npm run build` as SKIP because
 * those compiles exceed the 5s fail-fast budget; they are gated by the PR
 * build workflow and the planning checklist anchors M-1-5 / M-1-6.
 *
 * Stage 2/3 are reserved for phase-prod-3. Invoking with `--stage 2|3`
 * emits a placeholder "stage X is implemented in phase-prod-3" message.
 *
 * Usage:
 *   tsx src/cli/healthcheck.ts --stage 1 [--target <path>] [--out <dir>]
 *     [--json]
 */
import { spawn as nodeSpawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HealthcheckResult,
  type AuthModel,
  type AuthModels,
  type HealthcheckItem,
  type HealthcheckStage,
} from "./healthcheck-schema.js";
import { runStage2, type Stage2Fetch } from "./healthcheck-stage2.js";
import {
  runStage3,
  type Stage3Spawn,
  type Stage3SpawnInput,
} from "./healthcheck-stage3.js";

export type RunCmd = (
  cmd: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

const defaultRunCmd: RunCmd = (cmd, args, options) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 5_000,
    ...options,
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
};

export interface HealthcheckArgs {
  stage: HealthcheckStage;
  targetPath?: string;
  outDir?: string;
  json: boolean;
}

export interface HealthcheckEnv {
  run?: RunCmd;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  /** Stage 2 — HTTP probe (qwen ping). Defaults to global `fetch`. */
  fetch?: Stage2Fetch;
  /** Stage 3 — child spawn (mocked in tests). Defaults to a real spawn that
   * honors `stdinFromDevNull` for codex invocations. */
  stage3Spawn?: Stage3Spawn;
  /** Stage 3 — workdir override for RUN_DIR / cost ledger (tests). */
  stage3Workdir?: string;
  /** Stage 3 — homedir override (tests). */
  stage3Home?: string;
  /** Stage 3 — readLedger override (tests). */
  stage3ReadLedger?: (path: string) => string;
  /** Stage 3 — appendLedger override (tests). */
  stage3AppendLedger?: (path: string, line: string) => void;
  /** Stage 3 — mkdir override (tests). */
  stage3Mkdir?: (
    path: string,
    opts: { recursive: true; mode?: number },
  ) => void;
  /** Stage 3 — writeFile override (tests). */
  stage3WriteFile?: (path: string, content: string) => void;
}

export function parseArgs(argv: readonly string[]): HealthcheckArgs {
  const a = [...argv];
  const out: HealthcheckArgs = {
    stage: 1,
    json: false,
  };
  while (a.length > 0) {
    const flag = a.shift()!;
    switch (flag) {
      case "--stage": {
        const v = a.shift();
        if (v !== "1" && v !== "2" && v !== "3")
          throw new Error(`--stage must be 1|2|3 (got ${v ?? "<missing>"})`);
        out.stage = (Number.parseInt(v, 10) as HealthcheckStage);
        break;
      }
      case "--target":
        out.targetPath = a.shift();
        break;
      case "--out":
        out.outDir = a.shift();
        break;
      case "--json":
        out.json = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return out;
}

function commandExists(run: RunCmd, name: string): boolean {
  const r = run("command", ["-v", name], { shell: true });
  return r.status === 0 && r.stdout.trim().length > 0;
}

/**
 * Per-run probe cache. The same `gh auth status` and `<bin> --help` outputs
 * are consumed by both auth-model detection and the M-2-1/M-2-5 items, so we
 * memoize them for the lifetime of a single healthcheck invocation.
 */
interface ProbeCache {
  ghAuthStatus?: { status: number | null; stdout: string; stderr: string };
  cliHelp: Map<string, { status: number | null; stdout: string; stderr: string }>;
}

function newProbeCache(): ProbeCache {
  return { cliHelp: new Map() };
}

function probeGhAuthStatus(
  run: RunCmd,
  cache: ProbeCache,
): { status: number | null; stdout: string; stderr: string } {
  if (!cache.ghAuthStatus) cache.ghAuthStatus = run("gh", ["auth", "status"]);
  return cache.ghAuthStatus;
}

function probeCliHelp(
  run: RunCmd,
  cache: ProbeCache,
  bin: string,
): { status: number | null; stdout: string; stderr: string } {
  const hit = cache.cliHelp.get(bin);
  if (hit) return hit;
  const r = run(bin, ["--help"]);
  cache.cliHelp.set(bin, r);
  return r;
}

/** Parses output of `git --version`, e.g. "git version 2.43.0". */
function parseGitVersion(s: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Parses node version, e.g. "v20.10.0" or "20.10.0". */
function parseNodeVersion(s: string): [number, number, number] | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gteVersion(
  v: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function detectGhAuthModel(
  run: RunCmd,
  env: NodeJS.ProcessEnv,
  cache: ProbeCache,
): AuthModel {
  if (env.GH_TOKEN && env.GH_TOKEN.length > 0) return "env_token";
  // `gh auth status` mentions "keyring" / "Keychain" when the credential is
  // stored via the OS credential store; otherwise default to "other".
  const r = probeGhAuthStatus(run, cache);
  const text = `${r.stdout}\n${r.stderr}`;
  if (/keychain|keyring/i.test(text)) return "keychain";
  if (r.status === 0) return "other";
  return "unknown";
}

function detectCliAuthModel(
  run: RunCmd,
  bin: string,
  env: NodeJS.ProcessEnv,
  cache: ProbeCache,
): AuthModel {
  if (!commandExists(run, bin)) return "unknown";
  const tokenEnv = bin === "claude" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (tokenEnv && tokenEnv.length > 0) return "env_token";
  // Probe the help output for an `auth` / `login` subcommand. The exact
  // contract is defined in phase-prod-3; here we only positively classify
  // when the subcommand surface looks plausible, otherwise leave it as
  // `UNKNOWN_UNTIL_STAGE3` so operators know stage 3 will resolve it.
  const help = probeCliHelp(run, cache, bin);
  const text = `${help.stdout}\n${help.stderr}`;
  if (/\bauth\b/i.test(text) || /\blogin\b/i.test(text)) {
    return "interactive_only";
  }
  return "UNKNOWN_UNTIL_STAGE3";
}

function readEngineNodeMin(cwd: string): [number, number, number] | null {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(cwd, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    const range = pkg.engines?.node;
    if (!range) return null;
    const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
    if (!m) return null;
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  } catch {
    return null;
  }
}

export function runStage1(opts: {
  run: RunCmd;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): { items: HealthcheckItem[]; auth_models: AuthModels } {
  const { run, env, cwd } = opts;
  const items: HealthcheckItem[] = [];
  const cache = newProbeCache();

  // M-1-1 — required binaries (jq optional, SKIP if missing).
  const required = ["claude", "codex", "gh", "git", "node"] as const;
  const missing = required.filter((b) => !commandExists(run, b));
  items.push({
    id: "M-1-1.required-bins",
    status: missing.length === 0 ? "PASS" : "FAIL",
    detail:
      missing.length === 0
        ? `found: ${required.join(", ")}`
        : `missing: ${missing.join(", ")}`,
    anchor: "M-1-1",
  });
  items.push({
    id: "M-1-1.jq",
    status: commandExists(run, "jq") ? "PASS" : "SKIP",
    detail: commandExists(run, "jq") ? "jq present" : "jq optional, not found",
    anchor: "M-1-1",
  });

  // M-1-2 — git worktree support (>= 2.5).
  const gitV = run("git", ["--version"]);
  const gitVer = parseGitVersion(gitV.stdout);
  items.push({
    id: "M-1-2.git-worktree",
    status:
      gitV.status === 0 && gitVer != null && gteVersion(gitVer, [2, 5, 0])
        ? "PASS"
        : "FAIL",
    detail:
      gitVer != null
        ? `git ${gitVer.join(".")} (>= 2.5 required)`
        : `git --version unparsable: ${gitV.stdout.trim() || gitV.stderr.trim()}`,
    anchor: "M-1-2",
  });

  // M-1-3 — node version vs package.json#engines.
  const nodeV = run("node", ["--version"]);
  const nodeVer = parseNodeVersion(nodeV.stdout);
  const minNode = readEngineNodeMin(cwd) ?? [20, 0, 0];
  items.push({
    id: "M-1-3.node-engine",
    status:
      nodeV.status === 0 && nodeVer != null && gteVersion(nodeVer, minNode)
        ? "PASS"
        : "FAIL",
    detail:
      nodeVer != null
        ? `node ${nodeVer.join(".")} (>= ${minNode.join(".")} required)`
        : `node --version unparsable`,
    anchor: "M-1-3",
  });

  // M-1-4 — vitest list (project tests are runnable). Use --reporter=dot
  // and `--listFiles` lite-substitute by invoking `vitest list`. Falls back
  // to a non-zero status as FAIL.
  const vitestList = run("npx", ["--no-install", "vitest", "list"], {
    cwd,
  });
  items.push({
    id: "M-1-4.vitest-list",
    status: vitestList.status === 0 ? "PASS" : "FAIL",
    detail:
      vitestList.status === 0
        ? "vitest list ok"
        : `vitest list failed: ${(vitestList.stderr || vitestList.stdout).trim().slice(0, 160)}`,
    anchor: "M-1-4",
  });

  // M-1-5 — typecheck. Stage 1 is a 5s fail-fast probe and `npm run
  // typecheck` is a multi-second compile, so it is always SKIP here. The
  // PR build (.github/workflows) and `npm run typecheck` cover this gate.
  items.push({
    id: "M-1-5.typecheck",
    status: "SKIP",
    detail: "out of stage-1 fail-fast budget; run `npm run typecheck` separately",
    anchor: "M-1-5",
  });

  // M-1-6 — build. Same reasoning as M-1-5.
  items.push({
    id: "M-1-6.build",
    status: "SKIP",
    detail: "out of stage-1 fail-fast budget; run `npm run build` separately",
    anchor: "M-1-6",
  });

  // M-2-1 — gh auth status.
  const ghAuth = probeGhAuthStatus(run, cache);
  items.push({
    id: "M-2-1.gh-auth-status",
    status: ghAuth.status === 0 ? "PASS" : "FAIL",
    detail:
      ghAuth.status === 0
        ? "gh authenticated"
        : `gh auth status failed: ${(ghAuth.stderr || ghAuth.stdout).trim().slice(0, 160)}`,
    anchor: "M-2-1",
  });

  // M-2-2 — gh api user --jq .login (network).
  const ghUser = run("gh", ["api", "user", "--jq", ".login"]);
  items.push({
    id: "M-2-2.gh-api-user",
    status:
      ghUser.status === 0 && ghUser.stdout.trim().length > 0 ? "PASS" : "FAIL",
    detail:
      ghUser.status === 0
        ? `login=${ghUser.stdout.trim()}`
        : `gh api user failed: ${(ghUser.stderr || ghUser.stdout).trim().slice(0, 160)}`,
    anchor: "M-2-2",
  });

  // M-2-3 — GH_TOKEN or `gh auth token`.
  let tokenPresent = !!(env.GH_TOKEN && env.GH_TOKEN.length > 0);
  if (!tokenPresent) {
    const tok = run("gh", ["auth", "token"]);
    tokenPresent = tok.status === 0 && tok.stdout.trim().length > 0;
  }
  items.push({
    id: "M-2-3.gh-token",
    status: tokenPresent ? "PASS" : "FAIL",
    detail: tokenPresent ? "token reachable" : "no GH_TOKEN and `gh auth token` failed",
    anchor: "M-2-3",
  });

  // M-2-4 — `timeout` or `gtimeout`.
  const hasTimeout = commandExists(run, "timeout") || commandExists(run, "gtimeout");
  items.push({
    id: "M-2-4.timeout-bin",
    status: hasTimeout ? "PASS" : "FAIL",
    detail: hasTimeout ? "timeout available" : "neither timeout nor gtimeout present",
    anchor: "M-2-4",
  });

  // M-2-5 — claude/codex non-live auth subcommand probe.
  const claudeProbe = commandExists(run, "claude")
    ? probeCliHelp(run, cache, "claude")
    : null;
  const codexProbe = commandExists(run, "codex")
    ? probeCliHelp(run, cache, "codex")
    : null;
  const claudeText = claudeProbe ? `${claudeProbe.stdout}\n${claudeProbe.stderr}` : "";
  const codexText = codexProbe ? `${codexProbe.stdout}\n${codexProbe.stderr}` : "";
  const claudeAuthSurface = /\bauth\b/i.test(claudeText) || /\blogin\b/i.test(claudeText);
  const codexAuthSurface = /\bauth\b/i.test(codexText) || /\blogin\b/i.test(codexText);
  if (claudeProbe == null || codexProbe == null) {
    items.push({
      id: "M-2-5.cli-auth-subcmd",
      status: "SKIP",
      detail: "claude or codex not present; UNKNOWN_UNTIL_STAGE3",
      anchor: "M-2-5",
    });
  } else if (claudeAuthSurface && codexAuthSurface) {
    items.push({
      id: "M-2-5.cli-auth-subcmd",
      status: "PASS",
      detail: "claude + codex expose an auth/login surface",
      anchor: "M-2-5",
    });
  } else {
    items.push({
      id: "M-2-5.cli-auth-subcmd",
      status: "SKIP",
      detail: "auth/login subcommand not detected; UNKNOWN_UNTIL_STAGE3",
      anchor: "M-2-5",
    });
  }

  const auth_models: AuthModels = {
    claude: detectCliAuthModel(run, "claude", env, cache),
    codex: detectCliAuthModel(run, "codex", env, cache),
    gh: detectGhAuthModel(run, env, cache),
  };

  return { items, auth_models };
}

export async function runHealthcheck(
  args: HealthcheckArgs,
  envCfg: HealthcheckEnv = {},
): Promise<HealthcheckResult> {
  const run = envCfg.run ?? defaultRunCmd;
  const env = envCfg.env ?? process.env;
  const cwd = envCfg.cwd ?? process.cwd();
  const now = envCfg.now ?? (() => new Date());
  const generatedAt = now().toISOString();

  if (args.stage === 2) {
    const out = await runStage2({
      env,
      run,
      fetch: envCfg.fetch ?? (typeof fetch !== "undefined" ? defaultFetch : undefined),
      now,
    });
    const passed = out.items.every((it) => it.status !== "FAIL");
    const result: HealthcheckResult = {
      stage: 2,
      items: out.items,
      passed,
      generatedAt,
      // stage 2 does not re-classify CLI auth models; preserve neutral state.
      auth_models: {
        claude: "UNKNOWN_UNTIL_STAGE3",
        codex: "UNKNOWN_UNTIL_STAGE3",
        gh: env.GH_TOKEN && env.GH_TOKEN.length > 0 ? "env_token" : "unknown",
      },
    };
    return HealthcheckResult.parse(result);
  }

  if (args.stage === 3) {
    // Default-SKIP gate: without `LLM_TEAM_LIVE_HEALTHCHECK=1`, stage 3 must
    // not spawn anything AND must not run stage 2's network probes (qwen
    // ping, gh rate_limit). Return a SKIP-only result so an unauthenticated
    // host on a CI runner cannot accidentally fail this stage.
    if (env.LLM_TEAM_LIVE_HEALTHCHECK !== "1") {
      const skipItem: HealthcheckItem = {
        id: "M-3-opt-in",
        status: "SKIP",
        detail:
          "LLM_TEAM_LIVE_HEALTHCHECK not set to '1'; stage 3 (and its stage-2 prerequisites) skipped (no spawn, no network)",
        anchor: "M-3-0",
      };
      const result: HealthcheckResult = {
        stage: 3,
        items: [skipItem],
        passed: true,
        generatedAt,
        auth_models: {
          claude: "UNKNOWN_UNTIL_STAGE3",
          codex: "UNKNOWN_UNTIL_STAGE3",
          gh: env.GH_TOKEN && env.GH_TOKEN.length > 0 ? "env_token" : "unknown",
        },
      };
      return HealthcheckResult.parse(result);
    }
    // Stage 3 needs the qwen ping outcome to gate codex-qwen smoke. Run
    // stage 2 first as a prerequisite (its own probes also surface in the
    // stage-3 result so an operator sees the full picture).
    const s2 = await runStage2({
      env,
      run,
      fetch: envCfg.fetch ?? (typeof fetch !== "undefined" ? defaultFetch : undefined),
      now,
    });
    const s3 = await runStage3({
      env,
      spawn: envCfg.stage3Spawn ?? defaultStage3Spawn,
      qwenPassed: s2.qwenPassed,
      now,
      readLedger: envCfg.stage3ReadLedger,
      appendLedger: envCfg.stage3AppendLedger,
      mkdir: envCfg.stage3Mkdir,
      writeFile: envCfg.stage3WriteFile,
      home: envCfg.stage3Home,
      workdir: envCfg.stage3Workdir,
    });
    const items = [...s2.items, ...s3.items];
    const passed = items.every((it) => it.status !== "FAIL");
    const surface = (id: string): AuthModel => {
      const it = s3.items.find((x) => x.anchor === id);
      if (!it) return "UNKNOWN_UNTIL_STAGE3";
      if (it.status === "PASS") return "interactive_only";
      if (it.status === "FAIL") return "unknown";
      return "UNKNOWN_UNTIL_STAGE3";
    };
    const result: HealthcheckResult = {
      stage: 3,
      items,
      passed,
      generatedAt,
      auth_models: {
        claude: surface("M-3-claude"),
        codex: surface("M-3-codex"),
        gh: env.GH_TOKEN && env.GH_TOKEN.length > 0 ? "env_token" : "unknown",
      },
    };
    return HealthcheckResult.parse(result);
  }

  const { items, auth_models } = runStage1({
    run,
    env,
    cwd,
  });
  const passed = items.every((it) => it.status !== "FAIL");
  const result: HealthcheckResult = {
    stage: 1,
    items,
    passed,
    generatedAt,
    auth_models,
  };
  return HealthcheckResult.parse(result);
}

/**
 * Default Stage 2 fetch — uses the Node 20+ global `fetch`.
 */
const defaultFetch: Stage2Fetch = (url, init) =>
  // eslint-disable-next-line no-undef
  fetch(url, init).then((r) => ({
    status: r.status,
    text: () => r.text(),
  }));

/**
 * Default Stage 3 spawn — wraps `child_process.spawn` and honors
 * `stdinFromDevNull` (codex contract).
 */
const defaultStage3Spawn: Stage3Spawn = (input: Stage3SpawnInput) =>
  new Promise((resolveSpawn) => {
    const stdinSpec = input.stdinFromDevNull ? "ignore" : "pipe";
    const child = nodeSpawn(input.cmd, [...input.args], {
      cwd: input.cwd,
      stdio: [stdinSpec, "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    if (!input.stdinFromDevNull && input.stdin != null && child.stdin) {
      child.stdin.end(input.stdin, "utf8");
    } else if (!input.stdinFromDevNull && child.stdin) {
      child.stdin.end();
    }
    child.on("close", (code) => {
      clearTimeout(t);
      resolveSpawn({ status: code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(t);
      resolveSpawn({
        status: null,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        timedOut,
      });
    });
  });

function writeOutFile(
  result: HealthcheckResult,
  args: HealthcheckArgs,
  cwd: string,
): string | null {
  if (!args.outDir) return null;
  const target = args.targetPath ?? "default";
  const targetSlug = target.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const dir = resolve(cwd, args.outDir, targetSlug, "healthcheck");
  mkdirSync(dir, { recursive: true });
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const path = resolve(dir, `${stamp}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2), "utf8");
  return path;
}

export interface MainDeps extends HealthcheckEnv {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Suppress filesystem side-effect when --out is set (used in tests). */
  skipOutFile?: boolean;
}

export async function main(
  argv: readonly string[],
  deps: MainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const args = parseArgs(argv);
  const result = await runHealthcheck(args, deps);
  if (!deps.skipOutFile) writeOutFile(result, args, deps.cwd ?? process.cwd());
  if (args.json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    stdout(
      `stage=${result.stage} passed=${result.passed} items=${result.items.length}\n`,
    );
    for (const it of result.items) {
      stdout(`  [${it.status}] ${it.anchor} ${it.id} — ${it.detail}\n`);
    }
    stdout(
      `auth_models: claude=${result.auth_models.claude} codex=${result.auth_models.codex} gh=${result.auth_models.gh}\n`,
    );
  }
  return result.passed ? 0 : 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exit(2);
    },
  );
}
