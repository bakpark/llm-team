/**
 * Phase 2 PR body composer (cli-spicy-anchor.md §11).
 *
 * Builds a standard-section PR body from `LeadIntent` + appends the
 * canonical `<!-- llm-team:pr-machine ... -->` block at the very end. All
 * agent-authored markdown (decision_needed / open_questions / verification
 * notes) is sanitized via `sanitizeMarkdown` before inlining so an injected
 * machine block in the agent text cannot survive past the final `pr-machine`
 * block (last-match policy in `machine-block.parseLastMatch`).
 *
 * Sections (cli-spicy-anchor.md §11):
 *   ## Summary
 *   ## Changed files
 *   ## Decision needed
 *   ## Verification notes
 *   ## Open questions
 *   <pr-machine block>
 *
 * Phase 2 ships only the pure helper. lead-invoker calls it both at PR open
 * and at body update.
 */

import type { LeadIntent } from "../domain/schema/lead-intent.js";
import {
  computeNonce,
  type PrCanonicalFields,
  renderBlock,
  sanitizeMarkdown,
} from "./machine-block.js";

export interface ComposePrBodyInput {
  intent: LeadIntent;
  canonicalFields: PrCanonicalFields;
  /** HMAC secret read from env (cli-spicy-anchor.md §11-3). */
  machineBlockSecret: string;
}

export function composePrBody(input: ComposePrBodyInput): string {
  const { intent } = input;
  const sections: string[] = [];

  // ## Summary — agent-authored prose, sanitized.
  sections.push("## Summary");
  sections.push(sanitizeMarkdown(intent.summary).trim());

  // ## Changed files — list of declared paths (machine-friendly).
  sections.push("## Changed files");
  if (intent.changed_files.length === 0) {
    sections.push("_(none declared)_");
  } else {
    sections.push(
      intent.changed_files.map((p) => `- \`${sanitizeMarkdown(p)}\``).join("\n"),
    );
  }

  // ## Decision needed — agent-authored prose, sanitized.
  sections.push("## Decision needed");
  const decision = sanitizeMarkdown(intent.decision_needed).trim();
  sections.push(decision.length > 0 ? decision : "_(none)_");

  // ## Verification notes — agent-authored prose, sanitized.
  sections.push("## Verification notes");
  const verification = sanitizeMarkdown(intent.verification_notes).trim();
  sections.push(verification.length > 0 ? verification : "_(none)_");

  // ## Open questions — agent-authored prose, sanitized.
  sections.push("## Open questions");
  const questions = sanitizeMarkdown(intent.open_questions).trim();
  sections.push(questions.length > 0 ? questions : "_(none)_");

  // PR-machine block — last in body, signed.
  const nonce = computeNonce(
    input.machineBlockSecret,
    "pr",
    input.canonicalFields,
  );
  const block = renderBlock("pr", input.canonicalFields, nonce);

  return `${sections.join("\n\n")}\n\n${block}\n`;
}
