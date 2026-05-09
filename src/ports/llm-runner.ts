// Agent runner port (contract shape).
// Authority: docs/contracts/agent-runner-port-contract.md (ARC-PORT-SIGNATURE,
// ARC-CALL-SEMANTICS, ARC-EXIT-CLASSES, ARC-FAILURE-MODES).

export type ParentLoop = "outer" | "middle" | "inner";

// `human` is excluded — it routes through a separate human-signal path,
// not the LLM runner registry.
export type LlmAgentProfileId = "atlas" | "forge" | "sentinel" | "scout";

export type AgentRole = "lead" | "reviewer" | "observer";

export type ExitStatus =
  | "ok"
  | "timeout"
  | "transport_error"
  | "adapter_unavailable"
  | "malformed_output";

export interface LlmRunnerInput {
  agentProfileId: LlmAgentProfileId;
  sessionId: string;
  turnIndex: number;
  parentLoop: ParentLoop;
  purpose: string;
  agentRoleInSession: AgentRole;
  promptRef: string;
  sessionContextRef: string | null;
  manifestId: string;
  agentCwd: string;
  timeoutSec: number;
  idempotencyKey: string;
}

export interface LlmRunnerResult {
  exitStatus: ExitStatus;
  envelopeRef: string;
  diagnosticsRef: string;
  consumedAt: string;
}

export interface LlmRunnerPort {
  invoke(input: LlmRunnerInput): Promise<LlmRunnerResult>;
}

export interface ClassifyExitArgs {
  rawCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export function classifyExit(args: ClassifyExitArgs): ExitStatus {
  const { rawCode, signal, timedOut } = args;

  if (timedOut) return "timeout";

  if (rawCode === 0) return "ok";

  if (rawCode !== null) {
    switch (rawCode) {
      case 64:
        return "transport_error";
      case 65:
      case 67:
        return "malformed_output";
      case 66:
      case 127:
        return "adapter_unavailable";
      case 124:
        return "timeout";
      default:
        return "transport_error";
    }
  }

  if (signal === "SIGTERM" || signal === "SIGKILL") {
    return "transport_error";
  }

  return "transport_error";
}

/**
 * Sub-classification for `transport_error` exits. The contract `ExitStatus`
 * enum stays at five values; this string is captured into per-attempt
 * metadata so retry policy can distinguish rate-limit / quota / auth-fail
 * / network-disconnect from generic transport noise.
 *
 * Detection is deliberately conservative — a stderr substring must be
 * present and the matched terms are common across both Claude Code and
 * Codex CLI output. When nothing matches, `'other'` is returned.
 */
export type TransportReason =
  | "rate_limit"
  | "quota"
  | "auth_fail"
  | "network"
  | "other";

export interface ClassifyTransportReasonArgs {
  /** Combined stderr from the attempt. */
  stderr: string;
  rawCode?: number | null;
}

export function classifyTransportReason(
  args: ClassifyTransportReasonArgs,
): TransportReason {
  const stderr = (args.stderr ?? "").toLowerCase();
  if (stderr.length === 0) return "other";

  // Order matters — auth/quota are checked before generic rate-limit so the
  // more specific class wins when both terms appear together.
  if (
    /\b(401|403)\b/.test(stderr) ||
    stderr.includes("unauthorized") ||
    stderr.includes("authentication failed") ||
    stderr.includes("invalid api key") ||
    stderr.includes("invalid_api_key")
  ) {
    return "auth_fail";
  }

  if (
    stderr.includes("quota exceeded") ||
    stderr.includes("insufficient_quota") ||
    stderr.includes("billing") ||
    stderr.includes("usage limit")
  ) {
    return "quota";
  }

  if (
    /\b429\b/.test(stderr) ||
    stderr.includes("rate limit") ||
    stderr.includes("rate-limit") ||
    stderr.includes("rate_limit") ||
    stderr.includes("too many requests")
  ) {
    return "rate_limit";
  }

  if (
    stderr.includes("econnreset") ||
    stderr.includes("etimedout") ||
    stderr.includes("enetunreach") ||
    stderr.includes("eai_again") ||
    stderr.includes("getaddrinfo") ||
    stderr.includes("network is unreachable") ||
    stderr.includes("connection refused") ||
    stderr.includes("connection reset")
  ) {
    return "network";
  }

  return "other";
}
