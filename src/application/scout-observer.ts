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

  const perSlice: VerificationRunT[] = [];
  const slicesCovered: ContextSummarySliceRef[] = [];
  const slicesMissing: string[] = [];

  for (const slice of slices) {
    const sm = await findValidatedSliceMerge(slice, deps.store);
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

  const derivedVerdict = computeDerivedVerdict({
    sliceCount: slices.length,
    perSlice,
    missingCount: slicesMissing.length,
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
  await deps.store.writeAtomic(
    layout.verification(aggregate.verification_run_id),
    JSON.stringify(aggregate, null, 2),
  );

  return {
    aggregate,
    perSlice,
    derivedVerdict,
    slicesCovered,
    slicesMissing,
  };
}

function computeDerivedVerdict(args: {
  sliceCount: number;
  perSlice: readonly VerificationRunT[];
  missingCount: number;
}): ScoutDerivedVerdict {
  if (args.sliceCount === 0) return "STALE";
  if (args.missingCount > 0) return "STALE";
  if (args.perSlice.length === 0) return "STALE";
  for (const vr of args.perSlice) {
    if (vr.result !== "pass") return "FAIL";
  }
  return "PASS";
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

async function findValidatedSliceMerge(
  slice: SliceT,
  store: StorePort,
): Promise<SliceMergeT | null> {
  let entries: string[];
  try {
    entries = await store.list("slice_merges");
  } catch {
    return null;
  }
  let best: SliceMergeT | null = null;
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
    if (sm.slice_id !== slice.slice_id) continue;
    if (sm.state !== "SM_MERGED") continue;
    // Pick latest by merged_at (or audit predecessor depth fallback).
    if (best == null) {
      best = sm;
      continue;
    }
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
