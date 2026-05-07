import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";

const SLICE_ID = "01HZS00000000000000000000A";

describe("FakeWorkspace", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fakews-"));
  });
  afterEach(() => {
    // tmpdir entries are intentionally left behind for post-mortem debugging.
  });

  it("prepare → commit → head produces deterministic head differing from base", async () => {
    const ws = new FakeWorkspace(root);
    const prep = await ws.prepareInnerWorkspace({
      sliceId: SLICE_ID,
      trunkBaseRevision: "deadbeef",
    });
    expect(prep.headBefore).toBe("deadbeef");
    const c1 = await ws.commit({
      sliceId: SLICE_ID,
      message: "first",
      files: [{ path: "src/foo.ts", content: "export const x = 1;\n" }],
    });
    expect(c1.commit.length).toBeGreaterThan(0);
    expect(await ws.head(SLICE_ID)).toBe(c1.commit);
    const written = readFileSync(join(prep.agentCwd, "src/foo.ts"), "utf8");
    expect(written).toBe("export const x = 1;\n");
  });

  it("commit hash is deterministic for the same input sequence", async () => {
    const a = new FakeWorkspace(mkdtempSync(join(tmpdir(), "fakews-a-")));
    const b = new FakeWorkspace(mkdtempSync(join(tmpdir(), "fakews-b-")));
    for (const ws of [a, b]) {
      await ws.prepareInnerWorkspace({
        sliceId: SLICE_ID,
        trunkBaseRevision: "deadbeef",
      });
      await ws.commit({
        sliceId: SLICE_ID,
        message: "m",
        files: [{ path: "f.txt", content: "hello" }],
      });
    }
    expect(await a.head(SLICE_ID)).toBe(await b.head(SLICE_ID));
  });

  it("rejects absolute paths and traversal", async () => {
    const ws = new FakeWorkspace(root);
    await ws.prepareInnerWorkspace({
      sliceId: SLICE_ID,
      trunkBaseRevision: "x",
    });
    await expect(
      ws.commit({
        sliceId: SLICE_ID,
        message: "m",
        files: [{ path: "/etc/passwd", content: "x" }],
      }),
    ).rejects.toThrow(/absolute/);
    await expect(
      ws.commit({
        sliceId: SLICE_ID,
        message: "m",
        files: [{ path: "../escape.txt", content: "x" }],
      }),
    ).rejects.toThrow(/traversal/);
  });

  it("head() before prepare throws", async () => {
    const ws = new FakeWorkspace(root);
    await expect(ws.head(SLICE_ID)).rejects.toThrow(/no workspace prepared/);
  });
});
