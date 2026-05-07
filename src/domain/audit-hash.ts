import { createHash } from "node:crypto";

export const AUDIT_HASH_GENESIS = "0".repeat(64);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

export function computeAuditHash(
  prevHash: string,
  row: unknown,
  seed?: string,
): string {
  const h = createHash("sha256");
  if (seed != null && seed.length > 0) h.update(seed);
  h.update(prevHash);
  h.update(canonicalJson(row));
  return h.digest("hex");
}
