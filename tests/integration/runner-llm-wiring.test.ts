import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runnerMain } from "../../src/cli/runner.js";

/**
 * Phase 7a (G1-1) — runner CLI wiring mirror of the daemon test.
 *
 * `src/cli/runner.ts` previously hardcoded the same "real adapters wired
 * in later phases" guard whenever `--fake-llm-fixtures` was missing.
 * After 7a it MUST assemble a `MultiProfileLlmRunner` from
 * `cfg.agent_profiles` so a single-iteration runner can boot in
 * production mode (the actual external CLI is never invoked here — the
 * empty store yields a `noop` outcome, which is sufficient to prove the
 * wiring is now in place).
 */

const TARGET_ID = "demo-target";

function writeTarget(workdir: string): string {
  const target = {
    identity: {
      target_id: TARGET_ID,
      workdir_path: workdir,
      audit_hash_seed: "seed-7a-runner",
    },
    agent_profiles: {
      atlas: { runner: "fake" },
      forge: { runner: "fake" },
      sentinel: { runner: "fake" },
      scout: { runner: "fake" },
    },
  };
  const path = join(workdir, "target.json");
  writeFileSync(path, JSON.stringify(target), "utf8");
  return path;
}

function captureStdout(): { restore: () => void; lines: () => string[] } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
  return {
    restore: () => spy.mockRestore(),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((s) => s.length > 0),
  };
}

describe("Phase 7a — runner CLI production LLM runner wiring (G1-1)", () => {
  let prevFixtureDir: string | undefined;
  let prevAllowFake: string | undefined;

  beforeEach(() => {
    prevFixtureDir = process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    prevAllowFake = process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    // PR #73 review (P1): test-only opt-in for `runner: "fake"` in the
    // production CLI wiring path.
    process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = "1";
  });

  afterEach(() => {
    if (prevFixtureDir == null) delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    else process.env.LLM_TEAM_FAKE_FIXTURE_DIR = prevFixtureDir;
    if (prevAllowFake == null) delete process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    else process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = prevAllowFake;
  });

  it("--once --agent-profile forge boots from cfg without --fake-llm-fixtures", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7a-runner-fg-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7a-runner-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir);

    const cap = captureStdout();
    let code: number;
    try {
      code = await runnerMain([
        "--once",
        "--agent-profile",
        "forge",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase7a-runner",
      ]);
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as { kind: string };
    expect(parsed.kind).toBe("noop");
  });
});
