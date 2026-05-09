import { describe, expect, it } from "vitest";
import {
  main,
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
  it("defaults to stage=1, json=false", () => {
    const a = parseArgs([]);
    expect(a.stage).toBe(1);
    expect(a.json).toBe(false);
  });
  it("parses flags", () => {
    const a = parseArgs([
      "--stage",
      "1",
      "--json",
      "--out",
      "./hc",
      "--target",
      "./target.json",
    ]);
    expect(a.stage).toBe(1);
    expect(a.json).toBe(true);
    expect(a.outDir).toBe("./hc");
    expect(a.targetPath).toBe("./target.json");
  });
  it("rejects unknown stage", () => {
    expect(() => parseArgs(["--stage", "9"])).toThrow();
  });
  it("rejects unknown flag", () => {
    expect(() => parseArgs(["--what"])).toThrow();
  });
  it("rejects removed --include-typecheck / --include-build flags", () => {
    expect(() => parseArgs(["--include-typecheck"])).toThrow();
    expect(() => parseArgs(["--include-build"])).toThrow();
  });
});

describe("healthcheck runHealthcheck", () => {
  it("all-pass mock yields passed=true and conforms to Zod schema", async () => {
    const result = await runHealthcheck(
      { stage: 1, json: false },
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

  it("missing required binary yields FAIL and passed=false", async () => {
    const table = { ...ALL_PASS_TABLE };
    table["command -v claude"] = { status: 1 };
    const result = await runHealthcheck(
      { stage: 1, json: false },
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

  it("git < 2.5 yields FAIL on M-1-2", async () => {
    const table = { ...ALL_PASS_TABLE };
    table["git --version"] = { status: 0, stdout: "git version 2.4.0\n" };
    const result = await runHealthcheck(
      { stage: 1, json: false },
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

  it("typecheck/build are always SKIP in stage 1 (out of fail-fast budget)", async () => {
    const result = await runHealthcheck(
      { stage: 1, json: false },
      {
        run: mockRun(ALL_PASS_TABLE),
        env: { GH_TOKEN: "ghp_test" },
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(result.items.find((i) => i.id === "M-1-5.typecheck")?.status).toBe("SKIP");
    expect(result.items.find((i) => i.id === "M-1-6.build")?.status).toBe("SKIP");
  });

  it("stage 2 with no qwen URL skips qwen ping (no longer the phase-prod-3 placeholder)", async () => {
    const table: Record<string, { status: number; stdout?: string; stderr?: string }> = {
      "gh api rate_limit": {
        status: 0,
        stdout: JSON.stringify({
          resources: { core: { remaining: 4000, limit: 5000 } },
        }),
      },
    };
    const result = await runHealthcheck(
      { stage: 2, json: false },
      {
        run: mockRun(table),
        env: {},
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(result.stage).toBe(2);
    const qwen = result.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("SKIP");
    const gh = result.items.find((i) => i.id === "M-2-gh.rate-limit");
    expect(gh?.status).toBe("PASS");
    expect(result.auth_models.claude).toBe("UNKNOWN_UNTIL_STAGE3");
  });

  it("auth model detection: gh env_token and claude env_token via ANTHROPIC_API_KEY", async () => {
    const result = await runHealthcheck(
      { stage: 1, json: false },
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

  it("gh keychain detection when no GH_TOKEN", async () => {
    const result = await runHealthcheck(
      { stage: 1, json: false },
      {
        run: mockRun(ALL_PASS_TABLE),
        env: {},
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    expect(result.auth_models.gh).toBe("keychain");
  });

  it("caches `gh auth status` and `<bin> --help` (one spawn per probe)", async () => {
    const calls: string[] = [];
    const countingRun: RunCmd = (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`.trim();
      calls.push(key);
      const hit = ALL_PASS_TABLE[key];
      if (hit) return { status: hit.status, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
      return { status: 127, stdout: "", stderr: `mock: no entry for ${key}` };
    };
    await runHealthcheck(
      { stage: 1, json: false },
      {
        run: countingRun,
        // No GH_TOKEN forces detectGhAuthModel to actually probe `gh auth status`.
        env: {},
        cwd: process.cwd(),
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      },
    );
    const ghAuthCalls = calls.filter((k) => k === "gh auth status").length;
    const claudeHelpCalls = calls.filter((k) => k === "claude --help").length;
    const codexHelpCalls = calls.filter((k) => k === "codex --help").length;
    expect(ghAuthCalls).toBe(1);
    expect(claudeHelpCalls).toBe(1);
    expect(codexHelpCalls).toBe(1);
  });
});

describe("healthcheck main() integration", () => {
  it("returns exit 0 when all checks pass and writes valid JSON to stdout in --json mode", async () => {
    let captured = "";
    const code = await main(["--stage", "1", "--json"], {
      run: mockRun(ALL_PASS_TABLE),
      env: { GH_TOKEN: "ghp_test" },
      cwd: process.cwd(),
      now: () => new Date("2026-05-09T00:00:00.000Z"),
      stdout: (s) => {
        captured += s;
      },
      skipOutFile: true,
    });
    expect(code).toBe(0);
    // stdout must be parseable JSON (no progress noise mixed in).
    const parsed = JSON.parse(captured.trim());
    expect(() => HealthcheckResult.parse(parsed)).not.toThrow();
    expect(parsed.passed).toBe(true);
  });

  it("returns exit 1 when at least one check fails", async () => {
    const table = { ...ALL_PASS_TABLE };
    table["command -v claude"] = { status: 1 };
    let captured = "";
    const code = await main(["--stage", "1", "--json"], {
      run: mockRun(table),
      env: { GH_TOKEN: "ghp_test" },
      cwd: process.cwd(),
      now: () => new Date("2026-05-09T00:00:00.000Z"),
      stdout: (s) => {
        captured += s;
      },
      skipOutFile: true,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(captured.trim());
    expect(parsed.passed).toBe(false);
  });

  it("propagates parseArgs errors so the module-level handler can map them to exit 2", async () => {
    // Unknown flag → parseArgs throws → main rejects.
    // Module isMain handler maps this to process.exit(2).
    await expect(
      main(["--unknown-flag"], { skipOutFile: true }),
    ).rejects.toThrow(/unknown flag/);
  });

  it("non-json mode emits human-readable lines and exits 0 on all-pass", async () => {
    let captured = "";
    const code = await main(["--stage", "1"], {
      run: mockRun(ALL_PASS_TABLE),
      env: { GH_TOKEN: "ghp_test" },
      cwd: process.cwd(),
      now: () => new Date("2026-05-09T00:00:00.000Z"),
      stdout: (s) => {
        captured += s;
      },
      skipOutFile: true,
    });
    expect(code).toBe(0);
    expect(captured).toMatch(/stage=1 passed=true/);
    expect(captured).toMatch(/auth_models:/);
  });
});
