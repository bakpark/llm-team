import { z } from "zod";

/**
 * Phase prod-1 — Non-Live Preflight Healthcheck
 *
 * Stage 1 runs zero-cost, fail-fast (~5s) environment + dependency checks
 * before any live LLM call. Stage 2/3 are reserved for phase-prod-3 and
 * respond with a placeholder when invoked here.
 *
 * Each `HealthcheckItem.anchor` is an `M-*` identifier that traces back to
 * the planning doc (.human/draft/2026-05-09-production-implementation-phases.md)
 * so a failure can be located without reading the runtime code.
 */

export const HealthcheckStatus = z.enum(["PASS", "FAIL", "SKIP"]);
export type HealthcheckStatus = z.infer<typeof HealthcheckStatus>;

export const HealthcheckStage = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type HealthcheckStage = z.infer<typeof HealthcheckStage>;

export const HealthcheckItem = z
  .object({
    id: z.string().min(1),
    status: HealthcheckStatus,
    detail: z.string(),
    anchor: z.string().min(1),
  })
  .strict();
export type HealthcheckItem = z.infer<typeof HealthcheckItem>;

/**
 * Per-CLI authentication model detection. `unknown` is reserved for
 * surfaces the stage-1 probe cannot positively classify (e.g. when
 * `claude`/`codex` is missing or the subcommand introspection differs from
 * the documented contract). `UNKNOWN_UNTIL_STAGE3` is also accepted for
 * symmetry with the planning doc's `M-2-5` skip semantics.
 */
export const AuthModel = z.enum([
  "env_token",
  "credential_file",
  "interactive_only",
  "keychain",
  "other",
  "unknown",
  "UNKNOWN_UNTIL_STAGE3",
]);
export type AuthModel = z.infer<typeof AuthModel>;

export const AuthModels = z
  .object({
    claude: AuthModel,
    codex: AuthModel,
    gh: AuthModel,
  })
  .strict();
export type AuthModels = z.infer<typeof AuthModels>;

export const HealthcheckResult = z
  .object({
    stage: HealthcheckStage,
    items: z.array(HealthcheckItem),
    passed: z.boolean(),
    generatedAt: z.string().min(1),
    auth_models: AuthModels,
  })
  .strict();
export type HealthcheckResult = z.infer<typeof HealthcheckResult>;

/**
 * Phase prod-3 — Live Provider Healthcheck additions.
 *
 * Stage 3 may invoke real LLM CLIs (claude / codex) when opted in via
 * `LLM_TEAM_LIVE_HEALTHCHECK=1`. Each live invocation appends a single line
 * to a ndjson cost ledger so subsequent runs can enforce a daily cap.
 *
 * The ledger lives outside the trunk working tree (default
 * `~/.llm-team/healthcheck-cost-ledger.ndjson`) so `git status` never
 * surfaces it.
 */
export const CostLedgerEntry = z
  .object({
    /** ISO timestamp of the live call. */
    ts: z.string().min(1),
    /** Stable kind discriminator (e.g. `claude.smoke`, `codex.default.smoke`). */
    kind: z.string().min(1),
    /** Estimated USD cost charged against the cap. */
    estimated_usd: z.number().min(0),
    /** Optional run directory path (for traceability). */
    run_dir: z.string().optional(),
  })
  .strict();
export type CostLedgerEntry = z.infer<typeof CostLedgerEntry>;

/**
 * `verified-auth-model.json` — written after Stage 3 completes.
 *
 * `status` records the live-probe outcome per surface; `cli_version` and
 * `model` are best-effort strings extracted from CLI output.
 */
export const VerifiedAuthSurface = z
  .object({
    status: z.enum(["PASS", "FAIL", "SKIP"]),
    cli_version: z.string().optional(),
    model: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();
export type VerifiedAuthSurface = z.infer<typeof VerifiedAuthSurface>;

export const VerifiedAuthModel = z
  .object({
    generatedAt: z.string().min(1),
    claude: VerifiedAuthSurface,
    codex: VerifiedAuthSurface,
    codex_qwen: VerifiedAuthSurface,
    gh: VerifiedAuthSurface,
  })
  .strict();
export type VerifiedAuthModel = z.infer<typeof VerifiedAuthModel>;
