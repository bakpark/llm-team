/**
 * incident-10 — TCC-CONTEXT-BUDGET `timeout_sec` per-phase override + the new
 * `failure_policy.inner_lr_timeout_cap` block. Mirrors the existing phase-8a
 * conformance shape for `token_hard_cap` so operator overrides validate
 * correctly and resolve through `resolveAgentTimeoutSec`.
 */
import { describe, expect, it } from "vitest";
import {
  ContextBudget,
  ContextBudgetEntry,
  TIMEOUT_SEC_DEFAULTS,
  TargetConfig,
  parseTargetConfig,
  resolveAgentTimeoutSec,
} from "../../src/config/target-schema.js";

const PROFILES = {
  atlas: { runner: "fake" as const },
  forge: { runner: "fake" as const },
  sentinel: { runner: "fake" as const },
  scout: { runner: "fake" as const },
};
const ID = { target_id: "incident-10-test" };

describe("incident-10 — ContextBudgetEntry.timeout_sec", () => {
  it("accepts a positive integer per-phase timeout_sec", () => {
    const e = ContextBudgetEntry.parse({
      token_hard_cap: 128_000,
      timeout_sec: 600,
    });
    expect(e.timeout_sec).toBe(600);
  });

  it("treats timeout_sec as optional (legacy entries still parse)", () => {
    const e = ContextBudgetEntry.parse({ token_hard_cap: 128_000 });
    expect(e.timeout_sec).toBeUndefined();
  });

  it("rejects zero / negative / non-integer timeout_sec", () => {
    expect(() =>
      ContextBudgetEntry.parse({ token_hard_cap: 100, timeout_sec: 0 }),
    ).toThrow();
    expect(() =>
      ContextBudgetEntry.parse({ token_hard_cap: 100, timeout_sec: -1 }),
    ).toThrow();
    expect(() =>
      ContextBudgetEntry.parse({ token_hard_cap: 100, timeout_sec: 1.5 }),
    ).toThrow();
  });

  it("ContextBudget accepts timeout_sec for any LoopStep key", () => {
    const cfg = ContextBudget.parse({
      "outer.Discovery": { token_hard_cap: 256_000, timeout_sec: 90 },
      "inner.tdd_build": { token_hard_cap: 128_000, timeout_sec: 900 },
    });
    expect(cfg["outer.Discovery"]?.timeout_sec).toBe(90);
    expect(cfg["inner.tdd_build"]?.timeout_sec).toBe(900);
  });

  it("TargetConfig accepts a context_budget block with per-phase timeout_sec", () => {
    const cfg = parseTargetConfig({
      identity: ID,
      agent_profiles: PROFILES,
      context_budget: {
        "inner.tdd_build": { token_hard_cap: 128_000, timeout_sec: 600 },
      },
    });
    expect(
      cfg.context_budget?.["inner.tdd_build"]?.timeout_sec,
    ).toBe(600);
  });
});

describe("incident-10 — resolveAgentTimeoutSec", () => {
  it("prefers per-phase context_budget override when present", () => {
    const cfg = ContextBudget.parse({
      "inner.tdd_build": { token_hard_cap: 128_000, timeout_sec: 900 },
    });
    expect(resolveAgentTimeoutSec(cfg, "inner", "tdd_build", undefined)).toBe(
      900,
    );
  });

  it("falls back to architecture default for the (loop, step) pair when no caller override", () => {
    expect(
      resolveAgentTimeoutSec(undefined, "inner", "tdd_build", undefined),
    ).toBe(TIMEOUT_SEC_DEFAULTS["inner.tdd_build"]);
    expect(resolveAgentTimeoutSec({}, "outer", "Discovery", undefined)).toBe(
      TIMEOUT_SEC_DEFAULTS["outer.Discovery"],
    );
    expect(resolveAgentTimeoutSec({}, "middle", "review", undefined)).toBe(
      TIMEOUT_SEC_DEFAULTS["middle.review"],
    );
  });

  it("falls back to caller-supplied fallback for unknown (loop, step) pairs", () => {
    expect(resolveAgentTimeoutSec({}, "rogue", "step", 77)).toBe(77);
  });

  it("falls back to 120 when caller-supplied fallback is undefined and (loop, step) is unknown", () => {
    expect(resolveAgentTimeoutSec({}, "rogue", "step", undefined)).toBe(120);
  });

  it("ignores override when it is missing on the matching entry", () => {
    const cfg = ContextBudget.parse({
      "inner.tdd_build": { token_hard_cap: 128_000 },
    });
    expect(resolveAgentTimeoutSec(cfg, "inner", "tdd_build", undefined)).toBe(
      TIMEOUT_SEC_DEFAULTS["inner.tdd_build"],
    );
  });

  it("PR #110 P1-a: legacy agentTimeoutSec override wins over architecture default (operator-override precedence)", () => {
    // Operator explicitly set `agentTimeoutSec: 30` (legacy global override)
    // and did NOT set per-phase `context_budget.*.timeout_sec`. The
    // resolver must honor 30s, not silently inflate to TIMEOUT_SEC_DEFAULTS.
    expect(resolveAgentTimeoutSec(undefined, "inner", "tdd_build", 30)).toBe(
      30,
    );
    expect(resolveAgentTimeoutSec({}, "outer", "Discovery", 45)).toBe(45);
  });

  it("PR #110 P1-a: per-phase context_budget.timeout_sec still wins over legacy agentTimeoutSec", () => {
    const cfg = ContextBudget.parse({
      "inner.tdd_build": { token_hard_cap: 128_000, timeout_sec: 900 },
    });
    expect(resolveAgentTimeoutSec(cfg, "inner", "tdd_build", 30)).toBe(900);
  });

  it("architecture defaults match the contract: outer/middle short, inner.tdd_build 600", () => {
    expect(TIMEOUT_SEC_DEFAULTS["outer.Discovery"]).toBe(120);
    expect(TIMEOUT_SEC_DEFAULTS["outer.Specification"]).toBe(120);
    expect(TIMEOUT_SEC_DEFAULTS["outer.Planning"]).toBe(120);
    expect(TIMEOUT_SEC_DEFAULTS["outer.Validation"]).toBe(120);
    expect(TIMEOUT_SEC_DEFAULTS["middle.review"]).toBe(180);
    expect(TIMEOUT_SEC_DEFAULTS["middle.merge"]).toBe(180);
    expect(TIMEOUT_SEC_DEFAULTS["inner.tdd_build"]).toBe(600);
  });
});

describe("incident-10 — failure_policy.inner_lr_timeout_cap", () => {
  it("accepts an optional positive integer cap", () => {
    const cfg = TargetConfig.parse({
      identity: ID,
      agent_profiles: PROFILES,
      failure_policy: { inner_lr_timeout_cap: 7 },
    });
    expect(cfg.failure_policy?.inner_lr_timeout_cap).toBe(7);
  });

  it("treats failure_policy as optional (legacy targets parse unchanged)", () => {
    const cfg = TargetConfig.parse({
      identity: ID,
      agent_profiles: PROFILES,
    });
    expect(cfg.failure_policy).toBeUndefined();
  });

  it("rejects zero / negative inner_lr_timeout_cap", () => {
    expect(() =>
      TargetConfig.parse({
        identity: ID,
        agent_profiles: PROFILES,
        failure_policy: { inner_lr_timeout_cap: 0 },
      }),
    ).toThrow();
    expect(() =>
      TargetConfig.parse({
        identity: ID,
        agent_profiles: PROFILES,
        failure_policy: { inner_lr_timeout_cap: -1 },
      }),
    ).toThrow();
  });

  it("rejects unknown keys inside failure_policy (.strict())", () => {
    expect(() =>
      TargetConfig.parse({
        identity: ID,
        agent_profiles: PROFILES,
        failure_policy: { unknown: 1 } as unknown as Record<string, number>,
      }),
    ).toThrow();
  });
});
