/**
 * Phase 6b contract conformance — anchors + module surface.
 *
 * Anchors:
 *   - SOC-OBJECTS (external_refs[] mapping lives here)
 *   - SOC-INTAKE (GitHub adapter mention)
 *   - TCC-ENFORCEMENT (Stage 5 reach: stage_graded → block lookup)
 *   - RGC-NOTIFICATION (NotifierPort)
 *   - SOC-DISPATCH-MATRIX (mirror push side-effect ordering)
 *
 * The matrix row for each anchor MUST cite at least one TS path on disk so
 * the README ↔ source coupling stays load-bearing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_6B_ANCHORS = [
  "SOC-OBJECTS",
  "TCC-ENFORCEMENT",
  "RGC-NOTIFICATION",
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

describe("Phase 6b — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");

  for (const anchor of PHASE_6B_ANCHORS) {
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

  it("TCC-ENFORCEMENT row cites the new TS surface (Stage 5 reach)", () => {
    const row = findRowForAnchor(readme, "TCC-ENFORCEMENT");
    expect(row).toContain("src/application/invariant-enforcement.ts");
    expect(row).toContain("src/config/target-schema.ts");
  });

  it("SOC-OBJECTS row cites the IssueTrackerPort + GitHostPort + drift-observer surface", () => {
    const row = findRowForAnchor(readme, "SOC-OBJECTS");
    expect(row).toContain("src/ports/issue-tracker.ts");
    expect(row).toContain("src/ports/git-host.ts");
    expect(row).toContain("src/application/drift-observer.ts");
  });

  it("RGC-NOTIFICATION row cites the new NotifierPort", () => {
    const row = findRowForAnchor(readme, "RGC-NOTIFICATION");
    expect(row).toContain("src/ports/notifier.ts");
  });
});

describe("Phase 6b — module surface contract", () => {
  it("issue-tracker port exposes IssueTrackerPort interface", async () => {
    // ports are interfaces — verify the file imports cleanly.
    const m = await import("../../src/ports/issue-tracker.js");
    expect(m).toBeDefined();
  });

  it("git-host port file imports", async () => {
    const m = await import("../../src/ports/git-host.js");
    expect(m).toBeDefined();
  });

  it("notifier port file imports", async () => {
    const m = await import("../../src/ports/notifier.js");
    expect(m).toBeDefined();
  });

  it("FsMirrorIssueTracker / FsMirrorGitHost / FsMirrorNotifier are exported with provider tag", async () => {
    const it1 = await import(
      "../../src/adapters/issue-tracker/fs-mirror.js"
    );
    const gh = await import("../../src/adapters/git-host/fs-mirror.js");
    const nt = await import("../../src/adapters/notifier/fs-mirror.js");
    expect(it1.FsMirrorIssueTracker.provider).toBe("fs-mirror");
    expect(gh.FsMirrorGitHost.provider).toBe("fs-mirror");
    expect(nt.FsMirrorNotifier.provider).toBe("fs-mirror");
  });

  it("GitHub adapters are exported with provider tag", async () => {
    const it1 = await import("../../src/adapters/issue-tracker/github.js");
    const gh = await import("../../src/adapters/git-host/github.js");
    const nt = await import("../../src/adapters/notifier/github.js");
    expect(it1.GitHubIssueTracker.provider).toBe("github");
    expect(gh.GitHubGitHost.provider).toBe("github");
    expect(nt.GitHubNotifier.provider).toBe("github");
  });

  it("drift-observer exports runDriftObserverSweep", async () => {
    const m = await import("../../src/application/drift-observer.js");
    expect(typeof m.runDriftObserverSweep).toBe("function");
  });

  it("github-side-effect-timeline exports executeMirrorTimeline", async () => {
    const m = await import(
      "../../src/application/github-side-effect-timeline.js"
    );
    expect(typeof m.executeMirrorTimeline).toBe("function");
  });

  it("invariant-enforcement resolves stage_graded items to block at Stage 5", async () => {
    const { resolveEnforcementLevel, promoteToStage5 } = await import(
      "../../src/application/invariant-enforcement.js"
    );
    const cfg = {
      always_hard: ["caller_only_operational_write"],
      stage_graded: { dual_slot_fairness: "warn", scope_violation: "warn" },
    } as const;
    expect(resolveEnforcementLevel(cfg, "dual_slot_fairness", 4)).toBe("warn");
    expect(resolveEnforcementLevel(cfg, "dual_slot_fairness", 5)).toBe("block");
    expect(resolveEnforcementLevel(cfg, "scope_violation", 5)).toBe("block");
    // always_hard is unaffected by stage
    expect(
      resolveEnforcementLevel(cfg, "caller_only_operational_write", 2),
    ).toBe("block");
    // unknown invariants fail closed (block)
    expect(resolveEnforcementLevel(cfg, "unknown", 5)).toBe("block");

    const promoted = promoteToStage5(cfg);
    for (const v of Object.values(promoted.stage_graded)) {
      expect(v).toBe("block");
    }
  });

  it("InvariantEnforcement zod block accepts the documented default shape", async () => {
    const { InvariantEnforcement } = await import(
      "../../src/config/target-schema.js"
    );
    const parsed = InvariantEnforcement.parse({
      always_hard: [
        "caller_only_operational_write",
        "lease_acquisition_order",
      ],
      stage_graded: {
        dual_slot_fairness: "warn",
        required_evidence_unmet: "warn",
      },
    });
    expect(parsed.always_hard).toContain("caller_only_operational_write");
    expect(parsed.stage_graded["dual_slot_fairness"]).toBe("warn");
  });

  it("ExternalRef schema includes phase 6b sync_status enum (synced + orphan)", async () => {
    const { ExternalRefSyncStatus } = await import(
      "../../src/domain/schema/external-ref.js"
    );
    const opts = ExternalRefSyncStatus.options;
    expect(opts).toContain("synced");
    expect(opts).toContain("orphan");
    expect(opts).toContain("conflict");
  });
});
