/**
 * RGC-FAIRNESS within-scope scheduler fairness (oldest-ready-first).
 *
 * Pure helpers. Caller passes a list of ready candidates and gets back
 * either the head or a deterministic priority sort. The phase-4 daemon
 * uses these to break ties when multiple SLICE_READY slices or
 * SM_READY_FOR_REVIEW slice_merges compete for the same worker slot.
 *
 * Cross-slot fairness (delivery_first / balanced / discovery_first) lives in
 * `application/cross-slot-fairness.ts` (phase 6a) — within-scope is purely
 * "oldest first" with optional explicit priority overrides.
 */

export interface FairnessCandidate<T> {
  value: T;
  /** ISO8601. Older candidates win ties. */
  createdAt: string;
  /** Optional explicit priority (lower = higher priority). Default 0. */
  priority?: number;
}

/**
 * Returns the candidates sorted oldest-ready-first within priority groups.
 * Stable: equal (priority, createdAt) preserve original order.
 */
export function sortFairly<T>(
  candidates: readonly FairnessCandidate<T>[],
): FairnessCandidate<T>[] {
  return [...candidates]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = a.c.priority ?? 0;
      const pb = b.c.priority ?? 0;
      if (pa !== pb) return pa - pb;
      const ca = a.c.createdAt;
      const cb = b.c.createdAt;
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      return a.i - b.i;
    })
    .map((w) => w.c);
}

export function pickFairly<T>(
  candidates: readonly FairnessCandidate<T>[],
): FairnessCandidate<T> | null {
  if (candidates.length === 0) return null;
  return sortFairly(candidates)[0]!;
}
