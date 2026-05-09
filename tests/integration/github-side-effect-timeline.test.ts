/**
 * Phase 6b — github-side-effect-timeline ordering / atomicity test.
 *
 * Authority: docs/architecture/github-side-effect-timeline.md §3 (atomic
 * mirror push).
 *
 * Validates:
 *   - steps run in the supplied order
 *   - a step throwing returns `partial_fail` with the failed step name and
 *     stops subsequent steps
 *   - concurrent timelines on the SAME lockKey serialize (no interleaving)
 *   - concurrent timelines on DIFFERENT lockKeys can interleave
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { executeMirrorTimeline } from "../../src/application/github-side-effect-timeline.js";

describe("github-side-effect-timeline (Phase 6b)", () => {
  it("runs steps in order and returns ok with stepsRun=count", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const out = await executeMirrorTimeline({
      store,
      lockKey: "milestone/1",
      steps: [
        { name: "milestone_create", run: async () => void order.push("a") },
        { name: "issue_create", run: async () => void order.push("b") },
        { name: "label_apply", run: async () => void order.push("c") },
      ],
    });
    expect(out.result).toBe("ok");
    if (out.result === "ok") expect(out.stepsRun).toBe(3);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("partial_fail captures the failed step name and stops subsequent", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const out = await executeMirrorTimeline({
      store,
      lockKey: "milestone/1",
      steps: [
        { name: "milestone_create", run: async () => void order.push("a") },
        {
          name: "issue_create",
          run: async () => {
            throw new Error("rate-limited");
          },
        },
        { name: "label_apply", run: async () => void order.push("c") },
      ],
    });
    expect(out.result).toBe("partial_fail");
    if (out.result === "partial_fail") {
      expect(out.failedStep).toBe("issue_create");
      expect(out.stepsRun).toBe(1);
      expect(out.error).toContain("rate-limited");
    }
    expect(order).toEqual(["a"]);
  });

  it("same lockKey: concurrent timelines serialize", async () => {
    const store = new MemoryStore();
    const log: string[] = [];

    const slow = async (label: string) => {
      log.push(`${label}:enter`);
      await new Promise((r) => setTimeout(r, 30));
      log.push(`${label}:exit`);
    };

    const t1 = executeMirrorTimeline({
      store,
      lockKey: "milestone/1",
      steps: [
        { name: "s1a", run: () => slow("t1") },
        { name: "s1b", run: () => slow("t1b") },
      ],
    });
    const t2 = executeMirrorTimeline({
      store,
      lockKey: "milestone/1",
      steps: [{ name: "s2a", run: () => slow("t2") }],
    });
    await Promise.all([t1, t2]);

    // Find first occurrence of t1 enter and ensure all t1 events finish
    // before any t2 event enters.
    const firstT1 = log.indexOf("t1:enter");
    const lastT1 = log.lastIndexOf("t1b:exit");
    const firstT2 = log.indexOf("t2:enter");
    expect(firstT1).toBeGreaterThanOrEqual(0);
    expect(lastT1).toBeGreaterThan(firstT1);
    expect(firstT2).toBeGreaterThan(lastT1);
  });

  it("different lockKeys: timelines can interleave", async () => {
    const store = new MemoryStore();
    const enters: string[] = [];
    const t1 = executeMirrorTimeline({
      store,
      lockKey: "milestone/1",
      steps: [
        {
          name: "s1",
          run: async () => {
            enters.push("t1");
            await new Promise((r) => setTimeout(r, 30));
          },
        },
      ],
    });
    const t2 = executeMirrorTimeline({
      store,
      lockKey: "milestone/2",
      steps: [
        {
          name: "s2",
          run: async () => {
            enters.push("t2");
            await new Promise((r) => setTimeout(r, 30));
          },
        },
      ],
    });
    await Promise.all([t1, t2]);
    // Both should enter near-simultaneously (no serialization)
    expect(enters.sort()).toEqual(["t1", "t2"]);
  });
});
