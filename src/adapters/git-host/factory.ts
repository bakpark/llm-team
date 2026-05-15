/**
 * Phase 6.0a — `GitHostPort` factory.
 *
 * The daemon previously hardcoded `FsMirrorGitHost` at every wire-up site
 * regardless of `cfg.governance.git_host_provider`. This module routes to
 * the right adapter based on the schema field (mirrors
 * `team-membership/factory.ts`):
 *
 *   provider="fs-mirror" (default) → FsMirrorGitHost(store)
 *   provider="github"             → GitHubGitHost({repo, exec, labelPrefix?})
 *
 * The default preserves backward compatibility: deployments / fixtures that
 * never set the field stay on the in-process mirror used by tests and
 * self-host smoke.
 *
 * `GhExec` is injected (defaults to `ProcessGhExec`) so integration tests
 * can substitute a deterministic stub instead of spawning the real `gh`
 * CLI. Schema cross-field validation (`config-validator` →
 * `target-schema.ts`) guarantees `git_host_repo` is present when
 * `provider="github"`; this factory asserts the same invariant defensively
 * so a hand-constructed `Governance` cannot bypass it.
 *
 * Statelessness contract: pure function — every call returns a fresh
 * adapter instance with no module-level cache. A `git_host_provider` /
 * `git_host_repo` change is only picked up after a daemon restart.
 */

import type { StorePort } from "../../ports/store.js";
import type { GitHostPort } from "../../ports/git-host.js";
import type { Governance } from "../../config/target-schema.js";
import type { GhExec } from "../issue-tracker/github.js";
import { ProcessGhExec } from "../team-membership/github.js";
import { FsMirrorGitHost } from "./fs-mirror.js";
import { GitHubGitHost } from "./github.js";

export interface BuildGitHostDeps {
  store: StorePort;
  /** Test-only override; production callers omit and use `ProcessGhExec`. */
  ghExec?: GhExec;
}

export function buildGitHost(
  governance: Governance | undefined,
  deps: BuildGitHostDeps,
): GitHostPort {
  const provider = governance?.git_host_provider ?? "fs-mirror";
  switch (provider) {
    case "fs-mirror":
      return new FsMirrorGitHost(deps.store);
    case "github": {
      const repo = governance?.git_host_repo;
      if (repo == null || repo.length === 0) {
        throw new Error(
          'git_host_repo ("<owner>/<name>") is required when git_host_provider="github"',
        );
      }
      return new GitHubGitHost({
        repo,
        exec: deps.ghExec ?? new ProcessGhExec(),
        labelPrefix: governance?.git_host_label_prefix,
      });
    }
    default: {
      // Exhaustive check — adding a new variant to `GitHostProvider` must
      // force this switch to be updated at compile time, otherwise the
      // factory would silently return `undefined` and every PR op would
      // crash with `TypeError`. Mirrors team-membership/factory.ts.
      const _exhaustive: never = provider;
      throw new Error(`unknown git_host_provider: ${String(_exhaustive)}`);
    }
  }
}
