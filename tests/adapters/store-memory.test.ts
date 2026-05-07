import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";

describe("MemoryStore", () => {
  it("readText returns null when missing", async () => {
    const s = new MemoryStore();
    expect(await s.readText("x")).toBeNull();
  });

  it("writeAtomic + readText round-trips", async () => {
    const s = new MemoryStore();
    await s.writeAtomic("a.json", "1");
    expect(await s.readText("a.json")).toBe("1");
  });

  it("appendLine concatenates with newline", async () => {
    const s = new MemoryStore();
    await s.appendLine("l.ndjson", "a");
    await s.appendLine("l.ndjson", "b\n");
    expect(await s.readText("l.ndjson")).toBe("a\nb\n");
  });

  it("list returns immediate children of a dir prefix", async () => {
    const s = new MemoryStore();
    await s.writeAtomic("d/a.json", "{}");
    await s.writeAtomic("d/sub/b.json", "{}");
    expect(await s.list("d")).toEqual(["a.json", "sub"]);
  });
});
