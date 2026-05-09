/**
 * Phase 5c — KAC-REFACTOR-BACKLOG 6-state lifecycle.
 *
 * State machine (mirrors `docs/contracts/knowledge-contract.md#KAC-REFACTOR-BACKLOG`):
 *
 *   PROPOSED ─→ CURATED ─→ SCHEDULED ─→ DONE
 *      │           │          │
 *      ├──────────→├──────────┼──────→ DROPPED
 *      └──────────→├──────────┘
 *                  └──────────────────→ SUPERSEDED
 *
 * Producers:
 *   - scout: 정기 scan (`scoutScan`) — code complexity / churn / coverage drop /
 *     perf regression 등 외부 metric 을 근거로 PROPOSED 후보를 등록한다.
 *   - forge / sentinel: ad-hoc proposal contribution (`proposeRefactor`).
 *
 * Caller-only (Inv #4): persist 는 모두 `layout.refactorProposal` 경유.
 * 모든 상태 전이는 ledger row (object_kind="system", action_kind="external_observation",
 * idempotency scope="external_observation" — refactor_proposal 은 SOC 의
 * workflow 객체가 아니라 KAC 지식 누적 영역이므로 system + external_observation
 * 을 사용한다) 를 emit.
 *
 * Idempotency: `scoutScan` 은 (scope, code_location, suggested_refactor) 의
 * sha256 fingerprint 로 dedup — 같은 후보를 두 번 PROPOSED 하지 않는다.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../domain/audit-hash.js";
import { newMonotonicId } from "../domain/ids.js";
import {
  RefactorBacklogItem,
  type RefactorBacklogItem as RefactorBacklogItemT,
  type RefactorBacklogState,
} from "../domain/schema/knowledge.js";
import type { AgentProfileId } from "../domain/schema/contribution.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import { bodyAuditHash } from "./knowledge.js";
import { idempotencyKey } from "./idempotency.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

export interface RefactorBacklogDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export interface ProposeRefactorInput {
  proposed_by: AgentProfileId;
  scope: string;
  suggested_refactor: string;
  rationale: string;
  code_location: string;
  metric_target?: string | null;
  evidence_refs?: readonly string[];
  spawning_slice_id?: string | null;
}

const ALLOWED_TRANSITIONS: Record<
  RefactorBacklogState,
  ReadonlyArray<RefactorBacklogState>
> = {
  PROPOSED: ["CURATED", "DROPPED", "SUPERSEDED"],
  CURATED: ["SCHEDULED", "DROPPED", "SUPERSEDED"],
  SCHEDULED: ["DONE", "SUPERSEDED"],
  DONE: [],
  DROPPED: [],
  SUPERSEDED: [],
};

/**
 * Persist a fresh PROPOSED RefactorBacklogItem. Returns the persisted body.
 * Callers may dedup via `proposalFingerprint` before calling.
 */
export async function proposeRefactor(
  input: ProposeRefactorInput,
  deps: RefactorBacklogDeps,
): Promise<RefactorBacklogItemT> {
  const proposal_id = newMonotonicId(deps.clock.now());
  const proposed_at = deps.clock.isoNow();
  const body = {
    proposal_id,
    proposed_at,
    proposed_by: input.proposed_by,
    state: "PROPOSED" as const,
    scope: input.scope,
    suggested_refactor: input.suggested_refactor,
    rationale: input.rationale,
    code_location: input.code_location,
    metric_target: input.metric_target ?? null,
    evidence_refs: [...(input.evidence_refs ?? [])],
    spawning_slice_id: input.spawning_slice_id ?? null,
    superseded_by: null,
    updated_at: proposed_at,
  };
  const audit_hash = bodyAuditHash(body);
  const item: RefactorBacklogItemT = RefactorBacklogItem.parse({
    ...body,
    audit_hash,
  });
  await deps.store.writeAtomic(
    layout.refactorProposal(proposal_id),
    JSON.stringify(item, null, 2),
  );
  await emitLedgerRow(item, null, "PROPOSED", deps);
  return item;
}

export interface TransitionRefactorInput {
  proposal_id: string;
  to_state: RefactorBacklogState;
  /** Required when transitioning to SCHEDULED (links the spawning internal slice). */
  spawning_slice_id?: string | null;
  /** Required when transitioning to SUPERSEDED. */
  superseded_by?: string | null;
}

export async function transitionRefactor(
  input: TransitionRefactorInput,
  deps: RefactorBacklogDeps,
): Promise<RefactorBacklogItemT> {
  const path = layout.refactorProposal(input.proposal_id);
  return deps.store.withFileLock(path, async () => {
    const body = await deps.store.readText(path);
    if (body == null) {
      throw new Error(
        `transitionRefactor: proposal ${input.proposal_id} not found`,
      );
    }
    const live = RefactorBacklogItem.parse(JSON.parse(body));
    if (live.state === input.to_state) {
      // Idempotent re-run — emit the ledger row but skip the writeAtomic.
      await emitLedgerRow(live, live.state, input.to_state, deps);
      return live;
    }
    const allowed = ALLOWED_TRANSITIONS[live.state];
    if (!allowed.includes(input.to_state)) {
      throw new Error(
        `transitionRefactor: illegal ${live.state} → ${input.to_state}`,
      );
    }
    const nextBody = {
      proposal_id: live.proposal_id,
      proposed_at: live.proposed_at,
      proposed_by: live.proposed_by,
      state: input.to_state,
      scope: live.scope,
      suggested_refactor: live.suggested_refactor,
      rationale: live.rationale,
      code_location: live.code_location,
      metric_target: live.metric_target,
      evidence_refs: [...live.evidence_refs],
      spawning_slice_id:
        input.to_state === "SCHEDULED"
          ? (input.spawning_slice_id ?? live.spawning_slice_id ?? null)
          : live.spawning_slice_id,
      superseded_by:
        input.to_state === "SUPERSEDED"
          ? (input.superseded_by ?? null)
          : live.superseded_by,
      updated_at: deps.clock.isoNow(),
    };
    const audit_hash = bodyAuditHash(nextBody);
    const next = RefactorBacklogItem.parse({ ...nextBody, audit_hash });
    await deps.store.writeAtomic(path, JSON.stringify(next, null, 2));
    await emitLedgerRow(next, live.state, input.to_state, deps);
    return next;
  });
}

/**
 * List all RefactorBacklogItem entries (regardless of state). Callers can
 * filter by state — used by promotion-guard SCHEDULED capacity counter and
 * the scout scan dedup fingerprint check.
 */
export async function listRefactorProposals(
  store: StorePort,
): Promise<readonly RefactorBacklogItemT[]> {
  let entries: string[];
  try {
    entries = await store.list("knowledge/refactor_proposals");
  } catch {
    return [];
  }
  const out: RefactorBacklogItemT[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const body = await store.readText(`knowledge/refactor_proposals/${name}`);
    if (body == null) continue;
    try {
      out.push(RefactorBacklogItem.parse(JSON.parse(body)));
    } catch {
      continue;
    }
  }
  return out;
}

export interface ScoutScanCandidate {
  scope: string;
  suggested_refactor: string;
  rationale: string;
  code_location: string;
  metric_target?: string | null;
  evidence_refs?: readonly string[];
}

export interface ScoutScanInput {
  /**
   * Caller-supplied scan body. Returns a list of candidate proposals derived
   * from the project's metric / churn / complexity sources. Phase 5c keeps
   * the actual metric-collection adapter out of scope (TCC-REFACTOR-METRICS
   * is still spec-only); a real adapter slots in here in a later phase.
   */
  scan: () => Promise<readonly ScoutScanCandidate[]>;
}

export interface ScoutScanResult {
  proposed: readonly RefactorBacklogItemT[];
  /** Candidates already present (by fingerprint) — skipped for idempotency. */
  duplicates: readonly string[];
}

/**
 * scout 정기 scan 본체. injected `scan()` 으로부터 후보를 받아 fingerprint
 * dedup 후 PROPOSED 로 영속화한다. 같은 후보가 다음 cycle 에 다시 잡혀도 두
 * 번째 호출은 idempotent (no new writes).
 */
export async function scoutScan(
  input: ScoutScanInput,
  deps: RefactorBacklogDeps,
): Promise<ScoutScanResult> {
  const candidates = await input.scan();
  const existing = await listRefactorProposals(deps.store);
  const seen = new Set(existing.map((p) => proposalFingerprint(p)));

  const proposed: RefactorBacklogItemT[] = [];
  const duplicates: string[] = [];
  for (const cand of candidates) {
    const fp = candidateFingerprint(cand);
    if (seen.has(fp)) {
      duplicates.push(fp);
      continue;
    }
    seen.add(fp);
    const item = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: cand.scope,
        suggested_refactor: cand.suggested_refactor,
        rationale: cand.rationale,
        code_location: cand.code_location,
        metric_target: cand.metric_target ?? null,
        evidence_refs: cand.evidence_refs ?? [],
        spawning_slice_id: null,
      },
      deps,
    );
    proposed.push(item);
  }
  return { proposed, duplicates };
}

/** Stable fingerprint over the dedup-relevant fields. */
export function proposalFingerprint(item: RefactorBacklogItemT): string {
  return candidateFingerprint({
    scope: item.scope,
    suggested_refactor: item.suggested_refactor,
    rationale: item.rationale,
    code_location: item.code_location,
  });
}

function candidateFingerprint(c: {
  scope: string;
  suggested_refactor: string;
  rationale: string;
  code_location: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        scope: c.scope,
        suggested_refactor: c.suggested_refactor,
        rationale: c.rationale,
        code_location: c.code_location,
      }),
    )
    .digest("hex");
}

async function emitLedgerRow(
  item: RefactorBacklogItemT,
  fromState: RefactorBacklogState | null,
  toState: RefactorBacklogState,
  deps: RefactorBacklogDeps,
): Promise<void> {
  await deps.ledger.appendTransition({
    transition_id: newMonotonicId(deps.clock.now()),
    target_id: deps.targetId,
    object_id: item.proposal_id,
    object_kind: "system",
    from_state: fromState,
    to_state: toState,
    loop_kind: null,
    phase: null,
    slice_id: item.spawning_slice_id,
    slice_kind: null,
    dod_revision: null,
    session_id: null,
    turn_index: null,
    slot_kind: null,
    agent_profile_id: item.proposed_by,
    contribution_kind: null,
    action_kind: "external_observation",
    final_verdict: null,
    caller_id: deps.callerId,
    manifest_id: null,
    input_revision_pins: [],
    output_hash: null,
    verification_run_id: null,
    metric_run_id: null,
    idempotency_key: idempotencyKey({
      scope: "external_observation",
      parts: {
        kind: `refactor_${toState.toLowerCase()}`,
        proposal_id: item.proposal_id,
        from_state: fromState ?? "<genesis>",
        to_state: toState,
      },
    }),
    lease_token: null,
    lease_kind: null,
    result: "applied",
    result_detail: null,
    timestamp: deps.clock.isoNow(),
  });
}
