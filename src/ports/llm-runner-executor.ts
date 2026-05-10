import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type AttemptMetadata,
  type AttemptSlots,
  openAttemptSlots,
} from "../adapters/llm-runner/common/diagnostics.js";
import { extractEnvelope } from "../adapters/llm-runner/common/envelope-extract.js";
import { assertFourPartLayout } from "../adapters/llm-runner/common/prompt-relay.js";
import { redactSecrets } from "../adapters/llm-runner/common/redact.js";
import type { LlmRunnerAdapter } from "../adapters/llm-runner/types.js";
import type { ExitStatus, LlmRunnerInput, LlmRunnerResult } from "./llm-runner.js";
import { classifyExit, classifyTransportReason } from "./llm-runner.js";

// runInvoke — contract-shaped port executor. Always returns the 4-tuple
// (exitStatus, envelopeRef, diagnosticsRef, consumedAt) per ARC-PORT-SIGNATURE,
// even on preflight failure or unexpected throw. Adapter primitives never
// see the contract refs directly; this function resolves them into stdin.
//
// Per attempt, five files are written under LLM_TEAM_RUNNER_DIAG_DIR:
//   - <base>.prompt       (composed stdin handed to the adapter, redacted;
//                          written before assertFourPartLayout so layout
//                          violations still leave the offending body on disk
//                          — L-3-1)
//   - <base>.stdout       (raw stdout, redacted at write boundary)
//   - <base>.stderr       (raw stderr, redacted at write boundary; this is
//                          the path returned as `diagnosticsRef`)
//   - <base>.envelope     (extracted envelope JSON, or empty)
//   - <base>.metadata.json
//
// Even on preflight failure all five files are written (with empty bodies
// for slots that were never reached) so cycle bundles always reference a
// complete attempt directory.
export async function runInvoke(
  input: LlmRunnerInput,
  adapter: LlmRunnerAdapter,
): Promise<LlmRunnerResult> {
  const slots = await openAttemptSlots(input);
  // Tracks whether the prompt body was already written by the success path
  // before reaching `finish`. When false, finish writes an empty prompt file
  // so the slot is never missing.
  let promptWritten = false;

  const finish = async (
    exitStatus: ExitStatus,
    bodies: {
      stdout?: string;
      stderr?: string;
      envelope?: string;
      reason?: string;
      rawCode?: number | null;
      signal?: NodeJS.Signals | null;
      timedOut?: boolean;
      spawnEnv?: NodeJS.ProcessEnv;
    },
  ): Promise<LlmRunnerResult> => {
    const consumedAt = new Date().toISOString();
    const meta: AttemptMetadata = {
      rawExitCode: bodies.rawCode ?? null,
      signal: bodies.signal ?? null,
      timedOut: bodies.timedOut ?? false,
      consumedAt,
      ...(bodies.reason ? { reason: bodies.reason } : {}),
    };
    // Redact against the resolved spawn env when the adapter exposes it.
    // This catches secrets injected via envOverride that are not present in
    // process.env. When unavailable (preflight failures, fake adapters), we
    // fall back to process.env via the default branch in redactSecrets.
    const envSources: NodeJS.ProcessEnv[] = bodies.spawnEnv
      ? [process.env, bodies.spawnEnv]
      : [process.env];
    if (!promptWritten) {
      await writeRedacted(slots.prompt, "", envSources);
    }
    await writeRedacted(slots.stdout, bodies.stdout ?? "", envSources);
    await writeRedacted(slots.stderr, bodies.stderr ?? "", envSources);
    await writeRedacted(slots.envelope, bodies.envelope ?? "", envSources);
    // metadata is structured/short and cannot contain secrets, but we still
    // run it through redact for defense-in-depth (env values that happened to
    // collide with the consumed_at string would be unlikely but harmless).
    await writeRedacted(slots.metadata, JSON.stringify(meta), envSources);
    return {
      exitStatus,
      envelopeRef: slots.envelope.path,
      diagnosticsRef: slots.stderr.path,
      // consumed_at = call completion time, per ARC-PORT-SIGNATURE.
      consumedAt,
    };
  };

  try {
    if (!existsSync(input.agentCwd)) {
      return finish("adapter_unavailable", {
        stderr: `agentCwd not found: ${input.agentCwd}`,
        reason: "agent_cwd_missing",
      });
    }

    let stdin: string;
    try {
      stdin = await composeStdin(input.promptRef, input.sessionContextRef);
    } catch (e) {
      return finish("transport_error", {
        stderr: `compose stdin failed: ${(e as Error).message}`,
        reason: "compose_stdin_failed",
      });
    }

    // L-3-1: persist the composed prompt before any further validation so
    // a 4-part layout violation (or later adapter failure) still leaves the
    // offending body on disk for replay. spawnEnv is unknown here — fall
    // back to process.env for redaction; adapter envOverride secrets are
    // unlikely to appear in the prompt body.
    await writeRedacted(slots.prompt, stdin, [process.env]);
    promptWritten = true;

    try {
      assertFourPartLayout(stdin);
    } catch (e) {
      return finish("transport_error", {
        stderr: `4-part layout violation: ${(e as Error).message}`,
        reason: "prompt_layout_violation",
      });
    }

    const r = await adapter.run({
      stdin,
      agentCwd: input.agentCwd,
      timeoutSec: input.timeoutSec,
    });

    const baseStatus = classifyExit({
      rawCode: r.rawCode,
      signal: r.signal,
      timedOut: r.timedOut,
    });
    const extracted = extractEnvelope(r.stdout);
    let exitStatus = baseStatus;
    let envelopeBody = extracted ?? "";
    if (baseStatus === "ok") {
      if (extracted === null) {
        exitStatus = "malformed_output";
      } else if (!isParseableJson(extracted)) {
        // Adapter exited 0 with a fenced block, but the body is not JSON.
        // Per ARC-EXIT-CLASSES, an envelope body that is unparseable is
        // malformed_output regardless of process exit code.
        exitStatus = "malformed_output";
        envelopeBody = extracted;
      }
    }

    const reason =
      exitStatus === "transport_error"
        ? classifyTransportReason({ stderr: r.stderr, rawCode: r.rawCode })
        : undefined;

    return finish(exitStatus, {
      stdout: r.stdout,
      stderr: r.stderr,
      envelope: envelopeBody,
      rawCode: r.rawCode,
      signal: r.signal,
      timedOut: r.timedOut,
      reason,
      spawnEnv: r.spawnEnv,
    });
  } catch (e) {
    const stack = (e as Error).stack ?? String(e);
    return finish("transport_error", {
      stderr: `unexpected error: ${stack}`,
      reason: "executor_throw",
    });
  }
}

async function writeRedacted(
  slot: AttemptSlots["stdout"],
  body: string,
  envSources: NodeJS.ProcessEnv[],
): Promise<void> {
  await slot.write(redactSecrets(body, ...envSources));
}

function isParseableJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// composeStdin reads the prompt body from prompt_ref. If session_context_ref
// is provided, its body is injected as a sub-block under the prompt's
// `# Context` heading. Callers that have already merged the context body
// into the prompt should pass sessionContextRef=null.
async function composeStdin(
  promptRef: string,
  sessionContextRef: string | null,
): Promise<string> {
  const promptBody = await readFile(promptRef, "utf8");
  if (!sessionContextRef) return promptBody;
  const ctxBody = await readFile(sessionContextRef, "utf8");
  return injectSessionContext(promptBody, ctxBody);
}

function injectSessionContext(prompt: string, ctx: string): string {
  // Anchor on the canonical heading sequence. We require the *first*
  // "# Context" line to be a top-level heading immediately after a newline
  // — `assertFourPartLayout` will catch malformed prompts later, but if the
  // marker is genuinely missing we throw here rather than silently appending
  // (which would produce a layout-passing but semantically broken prompt).
  const marker = "\n# Context\n";
  const idx = prompt.indexOf(marker);
  if (idx < 0) {
    throw new Error(
      "session_context_ref provided but prompt has no '# Context' heading to inject under",
    );
  }
  const insertAt = idx + marker.length;
  const trimmedCtx = ctx.endsWith("\n") ? ctx : `${ctx}\n`;
  return `${prompt.slice(0, insertAt)}\n${trimmedCtx}\n${prompt.slice(insertAt)}`;
}
