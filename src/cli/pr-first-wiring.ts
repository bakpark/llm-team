/**
 * Phase 5 PR-first wiring (cli-spicy-anchor.md §1, audit §5-D).
 *
 * Audit P0-1 fixed here: the daemon entries used to construct zero
 * PR-first invokers/dispatchers/watchers; Phase 1-4 code therefore never
 * executed in production no matter how `target.json` was configured. This
 * module is a single seam where the daemon and runner CLI build the
 * invokers + helpers from a parsed `TargetConfig` so the wiring is testable
 * in isolation.
 *
 * Authority:
 *   - cli-spicy-anchor.md §1 (capability) + §11 (machine-block secret)
 *   - audit `docs/history/2026-05-12-pr-first-audit.md` §5-D
 *
 * Contract (kept narrow on purpose):
 *   - `resolvePrFirstSettings(cfg, env)` reads `experiments.*` toggles and
 *     `governance.*` wiring fields. The secret env var name defaults to
 *     `LLM_TEAM_MACHINE_BLOCK_SECRET`.
 *   - `requireMachineBlockSecretFromCfg(cfg, env)` is a thin wrapper that
 *     fails loud at daemon boot when the named env var is unset.
 *   - `buildPrFirstWiring(deps)` constructs `LeadInvoker`, `ReviewerInvoker`,
 *     `PrWatcher`, `PrFirstDispatcher`, `RecoveryCoordinator` from already-
 *     resolved deps. Only invokers the role consumes are instantiated by the
 *     caller (the helpers themselves are cheap, but selecting at the call-
 *     site keeps each daemon role focused).
 *
 * Default `experiments.{lead,reviewer}_pr_first === false` keeps the legacy
 * envelope path active until operators opt in.
 */
import { LeadInvoker } from "../application/lead-invoker.js";
import {
  MACHINE_BLOCK_SECRET_ENV_DEFAULT,
  requireMachineBlockSecret,
} from "../application/machine-block.js";
import { Outbox } from "../application/outbox.js";
import { PrFirstDispatcher } from "../application/caller-dispatch-prfirst.js";
import { PrWatcher } from "../application/pr-watcher.js";
import { RecoveryCoordinator } from "../application/recovery-coordinator.js";
import { ReviewerInvoker } from "../application/reviewer-invoker.js";
import { DroppedReviewSignalCache } from "../application/drift-observer.js";
import type { TargetConfig } from "../config/target-schema.js";
import type { ClockPort } from "../ports/clock.js";
import type { GitHostPort } from "../ports/git-host.js";
import type { LlmRunnerPort } from "../ports/llm-runner.js";
import type { StorePort } from "../ports/store.js";
import type { VerificationPort } from "../ports/verification.js";
import type { WorkspacePort } from "../ports/workspace.js";
import type { LedgerAppender } from "../application/ledger.js";

const DEFAULT_KNOWN_AGENT_PROFILE_IDS: readonly string[] = [
  "atlas",
  "forge",
  "sentinel",
  "scout",
];

export interface PrFirstSettings {
  /** target.experiments.lead_pr_first ?? false. */
  leadPrFirst: boolean;
  /** target.experiments.reviewer_pr_first ?? false. */
  reviewerPrFirst: boolean;
  /** Env var name for the HMAC secret. Defaults to LLM_TEAM_MACHINE_BLOCK_SECRET. */
  machineBlockSecretEnvName: string;
  /** PR-watcher gate ④(a). When undefined the watcher only requires a non-empty author. */
  expectedBotAccount: string | undefined;
  /** PR-watcher gate ④(b). Defaults to the four built-in profiles. */
  knownAgentProfileIds: readonly string[];
}

/**
 * Read PR-first settings from `target.json`. Pure — no I/O, no env read.
 */
export function resolvePrFirstSettings(cfg: TargetConfig): PrFirstSettings {
  const gov = cfg.governance;
  const exp = cfg.experiments;
  return {
    leadPrFirst: exp?.lead_pr_first ?? false,
    reviewerPrFirst: exp?.reviewer_pr_first ?? false,
    machineBlockSecretEnvName:
      gov?.machine_block_secret_env_name ?? MACHINE_BLOCK_SECRET_ENV_DEFAULT,
    expectedBotAccount: gov?.bot_account,
    knownAgentProfileIds:
      gov?.known_agent_profile_ids ?? DEFAULT_KNOWN_AGENT_PROFILE_IDS,
  };
}

/**
 * Resolve + assert the machine-block HMAC secret. Thin wrapper around
 * `requireMachineBlockSecret` that lets the daemon entry pass the cfg-
 * derived env-var name.
 *
 * Throws when the env var is missing — fail-loud per audit §5-D DoD.
 */
export function requireMachineBlockSecretFromCfg(
  cfg: TargetConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const settings = resolvePrFirstSettings(cfg);
  return requireMachineBlockSecret(settings.machineBlockSecretEnvName, env);
}

export interface PrFirstWiringDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  llmRunner: LlmRunnerPort | null;
  workspace: WorkspacePort;
  gitHost: GitHostPort;
  verification: VerificationPort;
  callerId: string;
  targetId: string;
  machineBlockSecret: string;
  settings: PrFirstSettings;
  /** Trunk branch for lead PR open. */
  baseBranch?: string;
}

export interface PrFirstWiring {
  outbox: Outbox;
  leadInvoker: LeadInvoker | null;
  reviewerInvoker: ReviewerInvoker | null;
  prWatcher: PrWatcher;
  prFirstDispatcher: PrFirstDispatcher;
  recoveryCoordinator: RecoveryCoordinator;
  droppedSignalCache: DroppedReviewSignalCache;
}

/**
 * Construct the PR-first invoker/dispatcher/watcher graph from already-
 * resolved deps. The caller chooses which fields to consume per role.
 */
export function buildPrFirstWiring(deps: PrFirstWiringDeps): PrFirstWiring {
  const outbox = new Outbox({ store: deps.store, ledger: deps.ledger });
  const droppedSignalCache = new DroppedReviewSignalCache();

  // `llmRunner` is required for the invokers; recovery / watcher / dispatcher
  // do not need it. The recovery role omits llmRunner entirely (Phase 7a).
  const leadInvoker =
    deps.llmRunner != null
      ? new LeadInvoker(
          {
            callerId: deps.callerId,
            targetId: deps.targetId,
            baseBranch: deps.baseBranch ?? "main",
          },
          {
            store: deps.store,
            clock: deps.clock,
            llmRunner: deps.llmRunner,
            workspace: deps.workspace,
            gitHost: deps.gitHost,
            ledger: deps.ledger,
            machineBlockSecret: deps.machineBlockSecret,
            outbox,
          },
        )
      : null;

  const reviewerInvoker =
    deps.llmRunner != null
      ? new ReviewerInvoker(
          {
            callerId: deps.callerId,
            targetId: deps.targetId,
          },
          {
            store: deps.store,
            clock: deps.clock,
            llmRunner: deps.llmRunner,
            workspace: deps.workspace,
            gitHost: deps.gitHost,
            ledger: deps.ledger,
            machineBlockSecret: deps.machineBlockSecret,
            outbox,
          },
        )
      : null;

  const prWatcher = new PrWatcher(
    {
      callerId: deps.callerId,
      targetId: deps.targetId,
      machineBlockSecret: deps.machineBlockSecret,
      ...(deps.settings.expectedBotAccount != null
        ? { expectedBotAccount: deps.settings.expectedBotAccount }
        : {}),
      knownAgentProfileIds: deps.settings.knownAgentProfileIds,
    },
    {
      store: deps.store,
      clock: deps.clock,
      gitHost: deps.gitHost,
      ledger: deps.ledger,
      droppedSignalCache,
    },
  );

  const prFirstDispatcher = new PrFirstDispatcher(
    {
      callerId: deps.callerId,
      targetId: deps.targetId,
    },
    {
      store: deps.store,
      clock: deps.clock,
      gitHost: deps.gitHost,
      ledger: deps.ledger,
      outbox,
      workspace: deps.workspace,
      verification: deps.verification,
    },
  );

  // ProbeBuilder is wired by the recovery role after construction (the
  // probe needs role-specific port resolution). For non-recovery roles the
  // coordinator is built but unused; daemon roles that actually run a sweep
  // overwrite the buildProbe before calling `runOnce`.
  const recoveryCoordinator = new RecoveryCoordinator(
    {
      callerId: deps.callerId,
      targetId: deps.targetId,
    },
    {
      store: deps.store,
      clock: deps.clock,
      ledger: deps.ledger,
      outbox,
      buildProbe: async () => null,
    },
  );

  return {
    outbox,
    leadInvoker,
    reviewerInvoker,
    prWatcher,
    prFirstDispatcher,
    recoveryCoordinator,
    droppedSignalCache,
  };
}
