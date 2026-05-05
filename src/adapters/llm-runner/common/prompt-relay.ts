// 4-part canonical layout preflight (ARC-ADAPTER-PROMPT-CONTRACT).
// Detects only TOP-LEVEL section headings — body content (e.g., a fenced
// example with `# Output Schema` inside) is ignored.

const TOP_LEVEL_CONTEXT = /^# Context$/m;
const TOP_LEVEL_INSTRUCTION = /^# Instruction$/m;
const TOP_LEVEL_SCHEMA = /^# Output Schema$/m;

export function assertFourPartLayout(body: string): void {
  if (!body.startsWith("---\n")) {
    throw new Error("missing leading frontmatter '---' on line 1");
  }
  const fmEnd = body.indexOf("\n---\n", 4);
  if (fmEnd < 0) {
    throw new Error("missing closing frontmatter '---'");
  }
  const afterFm = body.slice(fmEnd + 5);

  if (!afterFm.startsWith("\n# Context\n")) {
    throw new Error("expected blank line + '# Context' after frontmatter");
  }

  const cMatch = afterFm.match(TOP_LEVEL_CONTEXT);
  const iMatch = afterFm.match(TOP_LEVEL_INSTRUCTION);
  const sMatch = afterFm.match(TOP_LEVEL_SCHEMA);
  if (!cMatch || !iMatch || !sMatch) {
    throw new Error(
      "missing one of: '# Context' / '# Instruction' / '# Output Schema'",
    );
  }
  const cIdx = cMatch.index ?? -1;
  const iIdx = iMatch.index ?? -1;
  const sIdx = sMatch.index ?? -1;
  if (!(cIdx < iIdx && iIdx < sIdx)) {
    throw new Error(
      "section order must be Context → Instruction → Output Schema",
    );
  }
}
