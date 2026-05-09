/**
 * Sink-boundary redaction for adapter artifacts (diagnostics/envelope/logs).
 *
 * Policy
 * ------
 * Redaction runs *only at the persist boundary* (artifact writers, log/notify
 * appenders). Adapter internals keep raw stdout/stderr so that retry classifiers
 * and tests see the unmodified data. Once a string is handed to a sink, every
 * known token-shape and every literal `process.env` value is replaced with
 * `[REDACTED]`.
 *
 * Patterns (intentionally conservative — false negatives over false positives)
 * - GitHub PAT: `ghp_…`, `github_pat_…`
 * - Anthropic key: `sk-ant-…`
 * - OpenAI key: `sk-…` (excluding `sk-ant-` since Anthropic is matched first)
 * - Generic Bearer header: `Bearer <token>`
 * - process.env raw values: any env value present verbatim in the input
 *
 * Token boundaries are word-char-aware so that unrelated words (`scarf`,
 * `risk-free`) are not partially matched. The minimum length of 12 chars on
 * generic patterns avoids matching short prefixes.
 */

const PLACEHOLDER = "[REDACTED]";

// Order matters: Anthropic must run before the generic OpenAI sk- pattern.
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  // GitHub fine-grained PAT (often 80+ chars, _ separator) — match first.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Classic GitHub PAT
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  // Anthropic API key
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI-style key. Tightened to 20+ payload chars to avoid matching
  // short identifiers like `sk-test-1` in unrelated logs.
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // Bearer header (Authorization: Bearer xxx). Token must be 12+ chars.
  /Bearer\s+[A-Za-z0-9._-]{12,}/g,
];

/**
 * Redact secret-shaped substrings and any literal value from `envSnapshot`
 * that appears verbatim in the input.
 *
 * @param input        raw text (stdout/stderr/log line/notification body)
 * @param envSnapshot  env to scan for raw value matches (default: process.env)
 */
export function redactSecrets(
  input: string,
  envSnapshot: NodeJS.ProcessEnv = process.env,
): string {
  if (input.length === 0) return input;

  let out = input;

  // 1. Token-shape patterns first — these cover keys not present in env.
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, PLACEHOLDER);
  }

  // 2. Literal env value match. Only redact when the value looks
  //    secret-ish (>= 12 chars) to avoid scrubbing common short values like
  //    `0`, `true`, paths, or empty strings.
  const seen = new Set<string>();
  for (const [, value] of Object.entries(envSnapshot)) {
    if (typeof value !== "string") continue;
    if (value.length < 12) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!out.includes(value)) continue;
    out = splitReplaceAll(out, value, PLACEHOLDER);
  }

  return out;
}

/**
 * Replace every occurrence of `needle` in `haystack` with `replacement`,
 * without using a regex (so the needle's special characters are treated
 * literally).
 */
function splitReplaceAll(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  if (needle.length === 0) return haystack;
  return haystack.split(needle).join(replacement);
}
