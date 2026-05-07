import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeWorkspace } from "../../src/adapters/workspace/fake.js";
import { prepareAgentWorkspace } from "../../src/application/agent-workspace.js";

const SLICE_ID = "01HZS00000000000000000000A";

describe("prepareAgentWorkspace", () => {
  it("inner forge lead → mutable inner workspace", async () => {
    const ws = new FakeWorkspace(mkdtempSync(join(tmpdir(), "agws-")));
    const handle = await prepareAgentWorkspace(
      {
        parentLoop: "inner",
        phaseOrPurpose: "tdd_build",
        agentRoleInSession: "lead",
        agentProfileId: "forge",
        sliceId: SLICE_ID,
        revision: "trunk-base",
      },
      ws,
    );
    expect(handle.mutable).toBe(true);
    expect(handle.headBefore).toBe("trunk-base");
  });

  it("middle review (sentinel lead) → read-only checkout", async () => {
    const ws = new FakeWorkspace(mkdtempSync(join(tmpdir(), "agws-")));
    const handle = await prepareAgentWorkspace(
      {
        parentLoop: "middle",
        phaseOrPurpose: "review",
        agentRoleInSession: "lead",
        agentProfileId: "sentinel",
        sliceId: SLICE_ID,
        revision: "abc123",
      },
      ws,
    );
    expect(handle.mutable).toBe(false);
    expect(handle.headBefore).toBe("abc123");
  });

  it("rejects unsupported combinations", async () => {
    const ws = new FakeWorkspace(mkdtempSync(join(tmpdir(), "agws-")));
    await expect(
      prepareAgentWorkspace(
        {
          parentLoop: "outer",
          phaseOrPurpose: "Discovery",
          agentRoleInSession: "lead",
          agentProfileId: "atlas",
          sliceId: SLICE_ID,
          revision: "x",
        },
        ws,
      ),
    ).rejects.toThrow(/unsupported combination/);
  });
});
