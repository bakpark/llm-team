/**
 * Phase 1 capability-policy enforcement helpers shared by LLM runner adapters.
 *
 * Authority: `cli-spicy-anchor.md` §1.
 *
 * - `claudeCodeCapabilityFlags(policy)` → CLI args for L1 (claude-code).
 * - `codexCliCapabilityFlags(policy)` → CLI args for L1 (codex-cli).
 * - `applyCapabilityEnvStrip(env, policy)` → L3 env allowlist filter.
 *
 * L2 (cwd jail) is satisfied by the adapter passing `input.agentCwd` to
 * `spawnWithTimeout` unchanged. L4 (post-call tracked diff allowlist) is a
 * separate helper in `application/post-call-diff-allowlist.ts` invoked by
 * lead/reviewer-invoker (Phase 2/3).
 */

import {
  AgentCapabilityPolicy,
  CAPABILITY_L3_STRIP_KEYS,
  CAPABILITY_L3_STRIP_PREFIXES,
  CAPABILITY_L3_STRIP_SUFFIXES,
  isCapabilityStrippedEnvKey,
} from "../../../domain/schema/agent-capability-policy.js";

/** L1 — translate the policy into claude-code `--allowed-tools` / `--disallowed-tools`. */
export function claudeCodeCapabilityFlags(
  policy: AgentCapabilityPolicy,
): string[] {
  const allowed: string[] = [];
  const disallowed: string[] = [];

  // Read tool — claude-code's `Read` tool. Policy.read.mode=deny → disallow.
  if (policy.read.mode === "deny") disallowed.push("Read");
  else allowed.push("Read");

  // Edit tool covers `Edit` + `Write`.
  if (policy.edit.mode === "deny") disallowed.push("Edit", "Write");
  else allowed.push("Edit", "Write");

  // Bash. allow → unrestricted; allowlist → claude-code lacks per-pattern flag,
  // so 1회전 maps to `Bash` allowed (relies on L4 / L5 for true allowlisting).
  if (policy.bash.mode === "deny") disallowed.push("Bash");
  else allowed.push("Bash");

  // Network — WebFetch / WebSearch.
  if (policy.network === "deny") disallowed.push("WebFetch", "WebSearch");
  else allowed.push("WebFetch", "WebSearch");

  const flags: string[] = [];
  if (allowed.length > 0) {
    flags.push("--allowed-tools", allowed.join(","));
  }
  if (disallowed.length > 0) {
    flags.push("--disallowed-tools", disallowed.join(","));
  }
  return flags;
}

/** L1 — translate the policy into codex-cli `--sandbox` / network flags. */
export function codexCliCapabilityFlags(
  policy: AgentCapabilityPolicy,
): string[] {
  const flags: string[] = [];
  // Default codex sandbox is `workspace-write` when edit is permitted.
  // read-only when edit=deny but read != deny.
  if (policy.edit.mode === "deny" && policy.read.mode !== "deny") {
    flags.push("--sandbox", "read-only");
  } else if (policy.edit.mode !== "deny") {
    flags.push("--sandbox", "workspace-write");
  } else {
    // Both denied → fall back to read-only for self-consistency.
    flags.push("--sandbox", "read-only");
  }
  if (policy.network === "deny") {
    // codex-cli accepts `--no-network` per cli-spicy-anchor.md §1 L1.
    flags.push("--no-network");
  }
  return flags;
}

/**
 * L3 — strip secret env keys from the spawn env. Always removes the
 * baseline secret family from `agent-capability-policy.ts`. When `policy`
 * is provided we additionally apply `read.mode==="deny"` → drop `HOME` /
 * `XDG_*` (best-effort; many CLIs require HOME to start).
 */
export function applyCapabilityEnvStrip(
  env: NodeJS.ProcessEnv,
  policy?: AgentCapabilityPolicy,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isCapabilityStrippedEnvKey(k)) continue;
    out[k] = v;
  }
  // Network deny → drop common proxy env vars so the agent can't tunnel.
  if (policy && policy.network === "deny") {
    delete out.HTTP_PROXY;
    delete out.HTTPS_PROXY;
    delete out.http_proxy;
    delete out.https_proxy;
    delete out.ALL_PROXY;
    delete out.all_proxy;
  }
  return out;
}

export const CAPABILITY_STRIP_BASELINE = {
  keys: CAPABILITY_L3_STRIP_KEYS,
  prefixes: CAPABILITY_L3_STRIP_PREFIXES,
  suffixes: CAPABILITY_L3_STRIP_SUFFIXES,
} as const;
