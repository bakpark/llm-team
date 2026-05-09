/**
 * Sink-boundary redaction for adapter artifacts (diagnostics/envelope/logs).
 *
 * Policy
 * ------
 * Redaction runs *only at the persist boundary* (artifact writers, log/notify
 * appenders). Adapter internals keep raw stdout/stderr so that retry classifiers
 * and tests see the unmodified data. Once a string is handed to a sink, every
 * known token-shape and every secret-suspected env value is replaced with
 * `[REDACTED]`.
 *
 * Patterns (intentionally conservative — false negatives over false positives)
 * - GitHub PAT: `ghp_…`, `github_pat_…`
 * - Anthropic key: `sk-ant-…`
 * - OpenAI key: `sk-…` (excluding `sk-ant-` since Anthropic is matched first)
 * - Generic Bearer header: `Bearer <token>`
 * - env values: only values whose KEY matches a secret-suspected suffix
 *   (`_KEY`, `_TOKEN`, `_SECRET`, `_PAT`, `_PASSWORD`, `_AUTH`, `_CREDENTIAL`)
 *   or an explicit key (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
 *   This avoids scrubbing benign values like `HOME`, `PATH`, `TMPDIR`,
 *   working directories, etc. that happen to be ≥12 chars.
 *
 * Token boundaries are word-char-aware so that unrelated words (`scarf`,
 * `risk-free`) are not partially matched. The minimum length of 12 chars on
 * generic patterns avoids matching short prefixes.
 */

const PLACEHOLDER = "[REDACTED]";

// Suffix patterns (case-insensitive) — env keys ending with these are
// considered secret-bearing. Underscore-prefixed to avoid matching benign
// keys whose name merely contains "key" or "auth" mid-word.
const SECRET_KEY_SUFFIXES: ReadonlyArray<string> = [
  "_KEY",
  "_TOKEN",
  "_SECRET",
  "_PAT",
  "_PASSWORD",
  "_AUTH",
  "_CREDENTIAL",
];

// Explicit secret-bearing key names that don't fit the suffix pattern.
const SECRET_KEY_EXPLICIT: ReadonlySet<string> = new Set([
  "GH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);

function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SECRET_KEY_EXPLICIT.has(upper)) return true;
  for (const suffix of SECRET_KEY_SUFFIXES) {
    if (upper.endsWith(suffix)) return true;
  }
  return false;
}

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
 * whose KEY is secret-suspected (see SECRET_KEY_SUFFIXES / SECRET_KEY_EXPLICIT).
 *
 * Multiple env sources can be passed — values are merged before scanning so
 * that secrets injected via `envOverride` (and not present in `process.env`)
 * are still masked.
 *
 * @param input    raw text (stdout/stderr/log line/notification body)
 * @param envs     one or more env snapshots to scan. Defaults to [process.env].
 *                 An explicit empty array disables env-value redaction.
 */
export function redactSecrets(
  input: string,
  ...envs: NodeJS.ProcessEnv[]
): string {
  if (input.length === 0) return input;

  let out = input;

  // 1. Token-shape patterns first — these cover keys not present in env.
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, PLACEHOLDER);
  }

  // 2. Env-value match restricted to secret-suspected keys. Length floor of
  //    4 chars avoids absurd matches (e.g. a 1-char API key) but does not
  //    require a long suffix so short-but-real tokens are still masked.
  const sources: NodeJS.ProcessEnv[] =
    envs.length === 0 ? [process.env] : envs;
  const seen = new Set<string>();
  for (const env of sources) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") continue;
      if (value.length < 4) continue;
      if (!isSecretKey(key)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (!out.includes(value)) continue;
      out = splitReplaceAll(out, value, PLACEHOLDER);
    }
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
