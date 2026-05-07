import { runInvoke } from "../../ports/llm-runner-executor.js";
import type {
  LlmRunnerInput,
  LlmRunnerPort,
  LlmRunnerResult,
} from "../../ports/llm-runner.js";
import type { LlmRunnerAdapter } from "./types.js";

/**
 * Adapts a low-level LlmRunnerAdapter (provider-specific spawner) into the
 * contract-shaped LlmRunnerPort by delegating to the shared `runInvoke`
 * executor. Application code holds only the LlmRunnerPort interface.
 */
export class AdapterRunnerPort implements LlmRunnerPort {
  constructor(private readonly adapter: LlmRunnerAdapter) {}

  invoke(input: LlmRunnerInput): Promise<LlmRunnerResult> {
    return runInvoke(input, this.adapter);
  }
}
