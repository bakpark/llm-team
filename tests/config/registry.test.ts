import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/llm-runner/claude-code.js";
import { CodexCliAdapter } from "../../src/adapters/llm-runner/codex-cli.js";
import { FakeAdapter } from "../../src/adapters/llm-runner/fake.js";
import {
  buildRunnerRegistry,
  createAdapter,
} from "../../src/config/runner-registry.js";
import { parseTargetConfig } from "../../src/config/target-schema.js";

describe("target-schema", () => {
  it("rejects unknown runner ids", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: {
          atlas: { runner: "nope" },
          forge: { runner: "claude_code" },
          sentinel: { runner: "claude_code" },
          scout: { runner: "claude_code" },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown keys via .strict()", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: {
          atlas: { runner: "claude_code", typo_key: "x" },
          forge: { runner: "claude_code" },
          sentinel: { runner: "claude_code" },
          scout: { runner: "claude_code" },
        },
      }),
    ).toThrow();
  });

  it("accepts a fully populated profile set", () => {
    const cfg = parseTargetConfig({
      agent_profiles: {
        atlas: { runner: "claude_code", model: "claude-opus-4-7" },
        forge: { runner: "codex_cli", model: "gpt-5.4", profile: "coder" },
        sentinel: { runner: "claude_code", model: "claude-sonnet-4-6" },
        scout: { runner: "claude_code", model: "claude-haiku-4-5" },
      },
    });
    expect(cfg.agent_profiles.atlas.model).toBe("claude-opus-4-7");
  });
});

describe("createAdapter", () => {
  it("returns ClaudeCodeAdapter for runner=claude_code", () => {
    const a = createAdapter({ runner: "claude_code", model: "x" });
    expect(a).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns CodexCliAdapter for runner=codex_cli", () => {
    const a = createAdapter({ runner: "codex_cli" });
    expect(a).toBeInstanceOf(CodexCliAdapter);
  });

  it("returns FakeAdapter when LLM_TEAM_FAKE_FIXTURE_DIR is set", () => {
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = "/tmp/fake";
    const a = createAdapter({ runner: "fake" });
    expect(a).toBeInstanceOf(FakeAdapter);
  });

  it("throws for fake runner without LLM_TEAM_FAKE_FIXTURE_DIR", () => {
    delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    expect(() => createAdapter({ runner: "fake" })).toThrow();
  });
});

describe("buildRunnerRegistry", () => {
  it("returns ports for the four LLM profiles only (no human)", () => {
    const cfg = parseTargetConfig({
      agent_profiles: {
        atlas: { runner: "claude_code" },
        forge: { runner: "codex_cli" },
        sentinel: { runner: "claude_code" },
        scout: { runner: "claude_code" },
      },
    });
    const reg = buildRunnerRegistry(cfg);
    expect(Object.keys(reg).sort()).toEqual([
      "atlas",
      "forge",
      "scout",
      "sentinel",
    ]);
    for (const port of Object.values(reg)) {
      expect(typeof port.invoke).toBe("function");
    }
  });
});
