import { describe, expect, it } from "vitest";
import {
  runStage2,
  type Stage2Fetch,
  type Stage2RunCmd,
} from "../../src/cli/healthcheck-stage2.js";

function mockFetch(
  table: Record<string, { status: number; body?: string; throws?: string }>,
): Stage2Fetch {
  return async (url) => {
    const hit = table[url];
    if (!hit) throw new Error(`no mock for ${url}`);
    if (hit.throws) throw new Error(hit.throws);
    return {
      status: hit.status,
      text: async () => hit.body ?? "",
    };
  };
}

function ghRateLimitRun(
  table: Record<string, { status: number; stdout?: string; stderr?: string }>,
): Stage2RunCmd {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const hit = table[key];
    if (!hit) return { status: 127, stdout: "", stderr: `no mock: ${key}` };
    return { status: hit.status, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
}

const GH_OK = {
  "gh api rate_limit": {
    status: 0,
    stdout: JSON.stringify({
      resources: { core: { remaining: 4500, limit: 5000, reset: 0 } },
    }),
  },
};

describe("healthcheck stage 2 — qwen ping", () => {
  it("SKIPs when LLM_TEAM_QWEN_BASE_URL is not set", async () => {
    const out = await runStage2({
      env: {},
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({}),
    });
    const qwen = out.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("SKIP");
    expect(out.qwenPassed).toBe(false);
  });

  it("classifies HTTP 200 as PASS and sets qwenPassed=true", async () => {
    const out = await runStage2({
      env: { LLM_TEAM_QWEN_BASE_URL: "https://q.example.com/v1" },
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({
        "https://q.example.com/v1/ping": { status: 200, body: "ok" },
      }),
    });
    const qwen = out.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("PASS");
    expect(out.qwenPassed).toBe(true);
  });

  it("classifies HTTP 401 as FAIL(auth)", async () => {
    const out = await runStage2({
      env: { LLM_TEAM_QWEN_BASE_URL: "https://q.example.com" },
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({
        "https://q.example.com/ping": { status: 401, body: "unauthorized" },
      }),
    });
    const qwen = out.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("FAIL");
    expect(qwen?.detail).toContain("auth");
    expect(out.qwenPassed).toBe(false);
  });

  it("classifies HTTP 429 as PASS-with-warning (qwenPassed=true)", async () => {
    const out = await runStage2({
      env: { LLM_TEAM_QWEN_BASE_URL: "https://q.example.com" },
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({
        "https://q.example.com/ping": { status: 429 },
      }),
    });
    const qwen = out.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("PASS");
    expect(qwen?.detail).toContain("rate-limited");
    expect(out.qwenPassed).toBe(true);
  });

  it("classifies HTTP 5xx as FAIL(upstream)", async () => {
    const out = await runStage2({
      env: { LLM_TEAM_QWEN_BASE_URL: "https://q.example.com" },
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({
        "https://q.example.com/ping": { status: 503 },
      }),
    });
    const qwen = out.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("FAIL");
    expect(qwen?.detail).toContain("upstream");
  });

  it("falls back to /models when /ping returns 404", async () => {
    const out = await runStage2({
      env: { LLM_TEAM_QWEN_BASE_URL: "https://q.example.com" },
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({
        "https://q.example.com/ping": { status: 404 },
        "https://q.example.com/models": { status: 200, body: "[]" },
      }),
    });
    const qwen = out.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("PASS");
  });

  it("network error becomes FAIL", async () => {
    const out = await runStage2({
      env: { LLM_TEAM_QWEN_BASE_URL: "https://q.example.com" },
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({
        "https://q.example.com/ping": { status: 0, throws: "ECONNREFUSED" },
      }),
    });
    const qwen = out.items.find((i) => i.id === "M-2-qwen.ping");
    expect(qwen?.status).toBe("FAIL");
    expect(qwen?.detail).toContain("network error");
  });
});

describe("healthcheck stage 2 — gh rate_limit", () => {
  it("PASSes when remaining is comfortably above the warn cap", async () => {
    const out = await runStage2({
      env: {},
      run: ghRateLimitRun(GH_OK),
      fetch: mockFetch({}),
    });
    const gh = out.items.find((i) => i.id === "M-2-gh.rate-limit");
    expect(gh?.status).toBe("PASS");
    expect(gh?.detail).toContain("4500/5000");
  });

  it("PASSes with warning when remaining < cap (default 100)", async () => {
    const out = await runStage2({
      env: {},
      run: ghRateLimitRun({
        "gh api rate_limit": {
          status: 0,
          stdout: JSON.stringify({
            resources: { core: { remaining: 50, limit: 5000 } },
          }),
        },
      }),
      fetch: mockFetch({}),
    });
    const gh = out.items.find((i) => i.id === "M-2-gh.rate-limit");
    expect(gh?.status).toBe("PASS");
    expect(gh?.detail).toContain("low");
  });

  it("FAILs when remaining == 0", async () => {
    const out = await runStage2({
      env: {},
      run: ghRateLimitRun({
        "gh api rate_limit": {
          status: 0,
          stdout: JSON.stringify({
            resources: { core: { remaining: 0, limit: 5000 } },
          }),
        },
      }),
      fetch: mockFetch({}),
    });
    const gh = out.items.find((i) => i.id === "M-2-gh.rate-limit");
    expect(gh?.status).toBe("FAIL");
    expect(gh?.detail).toContain("exhausted");
  });

  it("FAILs when gh exits non-zero", async () => {
    const out = await runStage2({
      env: {},
      run: ghRateLimitRun({
        "gh api rate_limit": { status: 1, stderr: "auth required" },
      }),
      fetch: mockFetch({}),
    });
    const gh = out.items.find((i) => i.id === "M-2-gh.rate-limit");
    expect(gh?.status).toBe("FAIL");
  });

  it("FAILs when response is not JSON", async () => {
    const out = await runStage2({
      env: {},
      run: ghRateLimitRun({
        "gh api rate_limit": { status: 0, stdout: "<html>..." },
      }),
      fetch: mockFetch({}),
    });
    const gh = out.items.find((i) => i.id === "M-2-gh.rate-limit");
    expect(gh?.status).toBe("FAIL");
    expect(gh?.detail).toContain("unparsable");
  });

  it("honors LLM_TEAM_GH_RATE_LIMIT_WARN_AT override", async () => {
    const out = await runStage2({
      env: { LLM_TEAM_GH_RATE_LIMIT_WARN_AT: "1000" },
      run: ghRateLimitRun({
        "gh api rate_limit": {
          status: 0,
          stdout: JSON.stringify({
            resources: { core: { remaining: 500, limit: 5000 } },
          }),
        },
      }),
      fetch: mockFetch({}),
    });
    const gh = out.items.find((i) => i.id === "M-2-gh.rate-limit");
    expect(gh?.detail).toContain("low");
  });
});
