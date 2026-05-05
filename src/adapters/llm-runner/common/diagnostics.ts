import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DiagnosticsKey {
  sessionId: string;
  turnIndex: number;
  idempotencyKey: string;
}

export interface DiagnosticsSlot {
  path: string;
  write(body: string): Promise<void>;
}

function diagDir(): string {
  const fromEnv = process.env.LLM_TEAM_RUNNER_DIAG_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(tmpdir(), "llm-team", "runner");
}

function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9_.-]/g, "_");
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function atomicWrite(target: string, body: string): Promise<void> {
  // Same-directory mktemp + rename. If the target dir is on a single
  // filesystem (the default for os.tmpdir() on macOS/Linux), rename is
  // atomic. Cross-mount setups need operator review (verification step).
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, { encoding: "utf8" });
  await rename(tmp, target);
}

function makeSlot(path: string): DiagnosticsSlot {
  return {
    path,
    async write(body: string): Promise<void> {
      await atomicWrite(path, body);
    },
  };
}

// Per-attempt suffix — retries with the same idempotencyKey produce
// distinct filenames so prior call artifacts are never overwritten
// (the contract treats each retry as a separate transition).
function attemptSuffix(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export async function openDiagnosticsSlot(
  key: DiagnosticsKey,
): Promise<DiagnosticsSlot> {
  const dir = diagDir();
  await ensureDir(dir);
  const name = `${safe(key.sessionId)}-${key.turnIndex}-${safe(key.idempotencyKey)}-${attemptSuffix()}.stderr`;
  return makeSlot(join(dir, name));
}

export async function openEnvelopeSlot(
  key: DiagnosticsKey,
): Promise<DiagnosticsSlot> {
  const dir = diagDir();
  await ensureDir(dir);
  const name = `${safe(key.sessionId)}-${key.turnIndex}-${safe(key.idempotencyKey)}-${attemptSuffix()}.envelope`;
  return makeSlot(join(dir, name));
}
