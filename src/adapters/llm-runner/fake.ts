import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  LlmAdapterInput,
  LlmAdapterResult,
  LlmRunnerAdapter,
} from "./types.js";

// Fake adapter — fixture lookup with persisted sequence counter.
// Test-only. Stateful by design (intentional exception to ARC-ADAPTER-SUBSTITUTION;
// see docs/architecture/agent-runner-adapters.md §5).

export type FakeWrapPolicy = "auto" | "on" | "off";

export interface FakeAdapterCfg {
  fixtureDir: string;
  wrapFenced?: FakeWrapPolicy;
  seqStateDir?: string;
}

interface ExtractedHeader {
  agentProfileId: string;
  phaseOrPurpose: string;
  manifestId: string;
}

export class FakeAdapter implements LlmRunnerAdapter {
  readonly id = "fake" as const;

  constructor(private readonly cfg: FakeAdapterCfg) {}

  async run(input: LlmAdapterInput): Promise<LlmAdapterResult> {
    if (!existsSync(this.cfg.fixtureDir)) {
      return result(66, `fixtureDir not found: ${this.cfg.fixtureDir}`);
    }
    let header: ExtractedHeader;
    try {
      header = parseFrontmatterHeader(input.stdin);
    } catch (e) {
      return result(65, (e as Error).message);
    }

    const match = lookupFixture(this.cfg.fixtureDir, header);
    if (!match) {
      return result(
        67,
        `no fixture for profile='${header.agentProfileId}' purpose='${header.phaseOrPurpose}' manifest='${header.manifestId}' (dir=${this.cfg.fixtureDir})`,
      );
    }

    let contentPath = match.path;
    if (match.kind === "dir") {
      const seqDir = this.cfg.seqStateDir ?? join(this.cfg.fixtureDir, ".seq");
      const idx = nextSeqIndex(seqDir, match.path);
      contentPath = join(match.path, `${idx}.json`);
      if (!existsSync(contentPath)) {
        return result(
          67,
          `sequence fixture missing: ${contentPath} (call_index=${idx})`,
        );
      }
    }

    let content: string;
    try {
      content = readFileSync(contentPath, "utf8");
    } catch (e) {
      return result(67, `failed to read fixture: ${contentPath}: ${(e as Error).message}`);
    }

    content = substitutePlaceholders(content, header.manifestId, input.stdin);
    const stdout = applyWrapPolicy(content, this.cfg.wrapFenced ?? "auto");
    return {
      rawCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
    };
  }
}

function result(rawCode: number, stderr: string): LlmAdapterResult {
  return { rawCode, signal: null, timedOut: false, stdout: "", stderr };
}

function parseFrontmatterHeader(body: string): ExtractedHeader {
  if (!body.startsWith("---\n")) {
    throw new Error("frontmatter missing — expected leading '---'");
  }
  const fmEnd = body.indexOf("\n---\n", 4);
  if (fmEnd < 0) throw new Error("frontmatter missing closing '---'");
  const fm = body.slice(4, fmEnd);
  const map = new Map<string, string>();
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (m) map.set(m[1]!, stripQuotes(m[2]!));
  }
  const agentProfileId = map.get("agent_profile_id");
  const phaseOrPurpose = map.get("phase_or_purpose");
  const manifestId = map.get("manifest_id");
  if (!agentProfileId || !phaseOrPurpose || !manifestId) {
    throw new Error(
      `frontmatter missing required key(s): agent_profile_id='${agentProfileId ?? ""}' phase_or_purpose='${phaseOrPurpose ?? ""}' manifest_id='${manifestId ?? ""}'`,
    );
  }
  return { agentProfileId, phaseOrPurpose, manifestId };
}

function stripQuotes(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

interface FixtureMatch {
  path: string;
  kind: "file" | "dir";
}

function lookupFixture(
  dir: string,
  h: ExtractedHeader,
): FixtureMatch | null {
  const candidates: string[] = [
    join(dir, `${h.agentProfileId}-${h.phaseOrPurpose}-${h.manifestId}.json`),
    join(dir, `${h.agentProfileId}-${h.phaseOrPurpose}-${h.manifestId}`),
    join(dir, `${h.agentProfileId}-${h.phaseOrPurpose}.json`),
    join(dir, `${h.agentProfileId}-${h.phaseOrPurpose}`),
    join(dir, `${h.agentProfileId}.json`),
    join(dir, `${h.agentProfileId}`),
  ];
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    const st = statSync(cand);
    if (st.isFile()) return { path: cand, kind: "file" };
    if (st.isDirectory()) return { path: cand, kind: "dir" };
  }
  return null;
}

function safeKey(p: string): string {
  return p.replace(/[^A-Za-z0-9_-]/g, "_");
}

function nextSeqIndex(seqDir: string, fixturePath: string): number {
  if (!existsSync(seqDir)) mkdirSync(seqDir, { recursive: true });
  const file = join(seqDir, `${safeKey(fixturePath)}.json`);
  let count = 0;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { count?: number };
      if (typeof parsed.count === "number" && Number.isFinite(parsed.count)) {
        count = parsed.count;
      }
    } catch {
      count = 0;
    }
  }
  const next = count + 1;
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ count: next }), "utf8");
  renameSync(tmp, file);
  return count;
}

function substitutePlaceholders(
  content: string,
  manifestId: string,
  prompt: string,
): string {
  let out = content;
  if (out.includes("__MANIFEST_ID__")) {
    out = out.split("__MANIFEST_ID__").join(manifestId);
  }
  if (out.includes("__PIN__") || out.includes("__PIN_")) {
    const manifestJson = findManifestFencedBlock(prompt);
    if (manifestJson) {
      const entries = manifestJson.entries;
      if (Array.isArray(entries) && entries.length > 0) {
        const firstPin = entries[0]?.revision_pin;
        if (typeof firstPin === "string" && firstPin.length > 0) {
          out = out.split("__PIN__").join(firstPin);
        }
        for (const e of entries) {
          const oid = e?.object_id;
          const pin = e?.revision_pin;
          if (typeof oid === "string" && typeof pin === "string") {
            const ph = `__PIN_${oid}__`;
            if (out.includes(ph)) out = out.split(ph).join(pin);
          }
        }
      }
    }
  }
  return out;
}

function findManifestFencedBlock(
  prompt: string,
): { entries: Array<Record<string, unknown>> } | null {
  const re = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const body = m[1] ?? "";
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed && Array.isArray((parsed as { entries?: unknown }).entries)) {
        return parsed as { entries: Array<Record<string, unknown>> };
      }
    } catch {
      // continue scanning
    }
  }
  return null;
}

function applyWrapPolicy(content: string, mode: FakeWrapPolicy): string {
  switch (mode) {
    case "on":
      return `\`\`\`json\n${content}\n\`\`\`\n`;
    case "off":
      return content.endsWith("\n") ? content : `${content}\n`;
    case "auto":
    default: {
      if (/^\s*```/.test(content)) {
        return content.endsWith("\n") ? content : `${content}\n`;
      }
      try {
        JSON.parse(content);
        return `\`\`\`json\n${content}\n\`\`\`\n`;
      } catch {
        return content.endsWith("\n") ? content : `${content}\n`;
      }
    }
  }
}
