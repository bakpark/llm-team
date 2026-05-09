import { describe, expect, it } from "vitest";
import {
  parseArgs,
  runHealthcheck,
  type RunCmd,
} from "../../src/cli/healthcheck.js";
import { HealthcheckResult } from "../../src/cli/healthcheck-schema.js";

/**
 * Minimal mock RunCmd. Each entry maps `cmd args.join(" ")` → response.
 * Unknown commands default to a non-zero status so callers must opt in.
 */
function mockRun(table: Record<string, { status: number; stdout?: string; stderr?: string }>): RunCmd {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`.trim();
    const hit = table[key];
    if (hit) {
      return { status: hit.status, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
    }
    return { status: 127, stdout: "", stderr: `mock: no entry for ${key}` };
  };
}

const ALL_PASS_TABLE: Record<string, { status: number; stdout?: string; stderr?: string }> = {
  // command -v probes via shell:true land here as "command -v <name>".
  "command -v claude": { status: 0, stdout: "/usr/bin/claude\n" },
  "command -v codex": { status: 0, stdout: "/usr/bin/codex\n" },
  "command -v gh": { status: 0, stdout: "/usr/bin/gh\n" },
  "command -v git": { status: 0, stdout: "/usr/bin/git\n" },
  "command -v node": { status: 0, stdout: "/usr/bin/node\n" },
  "command -v jq": { status: 0, stdout: "/usr/bin/jq\n" },
  "command -v timeout": { status: 0, stdout: "/usr/bin/timeout\n" },
  "command -v gtimeout": { status: 1 },
  "git --version": { status: 0, stdout: "git version 2.43.0\n" },
  "node --version": { status: 0, stdout: "v20.10.0\n" },
  "npx --no-install vitest list": { status: 0, stdout: "tests/foo.test.ts\n" },
  "gh auth status": { status: 0, stdout: "Logged in (keychain)\n" },
  "gh api user --jq .login": { status: 0, stdout: "octocat\n" },
  "gh auth token": { status: 0, stdout: "ghp_xxx\n" },
  "claude --help": { status: 0, stdout: "Usage: claude [auth|login|...]\n" },
  "codex --help": { status: 0, stdout: "Usage: codex [auth|login|...]\n" },
};

describe("healthcheck parseArgs", () => {
  it("defaults to stage=1, json=false, no opt-ins", () => {
    const a = parseArgs([]);
    expect(a.stage).toBe(1);
    expect(a.json).toBe(false);
    expect(a.includeTypecheck).toBe(false);
    expect(a.includeBuild).toBe(false);
  });
  it("parses flags", () => {
    const a = parseArgs([
      "--stage",
      "1",
      "--json",
      "--include-typecheck",
      "--include-build",
      "--out",
      "./hc",
      "--target",
      "./target.json",
    ]);
    expect(a.stage).toBe(1);
    expect(a.json).toBe(true);
    expect(a.includeTypecheck).toBe(true);
    expect(a.includeBuild).toBe(true);
    expect(a.outDir).toBe("./hc");
    expect(a.targetPath).toBe("./target.json");
  });
  it("rejects unknown stage", () => {
    expect(() => parseArgs(["--stage", "9"])).toThrow();
  });
  it("rejects unknown flag", () => {
    expect(() => parseArgs(["--what"])).toThrow();
  });
});

describe("healthcheck runHealthcheck", () => {
  it("all-pass mock yields passed=true and conforms to Zod schema", () => {
    const result = runHealthcheck(
      { stage: 1, json: false, includeTypecheck: false, includeBuild: false },
      {
        run: mockRun(ALL_PASS_TABLE),
        env: { GH_TOKEN: "ghp_test" },
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    // Zod parse must succeed.
    expect(() => HealthcheckResult.parse(result)).not.toThrow();
    expect(result.passed).toBe(true);
    expect(result.stage).toBe(1);
    expect(result.items.every((i) => i.status !== "FAIL")).toBe(true);
    // Anchors present.
    expect(result.items.map((i) => i.anchor)).toEqual(
      expect.arrayContaining(["M-1-1", "M-1-2", "M-1-3", "M-1-4", "M-2-1", "M-2-2", "M-2-3", "M-2-4", "M-2-5"]),
    );
    // Auth models populated.
    expect(result.auth_models.gh).toBe("env_token");
  });

  it("missing required binary yields FAIL and passed=false", () => {
    const table = { ...ALL_PASS_TABLE };
    table["command -v claude"] = { status: 1 };
    const result = runHealthcheck(
      { stage: 1, json: false, includeTypecheck: false, includeBuild: false },
      {
        run: mockRun(table),
        env: { GH_TOKEN: "ghp_test" },
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(result.passed).toBe(false);
    const m11 = result.items.find((i) => i.id === "M-1-1.required-bins");
    expect(m11?.status).toBe("FAIL");
    expect(m11?.detail).toContain("claude");
  });

  it("git < 2.5 yields FAIL on M-1-2", () => {
    const table = { ...ALL_PASS_TABLE };
    table["git --version"] = { status: 0, stdout: "git version 2.4.0\n" };
    const result = runHealthcheck(
      { stage: 1, json: false, includeTypecheck: false, includeBuild: false },
      {
        run: mockRun(table),
        env: { GH_TOKEN: "ghp_test" },
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(result.passed).toBe(false);
    const m12 = result.items.find((i) => i.id === "M-1-2.git-worktree");
    expect(m12?.status).toBe("FAIL");
  });

  it("typecheck/build are SKIP by default and PASS when opted in", () => {
    const table = { ...ALL_PASS_TABLE };
    table["npm run typecheck --silent"] = { status: 0, stdout: "" };
    table["npm run build --silent"] = { status: 0, stdout: "" };
    const skipped = runHealthcheck(
      { stage: 1, json: false, includeTypecheck: false, includeBuild: false },
      {
        run: mockRun(table),
        env: { GH_TOKEN: "ghp_test" },
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(skipped.items.find((i) => i.id === "M-1-5.typecheck")?.status).toBe("SKIP");
    expect(skipped.items.find((i) => i.id === "M-1-6.build")?.status).toBe("SKIP");

    const optIn = runHealthcheck(
      { stage: 1, json: false, includeTypecheck: true, includeBuild: true },
      {
        run: mockRun(table),
        env: { GH_TOKEN: "ghp_test" },
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(optIn.items.find((i) => i.id === "M-1-5.typecheck")?.status).toBe("PASS");
    expect(optIn.items.find((i) => i.id === "M-1-6.build")?.status).toBe("PASS");
  });

  it("stage 2 returns the phase-prod-3 placeholder", () => {
    const result = runHealthcheck(
      { stage: 2, json: false, includeTypecheck: false, includeBuild: false },
      { run: mockRun({}), env: {}, cwd: process.cwd(), now: () => new Date(0) },
    );
    expect(result.stage).toBe(2);
    expect(result.passed).toBe(true);
    expect(result.items[0]?.detail).toContain("phase-prod-3");
    expect(result.auth_models.claude).toBe("UNKNOWN_UNTIL_STAGE3");
  });

  it("auth model detection: gh env_token and claude env_token via ANTHROPIC_API_KEY", () => {
    const result = runHealthcheck(
      { stage: 1, json: false, includeTypecheck: false, includeBuild: false },
      {
        run: mockRun(ALL_PASS_TABLE),
        env: { GH_TOKEN: "ghp_test", ANTHROPIC_API_KEY: "sk-ant" },
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(result.auth_models.gh).toBe("env_token");
    expect(result.auth_models.claude).toBe("env_token");
    // codex falls back to interactive_only because help mentions auth.
    expect(result.auth_models.codex).toBe("interactive_only");
  });

  it("gh keychain detection when no GH_TOKEN", () => {
    const result = runHealthcheck(
      { stage: 1, json: false, includeTypecheck: false, includeBuild: false },
      {
        run: mockRun(ALL_PASS_TABLE),
        env: {},
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(result.auth_models.gh).toBe("keychain");
  });
});
