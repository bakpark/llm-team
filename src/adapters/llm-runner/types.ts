// LlmRunnerAdapter primitive — provider-specific spawner.
// The contract-shaped LlmRunnerPort is implemented by the executor (runInvoke),
// which composes stdin from prompt_ref/session_context_ref and dispatches here.

export interface LlmAdapterInput {
  stdin: string;
  agentCwd: string;
  timeoutSec: number;
}

export interface LlmAdapterResult {
  rawCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /**
   * Resolved env passed to the child process (after allowlist + override
   * merge). The executor uses this for sink-boundary redaction so that
   * secrets injected via `envOverride` — and not present in `process.env` —
   * are still masked. Optional: adapters that don't expose this fall back
   * to `process.env` redaction in the executor.
   */
  spawnEnv?: NodeJS.ProcessEnv;
}

export type LlmAdapterId = "claude_code" | "codex_cli" | "fake";

export interface LlmRunnerAdapter {
  readonly id: LlmAdapterId;
  run(input: LlmAdapterInput): Promise<LlmAdapterResult>;
}
