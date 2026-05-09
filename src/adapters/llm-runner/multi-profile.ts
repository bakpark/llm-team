import type {
  LlmRunnerInput,
  LlmRunnerPort,
  LlmRunnerResult,
} from "../../ports/llm-runner.js";
import type { LlmRunnerRegistry } from "../../config/runner-registry.js";

/**
 * Phase 7a (G1-1) — multi-profile dispatcher.
 *
 * Implements `LlmRunnerPort` by routing each invocation to the per-profile
 * `LlmRunnerPort` resolved from `LlmRunnerRegistry` via
 * `input.agentProfileId`. This is the production wiring used by daemon /
 * runner once `cfg.agent_profiles` (and therefore `buildRunnerRegistry`)
 * supplies a real adapter per profile.
 *
 * Conformance: ARC-PORT-SIGNATURE (signature unchanged), ARC-ADAPTER-
 * SUBSTITUTION (different `agent_profile_id` may bind different adapters,
 * but the per-profile result distribution is preserved by delegation —
 * this dispatcher itself adds no behaviour beyond routing).
 */
export class MultiProfileLlmRunner implements LlmRunnerPort {
  constructor(private readonly registry: LlmRunnerRegistry) {}

  invoke(input: LlmRunnerInput): Promise<LlmRunnerResult> {
    const port = this.registry[input.agentProfileId];
    if (port == null) {
      throw new Error(
        `MultiProfileLlmRunner: no adapter registered for agent_profile_id=${input.agentProfileId}`,
      );
    }
    return port.invoke(input);
  }
}
