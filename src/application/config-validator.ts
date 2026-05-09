import { resolve } from "node:path";
import { ZodError } from "zod";
import { TargetConfig, parseTargetConfig } from "../config/target-schema.js";

export interface ConfigValidationError {
  path: string;
  message: string;
}

export interface ConfigValidationResult {
  ok: boolean;
  config?: TargetConfig;
  errors: ConfigValidationError[];
}

/**
 * Process-startup validator that produces field-level error messages.
 * Used by daemons before any side-effecting code runs.
 */
export function validateTargetConfig(raw: unknown): ConfigValidationResult {
  try {
    const config = parseTargetConfig(raw);
    // Self-hosting cross-field invariant: agent_cwd must escape workdir_path
    // so operational writes never collide with controller workdir state.
    if (
      config.identity.kind === "self-hosting" &&
      config.identity.workdir_path != null &&
      config.identity.agent_cwd != null
    ) {
      const wd = resolve(config.identity.workdir_path);
      const ac = resolve(config.identity.agent_cwd);
      if (ac === wd || ac.startsWith(`${wd}/`)) {
        return {
          ok: false,
          errors: [
            {
              path: "identity.agent_cwd",
              message:
                "self-hosting target requires agent_cwd to be outside workdir_path (controller / agent isolation, see worktree-pr-lifecycle §self-hosting)",
            },
          ],
        };
      }
    }
    return { ok: true, config, errors: [] };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        errors: err.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      };
    }
    return {
      ok: false,
      errors: [
        {
          path: "(root)",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

export class TargetConfigError extends Error {
  constructor(public readonly errors: ConfigValidationError[]) {
    super(
      `target config invalid:\n${errors
        .map((e) => `  - ${e.path}: ${e.message}`)
        .join("\n")}`,
    );
    this.name = "TargetConfigError";
  }
}

export function validateOrThrow(raw: unknown): TargetConfig {
  const result = validateTargetConfig(raw);
  if (!result.ok || result.config == null)
    throw new TargetConfigError(result.errors);
  return result.config;
}
