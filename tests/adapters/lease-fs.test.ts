import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FsLease } from "../../src/adapters/lease/fs.js";
import { FixedClock } from "../../src/ports/clock.js";

const SLICE_ID = "01HZS00000000000000000000A";
const TARGET = "demo";
const ISO_BASE = Date.parse("2026-05-08T00:00:00.000Z");

function buildLease() {
  const workdir = mkdtempSync(join(tmpdir(), "lease-fs-"));
  const store = new FsStore({ workdir });
  const clock = new FixedClock(ISO_BASE);
  const lease = new FsLease({ store, clock });
  return { workdir, store, clock, lease };
}

describe("FsLease (4-kind CAS adapter)", () => {
  let env: ReturnType<typeof buildLease>;
  beforeEach(() => {
    env = buildLease();
  });
  afterEach(() => {
    /* tmpdir left for post-mortem */
  });

  it("first claim acquires; concurrent second claim fails (CAS)", async () => {
    const r1 = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    expect(r1.result).toBe("acquired");
    if (r1.result !== "acquired") return;

    const r2 = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w2",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    expect(r2.result).toBe("claim_failed");
    if (r2.result === "claim_failed") {
      expect(r2.existingHolder).toBe("w1");
      expect(r2.existingLeaseId).toBe(r1.lease.lease_id);
    }
  });

  it("monotonic lease_token: each new claim yields strictly larger token", async () => {
    const r1 = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    expect(r1.result).toBe("acquired");
    if (r1.result !== "acquired") return;
    await env.lease.release({
      leaseId: r1.lease.lease_id,
      leaseToken: r1.lease.lease_token,
    });
    const r2 = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w2",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    expect(r2.result).toBe("acquired");
    if (r2.result !== "acquired") return;
    expect(r2.lease.lease_token > r1.lease.lease_token).toBe(true);
  });

  it("release with wrong token returns released=false", async () => {
    const r = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    if (r.result !== "acquired") return;
    const out = await env.lease.release({
      leaseId: r.lease.lease_id,
      leaseToken: "00000000:wrong",
    });
    expect(out.released).toBe(false);
    // Real release succeeds
    const out2 = await env.lease.release({
      leaseId: r.lease.lease_id,
      leaseToken: r.lease.lease_token,
    });
    expect(out2.released).toBe(true);
  });

  it("renew extends expires_at and updates ttl_ms", async () => {
    const r = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 30_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    if (r.result !== "acquired") return;
    env.clock.advance(10_000);
    const renewed = await env.lease.renew({
      leaseId: r.lease.lease_id,
      leaseToken: r.lease.lease_token,
      newTtlMs: 120_000,
    });
    expect(renewed.renewed).toBe(true);
    expect(renewed.newExpiresAt).not.toBeNull();
    expect(Date.parse(renewed.newExpiresAt!)).toBe(ISO_BASE + 10_000 + 120_000);
  });

  it("sweepStale returns expired and clears the active slot for re-claim", async () => {
    const r1 = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 1_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    if (r1.result !== "acquired") return;
    env.clock.advance(2_000);
    const expired = await env.lease.sweepStale();
    expect(expired.length).toBe(1);
    expect(expired[0]?.lease_id).toBe(r1.lease.lease_id);
    // Re-claim succeeds because the active slot was cleared.
    const r2 = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w2",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    expect(r2.result).toBe("acquired");
  });

  it("list returns active leases only", async () => {
    const r = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    if (r.result !== "acquired") return;
    const before = await env.lease.list();
    expect(before.length).toBe(1);
    await env.lease.release({
      leaseId: r.lease.lease_id,
      leaseToken: r.lease.lease_token,
    });
    const after = await env.lease.list();
    expect(after.length).toBe(0);
  });
});
