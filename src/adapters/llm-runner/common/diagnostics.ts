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

export interface AttemptSlots {
  /** stdout file slot (raw adapter stdout, redacted at write boundary). */
  stdout: DiagnosticsSlot;
  /** stderr file slot (redacted at write boundary). */
  stderr: DiagnosticsSlot;
  /** Envelope slot — contract `envelopeRef`. Body is JSON or empty. */
  envelope: DiagnosticsSlot;
  /** Metadata slot — JSON metadata for the attempt. */
  metadata: DiagnosticsSlot;
}

/**
 * Open the four per-attempt files for a single adapter invocation.
 * All four share the same attempt suffix so they correlate 1-to-1 in the
 * diagnostics directory. Used by the executor to keep stdout, stderr,
 * envelope, and metadata distinct (planning §3 phase-prod-2).
 */
export async function openAttemptSlots(
  key: DiagnosticsKey,
): Promise<AttemptSlots> {
  const dir = diagDir();
  await ensureDir(dir);
  const base = `${safe(key.sessionId)}-${key.turnIndex}-${safe(key.idempotencyKey)}-${attemptSuffix()}`;
  return {
    stdout: makeSlot(join(dir, `${base}.stdout`)),
    stderr: makeSlot(join(dir, `${base}.stderr`)),
    envelope: makeSlot(join(dir, `${base}.envelope`)),
    metadata: makeSlot(join(dir, `${base}.metadata.json`)),
  };
}

export interface AttemptMetadata {
  rawExitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  consumedAt: string;
  reason?: string;
}
