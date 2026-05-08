/**
 * RGC-SIGNALS drain (Phase 5a baseline).
 *
 * 매 cycle 시작 시 호출 — pending signal envelope 들을 읽어 구조 검증을 통과한
 * 것은 `applied` / 검증 실패는 `invalid` 로 markProcessed.
 *
 * Phase 5a 한계: signal 의 *실제 효과* (session termination 평가 흡수,
 * Caller operational write) 는 phase 5b dialogue-coordinator 가 담당한다.
 * 본 단계는 envelope 의 영속성 보장 + idempotency 만 책임진다.
 *
 * Caller 책임: drain 결과는 ledger 의 `signal_apply` row 로 남길 수 있도록
 * outcome 의 detailed list 를 반환한다 (daemon 이 ledger.appendTransition
 * 호출).
 */
import { HumanSignalEnvelope } from "../domain/schema/human-signal.js";
import type { ClockPort } from "../ports/clock.js";
import type { HumanSignalPort } from "../ports/human-signal.js";
import type { StorePort } from "../ports/store.js";
import { layout } from "./persistence-layout.js";

export type DrainOutcome =
  | {
      kind: "applied";
      signal_id: string;
      signal_type: string;
      target_kind: string;
      target_id: string;
    }
  | {
      kind: "invalid";
      signal_id: string;
      reason: string;
    };

export interface DrainDeps {
  store: StorePort;
  signal: HumanSignalPort;
  clock: ClockPort;
}

export async function runHumanSignalDrain(
  deps: DrainDeps,
): Promise<DrainOutcome[]> {
  const pending = await deps.signal.listPending();
  const results: DrainOutcome[] = [];

  for (const env of pending) {
    const validation = validateEnvelope(env);
    const now = deps.clock.isoNow();
    if (validation.ok) {
      const r = await deps.signal.markProcessed({
        signalId: env.signal_id,
        state: "applied",
        reason: null,
        contributionId: null,
        appliedAt: now,
      });
      // P0-2: skip outcome emission when a parallel drain already marked
      // this signal as processed inside its lock — otherwise both drains
      // would emit `applied` for the same signal_id.
      if (r.alreadyProcessed) continue;
      results.push({
        kind: "applied",
        signal_id: env.signal_id,
        signal_type: env.signal_type,
        target_kind: env.target_kind,
        target_id: env.target_id,
      });
    } else {
      const r = await deps.signal.markProcessed({
        signalId: env.signal_id,
        state: "invalid",
        reason: validation.reason,
        contributionId: null,
        appliedAt: now,
      });
      if (r.alreadyProcessed) continue;
      results.push({
        kind: "invalid",
        signal_id: env.signal_id,
        reason: validation.reason,
      });
    }
  }

  return results;
}

function validateEnvelope(env: HumanSignalEnvelope): { ok: true } | { ok: false; reason: string } {
  // Basic conditional-required checks per RGC-SIGNALS.
  const NEED_RELATED: Record<string, true> = {
    approve: true,
    reject: true,
    amendment_approve: true,
  };
  if (NEED_RELATED[env.signal_type] === true) {
    if (env.related_object_id == null) {
      return {
        ok: false,
        reason: `signal_type=${env.signal_type} requires related_object_id`,
      };
    }
  }
  // Some signal_type / target_kind combinations are documented as system-only.
  const SYSTEM_ONLY: Record<string, true> = {
    pause: true,
    resume: true,
  };
  if (SYSTEM_ONLY[env.signal_type] === true && env.target_kind !== "system") {
    return {
      ok: false,
      reason: `signal_type=${env.signal_type} requires target_kind=system`,
    };
  }
  return { ok: true };
}

/**
 * Convenience helper: write a raw envelope to the FS drop dir. Useful for
 * tests + the future CLI signal-injection command. Production signal sources
 * (GitHub Issue comment, future Slack adapter) will write their own paths.
 */
export async function dropSignal(
  store: StorePort,
  envelope: HumanSignalEnvelope,
): Promise<void> {
  await store.writeAtomic(
    layout.humanSignal(envelope.signal_id),
    JSON.stringify(envelope, null, 2),
  );
}
