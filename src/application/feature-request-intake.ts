/**
 * `feature_request_promote` use case (FS-only, Phase 5a).
 *
 * - 입력: `workdir/feature_requests/<request_id>.json` 의 queued 항목 (사람이 drop)
 * - 출력: `M_INTAKE_QUEUED` 상태의 Milestone 1건 + FeatureRequest 의 state 갱신
 *         + ledger row (action_kind=`intake`)
 *
 * Phase 5a 는 GitHub 미도입 (`external-tracking-mapping.md` 의 issue 매핑은
 * phase 6b 에서 추가). M_INTAKE_QUEUED → M_DISCOVERY_DRAFT 의 slot-lock 보호
 * 전이는 phase 6a 의 dual-track scheduler 가 담당한다.
 *
 * 정렬: `submitted_at asc` 로 가장 오래된 1건 (fairness).
 * Idempotency: queued state 가 아닌 record 는 skip; lock + re-read 로 TOCTOU 차단.
 */
import { newMonotonicId } from "../domain/ids.js";
import {
  FeatureRequest,
  type FeatureRequest as FeatureRequestT,
} from "../domain/schema/feature-request.js";
import {
  Milestone,
  type Milestone as MilestoneT,
} from "../domain/schema/milestone.js";
import type { ClockPort } from "../ports/clock.js";
import type { StorePort } from "../ports/store.js";
import type { LedgerAppender } from "./ledger.js";
import { layout } from "./persistence-layout.js";

export type FeatureRequestIntakeOutcome =
  | { kind: "promoted"; request_id: string; milestone_id: string }
  | { kind: "noop"; reason: "no_queued_requests" }
  | { kind: "error"; reason: string };

export interface FeatureRequestIntakeDeps {
  store: StorePort;
  clock: ClockPort;
  ledger: LedgerAppender;
  callerId: string;
  targetId: string;
}

export async function runFeatureRequestIntake(
  deps: FeatureRequestIntakeDeps,
): Promise<FeatureRequestIntakeOutcome> {
  const queued = await listQueuedRequests(deps.store);
  if (queued.length === 0) {
    return { kind: "noop", reason: "no_queued_requests" };
  }

  // Oldest first.
  queued.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  const candidate = queued[0]!;
  const requestPath = layout.featureRequest(candidate.request_id);

  return deps.store.withFileLock(requestPath, async () => {
    // Re-read inside the lock — another worker may have promoted it.
    const fresh = await deps.store.readText(requestPath);
    if (fresh == null) {
      return { kind: "noop", reason: "no_queued_requests" } as const;
    }
    let live: FeatureRequestT;
    try {
      live = FeatureRequest.parse(JSON.parse(fresh));
    } catch (e) {
      return {
        kind: "error",
        reason: `feature_request parse failed: ${(e as Error).message}`,
      } as const;
    }
    if (live.state !== "queued" && live.state !== "promoting") {
      return { kind: "noop", reason: "no_queued_requests" } as const;
    }

    const now = deps.clock.isoNow();

    // P1-3 atomicity: 4-step crash-safe protocol.
    //   queued → write FR=promoting + milestone_id (lease)
    //          → writeAtomic milestone (idempotent rewrite on retry)
    //          → write FR=promoted
    //          → ledger row (idempotency_key dedups duplicates)
    //
    // On retry, state=promoting resumes from the milestone write step using
    // the same milestone_id — the milestone file write is idempotent, and
    // the ledger row's idempotency_key dedups any subsequent append.
    let milestoneId: string;
    if (live.state === "promoting") {
      if (live.promoted_milestone_id == null) {
        return {
          kind: "error",
          reason: "promoting state without promoted_milestone_id",
        } as const;
      }
      milestoneId = live.promoted_milestone_id;
    } else {
      milestoneId = newMonotonicId(deps.clock.now());
      const promoting: FeatureRequestT = FeatureRequest.parse({
        ...live,
        state: "promoting",
        promoted_milestone_id: milestoneId,
      });
      await deps.store.writeAtomic(
        requestPath,
        JSON.stringify(promoting, null, 2),
      );
    }

    const milestone: MilestoneT = Milestone.parse({
      milestone_id: milestoneId,
      target_id: deps.targetId,
      title: live.title,
      state: "M_INTAKE_QUEUED",
      slot_kind: null,
      intake_source_kind: "feature_request",
      intake_source_id: live.request_id,
      spec_revision_pin: null,
      context_summary_id: null,
      external_refs: [],
      created_at: now,
      updated_at: now,
    });
    const milestonePath = layout.milestone(milestone.milestone_id);
    await deps.store.writeAtomic(
      milestonePath,
      JSON.stringify(milestone, null, 2),
    );

    const promoted: FeatureRequestT = FeatureRequest.parse({
      ...live,
      state: "promoted",
      promoted_milestone_id: milestone.milestone_id,
      processed_at: now,
    });
    await deps.store.writeAtomic(requestPath, JSON.stringify(promoted, null, 2));

    await deps.ledger.appendTransition({
      transition_id: newMonotonicId(deps.clock.now()),
      target_id: deps.targetId,
      object_id: milestone.milestone_id,
      object_kind: "milestone",
      from_state: null,
      to_state: "M_INTAKE_QUEUED",
      loop_kind: null,
      phase: null,
      slice_id: null,
      slice_kind: null,
      dod_revision: null,
      session_id: null,
      turn_index: null,
      slot_kind: null,
      agent_profile_id: null,
      contribution_kind: null,
      action_kind: "intake",
      final_verdict: null,
      caller_id: deps.callerId,
      manifest_id: null,
      input_revision_pins: [],
      output_hash: null,
      verification_run_id: null,
      metric_run_id: null,
      idempotency_key: `intake|feature_request|${live.request_id}`,
      lease_token: null,
      lease_kind: null,
      result: "applied",
      result_detail: null,
      timestamp: now,
    });

    return {
      kind: "promoted",
      request_id: live.request_id,
      milestone_id: milestone.milestone_id,
    } as const;
  });
}

async function listQueuedRequests(
  store: StorePort,
): Promise<FeatureRequestT[]> {
  let names: string[];
  try {
    names = await store.list("feature_requests");
  } catch {
    return [];
  }
  const out: FeatureRequestT[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const body = await store.readText(`feature_requests/${name}`);
    if (body == null) continue;
    try {
      const parsed = FeatureRequest.parse(JSON.parse(body));
      // Filename ↔ payload request_id consistency: a mismatch (foo.json
      // containing {request_id:"bar"}) would otherwise route the milestone
      // through layout.featureRequest(bar) while leaving foo.json pinned in
      // the queue. Skip mismatched files — they are operator drops gone
      // wrong, not legitimate requests. The next cycle re-evaluates.
      if (parsed.request_id !== id) continue;
      // Both `queued` and `promoting` are pickup-eligible: `promoting`
      // means a prior cycle crashed mid-flight; resume to finish.
      if (parsed.state === "queued" || parsed.state === "promoting")
        out.push(parsed);
    } catch {
      // Skip corrupt files; future cycle will re-attempt.
    }
  }
  return out;
}
