import { describe, expect, it, vi } from "vitest";
import { MultiProfileLlmRunner } from "../../src/adapters/llm-runner/multi-profile.js";
import type { LlmRunnerRegistry } from "../../src/config/runner-registry.js";
import type {
  LlmAgentProfileId,
  LlmRunnerInput,
  LlmRunnerPort,
  LlmRunnerResult,
} from "../../src/ports/llm-runner.js";

function makePort(label: string): LlmRunnerPort & { calls: LlmRunnerInput[] } {
  const calls: LlmRunnerInput[] = [];
  return {
    calls,
    invoke(input: LlmRunnerInput): Promise<LlmRunnerResult> {
      calls.push(input);
      return Promise.resolve({
        exitStatus: "ok",
        envelopeRef: `/tmp/${label}.json`,
        diagnosticsRef: `/tmp/${label}.diag`,
        consumedAt: "2026-05-09T00:00:00.000Z",
      });
    },
  };
}

function input(profile: LlmAgentProfileId): LlmRunnerInput {
  return {
    agentProfileId: profile,
    sessionId: "S",
    turnIndex: 0,
    parentLoop: "inner",
    purpose: "tdd_build",
    agentRoleInSession: "lead",
    promptRef: "/tmp/p.md",
    sessionContextRef: null,
    manifestId: "M",
    agentCwd: "/tmp",
    timeoutSec: 60,
    idempotencyKey: "",
  };
}

describe("MultiProfileLlmRunner", () => {
  it("dispatches each profile to the corresponding registry port", async () => {
    const ports = {
      atlas: makePort("atlas"),
      forge: makePort("forge"),
      sentinel: makePort("sentinel"),
      scout: makePort("scout"),
    };
    const registry: LlmRunnerRegistry = {
      atlas: ports.atlas,
      forge: ports.forge,
      sentinel: ports.sentinel,
      scout: ports.scout,
    };
    const runner = new MultiProfileLlmRunner(registry);

    const r1 = await runner.invoke(input("forge"));
    expect(r1.envelopeRef).toBe("/tmp/forge.json");
    expect(ports.forge.calls).toHaveLength(1);
    expect(ports.atlas.calls).toHaveLength(0);

    const r2 = await runner.invoke(input("scout"));
    expect(r2.envelopeRef).toBe("/tmp/scout.json");
    expect(ports.scout.calls).toHaveLength(1);
  });

  it("throws when the resolved profile has no registered adapter", () => {
    const partial = { atlas: makePort("atlas") } as unknown as LlmRunnerRegistry;
    const runner = new MultiProfileLlmRunner(partial);
    expect(() => runner.invoke(input("forge"))).toThrow(/forge/);
  });

  it("propagates the per-profile invocation result unchanged (no wrapping)", async () => {
    const port: LlmRunnerPort = {
      invoke: vi.fn().mockResolvedValue({
        exitStatus: "timeout",
        envelopeRef: "/tmp/e",
        diagnosticsRef: "/tmp/d",
        consumedAt: "2026-05-09T00:00:00.000Z",
      } satisfies LlmRunnerResult),
    };
    const registry: LlmRunnerRegistry = {
      atlas: port,
      forge: port,
      sentinel: port,
      scout: port,
    };
    const runner = new MultiProfileLlmRunner(registry);
    const r = await runner.invoke(input("atlas"));
    expect(r.exitStatus).toBe("timeout");
    expect(port.invoke).toHaveBeenCalledTimes(1);
  });
});
