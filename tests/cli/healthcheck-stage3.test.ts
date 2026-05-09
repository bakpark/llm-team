import { describe, expect, it } from "vitest";
import {
  runStage3,
  type Stage3Spawn,
  type Stage3SpawnInput,
  type Stage3SpawnResult,
} from "../../src/cli/healthcheck-stage3.js";

interface InMemoryFs {
  files: Map<string, string>;
  appended: Map<string, string>;
  mkdirCalls: { path: string; mode?: number }[];
}

function newFs(): InMemoryFs {
  return { files: new Map(), appended: new Map(), mkdirCalls: [] };
}

function makeFsDeps(fs: InMemoryFs) {
  return {
    mkdir: (path: string, opts: { recursive: true; mode?: number }) => {
      fs.mkdirCalls.push({ path, mode: opts.mode });
    },
    writeFile: (path: string, content: string) => {
      fs.files.set(path, content);
    },
    appendLedger: (path: string, line: string) => {
      const prev = fs.appended.get(path) ?? "";
      fs.appended.set(path, prev + line);
    },
    readLedger: (path: string) => fs.appended.get(path) ?? "",
  };
}

interface RecordedSpawn {
  inputs: Stage3SpawnInput[];
}

function recordingSpawn(
  recorded: RecordedSpawn,
  result: (input: Stage3SpawnInput) => Stage3SpawnResult,
): Stage3Spawn {
  return async (input) => {
    recorded.inputs.push(input);
    return result(input);
  };
}

const NOW = () => new Date("2026-05-09T10:00:00.000Z");

describe("healthcheck stage 3 — opt-in gate", () => {
  it("default (no LLM_TEAM_LIVE_HEALTHCHECK): all probes SKIP, no spawn, no ledger writes", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: {},
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "ok", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(recorded.inputs).toHaveLength(0);
    expect(out.items.every((i) => i.status === "SKIP")).toBe(true);
    expect(out.items[0]?.id).toBe("M-3-opt-in");
    expect(fs.appended.size).toBe(0);
    // verified-auth-model.json should still be written for traceability.
    const verified = [...fs.files.keys()].find((k) => k.endsWith("verified-auth-model.json"));
    expect(verified).toBeDefined();
  });

  it("LLM_TEAM_LIVE_HEALTHCHECK=1 + qwenPassed=true: all three probes spawn", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "ok", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(recorded.inputs).toHaveLength(3);
    expect(out.items.filter((i) => i.status === "PASS")).toHaveLength(3);
  });
});

describe("healthcheck stage 3 — codex argv invariants", () => {
  it("codex argv contains --ephemeral, --skip-git-repo-check, --cd <RUN_DIR>, and stdinFromDevNull=true", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "ok", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const codex = recorded.inputs.find((i) => i.cmd === "codex" && !i.args.includes("--profile"));
    const codexQwen = recorded.inputs.find((i) => i.args.includes("--profile"));
    expect(codex).toBeDefined();
    expect(codexQwen).toBeDefined();
    for (const c of [codex!, codexQwen!]) {
      expect(c.args).toContain("--ephemeral");
      expect(c.args).toContain("--skip-git-repo-check");
      expect(c.args).toContain("--color");
      expect(c.args).toContain("never");
      expect(c.args).toContain("--cd");
      // RUN_DIR must immediately follow --cd.
      const cdIdx = c.args.indexOf("--cd");
      expect(c.args[cdIdx + 1]).toBe(c.cwd);
      // stdin MUST be wired to /dev/null (never the prompt pipe).
      expect(c.stdinFromDevNull).toBe(true);
      expect(c.stdin).toBe(null);
    }
    // codex-qwen explicitly carries --profile <name>.
    const profIdx = codexQwen!.args.indexOf("--profile");
    expect(typeof codexQwen!.args[profIdx + 1]).toBe("string");
  });

  it("claude argv uses -p --output-format text and feeds prompt via stdin", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1", LLM_TEAM_CLAUDE_MODEL: "claude-3-5-haiku" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "ok", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const claude = recorded.inputs.find((i) => i.cmd === "claude");
    expect(claude).toBeDefined();
    expect(claude!.args.slice(0, 3)).toEqual(["-p", "--output-format", "text"]);
    expect(claude!.args).toContain("--model");
    expect(claude!.args[claude!.args.indexOf("--model") + 1]).toBe("claude-3-5-haiku");
    expect(claude!.stdin).toBeTypeOf("string");
    expect(claude!.stdinFromDevNull).toBe(false);
    expect(claude!.timeoutMs).toBe(60_000);
  });
});

describe("healthcheck stage 3 — RUN_DIR artifacts", () => {
  it("each spawn writes 4 files (.stdout/.stderr/.exit/.md) to RUN_DIR", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({
        status: 0,
        stdout: "two words",
        stderr: "",
      })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    for (const probeId of ["claude-attempt1", "codex-default-attempt1", "codex-qwen-attempt1"]) {
      for (const ext of [".stdout", ".stderr", ".exit", ".md"]) {
        const found = [...fs.files.keys()].find(
          (k) => k.endsWith(`${probeId}${ext}`),
        );
        expect(found, `${probeId}${ext} missing`).toBeDefined();
      }
    }
    // verified-auth-model.json written exactly once.
    expect(
      [...fs.files.keys()].filter((k) => k.endsWith("verified-auth-model.json")),
    ).toHaveLength(1);
    expect(out.runDir).toContain("/tmp/home/.llm-team/healthcheck/");
  });

  it("RUN_DIR is created with mode 0700", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(fs.mkdirCalls[0]?.mode).toBe(0o700);
  });

  it("LLM_TEAM_HEALTHCHECK_RUN_DIR env overrides default RUN_DIR", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: {
        LLM_TEAM_LIVE_HEALTHCHECK: "1",
        LLM_TEAM_HEALTHCHECK_RUN_DIR: "/tmp/custom/run-dir",
      },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(out.runDir).toBe("/tmp/custom/run-dir");
  });
});

describe("healthcheck stage 3 — qwen Stage 2 gating", () => {
  it("qwenPassed=false skips codex-qwen probe (claude + codex still run)", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: false,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(recorded.inputs).toHaveLength(2);
    const qwen = out.items.find((i) => i.id === "codex-qwen-attempt1");
    expect(qwen?.status).toBe("SKIP");
    expect(qwen?.detail).toContain("qwen");
  });
});

describe("healthcheck stage 3 — cost cap", () => {
  it("daily cap exceeded ⇒ probe SKIP (not FAIL)", async () => {
    const fs = newFs();
    // Pre-seed the ledger so daily total already at $0.999 (just below $1.00).
    // The first 0.005 spawn will push us over.
    fs.appended.set(
      "/tmp/home/.llm-team/healthcheck-cost-ledger.ndjson",
      JSON.stringify({
        ts: "2026-05-09T05:00:00.000Z",
        kind: "claude.smoke",
        estimated_usd: 0.999,
      }) + "\n",
    );
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(recorded.inputs).toHaveLength(0);
    expect(out.items.filter((i) => i.status === "SKIP").length).toBeGreaterThanOrEqual(3);
    const sample = out.items.find((i) => i.id === "claude-attempt1");
    expect(sample?.detail).toContain("cost cap");
  });

  it("per-run cap below estimated cost ⇒ SKIP", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1", LLM_TEAM_LIVE_COST_CAP_USD: "0.001" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(recorded.inputs).toHaveLength(0);
    const sample = out.items.find((i) => i.id === "claude-attempt1");
    expect(sample?.status).toBe("SKIP");
    expect(sample?.detail).toContain("per_run");
  });

  it("successful spawn appends a ledger entry", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const ledger = fs.appended.get(
      "/tmp/home/.llm-team/healthcheck-cost-ledger.ndjson",
    );
    expect(ledger).toBeDefined();
    const lines = ledger!.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      const p = JSON.parse(l);
      expect(p.estimated_usd).toBeGreaterThan(0);
      expect(p.kind).toMatch(/^(claude|codex)\./);
    }
  });
});

describe("healthcheck stage 3 — failure markdown", () => {
  it("any FAIL produces healthcheck-failure.md in RUN_DIR", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, (input) => ({
        status: input.cmd === "claude" ? 1 : 0,
        stdout: "",
        stderr: input.cmd === "claude" ? "auth failed" : "",
      })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(out.failureMdPath).toBeDefined();
    const md = fs.files.get(out.failureMdPath!);
    expect(md).toContain("FAILURE");
    expect(md).toContain("claude-attempt1");
  });

  it("all PASS does not produce healthcheck-failure.md", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    expect(out.failureMdPath).toBeUndefined();
  });
});

describe("healthcheck stage 3 — verified-auth-model.json", () => {
  it("records PASS/FAIL/SKIP per surface", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, (input) => ({
        status: input.cmd === "claude" ? 0 : 2,
        stdout: "",
        stderr: input.cmd === "claude" ? "" : "boom",
      })),
      qwenPassed: false, // qwen probe → SKIP
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const json = JSON.parse(fs.files.get(out.verifiedAuthModelPath!)!);
    expect(json.claude.status).toBe("PASS");
    expect(json.codex.status).toBe("FAIL");
    expect(json.codex_qwen.status).toBe("SKIP");
  });
});

describe("healthcheck stage 3 — per-run cost cap accumulator (P1-B)", () => {
  it("cap=$0.010 with 3 probes × $0.005 ⇒ first two PASS, third SKIP (per_run)", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const out = await runStage3({
      env: {
        LLM_TEAM_LIVE_HEALTHCHECK: "1",
        LLM_TEAM_LIVE_COST_CAP_USD: "0.010",
      },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "ok", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    // Two probes spawned, third gated by cumulative per-run cap.
    expect(recorded.inputs).toHaveLength(2);
    const passes = out.items.filter((i) => i.status === "PASS");
    expect(passes).toHaveLength(2);
    const skips = out.items.filter((i) => i.status === "SKIP");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.detail).toContain("per_run");
    // Ledger reflects only the two PASSes.
    const ledger = fs.appended.get(
      "/tmp/home/.llm-team/healthcheck-cost-ledger.ndjson",
    );
    expect(ledger!.trim().split("\n")).toHaveLength(2);
  });
});

describe("healthcheck stage 3 — redactSecrets at sink boundary (P1-C)", () => {
  it("redacts ghp_… token from stdout/stderr/.md and detail before persisting", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const leak = "auth failed: ghp_ABCDEFGHIJKLMNOPQRST123456 invalid";
    const out = await runStage3({
      env: { LLM_TEAM_LIVE_HEALTHCHECK: "1" },
      spawn: recordingSpawn(recorded, () => ({
        status: 1,
        stdout: `prefix ${leak} suffix`,
        stderr: leak,
      })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const stdoutFile = [...fs.files.entries()].find(([k]) =>
      k.endsWith("claude-attempt1.stdout"),
    );
    const stderrFile = [...fs.files.entries()].find(([k]) =>
      k.endsWith("claude-attempt1.stderr"),
    );
    const mdFile = [...fs.files.entries()].find(([k]) =>
      k.endsWith("claude-attempt1.md"),
    );
    expect(stdoutFile?.[1]).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST123456");
    expect(stdoutFile?.[1]).toContain("[REDACTED]");
    expect(stderrFile?.[1]).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST123456");
    expect(stderrFile?.[1]).toContain("[REDACTED]");
    expect(mdFile?.[1]).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST123456");
    // detail (in items + failure md) is also scrubbed.
    const failItem = out.items.find((i) => i.id === "claude-attempt1");
    expect(failItem?.detail).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST123456");
    expect(failItem?.detail).toContain("[REDACTED]");
    const failureMd = fs.files.get(out.failureMdPath!);
    expect(failureMd).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST123456");
  });

  it("redacts secret-suspected env values that leak into stderr", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    const secret = "supersecret-xyz-123";
    await runStage3({
      env: {
        LLM_TEAM_LIVE_HEALTHCHECK: "1",
        ANTHROPIC_API_KEY: secret,
      },
      spawn: recordingSpawn(recorded, () => ({
        status: 1,
        stdout: "",
        stderr: `boom: leaked ${secret}`,
      })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const stderrFile = [...fs.files.entries()].find(([k]) =>
      k.endsWith("claude-attempt1.stderr"),
    );
    expect(stderrFile?.[1]).not.toContain(secret);
    expect(stderrFile?.[1]).toContain("[REDACTED]");
  });
});

describe("healthcheck stage 3 — LLM_TEAM_CLAUDE_BIN multi-token (P1-D)", () => {
  it('LLM_TEAM_CLAUDE_BIN="npx claude" splits into cmd="npx" + leading args ["claude", ...]', async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    await runStage3({
      env: {
        LLM_TEAM_LIVE_HEALTHCHECK: "1",
        LLM_TEAM_CLAUDE_BIN: "npx claude",
      },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const claude = recorded.inputs.find((i) => i.cmd === "npx");
    expect(claude).toBeDefined();
    expect(claude!.cmd).toBe("npx");
    expect(claude!.args[0]).toBe("claude");
    expect(claude!.args.slice(1, 4)).toEqual(["-p", "--output-format", "text"]);
    // The literal "npx claude" must NOT appear as a single argv token.
    expect(recorded.inputs.find((i) => i.cmd === "npx claude")).toBeUndefined();
  });

  it("collapses repeated whitespace in LLM_TEAM_CLAUDE_BIN", async () => {
    const fs = newFs();
    const recorded: RecordedSpawn = { inputs: [] };
    await runStage3({
      env: {
        LLM_TEAM_LIVE_HEALTHCHECK: "1",
        LLM_TEAM_CLAUDE_BIN: "  npx   claude  ",
      },
      spawn: recordingSpawn(recorded, () => ({ status: 0, stdout: "", stderr: "" })),
      qwenPassed: true,
      now: NOW,
      home: "/tmp/home",
      ...makeFsDeps(fs),
    });
    const claude = recorded.inputs.find((i) => i.cmd === "npx");
    expect(claude).toBeDefined();
    expect(claude!.args[0]).toBe("claude");
  });
});
