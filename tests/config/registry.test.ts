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

describe("target.governance", () => {
  const baseProfiles = {
    atlas: { runner: "claude_code" },
    forge: { runner: "claude_code" },
    sentinel: { runner: "claude_code" },
    scout: { runner: "claude_code" },
  } as const;

  it("accepts a fully populated governance block with defaults", () => {
    const cfg = parseTargetConfig({
      agent_profiles: baseProfiles,
      governance: {
        human_team: "myorg/approvers",
        control_issue_number: 1,
        contract_change_issue_number: 2,
      },
    });
    expect(cfg.governance?.human_team).toBe("myorg/approvers");
    expect(cfg.governance?.control_issue_number).toBe(1);
    expect(cfg.governance?.contract_change_issue_number).toBe(2);
    // defaults
    expect(cfg.governance?.signal_command_prefix).toBe("/");
    expect(cfg.governance?.human_team_cache_ttl_seconds).toBe(300);
    expect(cfg.governance?.unauthorized_author_alert).toBe(false);
  });

  it("permits explicit override of optional fields", () => {
    const cfg = parseTargetConfig({
      agent_profiles: baseProfiles,
      governance: {
        human_team: "myorg/approvers",
        control_issue_number: 10,
        contract_change_issue_number: 11,
        signal_command_prefix: ":",
        human_team_cache_ttl_seconds: 60,
        unauthorized_author_alert: true,
      },
    });
    expect(cfg.governance?.signal_command_prefix).toBe(":");
    expect(cfg.governance?.human_team_cache_ttl_seconds).toBe(60);
    expect(cfg.governance?.unauthorized_author_alert).toBe(true);
  });

  it("default human_team_cache_ttl_seconds matches TCC-GOVERNANCE doc value (300)", () => {
    const cfg = parseTargetConfig({
      agent_profiles: baseProfiles,
      governance: {
        human_team: "myorg/approvers",
        control_issue_number: 1,
        contract_change_issue_number: 2,
        human_team_cache_ttl_seconds: 300,
      },
    });
    expect(cfg.governance?.human_team_cache_ttl_seconds).toBe(300);
  });

  it("rejects governance with missing required field", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: baseProfiles,
        governance: {
          // human_team missing
          control_issue_number: 1,
          contract_change_issue_number: 2,
        },
      }),
    ).toThrow();
  });

  it("rejects unknown governance keys via .strict()", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 1,
          contract_change_issue_number: 2,
          typo_key: "x",
        },
      }),
    ).toThrow();
  });

  it("rejects non-positive issue numbers", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 0,
          contract_change_issue_number: 2,
        },
      }),
    ).toThrow();
  });

  it("permits omitting the governance block entirely", () => {
    const cfg = parseTargetConfig({ agent_profiles: baseProfiles });
    expect(cfg.governance).toBeUndefined();
  });
});
