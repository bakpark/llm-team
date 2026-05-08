import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "../../src/adapters/store/fs.js";

describe("FsStore", () => {
  let workdir: string;
  let store: FsStore;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "llm-team-store-"));
    store = new FsStore({ workdir });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("readText returns null for missing files", async () => {
    expect(await store.readText("nope.json")).toBeNull();
  });

  it("writeAtomic + readText round-trips", async () => {
    await store.writeAtomic("milestones/m1.json", '{"x":1}');
    expect(await store.readText("milestones/m1.json")).toBe('{"x":1}');
  });

  it("writeAtomic creates intermediate dirs", async () => {
    await store.writeAtomic("a/b/c/d.json", "{}");
    expect(await store.exists("a/b/c/d.json")).toBe(true);
  });

  it("writeAtomic does not leave a partial tmp file behind on success", async () => {
    await store.writeAtomic("k.json", "ok");
    const entries = await store.list("");
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
  });

  it("appendLine writes one line per call with trailing newline", async () => {
    await store.appendLine("ledger/transitions.ndjson", '{"a":1}');
    await store.appendLine("ledger/transitions.ndjson", '{"a":2}');
    const body = await store.readText("ledger/transitions.ndjson");
    expect(body).toBe('{"a":1}\n{"a":2}\n');
  });

  it("appendLine adds newline only if missing", async () => {
    await store.appendLine("l.ndjson", "row1\n");
    await store.appendLine("l.ndjson", "row2");
    const body = await store.readText("l.ndjson");
    expect(body).toBe("row1\nrow2\n");
  });

  it("appendLine serializes concurrent appends without interleaving", async () => {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      tasks.push(store.appendLine("l.ndjson", `row-${i}`));
    }
    await Promise.all(tasks);
    const body = (await store.readText("l.ndjson")) ?? "";
    const lines = body.trimEnd().split("\n").sort();
    expect(lines.length).toBe(25);
    const expected = Array.from({ length: 25 }, (_, i) => `row-${i}`).sort();
    expect(lines).toEqual(expected);
  });

  it("list returns immediate entries only", async () => {
    await store.writeAtomic("d/a.json", "{}");
    await store.writeAtomic("d/sub/b.json", "{}");
    expect(await store.list("d")).toEqual(["a.json", "sub"]);
  });

  it("list returns [] for missing dir", async () => {
    expect(await store.list("missing")).toEqual([]);
  });

  it("rejects relPaths that escape workdir", async () => {
    await expect(store.readText("../escape")).rejects.toThrow();
    await expect(store.writeAtomic("/abs", "x")).rejects.toThrow();
  });

  it("writeAtomic overwrites prior content atomically", async () => {
    await store.writeAtomic("k.json", "v1");
    await store.writeAtomic("k.json", "v2");
    expect(await readFile(join(workdir, "k.json"), "utf8")).toBe("v2");
  });

  it("move atomically renames a file", async () => {
    await store.writeAtomic("src/a.json", "v1");
    await store.move("src/a.json", "dst/b.json");
    expect(await store.readText("src/a.json")).toBeNull();
    expect(await store.readText("dst/b.json")).toBe("v1");
  });

  it("move rejects when destination already exists", async () => {
    await store.writeAtomic("src/a.json", "v1");
    await store.writeAtomic("dst/b.json", "x");
    await expect(store.move("src/a.json", "dst/b.json")).rejects.toThrow();
  });

  it("withFileLock under heavy parallel acquisition (PR #65 P0-2 / P2-6 regression)", async () => {
    // 20 parallel acquirers must each get a strictly serialized turn
    // without losing critical-section state.
    let counter = 0;
    const tasks = Array.from({ length: 20 }, () =>
      store.withFileLock("k.json", async () => {
        const before = counter;
        await new Promise((r) => setImmediate(r));
        counter = before + 1;
      }),
    );
    await Promise.all(tasks);
    expect(counter).toBe(20);
  });

  it("orphaned lock is reclaimed within raceWindowMs (P2-6)", async () => {
    // Custom store with short raceWindowMs so the test runs quickly. The
    // production default is 1000ms; we use 50ms here to exercise the same
    // code path without a long sleep.
    const store2 = new FsStore({
      workdir,
      raceWindowMs: 50,
      staleLockMs: 60_000,
    });
    // Simulate a crashed acquirer: an empty lockdir with no keeper.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workdir, "orphan.json.lock"));
    // Wait past raceWindowMs so the next acquirer treats it as abandoned.
    await new Promise((r) => setTimeout(r, 80));
    const start = Date.now();
    let acquired = false;
    await store2.withFileLock("orphan.json", async () => {
      acquired = true;
    });
    expect(acquired).toBe(true);
    // Crucially: not waiting out the full 60s staleLockMs.
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
