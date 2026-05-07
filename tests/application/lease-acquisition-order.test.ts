import { describe, expect, it } from "vitest";
import {
  assertCanAcquire,
  checkCanAcquire,
  LeaseAcquisitionOrderError,
} from "../../src/application/lease-acquisition-order.js";

describe("assertCanAcquire (RGC-LEASE-KINDS outer→inner)", () => {
  it("allows claiming outer first when nothing held", () => {
    expect(() => assertCanAcquire([], "slot_lock")).not.toThrow();
    expect(() => assertCanAcquire([], "slice_lease")).not.toThrow();
    expect(() => assertCanAcquire([], "session_lease")).not.toThrow();
    expect(() => assertCanAcquire([], "turn_lease")).not.toThrow();
  });

  it("allows nested inner claims when outer is held", () => {
    expect(() => assertCanAcquire(["slot_lock"], "slice_lease")).not.toThrow();
    expect(() => assertCanAcquire(["slice_lease"], "session_lease")).not.toThrow();
    expect(() => assertCanAcquire(["session_lease"], "turn_lease")).not.toThrow();
    expect(() =>
      assertCanAcquire(["slot_lock", "slice_lease", "session_lease"], "turn_lease"),
    ).not.toThrow();
  });

  it("rejects upgrading outer while holding inner", () => {
    expect(() => assertCanAcquire(["slice_lease"], "slot_lock")).toThrow(
      LeaseAcquisitionOrderError,
    );
    expect(() => assertCanAcquire(["session_lease"], "slice_lease")).toThrow();
    expect(() => assertCanAcquire(["turn_lease"], "session_lease")).toThrow();
  });

  it("rejects re-claiming the same kind (kind is its own peer)", () => {
    // Claiming a second slice_lease while holding one is forbidden — different
    // slices are different objects but must be acquired in oldest-first order
    // and never nested.
    expect(() => assertCanAcquire(["slice_lease"], "slice_lease")).toThrow();
  });

  it("checkCanAcquire returns structured result instead of throwing", () => {
    expect(checkCanAcquire(["slice_lease"], "slot_lock")).toEqual({
      ok: false,
      held: ["slice_lease"],
      requested: "slot_lock",
    });
    expect(checkCanAcquire(["slice_lease"], "session_lease")).toEqual({
      ok: true,
    });
  });
});
