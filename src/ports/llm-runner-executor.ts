import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  openDiagnosticsSlot,
  openEnvelopeSlot,
} from "../adapters/llm-runner/common/diagnostics.js";
import { extractEnvelope } from "../adapters/llm-runner/common/envelope-extract.js";
import { assertFourPartLayout } from "../adapters/llm-runner/common/prompt-relay.js";
import type { LlmRunnerAdapter } from "../adapters/llm-runner/types.js";
import type { ExitStatus, LlmRunnerInput, LlmRunnerResult } from "./llm-runner.js";
import { classifyExit } from "./llm-runner.js";

// runInvoke — contract-shaped port executor. Always returns the 4-tuple
// (exitStatus, envelopeRef, diagnosticsRef, consumedAt) per ARC-PORT-SIGNATURE,
// even on preflight failure or unexpected throw. Adapter primitives never
// see the contract refs directly; this function resolves them into stdin.
export async function runInvoke(
  input: LlmRunnerInput,
  adapter: LlmRunnerAdapter,
): Promise<LlmRunnerResult> {
  const diagnostics = await openDiagnosticsSlot(input);
  const envelope = await openEnvelopeSlot(input);

  const finish = async (
    exitStatus: ExitStatus,
    envelopeBody: string,
    diagBody: string,
  ): Promise<LlmRunnerResult> => {
    await envelope.write(envelopeBody);
    await diagnostics.write(diagBody);
    return {
      exitStatus,
      envelopeRef: envelope.path,
      diagnosticsRef: diagnostics.path,
      // consumed_at = call completion time, per ARC-PORT-SIGNATURE.
      consumedAt: new Date().toISOString(),
    };
  };

  try {
    if (!existsSync(input.agentCwd)) {
      return finish(
        "adapter_unavailable",
        "",
        `agentCwd not found: ${input.agentCwd}`,
      );
    }

    let stdin: string;
    try {
      stdin = await composeStdin(input.promptRef, input.sessionContextRef);
    } catch (e) {
      return finish(
        "transport_error",
        "",
        `compose stdin failed: ${(e as Error).message}`,
      );
    }

    try {
      assertFourPartLayout(stdin);
    } catch (e) {
      return finish(
        "transport_error",
        "",
        `4-part layout violation: ${(e as Error).message}`,
      );
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

    return finish(exitStatus, envelopeBody, r.stderr);
  } catch (e) {
    const stack = (e as Error).stack ?? String(e);
    return finish("transport_error", "", `unexpected error: ${stack}`);
  }
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
