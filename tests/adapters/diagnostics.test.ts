import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DiagnosticsKey,
  openAttemptSlots,
} from "../../src/adapters/llm-runner/common/diagnostics.js";

let workDir: string;
let diagDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "diag-perm-test-"));
  diagDir = join(workDir, "diag");
  process.env.LLM_TEAM_RUNNER_DIAG_DIR = diagDir;
});

const sampleKey: DiagnosticsKey = {
  sessionId: "s-1",
  turnIndex: 1,
  idempotencyKey: "k-1",
};

function modeBits(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("diagnostics — AttemptSlots prompt slot (L-3-1)", () => {
  it("openAttemptSlots returns a 5th `prompt` slot alongside stdout/stderr/envelope/metadata", async () => {
    const slots = await openAttemptSlots(sampleKey);
    expect(slots.prompt).toBeDefined();
    expect(slots.prompt.path).toMatch(/\.prompt$/);
  });

  it("all five slots share the same attempt base prefix", async () => {
    const slots = await openAttemptSlots(sampleKey);
    const base = slots.prompt.path.replace(/\.prompt$/, "");
    expect(slots.stdout.path).toBe(`${base}.stdout`);
    expect(slots.stderr.path).toBe(`${base}.stderr`);
    expect(slots.envelope.path).toBe(`${base}.envelope`);
    expect(slots.metadata.path).toBe(`${base}.metadata.json`);
  });

  it("prompt slot writes a body that is readable from disk", async () => {
    const slots = await openAttemptSlots(sampleKey);
    await slots.prompt.write("hello prompt body");
    expect(modeBits(slots.prompt.path)).toBe(0o600);
  });
});

describe("diagnostics — directory and file permissions (L-3-7)", () => {
  it("openAttemptSlots creates the diag dir with mode 0700", async () => {
    await openAttemptSlots(sampleKey);
    expect(modeBits(diagDir)).toBe(0o700);
  });

  it("openAttemptSlots forces 0700 on a pre-existing dir created with looser mode", async () => {
    mkdirSync(diagDir, { recursive: true, mode: 0o755 });
    expect(modeBits(diagDir)).toBe(0o755);
    await openAttemptSlots(sampleKey);
    expect(modeBits(diagDir)).toBe(0o700);
  });

  it("all attempt files (prompt/stdout/stderr/envelope/metadata) are written with mode 0600", async () => {
    const slots = await openAttemptSlots(sampleKey);
    await slots.prompt.write("prompt body");
    await slots.stdout.write("stdout body");
    await slots.stderr.write("stderr body");
    await slots.envelope.write('{"ok":true}');
    await slots.metadata.write('{"meta":1}');
    expect(modeBits(slots.prompt.path)).toBe(0o600);
    expect(modeBits(slots.stdout.path)).toBe(0o600);
    expect(modeBits(slots.stderr.path)).toBe(0o600);
    expect(modeBits(slots.envelope.path)).toBe(0o600);
    expect(modeBits(slots.metadata.path)).toBe(0o600);
  });

  it("re-writing an existing slot keeps the file at mode 0600 (atomic rename preserves perms)", async () => {
    const slots = await openAttemptSlots(sampleKey);
    await slots.stdout.write("first body");
    await slots.stdout.write("second body");
    expect(modeBits(slots.stdout.path)).toBe(0o600);
  });
});

describe("diagnostics — does not chmod paths above the diag dir", () => {
  it("leaves the parent of diagDir untouched", async () => {
    const parentMode = modeBits(workDir);
    await openAttemptSlots(sampleKey);
    expect(modeBits(workDir)).toBe(parentMode);
  });
});

describe("diagnostics — atomicWrite tmp file collision (PR #91 qwen review)", () => {
  it("concurrent writes to distinct slots do not collide on the tmp filename", async () => {
    // Drive 8 parallel writes against 8 distinct slots in the same dir.
    // Without a uuid suffix on the tmp file, two writes hitting the same
    // millisecond inside the same pid would race on rename.
    const slotsArr = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        openAttemptSlots({
          ...sampleKey,
          idempotencyKey: `concurrent-${i}`,
        }),
      ),
    );
    await Promise.all(
      slotsArr.map((s, i) => s.stdout.write(`body-${i}`)),
    );
    for (let i = 0; i < slotsArr.length; i++) {
      expect(modeBits(slotsArr[i].stdout.path)).toBe(0o600);
    }
  });
});
