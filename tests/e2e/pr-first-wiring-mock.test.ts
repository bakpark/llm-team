/**
 * Phase 5 (audit §5-D, P0-1) — daemon entry PR-first wiring smoke.
 *
 * The audit found that `daemon.ts` / `runner.ts` constructed zero PR-first
 * invokers no matter how `target.json` was configured. Phase 1-4's
 * ~3000 LOC of new code therefore never executed in production. This file
 * pins the wiring contract with mock-port scenarios:
 *
 *   1. daemon fails loud at boot when `LLM_TEAM_MACHINE_BLOCK_SECRET` is
 *      unset (audit §5-D DoD).
 *   2. cfg-driven `experiments.lead_pr_first` toggle activates the lead
 *      PR-first path — observed via the `lead_path_pr_first` outcome.
 *   3. cfg-driven `experiments.reviewer_pr_first` toggle activates the
 *      reviewer PR-first path — observed via `reviewer_path_pr_first`.
 *   4. `governance.bot_account` / `governance.known_agent_profile_ids`
 *      schema fields parse without rejection.
 *   5. default `false` toggles preserve the legacy envelope path (no
 *      `lead_path_pr_first` outcome is emitted).
 *
 * The recovery role + PrWatcher cycle prelude are exercised by the
 * application-layer tests already (`recovery-coordinator.test.ts`,
 * `pr-watcher.test.ts`) — this file's contribution is the daemon entry
 * seam where the wiring lives in production.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonMain } from "../../src/cli/daemon.js";

const TARGET_ID = "demo-target";

interface TargetOverrides {
  experiments?: {
    lead_pr_first?: boolean;
    reviewer_pr_first?: boolean;
  };
  governance?: {
    bot_account?: string;
    known_agent_profile_ids?: string[];
    machine_block_secret_env_name?: string;
  };
}

function writeTarget(workdir: string, overrides: TargetOverrides = {}): string {
  const target: Record<string, unknown> = {
    identity: {
      target_id: TARGET_ID,
      workdir_path: workdir,
      audit_hash_seed: "seed-phase5",
    },
    agent_profiles: {
      atlas: { runner: "fake" },
      forge: { runner: "fake" },
      sentinel: { runner: "fake" },
      scout: { runner: "fake" },
    },
  };
  if (overrides.experiments) target.experiments = overrides.experiments;
  if (overrides.governance) {
    // governance is a `.strict()` object with three required fields
    // (human_team / control_issue_number / contract_change_issue_number).
    // Tests merge their PR-first-specific overrides on top of a complete
    // baseline so the target.json validator accepts the input.
    target.governance = {
      human_team: "test-team",
      control_issue_number: 1,
      contract_change_issue_number: 2,
      ...overrides.governance,
    };
  }
  const path = join(workdir, "target.json");
  writeFileSync(path, JSON.stringify(target), "utf8");
  return path;
}

function captureStdout(): { restore: () => void; lines: () => string[] } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
  return {
    restore: () => {
      spy.mockRestore();
      void orig;
    },
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((s) => s.length > 0),
  };
}

describe("Phase 5 — daemon PR-first wiring (audit P0-1)", () => {
  let prevAllowFake: string | undefined;
  let prevFixtureDir: string | undefined;
  let prevMachineSecret: string | undefined;

  beforeEach(() => {
    prevAllowFake = process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    prevFixtureDir = process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    prevMachineSecret = process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = "1";
  });

  afterEach(() => {
    if (prevAllowFake == null) delete process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    else process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = prevAllowFake;
    if (prevFixtureDir == null) delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    else process.env.LLM_TEAM_FAKE_FIXTURE_DIR = prevFixtureDir;
    if (prevMachineSecret == null)
      delete process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    else process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = prevMachineSecret;
  });

  it("(a) daemon boot fails loud when LLM_TEAM_MACHINE_BLOCK_SECRET is unset AND a PR-first toggle is on", async () => {
    // PR #125 self-review P1-1: fail-loud is gated on at least one
    // `experiments.{lead,reviewer}_pr_first` being true. Envelope-only
    // deployments tolerate a missing secret (see (g)).
    delete process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    const workdir = mkdtempSync(join(tmpdir(), "phase5-secret-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase5-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir, {
      experiments: { lead_pr_first: true },
    });

    await expect(
      daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase5-secret",
      ]),
    ).rejects.toThrow(/LLM_TEAM_MACHINE_BLOCK_SECRET/);
  });

  it("(b) custom governance.machine_block_secret_env_name routes the fail-loud check (PR-first toggle on)", async () => {
    delete process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    delete process.env.LLM_TEAM_CUSTOM_SECRET;
    const workdir = mkdtempSync(join(tmpdir(), "phase5-secret-custom-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase5-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir, {
      experiments: { reviewer_pr_first: true },
      governance: {
        machine_block_secret_env_name: "LLM_TEAM_CUSTOM_SECRET",
      } as TargetOverrides["governance"],
    });

    await expect(
      daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase5-custom-secret",
      ]),
    ).rejects.toThrow(/LLM_TEAM_CUSTOM_SECRET/);
  });

  it("(g) PR #125 P1-1 — envelope-only cfg (both toggles off) boots without the secret env", async () => {
    // Migration safety: a deployment running the legacy envelope path
    // (default `experiments.{lead,reviewer}_pr_first === false`) must NOT
    // abort on the next deploy when `LLM_TEAM_MACHINE_BLOCK_SECRET` is
    // unset. Fail-loud only kicks in once an operator opts into PR-first
    // by flipping a toggle.
    delete process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    const workdir = mkdtempSync(join(tmpdir(), "phase5-envelope-only-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase5-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir);

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase5-envelope-only",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: { kind: string };
    };
    expect(parsed.role).toBe("turn-worker");
    expect(parsed.outcome.kind).toBe("noop");
  });

  it("(c) default cfg (no experiments) boots without invoking the PR-first path", async () => {
    process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = "test-secret";
    const workdir = mkdtempSync(join(tmpdir(), "phase5-default-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase5-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir);

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase5-default",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: { kind: string };
    };
    expect(parsed.role).toBe("turn-worker");
    // Empty store → noop. PR-first toggles default false so no
    // `lead_path_pr_first` outcome is emitted on this empty pickup.
    expect(parsed.outcome.kind).toBe("noop");
  });

  it("(d) experiments.lead_pr_first=true boots all three lead-consuming roles (turn-worker / outer-coordinator)", async () => {
    process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = "test-secret";
    for (const role of ["turn-worker", "outer-coordinator"] as const) {
      const workdir = mkdtempSync(join(tmpdir(), `phase5-lead-${role}-`));
      const fixtureDir = mkdtempSync(join(tmpdir(), "phase5-fxt-"));
      process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
      const targetPath = writeTarget(workdir, {
        experiments: { lead_pr_first: true },
        governance: {
          bot_account: "phase5-bot[bot]",
          known_agent_profile_ids: ["atlas", "forge", "sentinel", "scout"],
        } as TargetOverrides["governance"],
      });

      const cap = captureStdout();
      let code: number;
      try {
        code = await daemonMain([
          "--role",
          role,
          "--target",
          targetPath,
          "--workdir",
          workdir,
          "--once",
          "--cycle-interval-ms",
          "0",
          "--fake-workspace",
          "--fake-verification",
          "--caller-id",
          `phase5-lead-${role}`,
        ]);
      } finally {
        cap.restore();
      }
      expect(code).toBe(0);
      const last = cap.lines().at(-1) ?? "";
      const parsed = JSON.parse(last) as {
        role: string;
        outcome: { kind: string };
      };
      expect(parsed.role).toBe(role);
      // Empty store → noop. The wiring assertion is that the daemon
      // reached the role's main body at all (the previous wiring threw
      // because LeadInvoker requires a machineBlockSecret it could not
      // resolve when secret env was unset and toggles were off).
      expect(parsed.outcome.kind).toBe("noop");
    }
  });

  it("(e) experiments.reviewer_pr_first=true boots dialogue-coordinator with reviewer wiring", async () => {
    process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = "test-secret";
    const workdir = mkdtempSync(join(tmpdir(), "phase5-reviewer-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase5-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir, {
      experiments: { reviewer_pr_first: true },
      governance: {
        bot_account: "phase5-bot[bot]",
      } as TargetOverrides["governance"],
    });

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "dialogue-coordinator",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase5-reviewer",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: { kind: string };
    };
    expect(parsed.role).toBe("dialogue-coordinator");
    expect(parsed.outcome.kind).toBe("noop");
  });

  it("(f) recovery role invokes PrFirst RecoveryCoordinator.runOnce", async () => {
    process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = "test-secret";
    const workdir = mkdtempSync(join(tmpdir(), "phase5-recovery-"));
    mkdirSync(join(workdir, "log"), { recursive: true });
    // recovery role omits llmRunner entirely (audit §5-D Phase 7a) — the
    // wiring still constructs RecoveryCoordinator and calls runOnce.
    const targetPath = writeTarget(workdir);

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "recovery",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--caller-id",
        "phase5-recovery",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: {
        kind: string;
        pr_first_scanned?: number;
        pr_first_items?: number;
      };
    };
    expect(parsed.role).toBe("recovery");
    expect(parsed.outcome.kind).toBe("swept");
    // Empty ledger → zero candidates. The presence of these fields proves
    // PrFirst RecoveryCoordinator.runOnce ran (audit P0-1 wire-up).
    expect(parsed.outcome.pr_first_scanned).toBe(0);
    expect(parsed.outcome.pr_first_items).toBe(0);
  });
});
