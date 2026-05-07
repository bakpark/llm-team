import { describe, expect, it } from "vitest";
import { NdjsonLogger } from "../../src/adapters/logger/ndjson.js";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { FixedClock } from "../../src/ports/clock.js";

describe("NdjsonLogger", () => {
  it("emits one JSON line per log call with ts/level/event/fields", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(new Date("2026-05-07T00:00:00Z").getTime());
    const logger = new NdjsonLogger({ store, clock, relPath: "log/app.ndjson" });
    logger.log({
      level: "info",
      event: "lease.claim",
      fields: { kind: "turn_lease", ttl_ms: 60000 },
    });
    logger.log({ level: "warn", event: "stale" });
    await logger.flush();
    const body = (await store.readText("log/app.ndjson")) ?? "";
    const rows = body.trimEnd().split("\n").map((s) => JSON.parse(s));
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      ts: "2026-05-07T00:00:00.000Z",
      level: "info",
      event: "lease.claim",
      kind: "turn_lease",
      ttl_ms: 60000,
    });
    expect(rows[1]).toEqual({
      ts: "2026-05-07T00:00:00.000Z",
      level: "warn",
      event: "stale",
    });
  });

  it("preserves call order under concurrent writes (single-process FIFO)", async () => {
    const store = new MemoryStore();
    const clock = new FixedClock(0);
    const logger = new NdjsonLogger({ store, clock, relPath: "log.ndjson" });
    for (let i = 0; i < 10; i++) {
      logger.log({ level: "info", event: "tick", fields: { i } });
    }
    await logger.flush();
    const body = (await store.readText("log.ndjson")) ?? "";
    const rows = body.trimEnd().split("\n").map((s) => JSON.parse(s));
    expect(rows.map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
