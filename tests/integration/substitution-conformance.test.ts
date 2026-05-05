import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/llm-runner/claude-code.js";
import { CodexCliAdapter } from "../../src/adapters/llm-runner/codex-cli.js";
import { runInvoke } from "../../src/ports/llm-runner-executor.js";
import type { LlmRunnerInput } from "../../src/ports/llm-runner.js";
import { buildValidPrompt } from "../helpers/sample-prompt.js";

const ENVELOPE_STUB = fileURLToPath(
  new URL("../stubs/envelope-emitter.mjs", import.meta.url),
);

let workDir: string;
let cwdDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "subst-test-"));
  cwdDir = join(workDir, "cwd");
  mkdirSync(cwdDir, { recursive: true });
  process.env.LLM_TEAM_RUNNER_DIAG_DIR = join(workDir, "diag");
});

function writePrompt(): string {
  const p = join(workDir, "prompt.md");
  writeFileSync(p, buildValidPrompt(), "utf8");
  return p;
}

function input(overrides: Partial<LlmRunnerInput> = {}): LlmRunnerInput {
  return {
    agentProfileId: "atlas",
    sessionId: "s-1",
    turnIndex: 1,
    parentLoop: "outer",
    purpose: "discovery",
    agentRoleInSession: "lead",
    promptRef: writePrompt(),
    sessionContextRef: null,
    manifestId: "m-001",
    agentCwd: cwdDir,
    timeoutSec: 5,
    idempotencyKey: overrides.idempotencyKey ?? "key-1",
    ...overrides,
  };
}

// ARC-ADAPTER-SUBSTITUTION conformance: claude_code and codex_cli must
// produce LlmRunnerResult objects with the same shape (4 fields populated)
// for the same input. Envelope content equality is not asserted —
// per contract, only result-distribution comparability is required.
describe("substitution conformance (claude_code vs codex_cli)", () => {
  it("both adapters produce a complete 4-tuple with extracted envelope", async () => {
    // Use envelope-emitter stub as both binaries — substitutes the real
    // claude/codex CLIs without affecting the contract-shape assertion.
    const claude = new ClaudeCodeAdapter({
      command: `node ${ENVELOPE_STUB}`,
    });
    const codex = new CodexCliAdapter({
      command: `node ${ENVELOPE_STUB}`,
    });

    const claudeResult = await runInvoke(input({ idempotencyKey: "claude-key" }), claude);
    const codexResult = await runInvoke(input({ idempotencyKey: "codex-key" }), codex);

    for (const r of [claudeResult, codexResult]) {
      expect(r.exitStatus).toBe("ok");
      expect(r.envelopeRef.length).toBeGreaterThan(0);
      expect(r.diagnosticsRef.length).toBeGreaterThan(0);
      expect(r.consumedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    // Shape parity, not content parity
    expect(Object.keys(claudeResult).sort()).toEqual(
      Object.keys(codexResult).sort(),
    );
  });
});
