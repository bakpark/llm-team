import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/llm-runner/claude-code.js";

describe("ClaudeCodeAdapter argv", () => {
  it("uses default `claude` binary and adds -p text flags", () => {
    const a = new ClaudeCodeAdapter();
    const { cmd, args } = a.buildArgv();
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "--output-format", "text"]);
  });

  it("appends --model when configured", () => {
    const a = new ClaudeCodeAdapter({ model: "claude-opus-4-7" });
    const { args } = a.buildArgv();
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-7");
  });

  it("supports compound command tokens (e.g., wrapper script)", () => {
    const a = new ClaudeCodeAdapter({ command: "node ./scripts/wrap.js" });
    const { cmd, args } = a.buildArgv();
    expect(cmd).toBe("node");
    expect(args.slice(0, 1)).toEqual(["./scripts/wrap.js"]);
    expect(args.slice(-3)).toEqual(["-p", "--output-format", "text"]);
  });

  it("appends extraArgs at the end", () => {
    const a = new ClaudeCodeAdapter({ extraArgs: ["--verbose"] });
    const { args } = a.buildArgv();
    expect(args.at(-1)).toBe("--verbose");
  });
});
