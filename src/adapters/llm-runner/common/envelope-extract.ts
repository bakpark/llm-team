// Extract the first ```json fenced block body from a stdout buffer.
// Returns null if no closed fenced block is found. Semantic validation
// (field enum, header echo, revision pin) is the caller's responsibility.

const OPENER = /^```json[ \t]*\r?\n/m;

export function extractEnvelope(stdout: string): string | null {
  const open = stdout.match(OPENER);
  if (!open || open.index === undefined) return null;
  const bodyStart = open.index + open[0].length;
  const closeRel = stdout.slice(bodyStart).search(/^```[ \t]*\r?$/m);
  if (closeRel < 0) return null;
  return stdout.slice(bodyStart, bodyStart + closeRel).replace(/\r?\n$/, "");
}
