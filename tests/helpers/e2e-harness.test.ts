import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_E2E_COST_CAP_USD,
  createE2eRun,
  snapshotBlastRadius,
  verifyBlastRadius,
} from "./e2e-harness.js";

describe("e2e harness — createE2eRun", () => {
  it("creates an isolated workdir with mode 0700 and overrides identity paths", () => {
    const handle = createE2eRun();
    try {
      // Workdir parent (run root) is mode 0700.
      const runRoot = handle.workdir.replace(/\/workdir$/, "");
      const stat = statSync(runRoot);
      expect(stat.isDirectory()).toBe(true);
      // POSIX mode mask — only the lower 9 bits matter.
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode & 0o077).toBe(0); // group + other have no perms

      // Fixture override: identity.workdir_path must match the handle.workdir.
      expect(handle.target.identity.workdir_path).toBe(handle.workdir);
      expect(handle.target.identity.agent_cwd).toBe(handle.agentCwd);
      // target_id is preserved from the fixture.
      expect(handle.target.identity.target_id).toBe("e2e-sandbox");
    } finally {
      handle.cleanup();
    }
  });

  it("cleanup removes the run root", () => {
    const handle = createE2eRun();
    const runRoot = handle.workdir.replace(/\/workdir$/, "");
    handle.cleanup();
    expect(existsSync(runRoot)).toBe(false);
  });

  it("respects LLM_TEAM_E2E_COST_CAP_USD and falls back to default", () => {
    const handle = createE2eRun({
      env: { LLM_TEAM_E2E_COST_CAP_USD: "0.42" },
    });
    try {
      expect(handle.costCapUsd).toBe(0.42);
    } finally {
      handle.cleanup();
    }

    const fallback = createE2eRun({ env: {} });
    try {
      expect(fallback.costCapUsd).toBe(DEFAULT_E2E_COST_CAP_USD);
    } finally {
      fallback.cleanup();
    }
  });

  it("respects LLM_TEAM_E2E_TMPDIR override", () => {
    const altRoot = mkdtempSync(join(tmpdir(), "alt-tmp-"));
    const handle = createE2eRun({ env: { LLM_TEAM_E2E_TMPDIR: altRoot } });
    try {
      expect(handle.workdir.startsWith(altRoot)).toBe(true);
    } finally {
      handle.cleanup();
    }
  });

  it("rejects malformed cost cap string and uses default", () => {
    const handle = createE2eRun({
      env: { LLM_TEAM_E2E_COST_CAP_USD: "not-a-number" },
    });
    try {
      expect(handle.costCapUsd).toBe(DEFAULT_E2E_COST_CAP_USD);
    } finally {
      handle.cleanup();
    }
  });
});

describe("e2e harness — snapshot/verify blast radius", () => {
  it("matches when nothing changes (no production ledger)", () => {
    const baseline = snapshotBlastRadius();
    expect(() => verifyBlastRadius(baseline)).not.toThrow();
  });

  it("detects production ledger size drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "prodledger-"));
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, "row-1\n", "utf8");
    const baseline = snapshotBlastRadius({ productionLedgerPath: ledgerPath });
    writeFileSync(ledgerPath, "row-1\nrow-2\n", "utf8");
    expect(() =>
      verifyBlastRadius(baseline, { productionLedgerPath: ledgerPath }),
    ).toThrow(/ledger size changed/);
  });

  it("tolerates missing production ledger (size=0 vs size=0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "noledger-"));
    const ledgerPath = join(dir, "missing.ndjson");
    const baseline = snapshotBlastRadius({ productionLedgerPath: ledgerPath });
    expect(baseline.productionLedgerSize).toBe(0);
    expect(() =>
      verifyBlastRadius(baseline, { productionLedgerPath: ledgerPath }),
    ).not.toThrow();
  });

  it("returns sentinel for non-git trunkRoot and matches itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "nogit-"));
    const baseline = snapshotBlastRadius({ trunkRoot: dir });
    expect(baseline.trunkStatus).toBe("<no-git>");
    expect(() => verifyBlastRadius(baseline, { trunkRoot: dir })).not.toThrow();
  });
});
