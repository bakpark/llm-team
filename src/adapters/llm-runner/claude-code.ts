import {
  applyCapabilityEnvStrip,
  claudeCodeCapabilityFlags,
} from "./common/capability.js";
import { resolveSpawnEnv, spawnWithTimeout } from "./common/spawn.js";
import type {
  LlmAdapterInput,
  LlmAdapterResult,
  LlmRunnerAdapter,
} from "./types.js";

export interface ClaudeCodeAdapterCfg {
  command?: string;
  model?: string;
  extraArgs?: string[];
  killGraceMs?: number;
  /** Optional env allowlist (defaults to inheriting process.env). */
  envAllowlist?: readonly string[];
  /** Optional env additions/overrides applied after the allowlist filter. */
  envOverride?: NodeJS.ProcessEnv;
}

export class ClaudeCodeAdapter implements LlmRunnerAdapter {
  readonly id = "claude_code" as const;

  constructor(private readonly cfg: ClaudeCodeAdapterCfg = {}) {}

  async run(input: LlmAdapterInput): Promise<LlmAdapterResult> {
    const { cmd, args } = this.buildArgv(input);
    // L3 — always apply the capability secret strip on top of allowlist /
    // override; secrets like LLM_TEAM_MACHINE_BLOCK_SECRET must never reach
    // the agent process even if the operator set them via envOverride.
    const baseEnv = resolveSpawnEnv({
      allowlist: this.cfg.envAllowlist,
      override: this.cfg.envOverride,
    });
    const env = applyCapabilityEnvStrip(baseEnv, input.capabilityPolicy);
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

  buildArgv(input?: LlmAdapterInput): { cmd: string; args: string[] } {
    const tokens = (this.cfg.command ?? "claude").split(/\s+/).filter(Boolean);
    const cmd = tokens[0] ?? "claude";
    const baseArgs = tokens.slice(1);
    const flags: string[] = ["-p", "--output-format", "text"];
    if (this.cfg.model) flags.push("--model", this.cfg.model);
    if (input?.capabilityPolicy) {
      flags.push(...claudeCodeCapabilityFlags(input.capabilityPolicy));
    }
    if (this.cfg.extraArgs) flags.push(...this.cfg.extraArgs);
    return { cmd, args: [...baseArgs, ...flags] };
  }
}
