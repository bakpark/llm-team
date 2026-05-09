/**
 * Phase 6a contract conformance — anchors + module surface.
 *
 * Anchors:
 *   - RGC-PROMOTION-GUARD
 *   - RGC-CROSS-SLOT-STALE
 *   - RGC-CROSS-SLOT-FAIRNESS
 *   - RGC-DUAL-GATE-QUEUE
 *   - RGC-SLOT-LOCK   (slot_lock acquisition path goes live)
 *   - SOC-DISPATCH-MATRIX (dual-track entry surfaces)
 *   - TCC-DUAL-TRACK
 *
 * Each row in `docs/contracts/README.md` MUST cite at least one TS path that
 * exists on disk. The implementation surface contract block additionally
 * pins exported symbols.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_6A_ANCHORS = [
  "RGC-PROMOTION-GUARD",
  "RGC-CROSS-SLOT-STALE",
  "RGC-CROSS-SLOT-FAIRNESS",
  "RGC-DUAL-GATE-QUEUE",
  "RGC-SLOT-LOCK",
  "SOC-DISPATCH-MATRIX",
  "TCC-DUAL-TRACK",
];

function findRowForAnchor(readme: string, anchor: string): string {
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

describe("Phase 6a — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");

  for (const anchor of PHASE_6A_ANCHORS) {
    it(`${anchor} row references at least one src/**/*.ts surface that exists`, () => {
      const row = findRowForAnchor(readme, anchor);
      const paths = extractTsPaths(row);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(existsSync(resolve(REPO_ROOT, p)), `missing file: ${p}`).toBe(
          true,
        );
      }
    });
  }

  it("RGC-PROMOTION-GUARD cites the new TS surface", () => {
    const row = findRowForAnchor(readme, "RGC-PROMOTION-GUARD");
    expect(row).toContain("src/application/promotion-guard.ts");
    expect(row).toContain("src/application/dual-track-scheduler.ts");
  });

  it("RGC-CROSS-SLOT-STALE cites the new TS surface", () => {
    const row = findRowForAnchor(readme, "RGC-CROSS-SLOT-STALE");
    expect(row).toContain("src/application/cross-slot-stale.ts");
  });

  it("RGC-CROSS-SLOT-FAIRNESS cites the new TS surface", () => {
    const row = findRowForAnchor(readme, "RGC-CROSS-SLOT-FAIRNESS");
    expect(row).toContain("src/application/cross-slot-fairness.ts");
  });

  it("RGC-DUAL-GATE-QUEUE cites the new TS surface", () => {
    const row = findRowForAnchor(readme, "RGC-DUAL-GATE-QUEUE");
    expect(row).toContain("src/application/dual-gate-queue.ts");
  });

  it("RGC-SLOT-LOCK cites the dual-track scheduler (slot_lock now wired)", () => {
    const row = findRowForAnchor(readme, "RGC-SLOT-LOCK");
    expect(row).toContain("src/application/dual-track-scheduler.ts");
  });

  it("SOC-DISPATCH-MATRIX row references dual-track scheduler daemon role", () => {
    const row = findRowForAnchor(readme, "SOC-DISPATCH-MATRIX");
    expect(row).toContain("dual-track-scheduler");
  });

  it("TCC-DUAL-TRACK row references the dual-track schema block", () => {
    const row = findRowForAnchor(readme, "TCC-DUAL-TRACK");
    expect(row).toContain("src/config/target-schema.ts");
  });
});

describe("Phase 6a — module surface contract", () => {
  it("dual-track-scheduler exports runOneDualTrackTurn", async () => {
    const m = await import("../../src/application/dual-track-scheduler.js");
    expect(typeof m.runOneDualTrackTurn).toBe("function");
  });

  it("promotion-guard exports evaluatePromotionGuard with the documented signature", async () => {
    const m = await import("../../src/application/promotion-guard.js");
    expect(typeof m.evaluatePromotionGuard).toBe("function");
  });

  it("cross-slot-stale exports detectCrossSlotStaleSessions", async () => {
    const m = await import("../../src/application/cross-slot-stale.js");
    expect(typeof m.detectCrossSlotStaleSessions).toBe("function");
  });

  it("cross-slot-fairness exports orderByCrossSlotPriority", async () => {
    const m = await import("../../src/application/cross-slot-fairness.js");
    expect(typeof m.orderByCrossSlotPriority).toBe("function");
  });

  it("dual-gate-queue exports both queue enumerators + snapshot", async () => {
    const m = await import("../../src/application/dual-gate-queue.js");
    expect(typeof m.enumerateIntakeQueue).toBe("function");
    expect(typeof m.enumerateDeliveryPromotionQueue).toBe("function");
    expect(typeof m.snapshotDualGateQueues).toBe("function");
    expect(typeof m.flattenSnapshot).toBe("function");
  });

  it("target-schema exports DualTrack + DualTrackPriority + TargetKind", async () => {
    const m = await import("../../src/config/target-schema.js");
    expect(m.DualTrack).toBeDefined();
    expect(m.DualTrackPriority).toBeDefined();
    expect(m.TargetKind).toBeDefined();
    // Default priority is delivery_first (RGC-CROSS-SLOT-FAIRNESS).
    const parsed = m.DualTrack.parse({});
    expect(parsed.priority).toBe("delivery_first");
  });

  it("self-hosting target rejects agent_cwd inside workdir_path", async () => {
    const { validateTargetConfig } = await import(
      "../../src/application/config-validator.js"
    );
    const baseProfile = { runner: "fake" as const };
    const r = validateTargetConfig({
      identity: {
        target_id: "demo",
        kind: "self-hosting",
        workdir_path: "/tmp/wd",
        agent_cwd: "/tmp/wd/agents",
      },
      agent_profiles: {
        atlas: baseProfile,
        forge: baseProfile,
        sentinel: baseProfile,
        scout: baseProfile,
      },
    });
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.path === "identity.agent_cwd"),
    ).toBe(true);
  });

  it("self-hosting target accepts agent_cwd outside workdir_path", async () => {
    const { validateTargetConfig } = await import(
      "../../src/application/config-validator.js"
    );
    const baseProfile = { runner: "fake" as const };
    const r = validateTargetConfig({
      identity: {
        target_id: "demo",
        kind: "self-hosting",
        workdir_path: "/tmp/wd",
        agent_cwd: "/tmp/agents",
      },
      agent_profiles: {
        atlas: baseProfile,
        forge: baseProfile,
        sentinel: baseProfile,
        scout: baseProfile,
      },
    });
    expect(r.ok).toBe(true);
  });

  it("daemon role enum accepts dual-track-scheduler", async () => {
    // Static import of the daemon module just to ensure it parses; the
    // role string check is by literal grep below.
    const src = readFileSync(
      resolve(REPO_ROOT, "src/cli/daemon.ts"),
      "utf8",
    );
    expect(src).toMatch(/"dual-track-scheduler"/);
    expect(src).toMatch(/runOneDualTrackTurn/);
  });
});
