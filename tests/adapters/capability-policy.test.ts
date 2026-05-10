import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/llm-runner/claude-code.js";
import { CodexCliAdapter } from "../../src/adapters/llm-runner/codex-cli.js";
import {
  applyCapabilityEnvStrip,
  claudeCodeCapabilityFlags,
  codexCliCapabilityFlags,
} from "../../src/adapters/llm-runner/common/capability.js";
import {
  defaultLeadCapabilityPolicy,
  defaultReviewerCapabilityPolicy,
} from "../../src/domain/schema/agent-capability-policy.js";

const baseInput = {
  stdin: "",
  agentCwd: "/tmp/agent",
  timeoutSec: 0,
};

describe("L1 — claude-code capability flags", () => {
  it("lead default → allowed Read,Edit,Write disallowed Bash,WebFetch,WebSearch", () => {
    const flags = claudeCodeCapabilityFlags(defaultLeadCapabilityPolicy());
    expect(flags).toContain("--allowed-tools");
    const allowed = flags[flags.indexOf("--allowed-tools") + 1];
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Edit");
    expect(allowed).toContain("Write");
    expect(flags).toContain("--disallowed-tools");
    const disallowed = flags[flags.indexOf("--disallowed-tools") + 1];
    expect(disallowed).toContain("Bash");
    expect(disallowed).toContain("WebFetch");
  });

  it("reviewer default → Edit/Write disallowed", () => {
    const flags = claudeCodeCapabilityFlags(defaultReviewerCapabilityPolicy());
    const disallowed = flags[flags.indexOf("--disallowed-tools") + 1];
    expect(disallowed).toContain("Edit");
    expect(disallowed).toContain("Write");
  });

  it("ClaudeCodeAdapter argv injects flags when policy supplied", () => {
    const a = new ClaudeCodeAdapter();
    const { args } = a.buildArgv({
      ...baseInput,
      capabilityPolicy: defaultReviewerCapabilityPolicy(),
    });
    expect(args).toContain("--allowed-tools");
    expect(args).toContain("--disallowed-tools");
  });

  it("ClaudeCodeAdapter argv stays unchanged when no policy", () => {
    const a = new ClaudeCodeAdapter();
    const { args } = a.buildArgv();
    expect(args).not.toContain("--allowed-tools");
  });
});

describe("L1 — codex-cli capability flags", () => {
  it("lead default → workspace-write + --no-network", () => {
    const flags = codexCliCapabilityFlags(defaultLeadCapabilityPolicy());
    expect(flags).toContain("--sandbox");
    expect(flags[flags.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(flags).toContain("--no-network");
  });

  it("reviewer default → read-only sandbox", () => {
    const flags = codexCliCapabilityFlags(defaultReviewerCapabilityPolicy());
    expect(flags[flags.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(flags).toContain("--no-network");
  });

  it("CodexCliAdapter argv injects flags when policy supplied", () => {
    const a = new CodexCliAdapter();
    const { args } = a.buildArgv({
      ...baseInput,
      capabilityPolicy: defaultLeadCapabilityPolicy(),
    });
    expect(args).toContain("--sandbox");
    expect(args).toContain("--no-network");
  });
});

describe("L3 — applyCapabilityEnvStrip", () => {
  it("removes baseline secret env keys", () => {
    const env = {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_xxx",
      GH_TOKEN: "gho_yyy",
      AWS_ACCESS_KEY_ID: "AKIA",
      LLM_TEAM_MACHINE_BLOCK_SECRET: "shhh",
      LLM_TEAM_OTHER_SECRET: "shh2",
      MY_API_SECRET: "shh3",
      NPM_TOKEN: "ntoken",
    };
    const stripped = applyCapabilityEnvStrip(env);
    expect(stripped.PATH).toBe("/usr/bin");
    expect(stripped.GITHUB_TOKEN).toBeUndefined();
    expect(stripped.GH_TOKEN).toBeUndefined();
    expect(stripped.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(stripped.LLM_TEAM_MACHINE_BLOCK_SECRET).toBeUndefined();
    expect(stripped.LLM_TEAM_OTHER_SECRET).toBeUndefined();
    expect(stripped.MY_API_SECRET).toBeUndefined();
    expect(stripped.NPM_TOKEN).toBeUndefined();
  });

  it("network=deny additionally strips proxy env vars", () => {
    const env = { HTTP_PROXY: "http://x", HTTPS_PROXY: "http://y", PATH: "/" };
    const stripped = applyCapabilityEnvStrip(env, defaultLeadCapabilityPolicy());
    expect(stripped.HTTP_PROXY).toBeUndefined();
    expect(stripped.HTTPS_PROXY).toBeUndefined();
    expect(stripped.PATH).toBe("/");
  });
});
