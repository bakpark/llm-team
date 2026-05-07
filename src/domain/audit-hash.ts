import { createHash } from "node:crypto";

export const AUDIT_HASH_GENESIS = "0".repeat(64);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint")
    throw new Error("audit-hash canonicalize: bigint not supported");
  if (t === "undefined" || t === "function" || t === "symbol")
    throw new Error(
      `audit-hash canonicalize: ${t} not supported in ledger payload`,
    );
  if (Array.isArray(value)) return value.map(canonicalize);
  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp
  ) {
    throw new Error(
      `audit-hash canonicalize: ${value.constructor.name} not supported — pre-serialize to ISO/string`,
    );
  }
  const obj = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    const name =
      (obj.constructor as { name?: string } | undefined)?.name ?? "unknown";
    throw new Error(
      `audit-hash canonicalize: only plain objects allowed (got ${name})`,
    );
  }
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
