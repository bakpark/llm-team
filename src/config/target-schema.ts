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

export const Identity = z
  .object({
    target_id: z.string().min(1),
    /**
     * TCC-IDENTITY: abstract reference to the persistent store binding.
     * Mirrors the contract field of the same name. Concrete adapter URIs
     * (e.g. `fs:///path/to/workdir`) are resolved by the adapter, not this
     * schema.
     */
    persistent_store_ref: z.string().min(1).optional(),
    /** FS adapter hint when persistent_store_ref points at a local path. */
    workdir_path: z.string().min(1).optional(),
    audit_hash_seed: z.string().min(1).optional(),
    label_prefix: z.string().min(1).optional(),
  })
  .strict();

export type Identity = z.infer<typeof Identity>;

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
  })
  .strict();

export type TargetConfig = z.infer<typeof TargetConfig>;

export function parseTargetConfig(raw: unknown): TargetConfig {
  return TargetConfig.parse(raw);
}
