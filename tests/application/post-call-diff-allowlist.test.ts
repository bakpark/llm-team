import { describe, expect, it } from "vitest";
import { checkPostCallDiffAllowlist } from "../../src/application/post-call-diff-allowlist.js";

describe("checkPostCallDiffAllowlist (L4)", () => {
  it("ok when tracked == declared", () => {
    const out = checkPostCallDiffAllowlist({
      declaredChangedFiles: ["a.ts", "b.ts"],
      trackedChangedFiles: ["a.ts", "b.ts"],
    });
    expect(out.ok).toBe(true);
    expect(out.violations).toEqual([]);
  });

  it("flags undeclared tracked changes", () => {
    const out = checkPostCallDiffAllowlist({
      declaredChangedFiles: ["a.ts"],
      trackedChangedFiles: ["a.ts", "rogue.ts"],
    });
    expect(out.ok).toBe(false);
    expect(out.violations.find((v) => v.kind === "capability_violation_l4_undeclared")).toBeTruthy();
    expect(
      out.violations.find((v) => v.kind === "capability_violation_l4_undeclared")!.paths,
    ).toEqual(["rogue.ts"]);
  });

  it("flags declared-but-missing as separate violation", () => {
    const out = checkPostCallDiffAllowlist({
      declaredChangedFiles: ["a.ts", "b.ts"],
      trackedChangedFiles: ["a.ts"],
    });
    expect(out.ok).toBe(false);
    expect(
      out.violations.find((v) => v.kind === "capability_violation_l4_missing_declared"),
    ).toBeTruthy();
  });

  it("reviewer role: ok only when worktree diff is empty", () => {
    const ok = checkPostCallDiffAllowlist({
      declaredChangedFiles: [],
      trackedChangedFiles: [],
      reviewerReadOnly: true,
    });
    expect(ok.ok).toBe(true);

    const bad = checkPostCallDiffAllowlist({
      declaredChangedFiles: [],
      trackedChangedFiles: ["x.ts"],
      reviewerReadOnly: true,
    });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.kind).toBe(
      "capability_violation_l4_reviewer_modified",
    );
  });
});
