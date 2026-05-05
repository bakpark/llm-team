import { describe, expect, it } from "vitest";
import { assertFourPartLayout } from "../../src/adapters/llm-runner/common/prompt-relay.js";
import { buildValidPrompt } from "../helpers/sample-prompt.js";

describe("assertFourPartLayout", () => {
  it("passes a canonical 4-part body", () => {
    expect(() => assertFourPartLayout(buildValidPrompt())).not.toThrow();
  });

  it("ignores fenced-block content that mentions section headings", () => {
    const body = buildValidPrompt({ schemaInBody: true });
    expect(() => assertFourPartLayout(body)).not.toThrow();
  });

  it("rejects missing leading frontmatter", () => {
    const body = "# Context\n\nbody\n# Instruction\n# Output Schema\n";
    expect(() => assertFourPartLayout(body)).toThrowError(/leading frontmatter/);
  });

  it("rejects missing closing frontmatter", () => {
    const body = "---\nfoo: bar\n# Context\n# Instruction\n# Output Schema\n";
    expect(() => assertFourPartLayout(body)).toThrowError(/closing frontmatter/);
  });

  it("rejects out-of-order section headings", () => {
    const body = `---\nsession_id: s\n---\n\n# Context\n\n# Output Schema\n\n# Instruction\n`;
    expect(() => assertFourPartLayout(body)).toThrowError(/order must be/);
  });

  it("rejects missing # Context after frontmatter", () => {
    const body = `---\nsession_id: s\n---\n\n# Instruction\n\n# Context\n\n# Output Schema\n`;
    expect(() => assertFourPartLayout(body)).toThrowError(/'# Context'/);
  });
});
