import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startLeaseHeartbeat,
  withLeaseHeartbeat,
} from "../../src/application/lease-heartbeat.js";
import type { LeasePort } from "../../src/ports/lease.js";

class FakeLease implements LeasePort {
  renewals = 0;
  shouldFail = false;
  shouldThrow = false;
  async claim() {
    return { result: "claim_failed" as const, existingHolder: "x", existingLeaseId: "x" };
  }
  async release() {
    return { released: true };
  }
  async renew() {
    this.renewals++;
    if (this.shouldThrow) throw new Error("boom");
    return { renewed: !this.shouldFail, newExpiresAt: this.shouldFail ? null : "2026-05-08T01:00:00.000Z" };
  }
  async sweepStale() {
    return [];
  }
  async clearExpired() {
    return { cleared: false };
  }
  async list() {
    return [];
  }
}

describe("lease-heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews periodically at ttl/3", async () => {
    const lease = new FakeLease();
    const handle = startLeaseHeartbeat({
      lease,
      leaseId: "lid",
      leaseToken: "tok",
      ttlMs: 60_000,
    });
    // First interval fires at t=20000ms (ttl/3=20000)
    await vi.advanceTimersByTimeAsync(20_001);
    expect(lease.renewals).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lease.renewals).toBe(2);
    expect(handle.status.lost).toBe(false);
    await handle.stop();
  });

  it("marks lost=true when renew rejects (token mismatch / expired)", async () => {
    const lease = new FakeLease();
    lease.shouldFail = true;
    const handle = startLeaseHeartbeat({
      lease,
      leaseId: "lid",
      leaseToken: "tok",
      ttlMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(handle.status.lost).toBe(true);
    expect(handle.status.lostReason).toContain("renew rejected");
    await handle.stop();
  });

  it("marks lost=true when renew throws", async () => {
    const lease = new FakeLease();
    lease.shouldThrow = true;
    const handle = startLeaseHeartbeat({
      lease,
      leaseId: "lid",
      leaseToken: "tok",
      ttlMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(handle.status.lost).toBe(true);
    expect(handle.status.lostReason).toContain("renew error");
    await handle.stop();
  });

  it("withLeaseHeartbeat stops on completion (fake timers)", async () => {
    const lease = new FakeLease();
    const promise = withLeaseHeartbeat(
      { lease, leaseId: "lid", leaseToken: "tok", ttlMs: 60_000 },
      async () => 42,
    );
    // fn resolves immediately; finally clears the timer before any tick fires.
    const result = await promise;
    expect(result.value).toBe(42);
    expect(result.status.lost).toBe(false);
    expect(lease.renewals).toBe(0);
  });
});
