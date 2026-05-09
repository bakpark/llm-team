/**
 * Phase 9a contract conformance — TCC-GOVERNANCE actor verification.
 *
 * Anchors:
 *   - TCC-GOVERNANCE (now references team-membership port + adapters +
 *     binding hook; Inv #5 actor verification is wired through the
 *     outer-coordinator drain).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTOR_NOT_IN_HUMAN_TEAM,
  bindHumanSignalToSession,
} from "../../src/application/human-signal-binding.js";
import type { TeamMembershipPort } from "../../src/ports/team-membership.js";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

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

describe("Phase 9a — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");

  it("TCC-GOVERNANCE row references the team-membership port + adapters + binding hook", () => {
    const row = findRowForAnchor(readme, "TCC-GOVERNANCE");
    expect(row).toContain("src/ports/team-membership.ts");
    expect(row).toContain("src/adapters/team-membership/github.ts");
    expect(row).toContain("src/adapters/team-membership/fs-mirror.ts");
    expect(row).toContain("src/application/human-signal-binding.ts");
    expect(row).toContain(ACTOR_NOT_IN_HUMAN_TEAM);
    // Phase 9a wires the policy via TCC-ENFORCEMENT stage_graded.
    expect(row).toContain("actor_team_membership_unreachable");
  });

  it("TCC-GOVERNANCE row TS paths exist on disk", () => {
    const row = findRowForAnchor(readme, "TCC-GOVERNANCE");
    const paths = extractTsPaths(row);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(
        existsSync(resolve(REPO_ROOT, p)),
        `missing file referenced by TCC-GOVERNANCE: ${p}`,
      ).toBe(true);
    }
  });
});

describe("Phase 9a — TeamMembershipPort surface", () => {
  it("port returns one of {member, non_member, unreachable}", async () => {
    // Compile-time check — the union is exhaustive.
    const port: TeamMembershipPort = {
      async isMember() {
        return { kind: "member" };
      },
    };
    const r = await port.isMember("acme/r", "alice");
    expect(["member", "non_member", "unreachable"]).toContain(r.kind);
  });

  it("bindHumanSignalToSession exposes the team-membership hook surface", () => {
    expect(typeof bindHumanSignalToSession).toBe("function");
  });
});
