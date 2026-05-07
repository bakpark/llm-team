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
});
