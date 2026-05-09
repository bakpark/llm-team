import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bundleDirName,
  bundleHash12,
  writeCycleBundle,
} from "../../src/persistence/cycle-bundle-minimal.js";

const createdWorkdirs: string[] = [];
function workdir(): string {
  const wd = mkdtempSync(join(tmpdir(), "cycle-bundle-"));
  createdWorkdirs.push(wd);
  return wd;
}
afterEach(() => {
  while (createdWorkdirs.length > 0) {
    const d = createdWorkdirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("cycle bundle minimal — directory layout", () => {
  it("writes <workdir>/<target>/cycles/<role>-<objId>-<hash12>/ with all files", () => {
    const wd = workdir();
    const result = writeCycleBundle({
      workdir: wd,
      targetId: "e2e-sandbox",
      role: "forge",
      objId: "01HZS00000000000000000000A",
      prompt: "prompt body line 1\nline 2\n",
      attempts: [
        {
          index: 1,
          stdout: "stdout text\n",
          stderr: "",
          exitCode: 0,
          envelope: { verdict: "tests_green" },
        },
      ],
      summary: {
        attempts: 1,
        outcome: "tests_green",
        finishedAt: "2026-05-09T00:00:00.000Z",
      },
      envSnapshots: [],
    });

    expect(result.relPath).toBe(
      `e2e-sandbox/cycles/forge-01HZS00000000000000000000A-${result.hash12}`,
    );
    expect(result.bundleDir.startsWith(wd)).toBe(true);

    // All required files present.
    const files = [
      "prompt.md",
      "attempt1.stdout",
      "attempt1.stderr",
      "attempt1.exit",
      "attempt1.envelope.json",
      "summary.json",
    ];
    for (const f of files) {
      expect(statSync(join(result.bundleDir, f)).isFile()).toBe(true);
    }

    // Content sanity.
    expect(readFileSync(join(result.bundleDir, "prompt.md"), "utf8")).toBe(
      "prompt body line 1\nline 2\n",
    );
    expect(readFileSync(join(result.bundleDir, "attempt1.exit"), "utf8")).toBe(
      "0\n",
    );
    const env = JSON.parse(
      readFileSync(join(result.bundleDir, "attempt1.envelope.json"), "utf8"),
    );
    expect(env.verdict).toBe("tests_green");

    const summary = JSON.parse(
      readFileSync(join(result.bundleDir, "summary.json"), "utf8"),
    );
    expect(summary).toMatchObject({
      target_id: "e2e-sandbox",
      role: "forge",
      obj_id: "01HZS00000000000000000000A",
      hash12: result.hash12,
      attempts: 1,
      outcome: "tests_green",
    });
  });

  it("hash12 is deterministic for identical (prompt, attemptCount)", () => {
    const a = bundleHash12("hello world", 1);
    const b = bundleHash12("hello world", 1);
    const c = bundleHash12("hello world", 2);
    const d = bundleHash12("hello other", 1);
    expect(a).toHaveLength(12);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it("hash12 changes when attempt count changes (used by directory name)", () => {
    const wd1 = workdir();
    const wd2 = workdir();
    const base = {
      targetId: "t",
      role: "forge",
      objId: "01HZS00000000000000000000A",
      prompt: "same prompt",
      summary: { attempts: 1, outcome: "ok" },
      envSnapshots: [],
    };
    const r1 = writeCycleBundle({
      ...base,
      workdir: wd1,
      attempts: [{ index: 1, stdout: "", stderr: "", exitCode: 0, envelope: null }],
    });
    const r2 = writeCycleBundle({
      ...base,
      workdir: wd2,
      attempts: [
        { index: 1, stdout: "", stderr: "", exitCode: 0, envelope: null },
        { index: 2, stdout: "", stderr: "", exitCode: 0, envelope: null },
      ],
    });
    expect(r1.hash12).not.toBe(r2.hash12);
  });

  it("rejects empty attempts", () => {
    expect(() =>
      writeCycleBundle({
        workdir: workdir(),
        targetId: "t",
        role: "forge",
        objId: "01HZS00000000000000000000A",
        prompt: "p",
        attempts: [],
        summary: { attempts: 0, outcome: "noop" },
      }),
    ).toThrow(/at least one attempt/);
  });

  it("rejects duplicated attempt index (PR #87 P1-B)", () => {
    expect(() =>
      writeCycleBundle({
        workdir: workdir(),
        targetId: "t",
        role: "forge",
        objId: "01HZS00000000000000000000A",
        prompt: "p",
        attempts: [
          { index: 1, stdout: "a", stderr: "", exitCode: 0, envelope: null },
          { index: 1, stdout: "b", stderr: "", exitCode: 0, envelope: null },
        ],
        summary: { attempts: 2, outcome: "noop" },
        envSnapshots: [],
      }),
    ).toThrow(/attempt index 1 duplicated/);
  });

  it("rejects non-positive / non-integer attempt index (PR #87 P1-B)", () => {
    expect(() =>
      writeCycleBundle({
        workdir: workdir(),
        targetId: "t",
        role: "forge",
        objId: "01HZS00000000000000000000A",
        prompt: "p",
        attempts: [
          { index: 0, stdout: "", stderr: "", exitCode: 0, envelope: null },
        ],
        summary: { attempts: 1, outcome: "noop" },
        envSnapshots: [],
      }),
    ).toThrow(/positive integer/);
  });

  it("bundleDirName composes the segment exactly", () => {
    expect(bundleDirName("forge", "ABC", "0123456789ab")).toBe(
      "forge-ABC-0123456789ab",
    );
  });
});

describe("cycle bundle minimal — secret redaction at writer boundary", () => {
  it("redacts secret-shaped tokens in prompt, stdout, stderr, envelope", () => {
    const wd = workdir();
    const ghPat = "ghp_" + "x".repeat(40);
    const skAnt = "sk-ant-" + "y".repeat(40);
    const result = writeCycleBundle({
      workdir: wd,
      targetId: "e2e-sandbox",
      role: "forge",
      objId: "01HZS00000000000000000000A",
      prompt: `prompt with ${ghPat} embedded`,
      attempts: [
        {
          index: 1,
          stdout: `stdout has ${skAnt}`,
          stderr: `stderr has ${ghPat}`,
          exitCode: 0,
          envelope: { token: ghPat, anth: skAnt },
        },
      ],
      summary: { attempts: 1, outcome: "tests_green" },
      envSnapshots: [],
    });

    const read = (f: string) => readFileSync(join(result.bundleDir, f), "utf8");
    expect(read("prompt.md")).not.toContain(ghPat);
    expect(read("prompt.md")).toContain("[REDACTED]");
    expect(read("attempt1.stdout")).not.toContain(skAnt);
    expect(read("attempt1.stderr")).not.toContain(ghPat);
    expect(read("attempt1.envelope.json")).not.toContain(ghPat);
    expect(read("attempt1.envelope.json")).not.toContain(skAnt);
  });

  it("redacts secret-shaped tokens in summary.json outcome (PR #87 P1-A)", () => {
    const wd = workdir();
    const ghPat = "ghp_" + "z".repeat(40);
    const result = writeCycleBundle({
      workdir: wd,
      targetId: "e2e-sandbox",
      role: "forge",
      objId: "01HZS00000000000000000000A",
      prompt: "p",
      attempts: [
        { index: 1, stdout: "", stderr: "", exitCode: 0, envelope: null },
      ],
      summary: { attempts: 1, outcome: `failed because ${ghPat} leaked` },
      envSnapshots: [],
    });
    const summaryRaw = readFileSync(
      join(result.bundleDir, "summary.json"),
      "utf8",
    );
    expect(summaryRaw).not.toContain(ghPat);
    expect(summaryRaw).toContain("[REDACTED]");
  });

  it("redacts env-bearing secret values when envSnapshots is provided", () => {
    const wd = workdir();
    const fakeEnv: NodeJS.ProcessEnv = {
      MY_API_TOKEN: "supersecretvalue1234",
      HOME: "/Users/test",
    };
    const result = writeCycleBundle({
      workdir: wd,
      targetId: "t",
      role: "forge",
      objId: "01HZS00000000000000000000A",
      prompt: "prompt mentions supersecretvalue1234 inline",
      attempts: [
        {
          index: 1,
          stdout: "log: token=supersecretvalue1234",
          stderr: "",
          exitCode: 0,
          envelope: null,
        },
      ],
      summary: { attempts: 1, outcome: "ok" },
      envSnapshots: [fakeEnv],
    });
    const read = (f: string) => readFileSync(join(result.bundleDir, f), "utf8");
    expect(read("prompt.md")).not.toContain("supersecretvalue1234");
    expect(read("attempt1.stdout")).not.toContain("supersecretvalue1234");
    // HOME (non-secret-suffix) value should NOT be touched.
    expect(read("prompt.md")).not.toContain("/Users/test"); // not present
  });
});
