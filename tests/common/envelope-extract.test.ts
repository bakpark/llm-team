import { describe, expect, it } from "vitest";
import { extractEnvelope } from "../../src/adapters/llm-runner/common/envelope-extract.js";

describe("extractEnvelope", () => {
  it("returns the body of a single fenced block", () => {
    const out = "preface\n```json\n{\"a\":1}\n```\ntrailing\n";
    expect(extractEnvelope(out)).toBe("{\"a\":1}");
  });

  it("returns null when no opener present", () => {
    expect(extractEnvelope("no fenced block here")).toBeNull();
  });

  it("returns null when opener has no closer", () => {
    expect(extractEnvelope("```json\n{\"a\":1}\n")).toBeNull();
  });

  it("returns the first fenced block when multiple exist", () => {
    const out = "```json\nfirst\n```\n```json\nsecond\n```\n";
    expect(extractEnvelope(out)).toBe("first");
  });

  it("tolerates trailing whitespace on the opener line", () => {
    const out = "```json   \n{\"a\":2}\n```\n";
    expect(extractEnvelope(out)).toBe("{\"a\":2}");
  });
});
