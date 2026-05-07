/**
 * Phase 4 contract conformance.
 *
 * Asserts:
 *   1. The README CONTRACT-CONFORMANCE matrix points each phase-4 anchor at
 *      a TS surface that exists.
 *   2. The phase-4 modules expose the documented public functions / types.
 *   3. acquisition order is enforced by the LeaseAcquisitionOrderError code
 *      path (data-driven assertion that every (held, requested) pair where
 *      held >= requested throws).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_4_ANCHORS = [
  "RGC-LEASE-KINDS",
  "RGC-SLOT-LOCK",
  "RGC-RECOVERY",
  "RGC-FAILURE",
  "RGC-FAIRNESS",
  "RGC-DAEMON-STARTUP",
  "TCC-LEASE-CONFIG",
];

function findRowForAnchor(readme: string, anchor: string): string {
  // Restrict to the CONTRACT-CONFORMANCE matrix rows: a leading `| `<anchor>``
  // followed by ` |` (single anchor per row). The architecture-mapping table
  // groups multiple anchors per cell so it does not match this shape.
  const re = new RegExp(`^\\|\\s*\`${anchor}\`[^\\n]*\\|`, "m");
  const m = readme.match(re);
  if (!m) throw new Error(`anchor ${anchor} not found in README matrix`);
  return m[0];
}

function extractTsPaths(matrixRow: string): string[] {
  const paths = new Set<string>();
  const re = /`(src\/[^`\s]+\.ts)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(matrixRow)) != null) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths];
}

describe("Phase 4 — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");
  for (const anchor of PHASE_4_ANCHORS) {
    it(`${anchor} row references at least one src/**/*.ts surface that exists`, () => {
      const row = findRowForAnchor(readme, anchor);
      const paths = extractTsPaths(row);
      expect(
        paths.length,
        `${anchor} matrix row should cite at least one TS path`,
      ).toBeGreaterThan(0);
      for (const p of paths) {
        expect(existsSync(resolve(REPO_ROOT, p)), `missing file: ${p}`).toBe(
          true,
        );
      }
    });
  }
});

describe("Phase 4 — module surface contract", () => {
  it("LeasePort + FsLease expose claim/release/renew/sweepStale/list", async () => {
    const adapterMod = await import("../../src/adapters/lease/fs.js");
    const portMod = await import("../../src/ports/lease.js");
    void portMod; // type-only export
    expect(typeof adapterMod.FsLease).toBe("function");
    const { FsLease } = adapterMod;
    const inst = new FsLease({
      store: {} as never,
      clock: {} as never,
    });
    for (const fn of ["claim", "release", "renew", "sweepStale", "list"] as const) {
      expect(typeof (inst as unknown as Record<string, unknown>)[fn]).toBe(
        "function",
      );
    }
  });

  it("lease-ttl-resolver exports resolveLeaseTtl + HARDCODED_FALLBACK_MS", async () => {
    const m = await import("../../src/application/lease-ttl-resolver.js");
    expect(typeof m.resolveLeaseTtl).toBe("function");
    expect(m.HARDCODED_FALLBACK_MS).toBe(60_000);
  });

  it("lease-acquisition-order exports assertCanAcquire + checkCanAcquire", async () => {
    const m = await import("../../src/application/lease-acquisition-order.js");
    expect(typeof m.assertCanAcquire).toBe("function");
    expect(typeof m.checkCanAcquire).toBe("function");
  });

  it("recovery exports runRecoverySweep", async () => {
    const m = await import("../../src/application/recovery.js");
    expect(typeof m.runRecoverySweep).toBe("function");
  });

  it("failure-policy exports evaluateRetry + DEFAULT_RETRY_CONFIG", async () => {
    const m = await import("../../src/application/failure-policy.js");
    expect(typeof m.evaluateRetry).toBe("function");
    expect(typeof m.DEFAULT_RETRY_CONFIG).toBe("object");
  });

  it("fairness exports sortFairly + pickFairly", async () => {
    const m = await import("../../src/application/fairness.js");
    expect(typeof m.sortFairly).toBe("function");
    expect(typeof m.pickFairly).toBe("function");
  });

  it("daemon CLI exports daemonMain", async () => {
    const m = await import("../../src/cli/daemon.js");
    expect(typeof m.daemonMain).toBe("function");
  });
});

describe("Phase 4 — acquisition order CI gate (RGC-DAEMON-STARTUP §운영 진입 게이트)", () => {
  it("every (held, requested) pair where held >= requested rank throws", async () => {
    const { assertCanAcquire, LEASE_ORDER_RANK } = await import(
      "../../src/application/lease-acquisition-order.js"
    );
    const kinds = Object.keys(LEASE_ORDER_RANK) as Array<keyof typeof LEASE_ORDER_RANK>;
    for (const held of kinds) {
      for (const req of kinds) {
        if (LEASE_ORDER_RANK[held] >= LEASE_ORDER_RANK[req]) {
          expect(() => assertCanAcquire([held], req)).toThrow();
        } else {
          expect(() => assertCanAcquire([held], req)).not.toThrow();
        }
      }
    }
  });
});
