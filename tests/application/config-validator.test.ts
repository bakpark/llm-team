import { describe, expect, it } from "vitest";
import {
  TargetConfigError,
  validateOrThrow,
  validateTargetConfig,
} from "../../src/application/config-validator.js";

const baseProfiles = {
  atlas: { runner: "claude_code" },
  forge: { runner: "claude_code" },
  sentinel: { runner: "claude_code" },
  scout: { runner: "claude_code" },
} as const;

describe("validateTargetConfig", () => {
  it("returns ok=true with parsed config on a valid input", () => {
    const r = validateTargetConfig({
      identity: { target_id: "demo" },
      agent_profiles: baseProfiles,
    });
    expect(r.ok).toBe(true);
    expect(r.config?.identity.target_id).toBe("demo");
    expect(r.errors).toEqual([]);
  });

  it("returns field-level errors for missing identity", () => {
    const r = validateTargetConfig({ agent_profiles: baseProfiles });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.path).toBe("identity");
  });

  it("includes a typed path for nested errors", () => {
    const r = validateTargetConfig({
      identity: { target_id: "demo" },
      agent_profiles: {
        atlas: { runner: "nope" },
        forge: { runner: "claude_code" },
        sentinel: { runner: "claude_code" },
        scout: { runner: "claude_code" },
      },
    });
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.path === "agent_profiles.atlas.runner"),
    ).toBe(true);
  });
});

describe("validateOrThrow", () => {
  it("throws TargetConfigError with structured errors on invalid input", () => {
    expect(() => validateOrThrow({})).toThrow(TargetConfigError);
    try {
      validateOrThrow({});
    } catch (err) {
      const e = err as TargetConfigError;
      expect(e.errors.length).toBeGreaterThan(0);
      expect(e.message).toContain("target config invalid");
    }
  });

  it("returns the parsed TargetConfig on valid input", () => {
    const cfg = validateOrThrow({
      identity: { target_id: "demo" },
      agent_profiles: baseProfiles,
    });
    expect(cfg.identity.target_id).toBe("demo");
  });
});
