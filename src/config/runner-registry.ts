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

/**
 * Options for {@link buildRunnerRegistry} / {@link createAdapter}.
 *
 * `allowFake` gates the test-only `fake` runner. The schema still parses
 * `runner: "fake"` (the same TargetConfig is used by tests and by
 * production callers), but production CLI entrypoints pass
 * `allowFake: false` so a target.json that smuggles `runner: "fake"`
 * cannot route a production daemon to the FakeAdapter even if
 * `LLM_TEAM_FAKE_FIXTURE_DIR` happens to be set in the environment
 * (PR #73 review).
 */
export interface BuildRegistryOptions {
  allowFake?: boolean;
}

export function buildRunnerRegistry(
  target: TargetConfig,
  options: BuildRegistryOptions = {},
): LlmRunnerRegistry {
  const adapters: Record<LlmAgentProfileId, LlmRunnerAdapter> = {
    atlas: createAdapter(target.agent_profiles.atlas, options),
    forge: createAdapter(target.agent_profiles.forge, options),
    sentinel: createAdapter(target.agent_profiles.sentinel, options),
    scout: createAdapter(target.agent_profiles.scout, options),
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

export function createAdapter(
  p: ProfileCfg,
  options: BuildRegistryOptions = {},
): LlmRunnerAdapter {
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
      // PR #73 review (P1): fake runner is test-only. Production CLI
      // entrypoints pass `allowFake: false` (the default) so a target.json
      // with `runner: "fake"` can never route to FakeAdapter from the
      // production code path, even if `LLM_TEAM_FAKE_FIXTURE_DIR` is set.
      if (!options.allowFake) {
        throw new Error(
          "fake runner is test-only and not permitted in production wiring " +
            "(pass allowFake:true from a test harness or use the " +
            "--fake-llm-fixtures CLI override)",
        );
      }
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
