/**
 * Phase 7c (G1-2) — drift-observer daemon role.
 *
 * Asserts the planning §검증 trio:
 *   (a) external (fs-mirror) drift on a Slice's tracker ref → next daemon
 *       cycle emits `external_observation` ledger row + outcome
 *       `{ kind: "swept", conflicts: 1 }`.
 *   (b) STOPPED control-state gate suppresses pickup (drift sweep does NOT
 *       run; `stopped` outcome instead). Confirms drift-observer reuses the
 *       phase-7b prelude.
 *   (c) sibling drift-observer daemons can not race — the second startup
 *       fails on the per-role lockdir.
 */
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsMirrorIssueTracker } from "../../src/adapters/issue-tracker/fs-mirror.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { daemonMain } from "../../src/cli/daemon.js";
import { applyControlSignal } from "../../src/application/control-state.js";
import { LEDGER_TRANSITIONS_PATH, layout } from "../../src/application/persistence-layout.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { HumanSignalEnvelope } from "../../src/domain/schema/human-signal.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { FixedClock } from "../../src/ports/clock.js";

const TARGET_ID = "demo-target";
const ISO_BASE = "2026-05-09T00:00:00.000Z";
const SLICE_ID = "01HZSA00000000000000000777";
const MILESTONE_ID = "01HZMS00000000000000000777";

function writeTarget(workdir: string): string {
  const target = {
    identity: {
      target_id: TARGET_ID,
      workdir_path: workdir,
      audit_hash_seed: "seed-7c",
    },
    agent_profiles: {
      atlas: { runner: "fake" },
      forge: { runner: "fake" },
      sentinel: { runner: "fake" },
      scout: { runner: "fake" },
    },
  };
  const path = join(workdir, "target.json");
  writeFileSync(path, JSON.stringify(target), "utf8");
  return path;
}

function captureStdout(): { restore: () => void; lines: () => string[] } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
  return {
    restore: () => {
      spy.mockRestore();
      void orig;
    },
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((s) => s.length > 0),
  };
}

async function readLedgerRows(store: FsStore): Promise<LedgerRow[]> {
  const body = await store.readText(LEDGER_TRANSITIONS_PATH);
  if (body == null) return [];
  return body
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => LedgerRow.parse(JSON.parse(s)));
}

async function persistSliceWithTrackerRef(
  store: FsStore,
  trackerId: string,
  initialRevision: string,
): Promise<void> {
  const sl = Slice.parse({
    slice_id: SLICE_ID,
    milestone_id: MILESTONE_ID,
    slice_kind: "feature",
    value_statement: "x",
    ac_ids: [],
    acceptance_tests: [],
    declared_scope: [],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "deadbeef",
    dod_revision_pin: "deadbeef",
    state: "SLICE_BUILDING",
    current_session_id: null,
    spawning_proposal_id: null,
    abandoned_reason: null,
    external_refs: [
      {
        provider: "fs-mirror",
        kind: "tracker",
        id: trackerId,
        sync_status: "synced",
        last_seen_external_revision: initialRevision,
        last_synced_internal_revision: "rev1",
      },
    ],
    created_at: ISO_BASE,
    updated_at: ISO_BASE,
  });
  await store.writeAtomic(layout.slice(SLICE_ID), JSON.stringify(sl, null, 2));
}

describe("Phase 7c — drift-observer daemon role", () => {
  let prevAllowFake: string | undefined;
  let prevMachineSecret: string | undefined;

  beforeEach(() => {
    prevAllowFake = process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    prevMachineSecret = process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = "1";
    // Phase 5 (audit §5-D): daemon boots fail-loud without the machine-block
    // secret. Tests opt in with a deterministic placeholder.
    process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = "test-machine-block-secret";
  });

  afterEach(() => {
    if (prevAllowFake == null) delete process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    else process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = prevAllowFake;
    if (prevMachineSecret == null)
      delete process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    else process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = prevMachineSecret;
  });

  it("(a) inbound drift on Slice tracker ref → external_observation ledger row + swept outcome", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7c-drift-"));
    const targetPath = writeTarget(workdir);
    const store = new FsStore({ workdir });

    const issueTracker = new FsMirrorIssueTracker(store);
    const issue = await issueTracker.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: ["slice-state/building"],
    });
    await persistSliceWithTrackerRef(store, issue.id, "1");
    // Out-of-band external mutation: a human edits labels via the tracker
    // (revision becomes 2). The daemon's drift sweep must catch this.
    await issueTracker.__externalMutate(issue, (s) => ({
      ...s,
      labels: [...s.labels, "manually-tagged"],
    }));

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "drift-observer",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--caller-id",
        "phase7c-do",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);

    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: { kind: string; conflicts?: number };
    };
    expect(parsed.role).toBe("drift-observer");
    expect(parsed.outcome.kind).toBe("swept");
    expect(parsed.outcome.conflicts).toBe(1);

    // Slice persisted with sync_status=conflict.
    const persisted = Slice.parse(
      JSON.parse((await store.readText(layout.slice(SLICE_ID)))!),
    );
    expect(persisted.external_refs[0]!.sync_status).toBe("conflict");

    // Ledger has external_observation row.
    const rows = await readLedgerRows(store);
    const obs = rows.filter((r) => r.action_kind === "external_observation");
    expect(obs.length).toBe(1);
    expect(obs[0]!.object_kind).toBe("slice");
    expect(obs[0]!.object_id).toBe(SLICE_ID);
    expect(obs[0]!.result).toBe("applied");
    expect(obs[0]!.result_detail).toBe("drift_revision_mismatch");
  });

  it("(b) STOPPED control-state suppresses drift sweep (prelude reused)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7c-stop-"));
    const targetPath = writeTarget(workdir);
    const store = new FsStore({ workdir });
    const clock = new FixedClock(Date.parse(ISO_BASE));

    // Pre-set STOPPED control-state. The drift-observer daemon's prelude
    // must short-circuit before the sweep runs.
    await applyControlSignal(
      store,
      clock,
      HumanSignalEnvelope.parse({
        signal_id: "sig-stop-1",
        signal_type: "stop",
        target_kind: "system",
        target_id: "system",
        actor: "operator",
        created_at: ISO_BASE,
        source: "fs_drop",
      }),
    );

    // Plant a drifting slice — this drift must NOT be picked up because the
    // daemon is STOPPED.
    const issueTracker = new FsMirrorIssueTracker(store);
    const issue = await issueTracker.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: [],
    });
    await persistSliceWithTrackerRef(store, issue.id, "1");
    await issueTracker.__externalMutate(issue, (s) => ({
      ...s,
      labels: ["edited"],
    }));

    const cap = captureStdout();
    try {
      const code = await daemonMain([
        "--role",
        "drift-observer",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        // No --once: STOPPED must end the loop on its own.
        "--cycle-interval-ms",
        "0",
        "--caller-id",
        "phase7c-do",
      ]);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as { outcome: { kind: string } };
    expect(parsed.outcome.kind).toBe("stopped");

    // Slice ref still synced — drift sweep was gated.
    const persisted = Slice.parse(
      JSON.parse((await store.readText(layout.slice(SLICE_ID)))!),
    );
    expect(persisted.external_refs[0]!.sync_status).toBe("synced");

    // No external_observation rows in the ledger.
    const rows = await readLedgerRows(store);
    expect(
      rows.filter((r) => r.action_kind === "external_observation").length,
    ).toBe(0);

    // Lockdir released on graceful shutdown.
    expect(
      existsSync(join(workdir, "log", "daemon-drift-observer.pid.lock")),
    ).toBe(false);
  });

  it("(c) sibling drift-observer daemon fails on per-role lockdir", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7c-lock-"));
    const targetPath = writeTarget(workdir);

    // Manually plant the lockdir as if a sibling daemon were running.
    const { mkdirSync } = await import("node:fs");
    const lockPath = join(workdir, "log", "daemon-drift-observer.pid.lock");
    mkdirSync(lockPath, { recursive: true });

    const cap = captureStdout();
    try {
      await expect(
        daemonMain([
          "--role",
          "drift-observer",
          "--target",
          targetPath,
          "--workdir",
          workdir,
          "--once",
          "--cycle-interval-ms",
          "0",
          "--caller-id",
          "phase7c-do",
        ]),
      ).rejects.toThrow(/another daemon role=drift-observer/);
    } finally {
      cap.restore();
    }
  });
});
