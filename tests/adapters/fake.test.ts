import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapters/llm-runner/fake.js";
import { buildValidPrompt } from "../helpers/sample-prompt.js";

let dir: string;
let seqDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-fixture-"));
  seqDir = mkdtempSync(join(tmpdir(), "fake-seq-"));
});
afterEach(() => {
  // tmpdir cleanup is best-effort; vitest doesn't require teardown
});

describe("FakeAdapter lookup", () => {
  it("matches the most-specific fixture file", async () => {
    writeFileSync(join(dir, "atlas-discovery-m-001.json"), '{"a":1}');
    writeFileSync(join(dir, "atlas-discovery.json"), '{"a":2}');
    writeFileSync(join(dir, "atlas.json"), '{"a":3}');
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir });
    const r = await a.run({
      stdin: buildValidPrompt(),
      agentCwd: dir,
      timeoutSec: 0,
    });
    expect(r.rawCode).toBe(0);
    expect(r.stdout).toContain('"a":1');
  });

  it("falls back to profile-only fixture", async () => {
    writeFileSync(join(dir, "atlas.json"), '{"fallback":true}');
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir });
    const r = await a.run({
      stdin: buildValidPrompt({ phaseOrPurpose: "novel-purpose", manifestId: "novel-m" }),
      agentCwd: dir,
      timeoutSec: 0,
    });
    expect(r.rawCode).toBe(0);
    expect(r.stdout).toContain("fallback");
  });

  it("returns rawCode 67 when no fixture matches", async () => {
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir });
    const r = await a.run({
      stdin: buildValidPrompt(),
      agentCwd: dir,
      timeoutSec: 0,
    });
    expect(r.rawCode).toBe(67);
    expect(r.stderr).toContain("no fixture for");
  });

  it("walks sequence directory across calls (0.json, 1.json, ...)", async () => {
    const seqFixture = join(dir, "atlas-discovery-m-001");
    mkdirSync(seqFixture, { recursive: true });
    writeFileSync(join(seqFixture, "0.json"), '{"step":0}');
    writeFileSync(join(seqFixture, "1.json"), '{"step":1}');
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir });

    const first = await a.run({
      stdin: buildValidPrompt(),
      agentCwd: dir,
      timeoutSec: 0,
    });
    const second = await a.run({
      stdin: buildValidPrompt(),
      agentCwd: dir,
      timeoutSec: 0,
    });
    expect(first.stdout).toContain('"step":0');
    expect(second.stdout).toContain('"step":1');
  });

  it("substitutes __MANIFEST_ID__ and __PIN__ placeholders", async () => {
    writeFileSync(
      join(dir, "atlas.json"),
      JSON.stringify({ manifest_id: "__MANIFEST_ID__", pin: "__PIN__", named: "__PIN_obj-1__" }),
    );
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir });
    // Inject a manifest fenced block into the # Context section
    const prompt = buildValidPrompt({ manifestId: "m-zzz" }).replace(
      "본 turn 의 context 본문.",
      [
        "본 turn 의 context 본문.",
        "```json",
        JSON.stringify({
          entries: [
            { object_id: "obj-1", revision_pin: "rev-aaa" },
            { object_id: "obj-2", revision_pin: "rev-bbb" },
          ],
        }),
        "```",
      ].join("\n"),
    );
    const r = await a.run({ stdin: prompt, agentCwd: dir, timeoutSec: 0 });
    expect(r.rawCode).toBe(0);
    expect(r.stdout).toContain('"manifest_id":"m-zzz"');
    expect(r.stdout).toContain('"pin":"rev-aaa"');
    expect(r.stdout).toContain('"named":"rev-aaa"');
  });

  it("auto-wraps pure JSON in a fenced block", async () => {
    writeFileSync(join(dir, "atlas.json"), '{"x":1}');
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir, wrapFenced: "auto" });
    const r = await a.run({ stdin: buildValidPrompt(), agentCwd: dir, timeoutSec: 0 });
    expect(r.stdout).toMatch(/^```json/);
  });

  it("does not wrap when policy is off", async () => {
    writeFileSync(join(dir, "atlas.json"), '{"x":1}');
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir, wrapFenced: "off" });
    const r = await a.run({ stdin: buildValidPrompt(), agentCwd: dir, timeoutSec: 0 });
    expect(r.stdout).not.toMatch(/^```/);
  });

  it("returns rawCode 65 on missing required frontmatter keys", async () => {
    writeFileSync(join(dir, "atlas.json"), "{}");
    const a = new FakeAdapter({ fixtureDir: dir, seqStateDir: seqDir });
    const stdin = `---\nsession_id: s\n---\n\n# Context\n\n# Instruction\n\n# Output Schema\n`;
    const r = await a.run({ stdin, agentCwd: dir, timeoutSec: 0 });
    expect(r.rawCode).toBe(65);
  });

  it("returns rawCode 66 when fixtureDir is missing", async () => {
    const a = new FakeAdapter({
      fixtureDir: join(tmpdir(), "definitely-not-exist-123456"),
      seqStateDir: seqDir,
    });
    const r = await a.run({ stdin: buildValidPrompt(), agentCwd: dir, timeoutSec: 0 });
    expect(r.rawCode).toBe(66);
  });
});
