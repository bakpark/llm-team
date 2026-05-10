import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runInvoke } from "../../src/ports/llm-runner-executor.js";
import type {
  LlmRunnerInput,
} from "../../src/ports/llm-runner.js";
import type {
  LlmAdapterInput,
  LlmAdapterResult,
  LlmRunnerAdapter,
} from "../../src/adapters/llm-runner/types.js";
import { buildValidPrompt } from "../helpers/sample-prompt.js";

class StubAdapter implements LlmRunnerAdapter {
  readonly id = "fake" as const;
  public lastInput: LlmAdapterInput | null = null;
  constructor(
    private readonly result: () => Promise<LlmAdapterResult> | LlmAdapterResult,
  ) {}
  async run(input: LlmAdapterInput): Promise<LlmAdapterResult> {
    this.lastInput = input;
    return await this.result();
  }
}

let workDir: string;
let cwdDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "exec-test-"));
  cwdDir = join(workDir, "cwd");
  mkdirSync(cwdDir, { recursive: true });
  process.env.LLM_TEAM_RUNNER_DIAG_DIR = join(workDir, "diag");
});

function writePrompt(): string {
  const p = join(workDir, "prompt.md");
  writeFileSync(p, buildValidPrompt(), "utf8");
  return p;
}

function makeInput(opts: Partial<LlmRunnerInput> = {}): LlmRunnerInput {
  return {
    agentProfileId: "atlas",
    sessionId: "s-1",
    turnIndex: 1,
    parentLoop: "outer",
    purpose: "discovery",
    agentRoleInSession: "lead",
    promptRef: opts.promptRef ?? writePrompt(),
    sessionContextRef: opts.sessionContextRef ?? null,
    manifestId: "m-001",
    agentCwd: opts.agentCwd ?? cwdDir,
    timeoutSec: 0,
    idempotencyKey: opts.idempotencyKey ?? "k-1",
    ...opts,
  };
}

describe("runInvoke", () => {
  it("returns ok when adapter exits 0 with extractable envelope", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: '```json\n{"x":1}\n```\n',
      stderr: "",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("ok");
    expect(readFileSync(r.envelopeRef, "utf8")).toBe('{"x":1}');
    expect(readFileSync(r.diagnosticsRef, "utf8")).toBe("");
    expect(r.consumedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("classifies adapter rawCode 0 with no fenced envelope as malformed_output", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: "no fenced block",
      stderr: "",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("malformed_output");
    expect(readFileSync(r.envelopeRef, "utf8")).toBe("");
  });

  it("returns adapter_unavailable when agentCwd missing, with full 4-tuple", async () => {
    const adapter = new StubAdapter(() => {
      throw new Error("should not be called");
    });
    const r = await runInvoke(
      makeInput({ agentCwd: join(workDir, "no-such-dir") }),
      adapter,
    );
    expect(r.exitStatus).toBe("adapter_unavailable");
    expect(r.envelopeRef.length).toBeGreaterThan(0);
    expect(r.diagnosticsRef.length).toBeGreaterThan(0);
    expect(readFileSync(r.diagnosticsRef, "utf8")).toContain("agentCwd not found");
    expect(adapter.lastInput).toBeNull();
  });

  it("returns transport_error on 4-part layout violation", async () => {
    const badPrompt = join(workDir, "bad.md");
    writeFileSync(badPrompt, "no frontmatter here\n# Context\n", "utf8");
    const adapter = new StubAdapter(() => {
      throw new Error("should not be called");
    });
    const r = await runInvoke(makeInput({ promptRef: badPrompt }), adapter);
    expect(r.exitStatus).toBe("transport_error");
    expect(readFileSync(r.diagnosticsRef, "utf8")).toContain("4-part layout violation");
  });

  it("preserves the 4-tuple even when the adapter throws", async () => {
    const adapter = new StubAdapter(() => {
      throw new Error("boom");
    });
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("transport_error");
    expect(readFileSync(r.diagnosticsRef, "utf8")).toContain("unexpected error");
    expect(r.consumedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("propagates adapter timeout as exitStatus=timeout", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: null,
      signal: "SIGTERM" as NodeJS.Signals,
      timedOut: true,
      stdout: "",
      stderr: "self-killed",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("timeout");
    expect(readFileSync(r.diagnosticsRef, "utf8")).toBe("self-killed");
  });

  it("classifies external SIGTERM (not self-timeout) as transport_error", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: null,
      signal: "SIGTERM" as NodeJS.Signals,
      timedOut: false,
      stdout: "",
      stderr: "killed by operator",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("transport_error");
  });

  it("downgrades ok→malformed_output when fenced envelope body is not parseable JSON", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: "```json\nthis is not json\n```\n",
      stderr: "",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("malformed_output");
    // Body is preserved so the caller can diagnose
    expect(readFileSync(r.envelopeRef, "utf8")).toBe("this is not json");
  });

  it("produces unique envelope/diagnostics files across retries with the same idempotencyKey", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: '```json\n{"x":1}\n```\n',
      stderr: "",
    }));
    const a = await runInvoke(makeInput({ idempotencyKey: "retry-1" }), adapter);
    const b = await runInvoke(makeInput({ idempotencyKey: "retry-1" }), adapter);
    expect(a.envelopeRef).not.toBe(b.envelopeRef);
    expect(a.diagnosticsRef).not.toBe(b.diagnosticsRef);
    expect(readFileSync(a.envelopeRef, "utf8")).toBe('{"x":1}');
    expect(readFileSync(b.envelopeRef, "utf8")).toBe('{"x":1}');
  });

  it("consumedAt reflects call completion, not start", async () => {
    const adapter = new StubAdapter(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        rawCode: 0,
        signal: null,
        timedOut: false,
        stdout: '```json\n{"y":2}\n```\n',
        stderr: "",
      };
    });
    const before = Date.now();
    const r = await runInvoke(makeInput(), adapter);
    const ts = Date.parse(r.consumedAt);
    expect(ts).toBeGreaterThanOrEqual(before + 50);
  });

  it("injects session_context body under the prompt's # Context heading", async () => {
    const ctxRef = join(workDir, "ctx.md");
    writeFileSync(ctxRef, "## Manifest\n\n(injected manifest body)\n", "utf8");

    let captured = "";
    const adapter = new StubAdapter((async (input?: LlmAdapterInput) => {
      // captured via closure on lastInput in StubAdapter, but easier to assert on stdin directly here
      return {
        rawCode: 0,
        signal: null,
        timedOut: false,
        stdout: '```json\n{"ok":true}\n```\n',
        stderr: "",
      };
    }) as () => Promise<LlmAdapterResult>);

    const r = await runInvoke(
      makeInput({ sessionContextRef: ctxRef }),
      adapter,
    );
    expect(r.exitStatus).toBe("ok");
    captured = adapter.lastInput?.stdin ?? "";
    expect(captured).toContain("# Context");
    expect(captured).toContain("(injected manifest body)");
    // Injected body must appear before the # Instruction heading
    expect(captured.indexOf("(injected manifest body)")).toBeLessThan(
      captured.indexOf("# Instruction"),
    );
  });

  it("writes attempt-level stdout/stderr/envelope/metadata files on success", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'header\n```json\n{"x":1}\n```\nfooter',
      stderr: "warn line",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("ok");

    const base = r.envelopeRef.replace(/\.envelope$/, "");
    const stdoutPath = `${base}.stdout`;
    const stderrPath = `${base}.stderr`;
    const metaPath = `${base}.metadata.json`;

    expect(existsSync(stdoutPath)).toBe(true);
    expect(existsSync(stderrPath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    expect(r.diagnosticsRef).toBe(stderrPath);
    expect(readFileSync(stdoutPath, "utf8")).toContain("header");
    expect(readFileSync(stderrPath, "utf8")).toBe("warn line");

    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.rawExitCode).toBe(0);
    expect(meta.timedOut).toBe(false);
    expect(meta.consumedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preflight failure still emits all four attempt files", async () => {
    const adapter = new StubAdapter(() => {
      throw new Error("should not be called");
    });
    const r = await runInvoke(
      makeInput({ agentCwd: join(workDir, "no-such-dir") }),
      adapter,
    );
    expect(r.exitStatus).toBe("adapter_unavailable");
    const base = r.envelopeRef.replace(/\.envelope$/, "");
    expect(existsSync(`${base}.stdout`)).toBe(true);
    expect(existsSync(`${base}.stderr`)).toBe(true);
    expect(existsSync(`${base}.envelope`)).toBe(true);
    expect(existsSync(`${base}.metadata.json`)).toBe(true);
    const meta = JSON.parse(readFileSync(`${base}.metadata.json`, "utf8"));
    expect(meta.reason).toBe("agent_cwd_missing");
  });

  it("on success persists the composed prompt to <base>.prompt for replay", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: '```json\n{"x":1}\n```\n',
      stderr: "",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("ok");
    const promptPath = r.envelopeRef.replace(/\.envelope$/, ".prompt");
    expect(existsSync(promptPath)).toBe(true);
    const promptBody = readFileSync(promptPath, "utf8");
    // adapter.lastInput.stdin is the canonical composed prompt the adapter saw.
    expect(promptBody).toBe(adapter.lastInput!.stdin);
  });

  it("4-part layout violation still persists the offending prompt body", async () => {
    const badPrompt = join(workDir, "bad.md");
    const badBody = "no frontmatter here\n# Context\n";
    writeFileSync(badPrompt, badBody, "utf8");
    const adapter = new StubAdapter(() => {
      throw new Error("should not be called");
    });
    const r = await runInvoke(makeInput({ promptRef: badPrompt }), adapter);
    expect(r.exitStatus).toBe("transport_error");
    const promptPath = r.envelopeRef.replace(/\.envelope$/, ".prompt");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf8")).toBe(badBody);
  });

  it("composeStdin failure still emits an empty prompt slot file", async () => {
    const noContextPrompt = join(workDir, "no-context.md");
    writeFileSync(
      noContextPrompt,
      `---\nsession_id: s\n---\n\n# Instruction\n\n# Output Schema\n`,
      "utf8",
    );
    const ctxRef = join(workDir, "ctx-missing-anchor.md");
    writeFileSync(ctxRef, "ctx body", "utf8");
    const adapter = new StubAdapter(() => {
      throw new Error("should not be called");
    });
    const r = await runInvoke(
      makeInput({ promptRef: noContextPrompt, sessionContextRef: ctxRef }),
      adapter,
    );
    expect(r.exitStatus).toBe("transport_error");
    const promptPath = r.envelopeRef.replace(/\.envelope$/, ".prompt");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf8")).toBe("");
  });

  it("agentCwd missing leaves an empty prompt slot file", async () => {
    const adapter = new StubAdapter(() => {
      throw new Error("should not be called");
    });
    const r = await runInvoke(
      makeInput({ agentCwd: join(workDir, "no-such-dir") }),
      adapter,
    );
    expect(r.exitStatus).toBe("adapter_unavailable");
    const promptPath = r.envelopeRef.replace(/\.envelope$/, ".prompt");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf8")).toBe("");
  });

  it("executor unexpected throw leaves an empty prompt slot file", async () => {
    const adapter = new StubAdapter(() => {
      throw new Error("boom");
    });
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("transport_error");
    const promptPath = r.envelopeRef.replace(/\.envelope$/, ".prompt");
    expect(existsSync(promptPath)).toBe(true);
    // Adapter throw happens *after* prompt was already written, so the body is
    // the composed stdin (not empty). The contract is only that the file exists.
    const body = readFileSync(promptPath, "utf8");
    expect(body.length).toBeGreaterThan(0);
  });

  it("captures transport_error reason='rate_limit' in metadata", async () => {
    const adapter = new StubAdapter(() => ({
      rawCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "anthropic API: 429 rate limit exceeded",
    }));
    const r = await runInvoke(makeInput(), adapter);
    expect(r.exitStatus).toBe("transport_error");
    const metaPath = r.envelopeRef.replace(/\.envelope$/, ".metadata.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.reason).toBe("rate_limit");
  });

  it("redacts secret-shaped tokens from stderr at sink boundary", async () => {
    const leak =
      "fail: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz12345";
    const adapter = new StubAdapter(() => ({
      rawCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: leak,
    }));
    const r = await runInvoke(makeInput(), adapter);
    const stderrBody = readFileSync(r.diagnosticsRef, "utf8");
    expect(stderrBody).not.toContain("Bearer abcdefghij");
    expect(stderrBody).not.toContain("ghp_abcdef");
    expect(stderrBody).toContain("[REDACTED]");
  });

  it("returns transport_error if session_context_ref is set but prompt lacks # Context", async () => {
    const badPrompt = join(workDir, "no-context.md");
    writeFileSync(
      badPrompt,
      `---\nsession_id: s\n---\n\n# Instruction\n\n# Output Schema\n`,
      "utf8",
    );
    const ctxRef = join(workDir, "ctx2.md");
    writeFileSync(ctxRef, "ctx body", "utf8");
    const adapter = new StubAdapter(() => {
      throw new Error("should not be called");
    });
    const r = await runInvoke(
      makeInput({ promptRef: badPrompt, sessionContextRef: ctxRef }),
      adapter,
    );
    expect(r.exitStatus).toBe("transport_error");
    expect(readFileSync(r.diagnosticsRef, "utf8")).toContain(
      "compose stdin failed",
    );
  });
});
