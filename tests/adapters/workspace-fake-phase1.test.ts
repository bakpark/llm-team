import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";

function freshFake(): FakeWorkspace {
  const root = mkdtempSync(join(tmpdir(), "fake-ws-phase1-"));
  return new FakeWorkspace(root);
}

const SLICE_ID = "01HZS00000000000000000000A";

describe("FakeWorkspace — Phase 1 additive surface", () => {
  it("findCommitByTrailer matches seeded trailer", async () => {
    const ws = freshFake();
    ws.seedCommitTrailer("slice/abc", "sha-1", { "Idempotency-Key": "K1" });
    ws.seedCommitTrailer("slice/abc", "sha-2", { "Idempotency-Key": "K2" });
    const sha = await ws.findCommitByTrailer({
      branch: "slice/abc",
      trailerKey: "Idempotency-Key",
      value: "K1",
    });
    expect(sha).toBe("sha-1");
    expect(
      await ws.findCommitByTrailer({
        branch: "slice/abc",
        trailerKey: "Idempotency-Key",
        value: "MISS",
      }),
    ).toBeNull();
  });

  it("getRemoteHeadSha returns seeded value", async () => {
    const ws = freshFake();
    ws.seedRemoteHead("origin", "slice/abc", "deadbeef");
    expect(
      await ws.getRemoteHeadSha({ remote: "origin", branch: "slice/abc" }),
    ).toBe("deadbeef");
    expect(
      await ws.getRemoteHeadSha({ remote: "origin", branch: "missing" }),
    ).toBeNull();
  });

  it("resetHard updates head + counts call", async () => {
    const ws = freshFake();
    await ws.prepareInnerWorkspace({
      sliceId: SLICE_ID,
      trunkBaseRevision: "trunk-1",
    });
    await ws.commit({
      sliceId: SLICE_ID,
      message: "wip",
      files: [{ path: "a.txt", content: "x" }],
    });
    expect(ws.resetHardCount).toBe(0);
    await ws.resetHard({ sliceId: SLICE_ID, sha: "trunk-1" });
    expect(ws.resetHardCount).toBe(1);
    expect(await ws.head(SLICE_ID)).toBe("trunk-1");
  });

  it("cleanForce increments counter", async () => {
    const ws = freshFake();
    expect(ws.cleanForceCount).toBe(0);
    await ws.cleanForce({ sliceId: SLICE_ID });
    expect(ws.cleanForceCount).toBe(1);
  });
});
