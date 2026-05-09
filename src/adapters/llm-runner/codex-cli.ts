import { resolveSpawnEnv, spawnWithTimeout } from "./common/spawn.js";
import type {
  LlmAdapterInput,
  LlmAdapterResult,
  LlmRunnerAdapter,
} from "./types.js";

export interface CodexCliAdapterCfg {
  command?: string;
  model?: string;
  profile?: string;
  extraArgs?: string[];
  killGraceMs?: number;
  /** Optional env allowlist (defaults to inheriting process.env). */
  envAllowlist?: readonly string[];
  /** Optional env additions/overrides applied after the allowlist filter. */
  envOverride?: NodeJS.ProcessEnv;
}

// Codex CLI invocation:
//   codex exec --skip-git-repo-check --cd <agent_cwd> --color never \
//     [--model <m>] [--profile <p>] [extraArgs...]
// Prompt is delivered via stdin (codex auto-reads stdin when no positional
// PROMPT is provided). This avoids ARG_MAX limits on large prompts.
export class CodexCliAdapter implements LlmRunnerAdapter {
  readonly id = "codex_cli" as const;

  constructor(private readonly cfg: CodexCliAdapterCfg = {}) {}

  async run(input: LlmAdapterInput): Promise<LlmAdapterResult> {
    const { cmd, args } = this.buildArgv(input);
    const env = resolveSpawnEnv({
      allowlist: this.cfg.envAllowlist,
      override: this.cfg.envOverride,
    });
    const r = await spawnWithTimeout({
      cmd,
      args,
      cwd: input.agentCwd,
      env,
      stdin: input.stdin,
      timeoutSec: input.timeoutSec,
      killGraceMs: this.cfg.killGraceMs,
    });
    return { ...r, spawnEnv: env };
  }

  buildArgv(input: LlmAdapterInput): { cmd: string; args: string[] } {
    const tokens = (this.cfg.command ?? "codex").split(/\s+/).filter(Boolean);
    const cmd = tokens[0] ?? "codex";
    const baseArgs = tokens.slice(1);
    const flags: string[] = [
      "exec",
      "--skip-git-repo-check",
      "--cd",
      input.agentCwd,
      "--color",
      "never",
    ];
    if (this.cfg.model) flags.push("--model", this.cfg.model);
    if (this.cfg.profile) flags.push("--profile", this.cfg.profile);
    if (this.cfg.extraArgs) flags.push(...this.cfg.extraArgs);
    return { cmd, args: [...baseArgs, ...flags] };
  }
}
