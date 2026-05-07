import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "../../src/ports/clock.js";
import { SeededRandom, SystemRandom } from "../../src/ports/random.js";

describe("SystemClock", () => {
  it("returns a positive monotonic-ish ms timestamp and an ISO string", () => {
    const c = new SystemClock();
    expect(c.now()).toBeGreaterThan(0);
    expect(c.isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("FixedClock", () => {
  it("returns the configured millis and reflects advance/set", () => {
    const c = new FixedClock(1000);
    expect(c.now()).toBe(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
    c.set(2000);
    expect(c.now()).toBe(2000);
    expect(c.isoNow()).toBe(new Date(2000).toISOString());
  });
});

describe("SystemRandom", () => {
  it("emits hex of the requested byte length", () => {
    const r = new SystemRandom();
    expect(r.hex(16)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("SeededRandom", () => {
  it("is deterministic given the same seed", () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    expect(a.hex(8)).toBe(b.hex(8));
    expect(a.hex(4)).toBe(b.hex(4));
  });

  it("differs across seeds", () => {
    expect(new SeededRandom(1).hex(8)).not.toBe(new SeededRandom(2).hex(8));
  });
});
