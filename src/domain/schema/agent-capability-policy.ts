import { z } from "zod";

/**
 * AgentCapabilityPolicy — declarative tool / fs / network capability scope
 * applied to a single agent invocation.
 *
 * Authority: `cli-spicy-anchor.md` §1 (다층 enforcement L1~L5).
 *
 * Phase 1 introduces the schema and L1~L3 wiring in claude-code / codex-cli
 * adapters. L4 (post-call tracked diff allowlist) ships as a helper only;
 * actual call-sites land in lead-invoker / reviewer-invoker (Phase 2/3).
 * L5 (OS sandbox / provider tool proxy) is deferred.
 */

const PathPattern = z.string().min(1);

export const CapabilityFsMode = z.enum(["allow", "deny", "scoped"]);
export type CapabilityFsMode = z.infer<typeof CapabilityFsMode>;

export const CapabilityFsScope = z
  .object({
    mode: CapabilityFsMode,
    /** Glob patterns relative to jail_root. Empty when mode != "scoped". */
    allowlist_paths: z.array(PathPattern).default(() => []),
    /** Absolute path used as the cwd jail root. Required when mode="scoped". */
    jail_root: z.string().min(1).nullable().default(null),
  })
  .strict();
export type CapabilityFsScope = z.infer<typeof CapabilityFsScope>;

export const CapabilityBashMode = z.enum(["allow", "deny", "allowlist"]);
export type CapabilityBashMode = z.infer<typeof CapabilityBashMode>;

export const CapabilityBashScope = z
  .object({
    mode: CapabilityBashMode,
    allowlist: z.array(z.string().min(1)).default(() => []),
    denylist: z.array(z.string().min(1)).default(() => []),
  })
  .strict();
export type CapabilityBashScope = z.infer<typeof CapabilityBashScope>;

export const CapabilityNetworkMode = z.enum(["allow", "deny"]);
export type CapabilityNetworkMode = z.infer<typeof CapabilityNetworkMode>;

export const AgentCapabilityPolicy = z
  .object({
    read: CapabilityFsScope,
    edit: CapabilityFsScope,
    bash: CapabilityBashScope,
    network: CapabilityNetworkMode,
    notes: z.string().default(""),
  })
  .strict();
export type AgentCapabilityPolicy = z.infer<typeof AgentCapabilityPolicy>;

/** Profile defaults from `cli-spicy-anchor.md` §1. */
export function defaultLeadCapabilityPolicy(jailRoot: string | null = null): AgentCapabilityPolicy {
  return {
    read: { mode: "scoped", allowlist_paths: [], jail_root: jailRoot },
    edit: { mode: "scoped", allowlist_paths: [], jail_root: jailRoot },
    bash: { mode: "deny", allowlist: [], denylist: [] },
    network: "deny",
    notes: "",
  };
}

export function defaultReviewerCapabilityPolicy(jailRoot: string | null = null): AgentCapabilityPolicy {
  return {
    read: { mode: "scoped", allowlist_paths: [], jail_root: jailRoot },
    edit: { mode: "deny", allowlist_paths: [], jail_root: null },
    bash: { mode: "deny", allowlist: [], denylist: [] },
    network: "deny",
    notes: "",
  };
}

/**
 * Env vars stripped from agent spawn under L3 enforcement (cli-spicy-anchor.md
 * §1 L3). The list bundles GitHub / SSH / cloud provider / package registry
 * tokens plus the daemon-only machine-block secret family.
 */
export const CAPABILITY_L3_STRIP_KEYS: readonly string[] = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "SSH_AUTH_SOCK",
  "NPM_TOKEN",
  "LLM_TEAM_MACHINE_BLOCK_SECRET",
];

/** Patterns whose names must be stripped via prefix/glob match (L3). */
export const CAPABILITY_L3_STRIP_PREFIXES: readonly string[] = [
  "AWS_",
  "LLM_TEAM_",
];

/** Suffixes — any env var matching `*_SECRET` is stripped (L3). */
export const CAPABILITY_L3_STRIP_SUFFIXES: readonly string[] = ["_SECRET"];

export function isCapabilityStrippedEnvKey(key: string): boolean {
  if (CAPABILITY_L3_STRIP_KEYS.includes(key)) return true;
  for (const p of CAPABILITY_L3_STRIP_PREFIXES) {
    if (key.startsWith(p)) return true;
  }
  for (const s of CAPABILITY_L3_STRIP_SUFFIXES) {
    if (key.endsWith(s)) return true;
  }
  return false;
}
