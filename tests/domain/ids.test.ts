import { describe, expect, it } from "vitest";
import { isUlid, newId, newMonotonicId } from "../../src/domain/ids.js";

describe("ids", () => {
  it("newId returns a 26-char Crockford base32 ULID", () => {
    const id = newId();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it("newMonotonicId is strictly increasing within the same millisecond", () => {
    const t = Date.now();
    const a = newMonotonicId(t);
    const b = newMonotonicId(t);
    const c = newMonotonicId(t);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("ULIDs from successive timestamps order lexicographically", () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_001_000);
    expect(a < b).toBe(true);
  });

  it("isUlid rejects malformed values", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("0".repeat(25))).toBe(false);
    expect(isUlid("I".repeat(26))).toBe(false); // I, L, O, U excluded
  });
});
