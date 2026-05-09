/**
 * Phase prod-5 — failure-path mock smoke.
 *
 * Default-pass. Drives the inner tdd_build harness with adapters that
 * surface each non-ok ExitStatus and asserts the runtime returns
 * `invalid_envelope` with the expected `lr_exit_status` reason. Covers:
 *
 *   - timeout         (rawCode=null, signal=SIGTERM, timedOut=true)
 *   - transport_error (rawCode=64)
 *   - malformed_output (rawCode=0, no fenced block)
 *
 * Each branch seeds a fresh sandbox via `createE2eRun`, asserts the inner
 * runner returns `kind === "invalid_envelope"` with reason
 * `lr_exit_status`, and confirms the cycle bundle / harness wiring did
 * not promote the slice past SLICE_BUILDING.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createE2eRun, runInnerTddBuild } from "../helpers/e2e-harness.js";
import { AdapterRunnerPort } from "../../src/adapters/llm-runner/runtime-port.js";
import { FsStore } from "../../src/adapters/store/fs.js";
import { layout } from "../../src/application/persistence-layout.js";
import { Slice } from "../../src/domain/schema/slice.js";
import type {
  LlmAdapterInput,
  LlmAdapterResult,
} from "../../src/adapters/llm-runner/types.js";

const SLICE_ID = "01HZS00000000000000000000A";
const MILESTONE_ID = "01HZM00000000000000000000A";
const ISO = "2026-05-10T00:00:00.000Z";

function seedSliceReady(workdir: string): void {
  const slice = Slice.parse({
    slice_id: SLICE_ID,
    milestone_id: MILESTONE_ID,
    slice_kind: "internal",
    value_statement: "add() function",
    ac_ids: ["AC-1"],
    acceptance_tests: [{ path: "tests/add.test.ts", name: "add", ac_id: "AC-1" }],
    declared_scope: ["src/add.ts", "tests/add.test.ts"],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "trunk-base",
    dod_revision_pin: "dod-pin",
    state: "SLICE_READY",
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  });
  mkdirSync(join(workdir, "slices"), { recursive: true });
  writeFileSync(join(workdir, layout.slice(SLICE_ID)), JSON.stringify(slice), "utf8");
}

class StaticAdapter {
  readonly id = "fake" as const;
  constructor(private readonly result: LlmAdapterResult) {}
  async run(_input: LlmAdapterInput): Promise<LlmAdapterResult> {
    void _input;
    return this.result;
  }
}

async function driveFailure(adapterResult: LlmAdapterResult) {
  const handle = createE2eRun();
  try {
    seedSliceReady(handle.workdir);
    const llmRunner = new AdapterRunnerPort(new StaticAdapter(adapterResult));
    const outcome = await runInnerTddBuild({ handle, llmRunner });
    const store = new FsStore({ workdir: handle.workdir });
    const sliceRaw = await store.readText(layout.slice(SLICE_ID));
    const slice = sliceRaw == null ? null : Slice.parse(JSON.parse(sliceRaw));
    return { outcome, slice };
  } finally {
    handle.cleanup();
  }
}

describe("Phase prod-5 — failure-paths mock smoke (default-pass)", () => {
  it("timeout adapter result drives invalid_envelope (lr_exit_status)", async () => {
    const { outcome, slice } = await driveFailure({
      rawCode: null,
      signal: "SIGTERM" as NodeJS.Signals,
      timedOut: true,
      stdout: "",
      stderr: "self-killed",
    });
    expect(outcome.kind).toBe("invalid_envelope");
    if (outcome.kind !== "invalid_envelope") return;
    expect(outcome.reason).toBe("lr_exit_status");
    // Slice must remain in a pre-review state — invalid_envelope cannot
    // promote SLICE_READY → SLICE_REVIEWING.
    expect(slice?.state).not.toBe("SLICE_REVIEWING");
  });

  it("transport_error adapter result drives invalid_envelope", async () => {
    const { outcome, slice } = await driveFailure({
      rawCode: 64,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "401 unauthorized",
    });
    expect(outcome.kind).toBe("invalid_envelope");
    if (outcome.kind !== "invalid_envelope") return;
    expect(outcome.reason).toBe("lr_exit_status");
    expect(outcome.detail).toMatch(/transport_error/);
    expect(slice?.state).not.toBe("SLICE_REVIEWING");
  });

  it("malformed_output (rawCode=0 no fenced block) drives invalid_envelope", async () => {
    const { outcome, slice } = await driveFailure({
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout: "no fenced block here",
      stderr: "",
    });
    expect(outcome.kind).toBe("invalid_envelope");
    if (outcome.kind !== "invalid_envelope") return;
    expect(outcome.reason).toBe("lr_exit_status");
    expect(outcome.detail).toMatch(/malformed_output/);
    expect(slice?.state).not.toBe("SLICE_REVIEWING");
  });
});
