import { describe, expect, it } from "vitest";
import {
  AUDIT_HASH_GENESIS,
  canonicalJson,
  computeAuditHash,
} from "../../src/domain/audit-hash.js";

describe("canonicalJson", () => {
  it("produces stable output regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("recursively sorts nested object keys", () => {
    const j = canonicalJson({ z: { y: 1, x: 2 }, a: [3, { c: 4, b: 5 }] });
    expect(j).toBe('{"a":[3,{"b":5,"c":4}],"z":{"x":2,"y":1}}');
  });
});

describe("computeAuditHash", () => {
  it("yields a deterministic 64-hex sha256 digest", () => {
    const h = computeAuditHash(AUDIT_HASH_GENESIS, { row: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when prevHash changes", () => {
    const a = computeAuditHash(AUDIT_HASH_GENESIS, { row: 1 });
    const b = computeAuditHash("a".repeat(64), { row: 1 });
    expect(a).not.toBe(b);
  });

  it("changes when row content changes", () => {
    const a = computeAuditHash(AUDIT_HASH_GENESIS, { row: 1 });
    const b = computeAuditHash(AUDIT_HASH_GENESIS, { row: 2 });
    expect(a).not.toBe(b);
  });

  it("invariant under key ordering of the row", () => {
    const a = computeAuditHash(AUDIT_HASH_GENESIS, { x: 1, y: 2 });
    const b = computeAuditHash(AUDIT_HASH_GENESIS, { y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("differs when seed is supplied", () => {
    const a = computeAuditHash(AUDIT_HASH_GENESIS, { row: 1 });
    const b = computeAuditHash(AUDIT_HASH_GENESIS, { row: 1 }, "seed-1");
    expect(a).not.toBe(b);
  });

  it("chains: hash(n) depends on hash(n-1)", () => {
    const h0 = AUDIT_HASH_GENESIS;
    const h1 = computeAuditHash(h0, { i: 1 });
    const h2 = computeAuditHash(h1, { i: 2 });
    const h2alt = computeAuditHash(h0, { i: 2 });
    expect(h2).not.toBe(h2alt);
  });

  it("rejects Date / Map / Set / RegExp / class instances (silent corruption guard)", () => {
    expect(() => canonicalJson(new Date())).toThrow(/Date/);
    expect(() => canonicalJson(new Map())).toThrow(/Map/);
    expect(() => canonicalJson(new Set())).toThrow(/Set/);
    expect(() => canonicalJson(/regex/)).toThrow(/RegExp/);
    class C {}
    expect(() => canonicalJson(new C())).toThrow(/plain objects/);
  });

  it("rejects bigint / undefined / function / symbol leaves", () => {
    expect(() => canonicalJson(BigInt(1) as unknown)).toThrow(/bigint/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ a: Symbol("x") })).toThrow(/symbol/);
  });
});
