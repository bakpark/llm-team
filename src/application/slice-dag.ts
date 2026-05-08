/**
 * SOC-SLICE-DEPENDENCIES — Planning phase 가 산출한 slice DAG 의 검증.
 *
 * - cycle 검사 (`blocks` + `coordinates_with` 모두 edge 로 간주 — Planning lead
 *   artifact 의 무결성 관점에서 둘 다 그래프의 일부)
 * - missing dependency 검사 (declare 된 slice_id 가 slices 리스트에 없으면 fail)
 * - join order: `blocks` 만 위상 정렬에 사용. `coordinates_with` 는 병렬 허용
 *   이므로 위상 순서에 영향 없음. join condition (`SLICE_PENDING → SLICE_READY`)
 *   은 `blocks` dependency 만 본다.
 *
 * 본 모듈은 순수 함수이며 store/ledger 에 의존하지 않는다 — Planning ensemble
 * 의 lead artifact validation 시 그리고 caller-dispatch 의 plan_accept 분기
 * 에서 호출된다.
 */
import type { Slice } from "../domain/schema/slice.js";

export type SliceLike = Pick<Slice, "slice_id" | "dependencies">;

export interface SliceDagOk {
  ok: true;
}

export interface SliceDagError {
  ok: false;
  errors: SliceDagIssue[];
}

export type SliceDagIssue =
  | {
      kind: "missing_dependency";
      slice_id: string;
      missing_id: string;
      edge_type: "blocks" | "coordinates_with";
    }
  | {
      kind: "self_dependency";
      slice_id: string;
      edge_type: "blocks" | "coordinates_with";
    }
  | {
      kind: "cycle";
      cycle: string[];
    }
  | {
      kind: "duplicate_slice";
      slice_id: string;
    };

export type SliceDagResult = SliceDagOk | SliceDagError;

export function validateSliceDag(slices: readonly SliceLike[]): SliceDagResult {
  const errors: SliceDagIssue[] = [];
  const ids = new Set<string>();
  for (const s of slices) {
    if (ids.has(s.slice_id)) {
      errors.push({ kind: "duplicate_slice", slice_id: s.slice_id });
    } else {
      ids.add(s.slice_id);
    }
  }

  for (const s of slices) {
    for (const dep of s.dependencies) {
      if (dep.slice_id === s.slice_id) {
        errors.push({
          kind: "self_dependency",
          slice_id: s.slice_id,
          edge_type: dep.edge_type,
        });
      } else if (!ids.has(dep.slice_id)) {
        errors.push({
          kind: "missing_dependency",
          slice_id: s.slice_id,
          missing_id: dep.slice_id,
          edge_type: dep.edge_type,
        });
      }
    }
  }

  // Cycle detection — DFS with three-color marking. Skip self-edges (already
  // reported) and missing edges to keep the cycle report clean.
  const adjacency = new Map<string, string[]>();
  for (const s of slices) adjacency.set(s.slice_id, []);
  for (const s of slices) {
    for (const dep of s.dependencies) {
      if (dep.slice_id === s.slice_id) continue;
      if (!ids.has(dep.slice_id)) continue;
      adjacency.get(s.slice_id)!.push(dep.slice_id);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);
  const stack: string[] = [];

  const reportedCycles = new Set<string>();
  function dfs(node: string): void {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next)!;
      if (c === GRAY) {
        const cycleStart = stack.indexOf(next);
        const cyclePath = stack.slice(cycleStart);
        const key = [...cyclePath].sort().join("|");
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          errors.push({ kind: "cycle", cycle: cyclePath });
        }
      } else if (c === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }
  for (const id of ids) {
    if (color.get(id) === WHITE) dfs(id);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * Topological order using only `blocks` edges (coordinates_with 는 병렬 허용).
 * 호출 전에 `validateSliceDag` 가 통과했음을 가정한다 — cycle / missing dep 가
 * 있으면 동작이 정의되지 않는다.
 */
export function topologicalOrder(slices: readonly SliceLike[]): string[] {
  const ids = new Set(slices.map((s) => s.slice_id));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    out.set(id, []);
  }
  for (const s of slices) {
    for (const dep of s.dependencies) {
      if (dep.edge_type !== "blocks") continue;
      if (!ids.has(dep.slice_id)) continue;
      // Edge: dep.slice_id -> s.slice_id (the dependency must finish first).
      out.get(dep.slice_id)!.push(s.slice_id);
      indeg.set(s.slice_id, indeg.get(s.slice_id)! + 1);
    }
  }
  const queue: string[] = [];
  // Stable order — iterate in input order so output is deterministic.
  for (const s of slices) {
    if (indeg.get(s.slice_id) === 0) queue.push(s.slice_id);
  }
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const next of out.get(id) ?? []) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return result;
}

/**
 * Compute the join-condition state: which slices are ready to transition
 * `SLICE_PENDING → SLICE_READY` given a snapshot of `(slice_id → state)`.
 * `blocks` dependency 가 모두 `SLICE_VALIDATED` 인 slice 만 ready.
 */
export function computeReadySlices(input: {
  slices: readonly SliceLike[];
  states: ReadonlyMap<string, string>;
}): string[] {
  const ready: string[] = [];
  for (const s of input.slices) {
    if (input.states.get(s.slice_id) !== "SLICE_PENDING") continue;
    let allValidated = true;
    for (const dep of s.dependencies) {
      if (dep.edge_type !== "blocks") continue;
      if (input.states.get(dep.slice_id) !== "SLICE_VALIDATED") {
        allValidated = false;
        break;
      }
    }
    if (allValidated) ready.push(s.slice_id);
  }
  return ready;
}
