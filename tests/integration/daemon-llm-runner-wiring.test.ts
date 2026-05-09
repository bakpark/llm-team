import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonMain } from "../../src/cli/daemon.js";

/**
 * Phase 7a (G1-1) — production wiring for the daemon LLM runner.
 *
 * The daemon used to require `--fake-llm-fixtures` for any non-recovery
 * role and threw "real adapters wired in later phases" otherwise. After
 * 7a it MUST assemble a `MultiProfileLlmRunner` from `cfg.agent_profiles`
 * via `buildRunnerRegistry`, with `--fake-llm-fixtures` retained only as
 * a test-only override.
 *
 * This test exercises the production path: no `--fake-llm-fixtures`
 * flag, all profiles bound to `runner: "fake"` (so registry construction
 * succeeds without spawning a real CLI), then runs `--once` against an
 * empty store and asserts the daemon emits a `noop` outcome rather than
 * the legacy "real adapters wired in later phases" error.
 */

const TARGET_ID = "demo-target";

function writeTarget(workdir: string, runner: "fake" | "claude_code"): string {
  const target = {
    identity: {
      target_id: TARGET_ID,
      workdir_path: workdir,
      audit_hash_seed: "seed-7a",
    },
    agent_profiles: {
      atlas: { runner },
      forge: { runner },
      sentinel: { runner },
      scout: { runner },
    },
  };
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

describe("Phase 7a — daemon production LLM runner wiring (G1-1)", () => {
  let prevFixtureDir: string | undefined;

  beforeEach(() => {
    prevFixtureDir = process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
  });

  afterEach(() => {
    if (prevFixtureDir == null) delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    else process.env.LLM_TEAM_FAKE_FIXTURE_DIR = prevFixtureDir;
  });

  it("turn-worker --once boots from cfg.agent_profiles without --fake-llm-fixtures", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7a-daemon-tw-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7a-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir, "fake");

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
        "phase7a-tw",
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
    // Empty store → no SLICE_READY work → noop. The key assertion is
    // that we reached this code path at all (the legacy guard would
    // have thrown synchronously before any outcome was written).
    expect(parsed.outcome.kind).toBe("noop");
  });

  it("dialogue-coordinator --once boots from cfg.agent_profiles without --fake-llm-fixtures", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7a-daemon-dc-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7a-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir, "fake");

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
        "phase7a-dc",
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

  it("outer-coordinator --once boots from cfg.agent_profiles without --fake-llm-fixtures", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7a-daemon-oc-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7a-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir, "fake");

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "outer-coordinator",
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
        "phase7a-oc",
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
    expect(parsed.role).toBe("outer-coordinator");
    expect(parsed.outcome.kind).toBe("noop");
  });

  it("fails clearly when fake runner is configured but LLM_TEAM_FAKE_FIXTURE_DIR is unset", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7a-daemon-err-"));
    delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    const targetPath = writeTarget(workdir, "fake");

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
        "phase7a-err",
      ]),
    ).rejects.toThrow(/LLM_TEAM_FAKE_FIXTURE_DIR/);
  });

  it("recovery role still boots with no LLM runner (no fake fixtures, no env)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7a-daemon-rc-"));
    delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    // Use claude_code so registry-build would succeed if it were attempted,
    // but recovery role MUST skip llmRunner construction entirely.
    const targetPath = writeTarget(workdir, "claude_code");
    mkdirSync(join(workdir, "log"), { recursive: true });

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
        "phase7a-rc",
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
    expect(parsed.role).toBe("recovery");
    expect(parsed.outcome.kind).toBe("swept");
  });
});
