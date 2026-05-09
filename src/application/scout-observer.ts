/**
 * Phase 5c — scout observer Validation evidence aggregation.
 *
 * KAC-CONTEXT-SUMMARY / SOC-OPERATIONS scout role consumer:
 *
 *   Validation 단계에서 milestone 의 모든 SLICE_VALIDATED slice 에 대해 그
 *   slice 의 SliceMerge.verification_run_id 를 따라 VerificationRun 을 모아
 *   다음을 합성한다:
 *
 *   - aggregated VerificationRun (`outer.validation.scout-aggregate`) —
 *     `evidence_only` + `verification_green` evidence 로 사용. 모든 hop 이
 *     `pass` 일 때만 `pass`, 하나라도 `fail`/`error` 면 `fail`.
 *   - derivedVerdict — `PASS` / `FAIL` / `STALE` (slices 가 0 개거나 어떤
 *     slice 에서 SliceMerge / VerificationRun 이 누락된 경우 `STALE`).
 *   - 새 ContextSummary slices 필드를 채울 `ContextSummarySliceRef[]`.
 *
 * Pure helper — store/clock 만 의존, gh / git / fs 직접 호출 없음. outer-turn
 * 에서 Validation 합성 단계에 호출되어 lead 의 milestone_package 결과를
 * scout 의 실 evidence 로 보강한다.
 *
 * lead-verdict guard (PR #69 P0-4) 보존: lead 가 명시적으로 FAIL/STALE 을
 * 낸 경우 scout aggregation 은 *evidence 만* 영속화하고 derivedVerdict 도
 * 계산하지만, outer-turn 의 finalize 경로는 lead 의 verdict 를 우선한다.
 */
import { newMonotonicId } from "../domain/ids.js";
import type { ContextSummarySliceRef } from "../domain/schema/knowledge.js";
import { Slice, type Slice as SliceT } from "../domain/schema/slice.js";
import { SliceMerge, type SliceMerge as SliceMergeT } from "../domain/schema/slice-merge.js";
import {
  VerificationRun,
  type VerificationRun as VerificationRunT,
} from "../domain/schema/verification.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { layout } from "./persistence-layout.js";

export type ScoutDerivedVerdict = "PASS" | "FAIL" | "STALE";

export interface ScoutEvidenceDeps {
  store: StorePort;
  clock: ClockPort;
  targetId: string;
}

export interface ScoutEvidenceInput {
  milestoneId: string;
}

/**
 * KAC-TRACEABILITY (phase 8c, plan §G2-2): per-AC traceability row joining
 * a declared slice AC-ID through its latest SliceMerge → VerificationRun
 * to a PASS / FAIL / MISSING verdict.
 *
 *   - PASS    : the slice's latest SM_MERGED VerificationRun is `pass` and
 *               its `covers_ac_ids` lists this AC.
 *   - FAIL    : the slice's latest SM_MERGED VerificationRun is `fail` /
 *               `error`, OR the slice's VR is pass but does not declare
 *               coverage for this AC (an explicit AC mapping gap from a
 *               passing slice is a Validation FAIL, not MISSING).
 *   - MISSING : the slice itself has no SM_MERGED SliceMerge yet, or the
 *               SliceMerge has no `verification_run_id`, or the VR file is
 *               missing on disk. STALE-style absence at the AC level.
 *
 * The status enum is fixed (PASS / FAIL / MISSING) per the phase-8c
 * constraint — no other states.
 */
export type AcTraceabilityStatus = "PASS" | "FAIL" | "MISSING";

export interface AcTraceabilityRow {
  ac_id: string;
  slice_id: string;
  slice_merge_id: string | null;
  latest_vr_id: string | null;
  status: AcTraceabilityStatus;
}

export interface ScoutEvidenceResult {
  /** Synthesised aggregate VerificationRun, persisted under verifications/. */
  aggregate: VerificationRunT;
  /** Per-slice raw VerificationRun list (in slice order). Already persisted. */
  perSlice: readonly VerificationRunT[];
  /** Derived verdict from the aggregate. */
  derivedVerdict: ScoutDerivedVerdict;
  /** Slices that contributed evidence. */
  slicesCovered: readonly ContextSummarySliceRef[];
  /** Slice ids that lacked SliceMerge / VerificationRun (cause STALE). */
  slicesMissing: readonly string[];
  /**
   * Phase 8c (KAC-TRACEABILITY): AC-level traceability rows aggregated
   * across all milestone slices. Additive — does not replace the slice-
   * level `slicesCovered` / `slicesMissing` summaries that downstream
   * consumers (ContextSummary snapshot) already rely on.
   */
  acTraceability: readonly AcTraceabilityRow[];
}

/**
 * Scan slices/ for the milestone, follow each SLICE_VALIDATED slice's
 * SliceMerge → VerificationRun, and synthesise an aggregate.
 *
 * Side effect: writeAtomic of the aggregate VerificationRun under
 * `verifications/<id>.json`. No ledger row — outer-turn emits the
 * scout observer SessionTurn which carries the aggregate id.
 */
export async function aggregateValidationEvidence(
  input: ScoutEvidenceInput,
  deps: ScoutEvidenceDeps,
): Promise<ScoutEvidenceResult> {
  const slices = await loadMilestoneSlices(input.milestoneId, deps.store);

  // PR #72 P0-2 fix: bulk-read slice_merges once and group by slice_id, so
  // the per-slice lookup is O(1) instead of O(K×M) full-directory scans.
  const sliceMergesBySliceId = await loadSliceMergesBySliceId(deps.store);

  const perSlice: VerificationRunT[] = [];
  const slicesCovered: ContextSummarySliceRef[] = [];
  const slicesMissing: string[] = [];

  for (const slice of slices) {
    const sm = pickLatestMerged(sliceMergesBySliceId.get(slice.slice_id));
    if (sm == null || sm.verification_run_id == null) {
      slicesMissing.push(slice.slice_id);
      continue;
    }
    const vr = await readVerificationRun(sm.verification_run_id, deps.store);
    if (vr == null) {
      slicesMissing.push(slice.slice_id);
      continue;
    }
    perSlice.push(vr);
    slicesCovered.push({
      slice_id: slice.slice_id,
      slice_kind: slice.slice_kind,
      validated_revision: sm.merge_revision ?? vr.target_revision,
      ac_ids: slice.ac_ids,
    });
  }

  // Phase 8c (KAC-TRACEABILITY): AC-level traceability is computed across
  // ALL milestone slices (not just SLICE_VALIDATED), since an AC declared
  // by a still-building slice is `MISSING`, not absent. The slice-level
  // `slicesCovered` / `slicesMissing` summaries above are unchanged.
  const acTraceability = await aggregateAcTraceability(
    input.milestoneId,
    sliceMergesBySliceId,
    deps.store,
  );

  const derivedVerdict = computeDerivedVerdict({
    sliceCount: slices.length,
    perSlice,
    missingCount: slicesMissing.length,
    acTraceability,
  });

  const aggregate: VerificationRunT = VerificationRun.parse({
    verification_run_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    target_revision: `milestone:${input.milestoneId}`,
    commands_or_checks: ["scout.validation.aggregate"],
    environment_fingerprint: "scout-observer",
    started_at: deps.clock.isoNow(),
    finished_at: deps.clock.isoNow(),
    result: derivedVerdict === "PASS" ? "pass" : "fail",
    failed_tests: collectFailedTests(perSlice),
    log_ref: null,
  });
  // PR #72 P1-3 fix: STALE means "evidence absent", not "verification
  // failed". Persisting a STALE-derived aggregate VR each call would (a)
  // pollute audit chain with synthesised "fail" runs that aren't real
  // failures and (b) accumulate unbounded VR files per Validation turn.
  // Return the synthetic aggregate in-memory only on STALE; PASS / FAIL
  // are real evidence summaries and stay persisted.
  if (derivedVerdict !== "STALE") {
    await deps.store.writeAtomic(
      layout.verification(aggregate.verification_run_id),
      JSON.stringify(aggregate, null, 2),
    );
  }

  return {
    aggregate,
    perSlice,
    derivedVerdict,
    slicesCovered,
    slicesMissing,
    acTraceability,
  };
}

function computeDerivedVerdict(args: {
  sliceCount: number;
  perSlice: readonly VerificationRunT[];
  missingCount: number;
  acTraceability: readonly AcTraceabilityRow[];
}): ScoutDerivedVerdict {
  if (args.sliceCount === 0) return "STALE";
  if (args.missingCount > 0) return "STALE";
  if (args.perSlice.length === 0) return "STALE";
  for (const vr of args.perSlice) {
    if (vr.result !== "pass") return "FAIL";
  }
  // Phase 8c (KAC-TRACEABILITY): even when every slice's VR is `pass`, a
  // partial AC mapping (slice.ac_ids ⊃ vr.covers_ac_ids) leaves some ACs
  // un-evidenced. Per plan §G2-2 검증, a fixture where only some ACs of a
  // slice are PASS converges Validation to FAIL — surface that here so the
  // downstream `evidence_only` gate sees `result=fail` and the FAIL bypass
  // routes through the dispatch matrix's `validation_fail` row.
  for (const row of args.acTraceability) {
    if (row.status === "FAIL") return "FAIL";
  }
  // MISSING rows alone do not flip a slice-green aggregate — they reflect
  // slices that haven't yet validated. computeDerivedVerdict already
  // returns STALE earlier (`missingCount > 0`) when the slice itself is
  // missing evidence; an AC row whose slice is BUILDING/PENDING shows up
  // as MISSING here without triggering FAIL.
  return "PASS";
}

/**
 * Phase 8c (KAC-TRACEABILITY, plan §G2-2): walk every milestone slice
 * and emit one AcTraceabilityRow per declared `ac_id`.
 *
 * Status assignment:
 *   - No SM_MERGED SliceMerge for the slice OR no `verification_run_id`
 *     OR the VR file is unreadable → `MISSING` (slice_merge_id /
 *     latest_vr_id may be null).
 *   - SM_MERGED VR present + `result=pass` + AC listed in
 *     `vr.covers_ac_ids` → `PASS`.
 *   - SM_MERGED VR present + `result≠pass` → `FAIL` (slice itself failed,
 *     all its ACs inherit FAIL).
 *   - SM_MERGED VR present + `result=pass` but AC NOT listed in
 *     `vr.covers_ac_ids` → `FAIL` (passing slice with incomplete AC
 *     mapping; KAC-TRACEABILITY requires every declared AC to be
 *     evidenced, otherwise Validation must FAIL).
 *
 * Backward compat: VRs persisted before phase 8c parse with
 * `covers_ac_ids = []` (zod default). Such VRs have empty coverage; if
 * the parent slice declares any AC, those rows render as `FAIL`. This
 * is the correct migration signal — pre-8c VRs cannot prove AC coverage,
 * so a Validation re-run that observes them must require operators to
 * re-emit fresh evidence. (Operator surface: the FAIL row points at the
 * specific (ac_id, slice_id, latest_vr_id) tuple that needs re-running.)
 */
export async function aggregateAcTraceability(
  milestoneId: string,
  sliceMergesBySliceId: Map<string, SliceMergeT[]>,
  store: StorePort,
): Promise<readonly AcTraceabilityRow[]> {
  const slices = await loadAllMilestoneSlices(milestoneId, store);
  const rows: AcTraceabilityRow[] = [];
  for (const slice of slices) {
    if (slice.ac_ids.length === 0) continue;
    const sm = pickLatestMerged(sliceMergesBySliceId.get(slice.slice_id));
    const vr =
      sm != null && sm.verification_run_id != null
        ? await readVerificationRun(sm.verification_run_id, store)
        : null;
    for (const acId of slice.ac_ids) {
      if (sm == null || sm.verification_run_id == null || vr == null) {
        rows.push({
          ac_id: acId,
          slice_id: slice.slice_id,
          slice_merge_id: sm?.slice_merge_id ?? null,
          latest_vr_id: sm?.verification_run_id ?? null,
          status: "MISSING",
        });
        continue;
      }
      const status: AcTraceabilityStatus =
        vr.result !== "pass"
          ? "FAIL"
          : vr.covers_ac_ids.includes(acId)
            ? "PASS"
            : "FAIL";
      rows.push({
        ac_id: acId,
        slice_id: slice.slice_id,
        slice_merge_id: sm.slice_merge_id,
        latest_vr_id: sm.verification_run_id,
        status,
      });
    }
  }
  rows.sort(
    (a, b) =>
      a.slice_id.localeCompare(b.slice_id) || a.ac_id.localeCompare(b.ac_id),
  );
  return rows;
}

/**
 * Phase 8c helper — load every slice for a milestone irrespective of
 * state. `loadMilestoneSlices` (slice-level aggregation) filters to
 * SLICE_VALIDATED only; AC traceability needs to surface declared ACs of
 * slices still BUILDING / REVIEWING as `MISSING` rows.
 */
async function loadAllMilestoneSlices(
  milestoneId: string,
  store: StorePort,
): Promise<readonly SliceT[]> {
  let entries: string[];
  try {
    entries = await store.list("slices");
  } catch {
    return [];
  }
  const out: SliceT[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`slices/${name}`);
    if (body == null) continue;
    let parsed: SliceT;
    try {
      parsed = Slice.parse(JSON.parse(body));
    } catch {
      continue;
    }
    if (parsed.milestone_id !== milestoneId) continue;
    out.push(parsed);
  }
  out.sort((a, b) => a.slice_id.localeCompare(b.slice_id));
  return out;
}

function collectFailedTests(
  runs: readonly VerificationRunT[],
): VerificationRunT["failed_tests"] {
  const out: VerificationRunT["failed_tests"] = [];
  for (const vr of runs) {
    for (const ft of vr.failed_tests) out.push(ft);
  }
  return out;
}

async function loadMilestoneSlices(
  milestoneId: string,
  store: StorePort,
): Promise<readonly SliceT[]> {
  let entries: string[];
  try {
    entries = await store.list("slices");
  } catch {
    return [];
  }
  const out: SliceT[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`slices/${name}`);
    if (body == null) continue;
    let parsed: SliceT;
    try {
      parsed = Slice.parse(JSON.parse(body));
    } catch {
      continue;
    }
    if (parsed.milestone_id !== milestoneId) continue;
    if (parsed.state !== "SLICE_VALIDATED") continue;
    out.push(parsed);
  }
  out.sort((a, b) => a.slice_id.localeCompare(b.slice_id));
  return out;
}

/**
 * PR #72 P0-2 fix: bulk-read slice_merges once and group by slice_id. The
 * caller picks the latest SM_MERGED entry per slice via `pickLatestMerged`.
 */
async function loadSliceMergesBySliceId(
  store: StorePort,
): Promise<Map<string, SliceMergeT[]>> {
  let entries: string[];
  try {
    entries = await store.list("slice_merges");
  } catch {
    return new Map();
  }
  const out = new Map<string, SliceMergeT[]>();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`slice_merges/${name}`);
    if (body == null) continue;
    let sm: SliceMergeT;
    try {
      sm = SliceMerge.parse(JSON.parse(body));
    } catch {
      continue;
    }
    if (sm.state !== "SM_MERGED") continue;
    const list = out.get(sm.slice_id);
    if (list == null) {
      out.set(sm.slice_id, [sm]);
    } else {
      list.push(sm);
    }
  }
  return out;
}

function pickLatestMerged(
  candidates: readonly SliceMergeT[] | undefined,
): SliceMergeT | null {
  if (candidates == null || candidates.length === 0) return null;
  let best: SliceMergeT | null = null;
  for (const sm of candidates) {
    if (best == null) {
      best = sm;
      continue;
    }
    // ISO-8601 timestamps compare correctly as strings.
    const a = sm.merged_at ?? sm.updated_at;
    const b = best.merged_at ?? best.updated_at;
    if (a > b) best = sm;
  }
  return best;
}

async function readVerificationRun(
  runId: string,
  store: StorePort,
): Promise<VerificationRunT | null> {
  const body = await store.readText(layout.verification(runId));
  if (body == null) return null;
  try {
    return VerificationRun.parse(JSON.parse(body));
  } catch {
    return null;
  }
}
