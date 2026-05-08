/**
 * Phase 5b.1: knowledge helpers — recordDecision + snapshotContextSummary.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import {
  recordDecision,
  snapshotContextSummary,
} from "../../src/application/knowledge.js";
import { layout } from "../../src/application/persistence-layout.js";
import { FixedClock } from "../../src/ports/clock.js";
import { ContextSummary, DecisionEntry } from "../../src/domain/schema/knowledge.js";

const ISO = "2026-05-08T00:00:00.000Z";
const M_ID = "01HZM00000000000000000000A";
const A = "01HZ1000000000000000000000";

describe("recordDecision", () => {
  it("writes a DecisionEntry with audit_hash", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO));
    const entry = await recordDecision(
      { store, clock },
      {
        decision_kind: "product_decision",
        decision: "single retry only",
        rationale: "infinite loop risk",
        affected_milestones: [M_ID],
      },
    );
    expect(entry.decision_kind).toBe("product_decision");
    expect(entry.audit_hash).toMatch(/^[0-9a-f]{64}$/);

    const reread = DecisionEntry.parse(
      JSON.parse((await store.readText(layout.decision(entry.decision_id)))!),
    );
    expect(reread).toEqual(entry);
  });
});

describe("snapshotContextSummary", () => {
  it("writes a ContextSummary with audit_hash + milestone-keyed path", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(Date.parse(ISO));
    const summary = await snapshotContextSummary(
      { store, clock },
      {
        milestone_id: M_ID,
        user_value: "users can add()",
        slices: [
          {
            slice_id: A,
            slice_kind: "feature",
            validated_revision: "v1",
            ac_ids: ["AC-1"],
          },
        ],
      },
    );
    expect(summary.user_value).toBe("users can add()");
    expect(summary.audit_hash).toMatch(/^[0-9a-f]{64}$/);

    const reread = ContextSummary.parse(
      JSON.parse((await store.readText(layout.contextSummary(M_ID)))!),
    );
    expect(reread).toEqual(summary);
  });
});
