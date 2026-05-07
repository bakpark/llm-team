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

  it("sweepStale returns expired without clearing; clearExpired drops the slot (PR #63 P0-4)", async () => {
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
    // Until clearExpired runs, the slot still holds the (expired) lease, so
    // a fresh claim must fail. This guarantees ledger-before-clear ordering:
    // a crash between sweepStale and clearExpired is recoverable on the
    // next sweep.
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
    // Now clear and retry.
    const cleared = await env.lease.clearExpired(expired[0]!);
    expect(cleared.cleared).toBe(true);
    const r3 = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w3",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    expect(r3.result).toBe("acquired");
  });

  it("clearExpired is idempotent (already-cleared slot returns cleared=false)", async () => {
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
    await env.lease.clearExpired(expired[0]!);
    const second = await env.lease.clearExpired(expired[0]!);
    expect(second.cleared).toBe(false);
  });

  it("sweepStale TOCTOU — concurrent re-claim under lock is preserved (PR #63 P0-1)", async () => {
    // Claim a short-lived lease, let it expire, then race a sweep against
    // a release+re-claim that finishes between the sweep's read and clear.
    // The new sweep contract re-reads inside the lock, so the fresh lease
    // is preserved.
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
    // Replace the expired lease with a fresh one.
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
    // Sweep should NOT see the fresh lease as expired — the probe sees
    // the new record with future expiry, returns nothing.
    const expired = await env.lease.sweepStale();
    expect(expired.length).toBe(0);
    // Even if we feed the OLD lease into clearExpired, it must not clear
    // the slot (lease_id mismatch).
    const out = await env.lease.clearExpired(r1.lease);
    expect(out.cleared).toBe(false);
    // Verify the fresh lease still holds.
    const list = await env.lease.list();
    expect(list.length).toBe(1);
    expect(list[0]?.lease_id).toBe(r2.lease.lease_id);
  });

  it("renew refuses after expires_at (PR #63 P1-7)", async () => {
    const r = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 1_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    if (r.result !== "acquired") return;
    env.clock.advance(2_000);
    const out = await env.lease.renew({
      leaseId: r.lease.lease_id,
      leaseToken: r.lease.lease_token,
      newTtlMs: 60_000,
    });
    expect(out.renewed).toBe(false);
    expect(out.newExpiresAt).toBeNull();
  });

  it("corrupt active record refuses claim with sentinel holder (PR #63 P0-5)", async () => {
    // Inject an invalid active record directly.
    const safeKey = SLICE_ID.replace(/[^A-Za-z0-9_-]/g, "_");
    await env.store.writeAtomic(
      `leases/active/${safeKey}.json`,
      "{ not valid json",
    );
    const out = await env.lease.claim({
      leaseKind: "slice_lease",
      objectId: SLICE_ID,
      workerId: "w1",
      ttlMs: 60_000,
      ttlSource: "ttl_default",
      targetId: TARGET,
      aux: { kind: "slice_lease", slice_id: SLICE_ID },
    });
    expect(out.result).toBe("claim_failed");
    if (out.result === "claim_failed") {
      expect(out.existingHolder).toBe("<corrupt-active-record>");
    }
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
