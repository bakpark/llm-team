import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnWithTimeout } from "../../src/adapters/llm-runner/common/spawn.js";

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
