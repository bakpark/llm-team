/**
 * Phase 5 (audit §5-D, P0-1) — `target.json` schema additions + cfg →
 * settings resolver smoke.
 *
 * Covers:
 *   - `experiments.lead_pr_first` / `experiments.reviewer_pr_first` parse
 *     to booleans (default false when omitted).
 *   - `governance.machine_block_secret_env_name` parses to a string
 *     (default `LLM_TEAM_MACHINE_BLOCK_SECRET` when omitted).
 *   - `governance.bot_account` parses to an optional string.
 *   - `governance.known_agent_profile_ids` parses to an optional string
 *     array (default `["atlas","forge","sentinel","scout"]`).
 *   - `buildPrFirstWiring` constructs all five components (LeadInvoker,
 *     ReviewerInvoker, PrWatcher, PrFirstDispatcher, RecoveryCoordinator)
 *     when `llmRunner` is supplied, and skips the LLM-dependent invokers
 *     when `llmRunner` is null (recovery role parity).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FakeVerification } from "../../src/adapters/verification/fake.js";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { FileLedger } from "../../src/application/ledger.js";
import { validateOrThrow } from "../../src/application/config-validator.js";
import {
  buildPrFirstWiring,
  resolveMachineBlockSecretIfPrFirstEnabled,
  resolvePrFirstSettings,
} from "../../src/cli/pr-first-wiring.js";
import { MACHINE_BLOCK_SECRET_ENV_DEFAULT } from "../../src/application/machine-block.js";
import { SystemClock } from "../../src/ports/clock.js";

function targetWith(extras: Record<string, unknown>): unknown {
  return {
    identity: {
      target_id: "demo-target",
      workdir_path: "/tmp/x",
      audit_hash_seed: "seed",
    },
    agent_profiles: {
      atlas: { runner: "fake" },
      forge: { runner: "fake" },
      sentinel: { runner: "fake" },
      scout: { runner: "fake" },
    },
    ...extras,
  };
}

describe("Phase 5 — target.json schema (experiments + governance)", () => {
  it("(a) experiments omitted → lead_pr_first/reviewer_pr_first default false", () => {
    const cfg = validateOrThrow(targetWith({}));
    const settings = resolvePrFirstSettings(cfg);
    expect(settings.leadPrFirst).toBe(false);
    expect(settings.reviewerPrFirst).toBe(false);
  });

  it("(b) experiments.lead_pr_first=true / reviewer_pr_first=true round-trip", () => {
    const cfg = validateOrThrow(
      targetWith({
        experiments: { lead_pr_first: true, reviewer_pr_first: true },
      }),
    );
    const settings = resolvePrFirstSettings(cfg);
    expect(settings.leadPrFirst).toBe(true);
    expect(settings.reviewerPrFirst).toBe(true);
  });

  it("(c) governance.machine_block_secret_env_name overrides the default name", () => {
    const cfg = validateOrThrow(
      targetWith({
        governance: {
          human_team: "team-a",
          control_issue_number: 1,
          contract_change_issue_number: 2,
          machine_block_secret_env_name: "CUSTOM_SECRET",
        },
      }),
    );
    const settings = resolvePrFirstSettings(cfg);
    expect(settings.machineBlockSecretEnvName).toBe("CUSTOM_SECRET");
  });

  it("(d) default machine_block_secret_env_name = LLM_TEAM_MACHINE_BLOCK_SECRET", () => {
    const cfg = validateOrThrow(targetWith({}));
    const settings = resolvePrFirstSettings(cfg);
    expect(settings.machineBlockSecretEnvName).toBe(
      MACHINE_BLOCK_SECRET_ENV_DEFAULT,
    );
  });

  it("(e) governance.bot_account / known_agent_profile_ids round-trip", () => {
    const cfg = validateOrThrow(
      targetWith({
        governance: {
          human_team: "team-a",
          control_issue_number: 1,
          contract_change_issue_number: 2,
          bot_account: "llm-team-bot[bot]",
          known_agent_profile_ids: ["atlas", "sentinel"],
        },
      }),
    );
    const settings = resolvePrFirstSettings(cfg);
    expect(settings.expectedBotAccount).toBe("llm-team-bot[bot]");
    expect(settings.knownAgentProfileIds).toEqual(["atlas", "sentinel"]);
  });

  it("(f) default known_agent_profile_ids = atlas/forge/sentinel/scout", () => {
    const cfg = validateOrThrow(targetWith({}));
    const settings = resolvePrFirstSettings(cfg);
    expect(settings.knownAgentProfileIds).toEqual([
      "atlas",
      "forge",
      "sentinel",
      "scout",
    ]);
  });

  it("(g) bot_account omitted → expectedBotAccount === undefined (legacy permissive author)", () => {
    const cfg = validateOrThrow(targetWith({}));
    const settings = resolvePrFirstSettings(cfg);
    expect(settings.expectedBotAccount).toBeUndefined();
  });
});

describe("Phase 5 — buildPrFirstWiring", () => {
  function buildDeps(opts: { withLlm: boolean }) {
    const workdir = mkdtempSync(join(tmpdir(), "phase5-wiring-"));
    const store = new FsStore({ workdir });
    const clock = new SystemClock();
    const ledger = new FileLedger({ store });
    const cfg = validateOrThrow(
      targetWith({
        experiments: { lead_pr_first: true, reviewer_pr_first: true },
        governance: {
          human_team: "team-a",
          control_issue_number: 1,
          contract_change_issue_number: 2,
          bot_account: "llm-team-bot[bot]",
        },
      }),
    );
    return {
      cfg,
      deps: {
        store,
        clock,
        ledger,
        llmRunner: opts.withLlm
          ? ({} as unknown as Parameters<typeof buildPrFirstWiring>[0]["llmRunner"])
          : null,
        workspace: new FakeWorkspace(join(workdir, "ws")),
        gitHost: new FsMirrorGitHost(store),
        verification: new FakeVerification(clock),
        callerId: "phase5-test",
        targetId: cfg.identity.target_id,
        machineBlockSecret: "test-secret",
        settings: resolvePrFirstSettings(cfg),
      },
    };
  }

  it("(h) llmRunner supplied → LeadInvoker + ReviewerInvoker constructed", () => {
    const { deps } = buildDeps({ withLlm: true });
    const wiring = buildPrFirstWiring(deps);
    expect(wiring.leadInvoker).not.toBeNull();
    expect(wiring.reviewerInvoker).not.toBeNull();
    expect(wiring.prWatcher).toBeDefined();
    expect(wiring.prFirstDispatcher).toBeDefined();
    expect(wiring.recoveryCoordinator).toBeDefined();
    expect(wiring.outbox).toBeDefined();
    expect(wiring.droppedSignalCache).toBeDefined();
  });

  it("(i) llmRunner null (recovery role parity) → invokers null but watcher/dispatcher/recovery still built", () => {
    const { deps } = buildDeps({ withLlm: false });
    const wiring = buildPrFirstWiring(deps);
    expect(wiring.leadInvoker).toBeNull();
    expect(wiring.reviewerInvoker).toBeNull();
    expect(wiring.prWatcher).toBeDefined();
    expect(wiring.prFirstDispatcher).toBeDefined();
    expect(wiring.recoveryCoordinator).toBeDefined();
  });

  it("(j) PR #125 P1-1 — machineBlockSecret null + llmRunner non-null → invokers null (envelope-only deployment)", () => {
    const { deps } = buildDeps({ withLlm: true });
    const wiring = buildPrFirstWiring({ ...deps, machineBlockSecret: null });
    expect(wiring.leadInvoker).toBeNull();
    expect(wiring.reviewerInvoker).toBeNull();
    // Non-invoker components still build so recovery role parity works.
    expect(wiring.prWatcher).toBeDefined();
    expect(wiring.prFirstDispatcher).toBeDefined();
    expect(wiring.recoveryCoordinator).toBeDefined();
    expect(wiring.outbox).toBeDefined();
  });
});

describe("Phase 5 — resolveMachineBlockSecretIfPrFirstEnabled (PR #125 P1-1)", () => {
  const ENV_NAME = "LLM_TEAM_MACHINE_BLOCK_SECRET";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV_NAME];
  });
  afterEach(() => {
    if (prev == null) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = prev;
  });

  it("(k) both toggles off + secret unset → returns null (envelope-only deploy boots)", () => {
    delete process.env[ENV_NAME];
    const cfg = validateOrThrow(targetWith({}));
    expect(resolveMachineBlockSecretIfPrFirstEnabled(cfg, process.env)).toBeNull();
  });

  it("(l) lead_pr_first=true + secret unset → throws", () => {
    delete process.env[ENV_NAME];
    const cfg = validateOrThrow(
      targetWith({ experiments: { lead_pr_first: true } }),
    );
    expect(() =>
      resolveMachineBlockSecretIfPrFirstEnabled(cfg, process.env),
    ).toThrow(/LLM_TEAM_MACHINE_BLOCK_SECRET/);
  });

  it("(m) reviewer_pr_first=true + secret set → returns the secret", () => {
    const cfg = validateOrThrow(
      targetWith({ experiments: { reviewer_pr_first: true } }),
    );
    expect(
      resolveMachineBlockSecretIfPrFirstEnabled(cfg, {
        ...process.env,
        [ENV_NAME]: "live-secret",
      }),
    ).toBe("live-secret");
  });
});
