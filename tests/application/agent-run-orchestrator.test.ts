import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkHeaderEcho,
  writePromptTmp,
  writePromptUnderWorkdir,
  type HeaderEchoFields,
} from "../../src/application/agent-run-orchestrator.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const MANIFEST_ID = "01HZMA0000000000000000000A";

function fields(overrides: Partial<HeaderEchoFields> = {}): HeaderEchoFields {
  return {
    session_id: SESSION_ID,
    turn_index: 0,
    parent_loop: "inner",
    phase_or_purpose: "tdd_build",
    agent_profile_id: "forge",
    agent_role_in_session: "lead",
    manifest_id: MANIFEST_ID,
    ...overrides,
  };
}

describe("agent-run-orchestrator (Phase 0.5 no-op extraction)", () => {
  describe("writePromptTmp", () => {
    it("writes the body under a fresh tmp dir and returns the absolute path", async () => {
      const path = await writePromptTmp(SESSION_ID, 7, "hello-prompt");
      expect(path.endsWith(`${SESSION_ID}-7.md`)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("hello-prompt");
    });
  });

  describe("writePromptUnderWorkdir", () => {
    it("writes to <workdir>/prompts/<sessionId>/<turnIndex>.md with mode 0o644", async () => {
      const workdir = mkdtempSync(join(tmpdir(), "workdir-"));
      const path = await writePromptUnderWorkdir(
        workdir,
        SESSION_ID,
        3,
        "body-3",
      );
      expect(path).toBe(join(workdir, "prompts", SESSION_ID, "3.md"));
      expect(readFileSync(path, "utf8")).toBe("body-3");
      // Mode pin matches writeAtomic — low 9 bits should be 0o644.
      expect(statSync(path).mode & 0o777).toBe(0o644);
    });

    it("is idempotent on (sessionId, turnIndex) — rewrites tolerated", async () => {
      const workdir = mkdtempSync(join(tmpdir(), "workdir-"));
      const a = await writePromptUnderWorkdir(workdir, SESSION_ID, 1, "v1");
      const b = await writePromptUnderWorkdir(workdir, SESSION_ID, 1, "v2");
      expect(a).toBe(b);
      expect(readFileSync(b, "utf8")).toBe("v2");
    });
  });

  describe("checkHeaderEcho", () => {
    it("returns null when all seven echo fields match", () => {
      expect(checkHeaderEcho(fields(), fields())).toBeNull();
    });

    it("reports a single mismatched field", () => {
      const out = checkHeaderEcho(fields(), fields({ turn_index: 1 }));
      expect(out).toBe("turn_index expected=0 got=1");
    });

    it("joins multiple mismatches with semicolons in field order", () => {
      const out = checkHeaderEcho(
        fields(),
        fields({ session_id: "OTHER", manifest_id: "OTHER_MID" }),
      );
      expect(out).toBe(
        `session_id expected=${SESSION_ID} got=OTHER; manifest_id expected=${MANIFEST_ID} got=OTHER_MID`,
      );
    });
  });
});
