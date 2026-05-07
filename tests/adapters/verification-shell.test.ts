import { describe, expect, it } from "vitest";
import { ShellVerification } from "../../src/adapters/verification/shell.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
import { FixedClock } from "../../src/ports/clock.js";

describe("ShellVerification", () => {
  it("runTest returns pass when commands succeed", async () => {
    const v = new ShellVerification({ clock: new FixedClock(0) });
    const out = await v.runTest([{ argv: ["true"], cwd: process.cwd() }]);
    expect(out.result).toBe("pass");
    expect(out.exitCodes).toEqual([0]);
  });

  it("runTest returns fail when first command exits non-zero", async () => {
    const v = new ShellVerification({ clock: new FixedClock(0) });
    const out = await v.runTest([{ argv: ["false"], cwd: process.cwd() }]);
    expect(out.result).toBe("fail");
  });

  it("runBuild returns error when binary missing", async () => {
    const v = new ShellVerification({ clock: new FixedClock(0) });
    const out = await v.runBuild([
      { argv: ["definitely-not-a-binary-xyz"], cwd: process.cwd() },
    ]);
    expect(out.result).toBe("error");
  });

  it("runMetric parses last numeric token from stdout", async () => {
    const v = new ShellVerification({ clock: new FixedClock(0) });
    const out = await v.runMetric({
      command: { argv: ["printf", "value: 7"], cwd: process.cwd() },
      compare: (n) => (n <= 10 ? "met" : "unmet"),
    });
    expect(out.value).toBe(7);
    expect(out.result).toBe("met");
  });
});

describe("FakeVerification", () => {
  it("returns the scripted outcome", async () => {
    const v = new FakeVerification(new FixedClock(0), {
      test: {
        result: "fail",
        failed_tests: [
          { path: "tests/foo.test.ts", name: "x", message: "got 2" },
        ],
      },
    });
    const out = await v.runTest([{ argv: ["true"], cwd: "." }]);
    expect(out.result).toBe("fail");
    expect(out.failed_tests.length).toBe(1);
  });

  it("metric default is met=0", async () => {
    const v = new FakeVerification(new FixedClock(0));
    const out = await v.runMetric({
      command: { argv: ["x"], cwd: "." },
      compare: () => "met",
    });
    expect(out.result).toBe("met");
    expect(out.value).toBe(0);
  });
});
