import { describe, expect, it } from "vitest";
import { CodexCliAdapter } from "../../src/adapters/llm-runner/codex-cli.js";

describe("CodexCliAdapter argv", () => {
  const baseInput = {
    stdin: "stdin body",
    agentCwd: "/tmp/agent",
    timeoutSec: 0,
  };

  it("emits the canonical exec invocation", () => {
    const a = new CodexCliAdapter();
    const { cmd, args } = a.buildArgv(baseInput);
    expect(cmd).toBe("codex");
    expect(args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--cd",
      "/tmp/agent",
      "--color",
      "never",
    ]);
  });

  it("does not pass the prompt as a positional argument", () => {
    const a = new CodexCliAdapter();
    const { args } = a.buildArgv(baseInput);
    for (const tok of args) {
      expect(tok).not.toContain("stdin body");
    }
  });

  it("appends --model and --profile when configured", () => {
    const a = new CodexCliAdapter({ model: "gpt-5.4", profile: "coder" });
    const { args } = a.buildArgv(baseInput);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.4");
    expect(args).toContain("--profile");
    expect(args[args.indexOf("--profile") + 1]).toBe("coder");
  });

  it("supports compound command tokens", () => {
    const a = new CodexCliAdapter({ command: "/usr/local/bin/codex" });
    const { cmd, args } = a.buildArgv(baseInput);
    expect(cmd).toBe("/usr/local/bin/codex");
    expect(args[0]).toBe("exec");
  });

  it("accepts envAllowlist/envOverride in cfg without throwing", () => {
    const a = new CodexCliAdapter({
      envAllowlist: ["PATH"],
      envOverride: { OPENAI_API_KEY: "test" },
    });
    expect(a.buildArgv(baseInput).cmd).toBe("codex");
  });
});
