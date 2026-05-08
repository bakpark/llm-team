/**
 * Phase 5a: feature_request_promote integration test.
 *
 * Validates: drop a feature_request file → use case promotes it to a
 * Milestone(M_INTAKE_QUEUED) + ledger row + idempotent re-run.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { CollectingLogger } from "../../src/ports/logger.js";
import { FixedClock } from "../../src/ports/clock.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import { runFeatureRequestIntake } from "../../src/application/feature-request-intake.js";
import { FeatureRequest } from "../../src/domain/schema/feature-request.js";
import { Milestone } from "../../src/domain/schema/milestone.js";

const ISO_BASE = "2026-05-08T00:00:00.000Z";
const REQ_A = "01HZFA0000000000000000000A";
const REQ_B = "01HZFB0000000000000000000B";

async function dropRequest(
  store: MemoryStore,
  request_id: string,
  submitted_at: string,
  title = "add feature",
): Promise<void> {
  const fr = FeatureRequest.parse({
    request_id,
    title,
    submitted_by: "alice",
    submitted_at,
    state: "queued",
  });
  await store.writeAtomic(
    layout.featureRequest(request_id),
    JSON.stringify(fr, null, 2),
  );
}

describe("feature_request_promote (Phase 5a)", () => {
  it("promotes a single queued request to M_INTAKE_QUEUED", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const logger = new CollectingLogger();
    const ledger = new FileLedger({ store, logger });

    await dropRequest(store, REQ_A, ISO_BASE);

    const out = await runFeatureRequestIntake({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "demo",
    });

    expect(out.kind).toBe("promoted");
    if (out.kind !== "promoted") return;

    // FeatureRequest record updated to promoted.
    const reread = FeatureRequest.parse(
      JSON.parse((await store.readText(layout.featureRequest(REQ_A)))!),
    );
    expect(reread.state).toBe("promoted");
    expect(reread.promoted_milestone_id).toBe(out.milestone_id);

    // Milestone created at M_INTAKE_QUEUED.
    const m = Milestone.parse(
      JSON.parse((await store.readText(layout.milestone(out.milestone_id)))!),
    );
    expect(m.state).toBe("M_INTAKE_QUEUED");
    expect(m.intake_source_kind).toBe("feature_request");
    expect(m.intake_source_id).toBe(REQ_A);

    // Ledger row appended.
    const ledgerLines = (await store.readText(LEDGER_TRANSITIONS_PATH))!
      .trim()
      .split("\n");
    expect(ledgerLines.length).toBe(1);
    const row = JSON.parse(ledgerLines[0]!);
    expect(row.action_kind).toBe("intake");
    expect(row.result).toBe("applied");
    expect(row.idempotency_key).toBe(`intake|feature_request|${REQ_A}`);
  });

  it("noop when no queued requests exist", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const logger = new CollectingLogger();
    const ledger = new FileLedger({ store, logger });

    const out = await runFeatureRequestIntake({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "demo",
    });

    expect(out.kind).toBe("noop");
  });

  it("picks oldest by submitted_at; second invocation gets the next", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const logger = new CollectingLogger();
    const ledger = new FileLedger({ store, logger });

    // B is older than A.
    await dropRequest(store, REQ_A, "2026-05-08T01:00:00.000Z", "newer");
    await dropRequest(store, REQ_B, "2026-05-08T00:30:00.000Z", "older");

    const first = await runFeatureRequestIntake({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "demo",
    });
    expect(first.kind).toBe("promoted");
    if (first.kind !== "promoted") return;
    expect(first.request_id).toBe(REQ_B);

    const second = await runFeatureRequestIntake({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "demo",
    });
    expect(second.kind).toBe("promoted");
    if (second.kind !== "promoted") return;
    expect(second.request_id).toBe(REQ_A);
  });

  it("idempotent: a record already in promoted state is skipped", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO_BASE));
    const logger = new CollectingLogger();
    const ledger = new FileLedger({ store, logger });

    // Pre-existing promoted record (e.g. left over from a prior cycle).
    const fr = FeatureRequest.parse({
      request_id: REQ_A,
      title: "x",
      submitted_by: "alice",
      submitted_at: ISO_BASE,
      state: "promoted",
      promoted_milestone_id: "01HZM00000000000000000000A",
      processed_at: ISO_BASE,
    });
    await store.writeAtomic(
      layout.featureRequest(REQ_A),
      JSON.stringify(fr, null, 2),
    );

    const out = await runFeatureRequestIntake({
      store,
      clock,
      ledger,
      callerId: "test-caller",
      targetId: "demo",
    });
    expect(out.kind).toBe("noop");
  });
});
