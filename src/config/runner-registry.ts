import { ClaudeCodeAdapter } from "../adapters/llm-runner/claude-code.js";
import { CodexCliAdapter } from "../adapters/llm-runner/codex-cli.js";
import { FakeAdapter } from "../adapters/llm-runner/fake.js";
import type { LlmRunnerAdapter } from "../adapters/llm-runner/types.js";
import { runInvoke } from "../ports/llm-runner-executor.js";
import type {
  LlmAgentProfileId,
  LlmRunnerInput,
  LlmRunnerPort,
  LlmRunnerResult,
} from "../ports/llm-runner.js";
import type { ProfileCfg, TargetConfig } from "./target-schema.js";

export type LlmRunnerRegistry = Record<LlmAgentProfileId, LlmRunnerPort>;

export function buildRunnerRegistry(target: TargetConfig): LlmRunnerRegistry {
  const adapters: Record<LlmAgentProfileId, LlmRunnerAdapter> = {
    atlas: createAdapter(target.agent_profiles.atlas),
    forge: createAdapter(target.agent_profiles.forge),
    sentinel: createAdapter(target.agent_profiles.sentinel),
    scout: createAdapter(target.agent_profiles.scout),
  };

  const wrap = (a: LlmRunnerAdapter): LlmRunnerPort => ({
    invoke: (input: LlmRunnerInput): Promise<LlmRunnerResult> =>
      runInvoke(input, a),
  });

  return {
    atlas: wrap(adapters.atlas),
    forge: wrap(adapters.forge),
    sentinel: wrap(adapters.sentinel),
    scout: wrap(adapters.scout),
  };
}

export function createAdapter(p: ProfileCfg): LlmRunnerAdapter {
  switch (p.runner) {
    case "claude_code":
      return new ClaudeCodeAdapter({
        command: p.command,
        model: p.model,
        extraArgs: p.extraArgs,
        killGraceMs: p.killGraceMs,
      });
    case "codex_cli":
      return new CodexCliAdapter({
        command: p.command,
        model: p.model,
        profile: p.profile,
        extraArgs: p.extraArgs,
        killGraceMs: p.killGraceMs,
      });
    case "fake": {
      const fixtureDir = process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
      if (!fixtureDir) {
        throw new Error(
          "fake runner requires LLM_TEAM_FAKE_FIXTURE_DIR to be set",
        );
      }
      return new FakeAdapter({ fixtureDir });
    }
  }
}
