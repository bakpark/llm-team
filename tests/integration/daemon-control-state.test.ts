/**
 * Phase 7b (G1-4) — daemon prelude wiring + control-state gate.
 *
 * Asserts the planning §검증 trio:
 *   (a) pause signal drop + next loop emits a noop ledger row + outcome
 *   (b) resume signal restores normal pickup
 *   (c) stop signal triggers graceful shutdown + lockdir release
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsStore } from "../../src/adapters/store/fs.js";
import { daemonMain } from "../../src/cli/daemon.js";
import {
  applyControlSignal,
  readControlState,
} from "../../src/application/control-state.js";
import {
  dropSignal,
  runHumanSignalDrain,
} from "../../src/application/human-signal-drain.js";
import { LEDGER_TRANSITIONS_PATH } from "../../src/application/persistence-layout.js";
import {
  HumanSignalEnvelope,
  type HumanSignalEnvelope as HumanSignalEnvelopeT,
} from "../../src/domain/schema/human-signal.js";
import { LedgerRow } from "../../src/domain/schema/ledger.js";
import { FixedClock } from "../../src/ports/clock.js";
import { FsHumanSignal } from "../../src/adapters/human-signal/fs.js";

const TARGET_ID = "demo-target";

function writeTarget(workdir: string): string {
  const target = {
    identity: {
      target_id: TARGET_ID,
      workdir_path: workdir,
      audit_hash_seed: "seed-7b",
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

function controlSignal(
  partial: Partial<HumanSignalEnvelopeT> & {
    signal_id: string;
    signal_type: "pause" | "resume" | "stop";
  },
): HumanSignalEnvelopeT {
  return HumanSignalEnvelope.parse({
    target_kind: "system",
    target_id: "system",
    actor: "operator",
    created_at: "2026-05-09T00:00:00.000Z",
    source: "fs_drop",
    ...partial,
  });
}

async function readLedgerRows(store: FsStore): Promise<LedgerRow[]> {
  const body = await store.readText(LEDGER_TRANSITIONS_PATH);
  if (body == null) return [];
  return body
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => LedgerRow.parse(JSON.parse(s)));
}

describe("Phase 7b — daemon control-state prelude gate", () => {
  let prevAllowFake: string | undefined;
  let prevFixtureDir: string | undefined;
  let prevMachineSecret: string | undefined;

  beforeEach(() => {
    prevAllowFake = process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    prevFixtureDir = process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    prevMachineSecret = process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = "1";
    // Phase 5 (audit §5-D): daemon boots fail-loud without the machine-block
    // secret. Tests opt in with a deterministic placeholder.
    process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = "test-machine-block-secret";
  });

  afterEach(() => {
    if (prevAllowFake == null) delete process.env.LLM_TEAM_ALLOW_FAKE_RUNNER;
    else process.env.LLM_TEAM_ALLOW_FAKE_RUNNER = prevAllowFake;
    if (prevFixtureDir == null) delete process.env.LLM_TEAM_FAKE_FIXTURE_DIR;
    else process.env.LLM_TEAM_FAKE_FIXTURE_DIR = prevFixtureDir;
    if (prevMachineSecret == null)
      delete process.env.LLM_TEAM_MACHINE_BLOCK_SECRET;
    else process.env.LLM_TEAM_MACHINE_BLOCK_SECRET = prevMachineSecret;
  });

  it("(a) pause signal drop → next pickup emits noop outcome + pause_resume ledger row", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7b-pause-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7b-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir);

    // Drop a pause signal BEFORE the daemon starts so its drain sees it.
    const store = new FsStore({ workdir });
    await dropSignal(
      store,
      controlSignal({ signal_id: "sig-pause-1", signal_type: "pause" }),
    );

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase7b-tw",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);

    const lines = cap.lines();
    const last = lines.at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: { kind: string; detail?: string };
    };
    expect(parsed.role).toBe("turn-worker");
    expect(parsed.outcome.kind).toBe("noop");
    expect(parsed.outcome.detail).toBe("paused");

    // Ledger contains a pause_resume row.
    const rows = await readLedgerRows(store);
    const pauseRows = rows.filter((r) => r.action_kind === "pause_resume");
    expect(pauseRows.length).toBeGreaterThan(0);
    expect(pauseRows[0]?.to_state).toBe("PAUSED");
  });

  it("(b) resume signal restores normal pickup", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7b-resume-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7b-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir);

    // Pre-set the state to PAUSED via a direct apply, then drop the resume
    // signal. The daemon's drain will pick it up and revert to RUNNING
    // before the prelude gate runs.
    const store = new FsStore({ workdir });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-pause-pre", signal_type: "pause" }),
    );
    expect((await readControlState(store, clock)).state).toBe("PAUSED");

    await dropSignal(
      store,
      controlSignal({
        signal_id: "sig-resume-1",
        signal_type: "resume",
        created_at: "2026-05-09T00:01:00.000Z",
      }),
    );

    const cap = captureStdout();
    try {
      const code = await daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--once",
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase7b-tw",
      ]);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: { kind: string; detail?: string };
    };
    // After resume, the pickup proceeds — empty store yields a real `noop`
    // outcome from turn-worker (not the paused detail).
    expect(parsed.outcome.kind).toBe("noop");
    expect(parsed.outcome.detail).not.toBe("paused");
    // State.json now back to RUNNING.
    expect((await readControlState(store, clock)).state).toBe("RUNNING");
  });

  it("(c) stop signal → graceful daemon shutdown + lockdir released", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7b-stop-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7b-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir);

    const store = new FsStore({ workdir });
    await dropSignal(
      store,
      controlSignal({ signal_id: "sig-stop-1", signal_type: "stop" }),
    );

    const cap = captureStdout();
    let code: number;
    try {
      code = await daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        // Note: no --once. The stop signal must end the loop on its own.
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase7b-tw",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);

    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      role: string;
      outcome: { kind: string };
    };
    expect(parsed.outcome.kind).toBe("stopped");

    // Lockdir released (graceful shutdown).
    expect(existsSync(join(workdir, "log", "daemon-turn-worker.pid.lock"))).toBe(
      false,
    );
    // STOPPED is terminal — re-launching the daemon must continue to gate.
    expect(
      (await readControlState(store, new FixedClock(0))).state,
    ).toBe("STOPPED");
  });

  it("STOPPED persists across daemon launches (re-run still gates)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "phase7b-stop2-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "phase7b-fxt-"));
    process.env.LLM_TEAM_FAKE_FIXTURE_DIR = fixtureDir;
    const targetPath = writeTarget(workdir);
    const store = new FsStore({ workdir });
    const clock = new FixedClock(Date.parse("2026-05-09T00:00:00.000Z"));
    await applyControlSignal(
      store,
      clock,
      controlSignal({ signal_id: "sig-stop-pre", signal_type: "stop" }),
    );

    const cap = captureStdout();
    try {
      const code = await daemonMain([
        "--role",
        "turn-worker",
        "--target",
        targetPath,
        "--workdir",
        workdir,
        "--cycle-interval-ms",
        "0",
        "--fake-workspace",
        "--fake-verification",
        "--caller-id",
        "phase7b-tw",
      ]);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
    const last = cap.lines().at(-1) ?? "";
    const parsed = JSON.parse(last) as {
      outcome: { kind: string };
    };
    expect(parsed.outcome.kind).toBe("stopped");
  });
});
