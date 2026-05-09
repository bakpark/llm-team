import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import {
  FsMirrorTeamMembership,
  writeFsMirrorTeam,
  writeFsMirrorTeamUnreachable,
} from "../../src/adapters/team-membership/fs-mirror.js";

describe("FsMirrorTeamMembership", () => {
  it("returns member for actor present in allowlist", async () => {
    const store = new MemoryStore();
    await writeFsMirrorTeam(store, "acme/reviewers", ["alice", "bob"]);
    const port = new FsMirrorTeamMembership(store);
    const r = await port.isMember("acme/reviewers", "alice");
    expect(r.kind).toBe("member");
  });

  it("returns non_member for actor absent from allowlist", async () => {
    const store = new MemoryStore();
    await writeFsMirrorTeam(store, "acme/reviewers", ["alice"]);
    const port = new FsMirrorTeamMembership(store);
    const r = await port.isMember("acme/reviewers", "mallory");
    expect(r.kind).toBe("non_member");
  });

  it("returns unreachable when team file missing", async () => {
    const store = new MemoryStore();
    const port = new FsMirrorTeamMembership(store);
    const r = await port.isMember("acme/reviewers", "alice");
    expect(r.kind).toBe("unreachable");
  });

  it("returns unreachable when marker file present", async () => {
    const store = new MemoryStore();
    await writeFsMirrorTeam(store, "acme/reviewers", ["alice"]);
    await writeFsMirrorTeamUnreachable(store, "acme/reviewers");
    const port = new FsMirrorTeamMembership(store);
    const r = await port.isMember("acme/reviewers", "alice");
    expect(r.kind).toBe("unreachable");
  });

  it("returns unreachable on malformed JSON", async () => {
    const store = new MemoryStore();
    await store.writeAtomic(
      "external_mirror/teams/acme__reviewers.json",
      "not json",
    );
    const port = new FsMirrorTeamMembership(store);
    const r = await port.isMember("acme/reviewers", "alice");
    expect(r.kind).toBe("unreachable");
  });

  it("rejects empty inputs", async () => {
    const store = new MemoryStore();
    const port = new FsMirrorTeamMembership(store);
    await expect(port.isMember("", "alice")).rejects.toThrow();
    await expect(port.isMember("acme/team", "")).rejects.toThrow();
  });
});
