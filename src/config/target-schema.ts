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
  .strict();

export type Governance = z.infer<typeof Governance>;

export const TargetConfig = z
  .object({
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
