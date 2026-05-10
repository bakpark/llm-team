import { createHmac } from "node:crypto";

/**
 * PR / review machine-block module.
 *
 * Authority: `cli-spicy-anchor.md` §11 (sanitize / last-match / nonce).
 *
 * Responsibilities:
 *   - `sanitizeMarkdown(body)`: strip any agent-authored
 *     `<!-- llm-team:... -->` blocks before the Caller inlines agent text
 *     into PR/review bodies (defense against block-injection spoofing).
 *   - `parseLastMatch(body, blockKind)`: only the **last** machine block of
 *     the requested kind is authoritative.
 *   - `buildCanonicalString` / `computeNonce` / `verifyNonce` /
 *     `renderBlock`: HMAC-SHA256 (prefix-16 hex) signing of the block's
 *     canonical fields.
 *
 * `secret` for HMAC is read from the env var named by
 * `target.governance.machine_block_secret_env_name` (default
 * `LLM_TEAM_MACHINE_BLOCK_SECRET`). The daemon must fail-loud at startup if
 * the env var is unset (`requireMachineBlockSecret`).
 */

export type MachineBlockKind = "pr" | "review";

const KIND_NAMES = new Set<string>(["pr", "review"]);

const PR_FIELDS = [
  "review_surface_id",
  "parent_kind",
  "parent_id",
  "parent_phase",
  "head_sha",
  "review_round",
  "last_verification_result",
  "idempotency_key",
] as const;

const REVIEW_FIELDS = [
  "review_surface_id",
  "parent_kind",
  "parent_id",
  "parent_phase",
  "review_round",
  "session_id",
  "turn_index",
  "agent_profile_id",
  "idempotency_key",
] as const;

export type PrCanonicalFields = Record<(typeof PR_FIELDS)[number], string>;
export type ReviewCanonicalFields = Record<(typeof REVIEW_FIELDS)[number], string>;
export type CanonicalFieldsFor<K extends MachineBlockKind> = K extends "pr"
  ? PrCanonicalFields
  : ReviewCanonicalFields;

export const MACHINE_BLOCK_SECRET_ENV_DEFAULT =
  "LLM_TEAM_MACHINE_BLOCK_SECRET";

/**
 * Read & assert the machine-block HMAC secret from process.env. Throws an
 * Error if the variable is unset or empty so the daemon boots fail-loud
 * (cli-spicy-anchor.md §11-3 secret 위치).
 */
export function requireMachineBlockSecret(
  envName: string = MACHINE_BLOCK_SECRET_ENV_DEFAULT,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const v = env[envName];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `machine-block secret env var ${envName} is not set; refusing to start`,
    );
  }
  return v;
}

/**
 * Strip any `<!-- llm-team:... -->` HTML comment block. Used to sanitize
 * agent-authored markdown before inlining.
 */
export function sanitizeMarkdown(body: string): string {
  return body.replace(/<!--\s*llm-team:[\s\S]*?-->/g, "");
}

export function fieldsForKind(
  kind: MachineBlockKind,
): readonly string[] {
  return kind === "pr" ? PR_FIELDS : REVIEW_FIELDS;
}

/**
 * Build the canonical string the HMAC is computed over. Field order is
 * fixed and must match `cli-spicy-anchor.md §11-3`.
 */
export function buildCanonicalString<K extends MachineBlockKind>(
  blockKind: K,
  fields: CanonicalFieldsFor<K>,
): string {
  const parts: string[] = [`block_kind=${blockKind}`];
  const order = fieldsForKind(blockKind);
  for (const k of order) {
    const v = (fields as Record<string, string>)[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`canonical field "${k}" is missing or empty`);
    }
    parts.push(`${k}=${v}`);
  }
  return parts.join("|");
}

/** HMAC-SHA256 hex prefix 16. */
export function computeNonce<K extends MachineBlockKind>(
  secret: string,
  blockKind: K,
  fields: CanonicalFieldsFor<K>,
): string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("computeNonce: secret must be a non-empty string");
  }
  const canonical = buildCanonicalString(blockKind, fields);
  return createHmac("sha256", secret)
    .update(canonical)
    .digest("hex")
    .slice(0, 16);
}

export function verifyNonce<K extends MachineBlockKind>(
  secret: string,
  blockKind: K,
  fields: CanonicalFieldsFor<K>,
  nonce: string,
): boolean {
  try {
    const expected = computeNonce(secret, blockKind, fields);
    return constantTimeEqual(expected, nonce);
  } catch {
    return false;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}

/**
 * Serialize a machine block (canonical fields + nonce) into the wire
 * format. The block is meant to be appended to the PR/review body's tail
 * — the parser uses last-match semantics.
 */
export function renderBlock<K extends MachineBlockKind>(
  blockKind: K,
  fields: CanonicalFieldsFor<K>,
  nonce: string,
): string {
  const order = fieldsForKind(blockKind);
  const lines: string[] = [`<!-- llm-team:${blockKind}-machine`];
  for (const k of order) {
    const v = (fields as Record<string, string>)[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`renderBlock: field "${k}" missing or empty`);
    }
    lines.push(`${k}: ${v}`);
  }
  lines.push(`nonce: ${nonce}`);
  lines.push("-->");
  return lines.join("\n");
}

export interface ParsedMachineBlock<K extends MachineBlockKind> {
  blockKind: K;
  fields: CanonicalFieldsFor<K>;
  nonce: string;
  /** Substring offset where the parsed block starts, for diagnostics. */
  startOffset: number;
}

/**
 * Locate the **last** machine block of `blockKind` in `body`. Returns null
 * when no block is present or when the block is malformed (unknown field /
 * missing nonce).
 *
 * Last-match policy: cli-spicy-anchor.md §11-2 — Caller appends its own
 * block to the body's end so any earlier (agent-injected) block is
 * shadowed.
 */
export function parseLastMatch<K extends MachineBlockKind>(
  body: string,
  blockKind: K,
): ParsedMachineBlock<K> | null {
  if (!KIND_NAMES.has(blockKind)) return null;
  const re = new RegExp(
    `<!--\\s*llm-team:${blockKind}-machine\\b([\\s\\S]*?)-->`,
    "g",
  );
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) lastMatch = m;
  if (lastMatch == null) return null;

  const inner = lastMatch[1] ?? "";
  const order = fieldsForKind(blockKind);
  const knownKeys = new Set([...order, "nonce"]);
  const fields: Record<string, string> = {};
  let nonce: string | null = null;

  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const idx = line.indexOf(":");
    if (idx < 0) return null;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!knownKeys.has(key)) return null; // forward-compat-strict
    if (key === "nonce") nonce = value;
    else fields[key] = value;
  }

  for (const k of order) {
    if (!(k in fields)) return null;
  }
  if (nonce == null || nonce.length === 0) return null;

  return {
    blockKind,
    fields: fields as CanonicalFieldsFor<K>,
    nonce,
    startOffset: lastMatch.index,
  };
}
