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

export const Governance = z
  .object({
    human_team: z.string().min(1),
    control_issue_number: z.number().int().positive(),
    contract_change_issue_number: z.number().int().positive(),
    signal_command_prefix: z.string().min(1).default("/"),
    human_team_cache_ttl_seconds: z.number().int().positive().default(300),
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
  })
  .strict();

export type TargetConfig = z.infer<typeof TargetConfig>;

export function parseTargetConfig(raw: unknown): TargetConfig {
  return TargetConfig.parse(raw);
}
