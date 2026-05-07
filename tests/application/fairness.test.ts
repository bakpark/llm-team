import { describe, expect, it } from "vitest";
import { pickFairly, sortFairly } from "../../src/application/fairness.js";

describe("fairness (within-scope oldest-ready-first)", () => {
  it("returns null on empty list", () => {
    expect(pickFairly([])).toBeNull();
  });

  it("picks the oldest createdAt", () => {
    const out = pickFairly([
      { value: "b", createdAt: "2026-05-08T01:00:00.000Z" },
      { value: "a", createdAt: "2026-05-08T00:00:00.000Z" },
      { value: "c", createdAt: "2026-05-08T02:00:00.000Z" },
    ]);
    expect(out?.value).toBe("a");
  });

  it("priority overrides age", () => {
    const out = pickFairly([
      { value: "b", createdAt: "2026-05-08T00:00:00.000Z", priority: 5 },
      { value: "a", createdAt: "2026-05-08T05:00:00.000Z", priority: 1 },
    ]);
    expect(out?.value).toBe("a");
  });

  it("sortFairly is stable for equal (priority, createdAt)", () => {
    const out = sortFairly([
      { value: "first", createdAt: "2026-05-08T00:00:00.000Z" },
      { value: "second", createdAt: "2026-05-08T00:00:00.000Z" },
      { value: "third", createdAt: "2026-05-08T00:00:00.000Z" },
    ]);
    expect(out.map((c) => c.value)).toEqual(["first", "second", "third"]);
  });
});
