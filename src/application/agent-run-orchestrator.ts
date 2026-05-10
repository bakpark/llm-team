import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Phase 0.5 — agent-io neutral helper extraction (no-op refactor).
 *
 * Houses the LLM-neutral, envelope-무관 helpers that `agent-io.ts`
 * historically owned. Phase 1 introduces a PR-first orchestration path
 * (lead-invoker / reviewer-invoker / outbox / machine-block) that needs
 * the same prompt-persistence and header-echo primitives without
 * dragging in envelope-specific parsing/enrichment code.
 *
 * Behaviour MUST stay identical to the pre-extraction implementation —
 * `agent-io.ts` re-exports / delegates to these helpers so existing
 * callers (turn-worker / dialogue-coordinator / outer-turn / cli) remain
 * source-compatible.
 */

/**
 * Legacy prompt persistence — used when no `workdirRoot` is threaded
 * through `AgentIoDeps`. Kept for single-shot tests and fixture-only
 * adapters that have no workdir notion.
 *
 * Each call allocates a fresh `mkdtempSync` directory and writes
 * `<sessionId>-<turnIndex>.md` inside it, returning the absolute path
 * the LlmRunner consumes via `composeStdin → readFile`.
 */
export async function writePromptTmp(
  sessionId: string,
  turnIndex: number,
  body: string,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "llm-team-prompt-"));
  const path = join(dir, `${sessionId}-${turnIndex}.md`);
  await writeFile(path, body, "utf8");
  return path;
}

/**
 * phase-0-stabilization C — write the composed prompt body to
 * `<workdirRoot>/prompts/<sessionId>/<turnIndex>.md` and return the
 * absolute path the LlmRunner consumes via
 * `runInvoke.composeStdin → readFile`.
 *
 * Replaces `writePromptTmp` for callers that thread `workdirRoot` through
 * `AgentIoDeps`. The historical `mkdtempSync(tmpdir(), "llm-team-prompt-")`
 * behaviour leaked one tmp directory per turn (6,503 dirs accumulated on a
 * single self-host run) with no cleanup hook. Persisting under the workdir
 * gives a stable, predictable, operator-inspectable path for post-incident
 * replay, and a single tree to GC when the operator chooses.
 *
 * Idempotent on (sessionId, turnIndex): rewrite of an existing file is
 * tolerated because the runner re-reads the body on each invocation, but
 * the typical caller writes once before invoking the runner.
 */
export async function writePromptUnderWorkdir(
  workdirRoot: string,
  sessionId: string,
  turnIndex: number,
  body: string,
): Promise<string> {
  const path = join(workdirRoot, "prompts", sessionId, `${turnIndex}.md`);
  await mkdir(dirname(path), { recursive: true });
  // qwen review P1-2: pin the mode explicitly so the prompt body does not
  // depend on the operator's umask. Mirrors `writeAtomic` (store/fs.ts)
  // which also writes 0o644.
  await writeFile(path, body, { encoding: "utf8", mode: 0o644 });
  return path;
}

/**
 * Header echo invariant — the agent must replay the seven prompt
 * frontmatter fields back in its envelope. This helper compares
 * `expected` (from prompt input) against `got` (from the agent-authored
 * envelope or any structurally compatible payload). Returns a
 * semicolon-joined mismatch string, or `null` when all seven fields
 * match.
 *
 * Envelope-무관: the caller passes plain field bags so Phase 1
 * (PR-first lead-invoker / reviewer-invoker) can reuse the same check
 * against its own envelope shape without depending on
 * `AgentAuthoredEnvelope`.
 */
export interface HeaderEchoFields {
  session_id: string;
  turn_index: number;
  parent_loop: string;
  phase_or_purpose: string;
  agent_profile_id: string;
  agent_role_in_session: string;
  manifest_id: string;
}

export function checkHeaderEcho(
  expected: HeaderEchoFields,
  got: HeaderEchoFields,
): string | null {
  const mismatches: string[] = [];
  const echo = (
    field: keyof HeaderEchoFields,
    a: string | number,
    b: string | number,
  ) => {
    if (a !== b) mismatches.push(`${field} expected=${a} got=${b}`);
  };
  echo("session_id", expected.session_id, got.session_id);
  echo("turn_index", expected.turn_index, got.turn_index);
  echo("parent_loop", expected.parent_loop, got.parent_loop);
  echo("phase_or_purpose", expected.phase_or_purpose, got.phase_or_purpose);
  echo("agent_profile_id", expected.agent_profile_id, got.agent_profile_id);
  echo(
    "agent_role_in_session",
    expected.agent_role_in_session,
    got.agent_role_in_session,
  );
  echo("manifest_id", expected.manifest_id, got.manifest_id);
  return mismatches.length > 0 ? mismatches.join("; ") : null;
}
