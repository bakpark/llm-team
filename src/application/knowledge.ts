/**
 * KAC application helpers — Phase 5b.1 baseline.
 *
 * - `recordDecision`           (KAC-DECISION-LOG)
 * - `snapshotContextSummary`   (KAC-CONTEXT-SUMMARY) — Validation pass 시 응축
 *
 * Compaction (size/wallclock trigger) + slice telemetry emit + Refactor
 * Backlog 6-state lifecycle 는 phase 5c 에서 별도 모듈로 wire.
 *
 * audit_hash 는 record body 자체의 sha256(canonical-json) 만 사용한다 — ledger
 * 의 chain hash 와 의도적으로 다르다. KAC-MANIFEST consumer 가 body 만으로
 * revision_pin 을 재계산해 무결성 검증할 수 있어야 한다. (PR #66 P1-6 fix:
 * 이전 구현은 `computeAuditHash(GENESIS, body)` 로 64-char "0" prefix 를
 * 추가해 body-only 재계산과 불일치했음.)
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../domain/audit-hash.js";
import { newMonotonicId } from "../domain/ids.js";
import {
  ContextSummary,
  type ContextSummary as ContextSummaryT,
  type ContextSummarySliceRef,
  DecisionEntry,
  type DecisionEntry as DecisionEntryT,
  type DecisionKind,
} from "../domain/schema/knowledge.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { layout } from "./persistence-layout.js";

export interface KnowledgeDeps {
  store: StorePort;
  clock: ClockPort;
}

export interface RecordDecisionInput {
  decision_kind: DecisionKind;
  decision: string;
  alternatives?: string[];
  rationale: string;
  affected_milestones?: string[];
  affected_slices?: string[];
  supersedes?: string | null;
}

export async function recordDecision(
  deps: KnowledgeDeps,
  input: RecordDecisionInput,
): Promise<DecisionEntryT> {
  const decision_id = newMonotonicId(deps.clock.now());
  const decided_at = deps.clock.isoNow();
  const body = {
    decision_id,
    decision_kind: input.decision_kind,
    decision: input.decision,
    alternatives: input.alternatives ?? [],
    rationale: input.rationale,
    decided_at,
    affected_milestones: input.affected_milestones ?? [],
    affected_slices: input.affected_slices ?? [],
    supersedes: input.supersedes ?? null,
  };
  const audit_hash = bodyAuditHash(body);
  const entry: DecisionEntryT = DecisionEntry.parse({ ...body, audit_hash });
  await deps.store.writeAtomic(
    layout.decision(decision_id),
    JSON.stringify(entry, null, 2),
  );
  return entry;
}

export interface SnapshotContextSummaryInput {
  milestone_id: string;
  user_value: string;
  behavior_changes?: string[];
  decisions_to_preserve?: string[];
  risks?: string[];
  slices?: ContextSummarySliceRef[];
  architectural_debt_indicators?: string[];
}

export async function snapshotContextSummary(
  deps: KnowledgeDeps,
  input: SnapshotContextSummaryInput,
): Promise<ContextSummaryT> {
  const summary_id = newMonotonicId(deps.clock.now());
  const generated_at = deps.clock.isoNow();
  const body = {
    summary_id,
    milestone_id: input.milestone_id,
    user_value: input.user_value,
    behavior_changes: input.behavior_changes ?? [],
    decisions_to_preserve: input.decisions_to_preserve ?? [],
    risks: input.risks ?? [],
    slices: input.slices ?? [],
    architectural_debt_indicators: input.architectural_debt_indicators ?? [],
    generated_at,
  };
  const audit_hash = bodyAuditHash(body);
  const summary: ContextSummaryT = ContextSummary.parse({
    ...body,
    audit_hash,
  });
  // KAC-MANIFEST 의 entry revision_pin = audit_hash. Caller 는 이 path 를
  // milestone.context_summary_id 로 연결한다.
  await deps.store.writeAtomic(
    layout.contextSummary(input.milestone_id),
    JSON.stringify(summary, null, 2),
  );
  return summary;
}

/**
 * Body-only sha256 of the canonical-json record. KAC-MANIFEST consumer can
 * verify revision_pin = sha256(canonicalJson(record_without_audit_hash)).
 */
export function bodyAuditHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}
