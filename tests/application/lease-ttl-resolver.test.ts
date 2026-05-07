import { describe, expect, it } from "vitest";
import {
  HARDCODED_FALLBACK_MS,
  resolveLeaseTtl,
} from "../../src/application/lease-ttl-resolver.js";

describe("resolveLeaseTtl", () => {
  it("falls back to 60_000 ms when no config provided", () => {
    expect(
      resolveLeaseTtl({ leaseKind: "session_lease" }),
    ).toEqual({ ttlMs: HARDCODED_FALLBACK_MS, source: "hardcoded_fallback" });
  });

  it("ttl_default fires when no kind / profile / phase match", () => {
    expect(
      resolveLeaseTtl({
        leaseKind: "session_lease",
        leaseConfig: { ttl_default_ms: 30_000 },
      }),
    ).toEqual({ ttlMs: 30_000, source: "ttl_default" });
  });

  it("ttl_by_lease_kind takes precedence over ttl_default", () => {
    expect(
      resolveLeaseTtl({
        leaseKind: "slice_lease",
        leaseConfig: {
          ttl_default_ms: 30_000,
          ttl_by_lease_kind: { slice_lease: 90_000 },
        },
      }),
    ).toEqual({ ttlMs: 90_000, source: "by_lease_kind" });
  });

  it("ttl_by_agent_profile takes precedence over ttl_by_lease_kind", () => {
    expect(
      resolveLeaseTtl({
        leaseKind: "turn_lease",
        agentProfileId: "forge",
        leaseConfig: {
          ttl_by_lease_kind: { turn_lease: 60_000 },
          ttl_by_agent_profile: { forge: 240_000 },
        },
      }),
    ).toEqual({ ttlMs: 240_000, source: "by_agent_profile" });
  });

  it("ttl_by_phase takes precedence over ttl_by_agent_profile", () => {
    expect(
      resolveLeaseTtl({
        leaseKind: "session_lease",
        phase: "tdd_build",
        agentProfileId: "forge",
        leaseConfig: {
          ttl_by_phase: { tdd_build: 600_000 },
          ttl_by_agent_profile: { forge: 240_000 },
        },
      }),
    ).toEqual({ ttlMs: 600_000, source: "by_phase" });
  });

  it("worker override beats every config", () => {
    expect(
      resolveLeaseTtl({
        leaseKind: "session_lease",
        workerOverrideMs: 5_000,
        leaseConfig: {
          ttl_default_ms: 30_000,
          ttl_by_lease_kind: { session_lease: 60_000 },
        },
      }),
    ).toEqual({ ttlMs: 5_000, source: "by_phase" });
  });
});
