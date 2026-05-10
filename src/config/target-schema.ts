import { z } from "zod";

export const RunnerIdEnum = z.enum(["claude_code", "codex_cli", "fake"]);
export type RunnerId = z.infer<typeof RunnerIdEnum>;

export const ProfileCfg = z
  .object({
    runner: RunnerIdEnum,
    model: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    extraArgs: z.array(z.string()).optional(),
    killGraceMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ProfileCfg = z.infer<typeof ProfileCfg>;

/**
 * TCC-GOVERNANCE `human_team_provider` — selects the `TeamMembershipPort`
 * adapter the daemon binds. `fs-mirror` (default) keeps the phase-9a parity
 * wiring; `github` opts the deployment into the `gh api` Teams adapter
 * (phase-9d follow-up to PR #79). The schema default preserves backward
 * compatibility — operators who never set the field stay on fs-mirror.
 */
export const HumanTeamProvider = z.enum(["github", "fs-mirror"]);
export type HumanTeamProvider = z.infer<typeof HumanTeamProvider>;

export const Governance = z
  .object({
    human_team: z.string().min(1),
    control_issue_number: z.number().int().positive(),
    contract_change_issue_number: z.number().int().positive(),
    signal_command_prefix: z.string().min(1).default("/"),
    human_team_cache_ttl_seconds: z.number().int().positive().default(300),
    human_team_provider: HumanTeamProvider.default("fs-mirror"),
    unauthorized_author_alert: z.boolean().default(false),
  })
  .strict()
  .refine(
    (g) => g.control_issue_number !== g.contract_change_issue_number,
    {
      message:
        "control_issue_number and contract_change_issue_number must differ",
      path: ["contract_change_issue_number"],
    },
  );

export type Governance = z.infer<typeof Governance>;

/**
 * TCC-LEASE-CONFIG (4-kind TTL chain). Phase 4 introduces this block.
 *
 * Lookup chain (highest precedence first):
 *   worker_override (caller code) → ttl_by_phase[phase] →
 *   ttl_by_agent_profile[profile] → ttl_by_lease_kind[kind] →
 *   ttl_default → 60_000ms hardcoded fallback.
 *
 * Units are millis. Zero / negative are rejected by the schema.
 */
export const LeaseConfig = z
  .object({
    ttl_default_ms: z.number().int().positive().optional(),
    ttl_by_lease_kind: z
      .object({
        slot_lock: z.number().int().positive().optional(),
        slice_lease: z.number().int().positive().optional(),
        session_lease: z.number().int().positive().optional(),
        turn_lease: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    ttl_by_agent_profile: z
      .record(z.string().min(1), z.number().int().positive())
      .optional(),
    ttl_by_phase: z
      .record(z.string().min(1), z.number().int().positive())
      .optional(),
  })
  .strict();

export type LeaseConfig = z.infer<typeof LeaseConfig>;

/**
 * TCC-SLICE-CLASS-RULES — internal slice 가 자동 feature 게이트로 승격되는
 * 6 rule. 각 rule 은 default-on (target operator 가 disable 가능). path/glob
 * 또는 threshold 의 default 는 target operator 가 정의해야 한다.
 */

const PathGlobList = z.array(z.string().min(1));

const InterfaceBreakRule = z
  .object({
    enabled: z.boolean().default(true),
    protected_apis: PathGlobList.default(() => []),
  })
  .strict();

const SchemaOrMigrationChangeRule = z
  .object({
    enabled: z.boolean().default(true),
    paths: PathGlobList.default(() => []),
  })
  .strict();

const SecuritySensitivePathRule = z
  .object({
    enabled: z.boolean().default(true),
    paths: PathGlobList.default(() => []),
  })
  .strict();

const PerfCriticalPathRule = z
  .object({
    enabled: z.boolean().default(true),
    paths: PathGlobList.default(() => []),
    regression_threshold: z.number().nullable().default(null),
  })
  .strict();

const ExistingTestCoverageRule = z
  .object({
    enabled: z.boolean().default(true),
    threshold: z.number().min(0).max(1).default(0.7),
  })
  .strict();

const MetricRunnerUnavailableRule = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

export const InternalEscalationRules = z
  .object({
    interface_break: InterfaceBreakRule.default(() =>
      InterfaceBreakRule.parse({}),
    ),
    schema_or_migration_change: SchemaOrMigrationChangeRule.default(() =>
      SchemaOrMigrationChangeRule.parse({}),
    ),
    security_sensitive_path: SecuritySensitivePathRule.default(() =>
      SecuritySensitivePathRule.parse({}),
    ),
    perf_critical_path: PerfCriticalPathRule.default(() =>
      PerfCriticalPathRule.parse({}),
    ),
    existing_test_coverage_below_threshold:
      ExistingTestCoverageRule.default(() =>
        ExistingTestCoverageRule.parse({}),
      ),
    metric_runner_unavailable: MetricRunnerUnavailableRule.default(() =>
      MetricRunnerUnavailableRule.parse({}),
    ),
  })
  .strict();

export type InternalEscalationRules = z.infer<typeof InternalEscalationRules>;

/**
 * TCC-DUAL-TRACK — cross-slot priority + scout cron entry (phase 6a).
 *
 * `priority` selects the cross-slot fairness strategy that
 * `application/cross-slot-fairness.ts` applies when both intake and delivery
 * promotion candidates are ready in the same scheduler cycle. Default is
 * `delivery_first` per RGC-CROSS-SLOT-FAIRNESS.
 *
 * `refactor_scheduled_capacity` is the optional cap consulted by
 * `application/promotion-guard.ts` (RGC-PROMOTION-GUARD third row).
 *
 * `scout_scan` is a minimal schedule helper for the scout periodic scan
 * referenced by KAC-REFACTOR-BACKLOG / KAC-SLICE-TELEMETRY. Only the cadence
 * is recorded here; the actual trigger lives with phase 5c/6b.
 */
export const DualTrackPriority = z.enum([
  "delivery_first",
  "balanced",
  "discovery_first",
]);
export type DualTrackPriority = z.infer<typeof DualTrackPriority>;

export const ScoutScanSchedule = z
  .object({
    enabled: z.boolean().default(true),
    interval_seconds: z.number().int().positive().default(3600),
  })
  .strict();
export type ScoutScanSchedule = z.infer<typeof ScoutScanSchedule>;

export const DualTrack = z
  .object({
    priority: DualTrackPriority.default("delivery_first"),
    refactor_scheduled_capacity: z.number().int().nonnegative().nullable().default(null),
    scout_scan: ScoutScanSchedule.default(() => ScoutScanSchedule.parse({})),
  })
  .strict();
export type DualTrack = z.infer<typeof DualTrack>;

/**
 * TCC-IDENTITY `kind` distinguishes self-hosting (LLM-team is its own target)
 * from external operation. Self-hosting MUST run agent_cwd off-tree from the
 * controller workdir to keep operational writes (Inv #4) from contaminating
 * the controller process. The strict separation is enforced by
 * `application/agent-workspace.ts` — when `kind=self-hosting` and
 * `agent_cwd === workdir_path` we throw at config load.
 */
export const TargetKind = z.enum(["external", "self-hosting"]);
export type TargetKind = z.infer<typeof TargetKind>;

export const Identity = z
  .object({
    target_id: z.string().min(1),
    /**
     * external (default) — target is a separate codebase.
     * self-hosting — target is the LLM-team repo itself; agent_cwd ≠ workdir_path enforced.
     */
    kind: TargetKind.default("external"),
    /**
     * TCC-IDENTITY: abstract reference to the persistent store binding.
     * Mirrors the contract field of the same name. Concrete adapter URIs
     * (e.g. `fs:///path/to/workdir`) are resolved by the adapter, not this
     * schema.
     */
    persistent_store_ref: z.string().min(1).optional(),
    /** FS adapter hint when persistent_store_ref points at a local path. */
    workdir_path: z.string().min(1).optional(),
    /**
     * Agent worktrees / workspace root. When omitted, callers default to
     * `<workdir_path>/workspaces`. For self-hosting targets `agent_cwd`
     * MUST resolve outside `workdir_path` (enforced at config validation).
     */
    agent_cwd: z.string().min(1).optional(),
    audit_hash_seed: z.string().min(1).optional(),
    label_prefix: z.string().min(1).optional(),
  })
  .strict();

export type Identity = z.infer<typeof Identity>;

/**
 * TCC-ENFORCEMENT — invariant enforcement level table (phase 6b Stage 5).
 *
 * `always_hard` items block in every Stage. `stage_graded` items declare a
 * per-Stage mode (`warn` or `block`). Phase 6b reaches Stage 5: callers
 * resolve via `application/invariant-enforcement.ts` which forces every
 * `stage_graded` entry to `block` once `stage>=5`.
 */
export const EnforcementMode = z.enum(["warn", "block"]);
export type EnforcementMode = z.infer<typeof EnforcementMode>;

export const InvariantEnforcement = z
  .object({
    always_hard: z.array(z.string().min(1)).default(() => []),
    stage_graded: z.record(z.string().min(1), EnforcementMode).default(() => ({})),
  })
  .strict();
export type InvariantEnforcement = z.infer<typeof InvariantEnforcement>;

/**
 * TCC-CONTEXT-BUDGET — `(parent_loop, phase_or_purpose)` 쌍별 1-shot context
 * window hard cap (phase 8a, G2-1).
 *
 * Keys match the `parent_loop`/`phase_or_purpose` enum the AGC envelope
 * already carries (`docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`)
 * — `outer.{Discovery,Specification,Planning,Validation}`,
 * `middle.{review,merge}`, `inner.tdd_build`. The architecture default values
 * are reproduced verbatim from `target-config-contract.md#TCC-CONTEXT-BUDGET`
 * so target operators can omit keys they do not customize.
 *
 * `prompt-compose` reads the cap via `resolveContextBudget(...)` and applies
 * AGC-CONTEXT-BUDGET truncation priority (low fetch_scope → high) before the
 * 1-shot call. Persistent overflow surfaces as the AGC-INVALID reason
 * `context_budget_truncation` (`src/application/envelope.ts`).
 */
export const LoopStep = z.enum([
  "outer.Discovery",
  "outer.Specification",
  "outer.Planning",
  "outer.Validation",
  "middle.review",
  "middle.merge",
  "inner.tdd_build",
]);
export type LoopStep = z.infer<typeof LoopStep>;

export const ContextBudgetEntry = z
  .object({
    token_hard_cap: z.number().int().positive(),
    soft_warn_pct: z.number().min(0).max(1).optional(),
    /**
     * incident-10: per-(parent_loop, phase_or_purpose) wall-clock timeout for
     * the LlmRunner invocation, in seconds. When omitted, callers fall back
     * to `TIMEOUT_SEC_DEFAULTS[loop.step]` (see `resolveAgentTimeoutSec`),
     * then to the caller-supplied ultimate fallback (120s).
     *
     * Inner `tdd_build` defaults to 600s because an authoring forge may
     * legitimately run multi-minute red→green→refactor cycles inside a
     * single 1-shot — the previous 120s ceiling caused incident-10 (the
     * forge wrote a 138-line test file but the runner timed out before
     * envelope emit, looping the daemon on `lr_invoke/lr_exit_status`).
     */
    timeout_sec: z.number().int().positive().optional(),
  })
  .strict();
export type ContextBudgetEntry = z.infer<typeof ContextBudgetEntry>;

export const ContextBudget = z
  .record(LoopStep, ContextBudgetEntry)
  .default(() => ({}));
export type ContextBudget = z.infer<typeof ContextBudget>;

/**
 * Architecture defaults from `target-config-contract.md#TCC-CONTEXT-BUDGET`.
 * Provider limits are not fixed here; operators override per (loop, step).
 */
export const CONTEXT_BUDGET_DEFAULTS: Readonly<
  Record<LoopStep, ContextBudgetEntry>
> = Object.freeze({
  "outer.Discovery": { token_hard_cap: 256_000 },
  "outer.Specification": { token_hard_cap: 256_000 },
  "outer.Planning": { token_hard_cap: 256_000 },
  "outer.Validation": { token_hard_cap: 256_000 },
  "middle.review": { token_hard_cap: 192_000 },
  "middle.merge": { token_hard_cap: 128_000 },
  "inner.tdd_build": { token_hard_cap: 128_000 },
});

/**
 * Resolves the `(parent_loop, phase_or_purpose)` budget for a target. Returns
 * the operator override when present, falling back to the architecture
 * default. `null` is returned only when the (loop, step) pair is not a known
 * `LoopStep` — callers MUST treat that as a programmer error and refuse to
 * compose a prompt.
 */
export function resolveContextBudget(
  cfg: ContextBudget | undefined,
  parentLoop: string,
  phaseOrPurpose: string,
): ContextBudgetEntry | null {
  const key = `${parentLoop}.${phaseOrPurpose}`;
  const parsed = LoopStep.safeParse(key);
  if (!parsed.success) return null;
  const override = cfg?.[parsed.data];
  if (override != null) return override;
  return CONTEXT_BUDGET_DEFAULTS[parsed.data];
}

/**
 * incident-10: architecture defaults for per-phase LlmRunner wall-clock
 * timeouts (seconds). Outer phases run read-only analysis, middle review
 * runs evaluator agents, and inner `tdd_build` may legitimately cycle
 * red→green→refactor for several minutes inside a single 1-shot.
 */
export const TIMEOUT_SEC_DEFAULTS: Readonly<Record<LoopStep, number>> =
  Object.freeze({
    "outer.Discovery": 120,
    "outer.Specification": 120,
    "outer.Planning": 120,
    "outer.Validation": 120,
    "middle.review": 180,
    "middle.merge": 180,
    "inner.tdd_build": 600,
  });

/**
 * Resolves the LlmRunner timeout (seconds) for a `(parent_loop,
 * phase_or_purpose)` pair. Lookup order:
 *   1. Per-phase operator override at `cfg[loop.step].timeout_sec`
 *   2. Caller-supplied legacy `agentTimeoutSec` override (only when
 *      explicitly set — `undefined` skips this step). PR #110 review P1
 *      (qwen): keeping legacy operator overrides ahead of architecture
 *      defaults prevents `agentTimeoutSec: 30` from being silently
 *      shadowed by `TIMEOUT_SEC_DEFAULTS[loop.step]`.
 *   3. `TIMEOUT_SEC_DEFAULTS[loop.step]` (if `(loop, step)` is a known LoopStep)
 *   4. `120` as final last-resort fallback (mirrors the previous default).
 *
 * Unlike `resolveContextBudget`, this never returns null — an unknown
 * (loop, step) falls through to step 2/4. Callers are typically already
 * inside a `LoopStep`-typed branch, so this is defensive.
 */
export function resolveAgentTimeoutSec(
  cfg: ContextBudget | undefined,
  parentLoop: string,
  phaseOrPurpose: string,
  fallbackSec: number | undefined,
): number {
  const key = `${parentLoop}.${phaseOrPurpose}`;
  const parsed = LoopStep.safeParse(key);
  if (!parsed.success) return fallbackSec ?? 120;
  const override = cfg?.[parsed.data]?.timeout_sec;
  if (override != null && override > 0) return override;
  if (fallbackSec != null && fallbackSec > 0) return fallbackSec;
  const def = TIMEOUT_SEC_DEFAULTS[parsed.data];
  return def ?? 120;
}

/**
 * incident-10: operator-tunable retry caps for the inner `lr_invoke` failure
 * lane. Mirrors the existing `prompt_compose_truncation` limit shape but
 * lives in target.json (so operators can dial the cap without touching code).
 *
 * Only the inner timeout cap is exposed today — this block is a place to grow
 * additional retry caps as further incidents surface. All fields are optional
 * with sensible defaults provided by `failure-policy.ts DEFAULT_RETRY_CONFIG`.
 */
export const FailurePolicy = z
  .object({
    /**
     * Maximum consecutive `lr_invoke/lr_exit_status` (timeout) failures for an
     * inner session before it is ABANDONED. Default 5 — see
     * `failure-policy.ts DEFAULT_RETRY_CONFIG.innerLrInvokeTimeoutLimit`.
     */
    inner_lr_timeout_cap: z.number().int().positive().optional(),
  })
  .strict();
export type FailurePolicy = z.infer<typeof FailurePolicy>;

export const TargetConfig = z
  .object({
    identity: Identity,
    agent_profiles: z
      .object({
        atlas: ProfileCfg,
        forge: ProfileCfg,
        sentinel: ProfileCfg,
        scout: ProfileCfg,
      })
      .strict(),
    governance: Governance.optional(),
    lease: LeaseConfig.optional(),
    internal_escalation_rules: InternalEscalationRules.optional(),
    dual_track: DualTrack.optional(),
    invariant_enforcement: InvariantEnforcement.optional(),
    context_budget: ContextBudget.optional(),
    failure_policy: FailurePolicy.optional(),
  })
  .strict();

export type TargetConfig = z.infer<typeof TargetConfig>;

export function parseTargetConfig(raw: unknown): TargetConfig {
  return TargetConfig.parse(raw);
}
