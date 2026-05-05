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
