import { describe, expect, it } from "vitest";
import {
  computeReadySlices,
  topologicalOrder,
  validateSliceDag,
  type SliceLike,
} from "../../src/application/slice-dag.js";

const A = "01HZ1000000000000000000000";
const B = "01HZ2000000000000000000000";
const C = "01HZ3000000000000000000000";
const D = "01HZ4000000000000000000000";

function s(
  slice_id: string,
  deps: { slice_id: string; edge_type: "blocks" | "coordinates_with" }[] = [],
): SliceLike {
  return { slice_id, dependencies: deps };
}

describe("validateSliceDag", () => {
  it("accepts a linear blocks chain", () => {
    const r = validateSliceDag([
      s(A),
      s(B, [{ slice_id: A, edge_type: "blocks" }]),
      s(C, [{ slice_id: B, edge_type: "blocks" }]),
    ]);
    expect(r.ok).toBe(true);
  });

  it("accepts a coordinates_with parallel pair", () => {
    const r = validateSliceDag([
      s(A),
      s(B, [{ slice_id: A, edge_type: "coordinates_with" }]),
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejects a self-dependency", () => {
    const r = validateSliceDag([
      s(A, [{ slice_id: A, edge_type: "blocks" }]),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.kind).toBe("self_dependency");
    }
  });

  it("rejects a missing dependency", () => {
    const r = validateSliceDag([
      s(A, [{ slice_id: B, edge_type: "blocks" }]),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatchObject({
        kind: "missing_dependency",
        slice_id: A,
        missing_id: B,
      });
    }
  });

  it("detects a 2-cycle", () => {
    const r = validateSliceDag([
      s(A, [{ slice_id: B, edge_type: "blocks" }]),
      s(B, [{ slice_id: A, edge_type: "blocks" }]),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const cycleErr = r.errors.find((e) => e.kind === "cycle");
      expect(cycleErr).toBeDefined();
      if (cycleErr && cycleErr.kind === "cycle") {
        expect(new Set(cycleErr.cycle)).toEqual(new Set([A, B]));
      }
    }
  });

  it("detects a 3-cycle through coordinates_with", () => {
    // coordinates_with also counted as a graph edge for cycle purposes.
    const r = validateSliceDag([
      s(A, [{ slice_id: B, edge_type: "blocks" }]),
      s(B, [{ slice_id: C, edge_type: "coordinates_with" }]),
      s(C, [{ slice_id: A, edge_type: "blocks" }]),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.kind === "cycle")).toBe(true);
    }
  });

  it("rejects duplicate slice_id", () => {
    const r = validateSliceDag([s(A), s(A)]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.kind).toBe("duplicate_slice");
    }
  });
});

describe("topologicalOrder", () => {
  it("orders blocks chain", () => {
    const order = topologicalOrder([
      s(C, [{ slice_id: B, edge_type: "blocks" }]),
      s(B, [{ slice_id: A, edge_type: "blocks" }]),
      s(A),
    ]);
    expect(order).toEqual([A, B, C]);
  });

  it("ignores coordinates_with for ordering", () => {
    const order = topologicalOrder([
      s(A),
      s(B, [{ slice_id: A, edge_type: "coordinates_with" }]),
    ]);
    // Both have indeg=0 because coordinates_with isn't counted; both ready.
    expect(new Set(order)).toEqual(new Set([A, B]));
  });
});

describe("computeReadySlices (join condition)", () => {
  it("promotes pending to ready when all blocks deps validated", () => {
    const slices = [
      s(A),
      s(B, [{ slice_id: A, edge_type: "blocks" }]),
      s(C, [{ slice_id: A, edge_type: "blocks" }]),
    ];
    const states = new Map<string, string>([
      [A, "SLICE_VALIDATED"],
      [B, "SLICE_PENDING"],
      [C, "SLICE_PENDING"],
    ]);
    const ready = computeReadySlices({ slices, states });
    expect(new Set(ready)).toEqual(new Set([B, C]));
  });

  it("does not promote pending if blocks dep not validated", () => {
    const slices = [
      s(A),
      s(B, [{ slice_id: A, edge_type: "blocks" }]),
    ];
    const states = new Map<string, string>([
      [A, "SLICE_BUILDING"],
      [B, "SLICE_PENDING"],
    ]);
    expect(computeReadySlices({ slices, states })).toEqual([]);
  });

  it("ignores coordinates_with for join condition", () => {
    const slices = [
      s(A),
      s(B, [{ slice_id: A, edge_type: "coordinates_with" }]),
    ];
    const states = new Map<string, string>([
      [A, "SLICE_BUILDING"],
      [B, "SLICE_PENDING"],
    ]);
    expect(computeReadySlices({ slices, states })).toEqual([B]);
  });

  it("only considers SLICE_PENDING — not READY/BUILDING", () => {
    const slices = [s(A), s(B, [{ slice_id: A, edge_type: "blocks" }])];
    const states = new Map<string, string>([
      [A, "SLICE_VALIDATED"],
      [B, "SLICE_BUILDING"],
    ]);
    expect(computeReadySlices({ slices, states })).toEqual([]);
  });
});

describe("validateSliceDag — diamond DAG", () => {
  it("accepts a diamond (A→B, A→C, B→D, C→D)", () => {
    const r = validateSliceDag([
      s(A),
      s(B, [{ slice_id: A, edge_type: "blocks" }]),
      s(C, [{ slice_id: A, edge_type: "blocks" }]),
      s(D, [
        { slice_id: B, edge_type: "blocks" },
        { slice_id: C, edge_type: "blocks" },
      ]),
    ]);
    expect(r.ok).toBe(true);
  });
});
