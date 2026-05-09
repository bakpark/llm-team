import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveSpawnEnv,
  spawnWithTimeout,
} from "../../src/adapters/llm-runner/common/spawn.js";

const STUB = fileURLToPath(new URL("../stubs/echo-stub.mjs", import.meta.url));

describe("spawnWithTimeout", () => {
  it("captures stdout/stderr and rawCode 0 on success", async () => {
    const r = await spawnWithTimeout({
      cmd: "node",
      args: [STUB, "--stderr", "hello-stderr"],
      cwd: process.cwd(),
      stdin: "payload",
      timeoutSec: 0,
    });
    expect(r.rawCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("payload");
    expect(r.stderr).toBe("hello-stderr");
  });

  it("surfaces non-zero exit codes", async () => {
    const r = await spawnWithTimeout({
      cmd: "node",
      args: [STUB, "--exit", "42"],
      cwd: process.cwd(),
      stdin: "",
      timeoutSec: 0,
    });
    expect(r.rawCode).toBe(42);
    expect(r.timedOut).toBe(false);
  });

  it("kills via SIGTERM and sets timedOut=true on timeout", async () => {
    const r = await spawnWithTimeout({
      cmd: "node",
      args: [STUB, "--sleep", "5"],
      cwd: process.cwd(),
      stdin: "",
      timeoutSec: 1,
      killGraceMs: 100,
    });
    expect(r.timedOut).toBe(true);
    expect(["SIGTERM", "SIGKILL"]).toContain(r.signal ?? "SIGTERM");
  }, 10000);

  it("returns rawCode 127 on ENOENT (binary not found)", async () => {
    const r = await spawnWithTimeout({
      cmd: "/nonexistent/binary-xyzzy",
      args: [],
      cwd: process.cwd(),
      stdin: "",
      timeoutSec: 0,
    });
    expect(r.rawCode).toBe(127);
  });
});

describe("resolveSpawnEnv", () => {
  it("returns process.env-based copy when no options given", () => {
    const env = resolveSpawnEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("uses an explicit base over process.env", () => {
    const env = resolveSpawnEnv({ base: { FOO: "1" } });
    expect(env.FOO).toBe("1");
    expect(env.PATH).toBeUndefined();
  });

  it("filters base via allowlist", () => {
    const base = { KEEP: "yes", DROP: "no" };
    const env = resolveSpawnEnv({ base, allowlist: ["KEEP"] });
    expect(env).toEqual({ KEEP: "yes" });
  });

  it("override adds and replaces keys after allowlist", () => {
    const base = { KEEP: "yes", DROP: "no" };
    const env = resolveSpawnEnv({
      base,
      allowlist: ["KEEP"],
      override: { KEEP: "override", EXTRA: "added" },
    });
    expect(env).toEqual({ KEEP: "override", EXTRA: "added" });
  });

  it("undefined override values are ignored (not propagated)", () => {
    const env = resolveSpawnEnv({
      base: { A: "1" },
      override: { A: undefined, B: "2" },
    });
    expect(env).toEqual({ A: "1", B: "2" });
  });
});
