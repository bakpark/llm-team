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
  })
  .strict();

export type TargetConfig = z.infer<typeof TargetConfig>;

export function parseTargetConfig(raw: unknown): TargetConfig {
  return TargetConfig.parse(raw);
}
