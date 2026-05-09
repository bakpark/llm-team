import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/llm-runner/claude-code.js";
import { CodexCliAdapter } from "../../src/adapters/llm-runner/codex-cli.js";
import { FakeAdapter } from "../../src/adapters/llm-runner/fake.js";
import {
  buildRunnerRegistry,
  createAdapter,
} from "../../src/config/runner-registry.js";
import { parseTargetConfig } from "../../src/config/target-schema.js";

const ID = { target_id: "demo-target" };

describe("target-schema", () => {
  it("rejects unknown runner ids", () => {
    expect(() =>
      parseTargetConfig({
        identity: ID,
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
        identity: ID,
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
      identity: ID,
      agent_profiles: {
        atlas: { runner: "claude_code", model: "claude-opus-4-7" },
        forge: { runner: "codex_cli", model: "gpt-5.4", profile: "coder" },
        sentinel: { runner: "claude_code", model: "claude-sonnet-4-6" },
        scout: { runner: "claude_code", model: "claude-haiku-4-5" },
      },
    });
    expect(cfg.agent_profiles.atlas.model).toBe("claude-opus-4-7");
  });

  it("requires identity.target_id", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: {
          atlas: { runner: "claude_code" },
          forge: { runner: "claude_code" },
          sentinel: { runner: "claude_code" },
          scout: { runner: "claude_code" },
        },
      }),
    ).toThrow();
  });

  it("accepts identity with optional workdir_path and audit_hash_seed", () => {
    const cfg = parseTargetConfig({
      identity: {
        target_id: "demo-target",
        workdir_path: "/tmp/workdir",
        audit_hash_seed: "seed-1",
        label_prefix: "demo:",
      },
      agent_profiles: {
        atlas: { runner: "claude_code" },
        forge: { runner: "claude_code" },
        sentinel: { runner: "claude_code" },
        scout: { runner: "claude_code" },
      },
    });
    expect(cfg.identity.target_id).toBe("demo-target");
    expect(cfg.identity.workdir_path).toBe("/tmp/workdir");
    expect(cfg.identity.audit_hash_seed).toBe("seed-1");
    expect(cfg.identity.label_prefix).toBe("demo:");
  });

  it("rejects identity with empty target_id", () => {
    expect(() =>
      parseTargetConfig({
        identity: { target_id: "" },
        agent_profiles: {
          atlas: { runner: "claude_code" },
          forge: { runner: "claude_code" },
          sentinel: { runner: "claude_code" },
          scout: { runner: "claude_code" },
        },
      }),
    ).toThrow();
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

  it("returns FakeAdapter when allowFake:true and LLM_TEAM_FAKE_FIXTURE_DIR is set", () => {
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = "/tmp/fake";
    const a = createAdapter({ runner: "fake" }, { allowFake: true });
    expect(a).toBeInstanceOf(FakeAdapter);
  });

  it("throws for fake runner without LLM_TEAM_FAKE_FIXTURE_DIR (allowFake:true)", () => {
    delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    expect(() =>
      createAdapter({ runner: "fake" }, { allowFake: true }),
    ).toThrow(/LLM_TEAM_FAKE_FIXTURE_DIR/);
  });

  it("PR #73 review (P1): rejects fake runner in production path (allowFake omitted)", () => {
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = "/tmp/fake";
    expect(() => createAdapter({ runner: "fake" })).toThrow(/test-only/);
  });
});

describe("buildRunnerRegistry", () => {
  it("returns ports for the four LLM profiles only (no human)", () => {
    const cfg = parseTargetConfig({
      identity: ID,
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
      identity: ID,
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
    expect(cfg.governance?.signal_command_prefix).toBe("/");
    expect(cfg.governance?.human_team_cache_ttl_seconds).toBe(300);
    expect(cfg.governance?.unauthorized_author_alert).toBe(false);
  });

  it("permits explicit override of optional fields", () => {
    const cfg = parseTargetConfig({
      identity: ID,
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
      identity: ID,
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
        identity: ID,
        agent_profiles: baseProfiles,
        governance: {
          control_issue_number: 1,
          contract_change_issue_number: 2,
        },
      }),
    ).toThrow();
  });

  it("rejects unknown governance keys via .strict()", () => {
    expect(() =>
      parseTargetConfig({
        identity: ID,
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
        identity: ID,
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
    const cfg = parseTargetConfig({
      identity: ID,
      agent_profiles: baseProfiles,
    });
    expect(cfg.governance).toBeUndefined();
  });

  it("rejects negative human_team_cache_ttl_seconds", () => {
    expect(() =>
      parseTargetConfig({
        identity: ID,
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 1,
          contract_change_issue_number: 2,
          human_team_cache_ttl_seconds: -1,
        },
      }),
    ).toThrow();
  });

  it("rejects non-integer issue numbers", () => {
    expect(() =>
      parseTargetConfig({
        identity: ID,
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 1.5,
          contract_change_issue_number: 2,
        },
      }),
    ).toThrow();
  });

  it("rejects empty signal_command_prefix", () => {
    expect(() =>
      parseTargetConfig({
        identity: ID,
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 1,
          contract_change_issue_number: 2,
          signal_command_prefix: "",
        },
      }),
    ).toThrow();
  });

  it("rejects identical control_issue_number and contract_change_issue_number", () => {
    expect(() =>
      parseTargetConfig({
        identity: ID,
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 7,
          contract_change_issue_number: 7,
        },
      }),
    ).toThrow();
  });
});
