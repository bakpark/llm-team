/**
 * Phase 1a contract conformance.
 *
 * Asserts that the contract README's CONTRACT-CONFORMANCE matrix points at
 * implementation_surface paths that actually exist for every anchor this
 * phase is responsible for. Per the plan, each phase updates only its own
 * surface entries — this test enforces that this phase's surfaces have not
 * regressed.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");
const PERSISTENCE_LAYOUT = resolve(
  REPO_ROOT,
  "docs/architecture/persistence-layout.md",
);

/** Anchors this phase 1a is responsible for. */
const PHASE_1A_ANCHORS = ["RGC-LEDGER", "TCC-IDENTITY", "SOC-IDEMPOTENCY"];

function readReadme(): string {
  return readFileSync(README, "utf8");
}

function findRowForAnchor(readme: string, anchor: string): string {
  const re = new RegExp(`\\|\\s*\`${anchor}\`[^\n]*\\|`);
  const match = readme.match(re);
  if (!match) throw new Error(`anchor ${anchor} not found in README matrix`);
  return match[0];
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

describe("Phase 1a — contract conformance matrix", () => {
  const readme = readReadme();

  for (const anchor of PHASE_1A_ANCHORS) {
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

describe("Phase 1a — persistence layout authority", () => {
  const layout = readFileSync(PERSISTENCE_LAYOUT, "utf8");

  it("declares Milestone / Slice / SliceMerge authoritative paths", () => {
    expect(layout).toMatch(/milestones\/\s*\n\s*<milestone_id>\.json/);
    expect(layout).toMatch(/slices\/\s*\n\s*<slice_id>\.json/);
    expect(layout).toMatch(/slice_merges\/\s*\n\s*<slice_merge_id>\.json/);
  });

  it("declares the lease record path (record schema only — acquisition in phase 4)", () => {
    expect(layout).toMatch(/leases\/\s*\n\s*<lease_id>\.json/);
  });
});

describe("Phase 1a — legacy phase-model imports forbidden", () => {
  const fg = require("node:fs");
  const path = require("node:path");

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of fg.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fg.statSync(full);
      if (stat.isDirectory()) out.push(...walk(full));
      else if (full.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("no src/ file imports from docs/history/legacy-phase-model/", () => {
    const tsFiles = walk(resolve(REPO_ROOT, "src"));
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const body = readFileSync(file, "utf8");
      if (/legacy-phase-model/.test(body)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Phase 1a — ledger row schema includes target_id (TCC-IDENTITY)", () => {
  it("schema file mentions target_id as required", () => {
    const body = readFileSync(
      resolve(REPO_ROOT, "src/domain/schema/ledger.ts"),
      "utf8",
    );
    expect(body).toMatch(/target_id:\s*z\.string\(\)\.min\(1\)/);
    expect(body).toMatch(
      /audit_hash:\s*z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{64\}\$\//,
    );
    expect(body).toMatch(
      /audit_hash_prev:\s*z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{64\}\$\//,
    );
  });
});

describe("Phase 1a — Lease record schema matches RGC-LEASE-KINDS", () => {
  it("uses lease_kind discriminator and contract field names (claimed_at, object_id)", async () => {
    const mod = (await import(
      resolve(REPO_ROOT, "src/domain/schema/lease.ts")
    )) as typeof import("../../src/domain/schema/lease.js");
    const shape = (mod.SliceLease as unknown as { _def: { shape: () => Record<string, unknown> } })
      ._def.shape();
    for (const required of [
      "lease_id",
      "lease_kind",
      "object_id",
      "worker_id",
      "claimed_at",
      "expires_at",
      "lease_token",
      "ttl_ms",
      "ttl_source",
    ]) {
      expect(Object.keys(shape)).toContain(required);
    }
    // Guard against regression to the legacy `kind`/`acquired_at` names.
    expect(Object.keys(shape)).not.toContain("kind");
    expect(Object.keys(shape)).not.toContain("acquired_at");
  });

  it("turn_lease and session_lease require agent_profile_id", async () => {
    const mod = (await import(
      resolve(REPO_ROOT, "src/domain/schema/lease.ts")
    )) as typeof import("../../src/domain/schema/lease.js");
    for (const v of [mod.TurnLease, mod.SessionLease]) {
      const shape = (v as unknown as { _def: { shape: () => Record<string, unknown> } })
        ._def.shape();
      expect(Object.keys(shape)).toContain("agent_profile_id");
    }
  });
});

describe("Phase 1a — Identity schema models TCC-IDENTITY", () => {
  it("declares target_id required and persistent_store_ref optional", async () => {
    const mod = (await import(
      resolve(REPO_ROOT, "src/config/target-schema.ts")
    )) as typeof import("../../src/config/target-schema.js");
    const shape = (mod.Identity as unknown as { _def: { shape: () => Record<string, unknown> } })
      ._def.shape();
    expect(Object.keys(shape)).toContain("target_id");
    expect(Object.keys(shape)).toContain("persistent_store_ref");
    expect(Object.keys(shape)).toContain("label_prefix");
  });
});

describe("Phase 1a — ULID refinement enforced on Caller-issued ids", () => {
  it("Milestone schema rejects non-ULID milestone_id", async () => {
    const mod = (await import(
      resolve(REPO_ROOT, "src/domain/schema/milestone.ts")
    )) as typeof import("../../src/domain/schema/milestone.js");
    expect(() =>
      mod.Milestone.parse({
        milestone_id: "M1",
        target_id: "demo",
        title: "x",
        state: "M_INTAKE_QUEUED",
        slot_kind: null,
        intake_source_kind: "k",
        intake_source_id: "s",
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: "2026-05-07T00:00:00.000Z",
        updated_at: "2026-05-07T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
