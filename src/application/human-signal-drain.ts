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
import {
  applyControlSignal,
  type ApplyControlOutcome,
  type ControlAuditContext,
} from "./control-state.js";
import {
  bindHumanSignalToSession,
  type HumanSignalBindingDeps,
} from "./human-signal-binding.js";
import { layout } from "./persistence-layout.js";

export type DrainOutcome =
  | {
      kind: "applied";
      signal_id: string;
      signal_type: string;
      target_kind: string;
      target_id: string;
      /** Phase 5b.2: present when the drain bound the signal to a session. */
      binding?:
        | { kind: "appended"; session_id: string; turn_index: number }
        | { kind: "unsupported"; reason: string };
      /** Phase 7b: present for pause/resume/stop signals — records the
       *  control-state machine transition (or noop reason). */
      control?: ApplyControlOutcome;
    }
  | {
      kind: "invalid";
      signal_id: string;
      reason: string;
    }
  | {
      /**
       * Codex P2: binding returned `no_session` — addressed milestone has no
       * SESSION_OPEN outer session yet. Signal is intentionally NOT marked
       * processed so the next drain cycle re-tries once the coordinator opens
       * the session. Operators can manually delete the file to abort.
       */
      kind: "deferred";
      signal_id: string;
      reason: string;
    };

export interface DrainDeps {
  store: StorePort;
  signal: HumanSignalPort;
  clock: ClockPort;
  /**
   * Phase 5b.2: when supplied, applied signals are bound to their addressed
   * outer DialogueSession as a `human_approval` SessionTurn. Drain remains
   * functional without this — phase-5a callers omit it for envelope-only
   * persistence semantics.
   */
  binding?: HumanSignalBindingDeps;
  /**
   * Phase 7b: when true, pause/resume/stop envelopes drive the persisted
   * control state machine (RGC-SIGNALS, Inv #4 / #8). Daemons opt in via
   * `runDaemonPrelude`; phase-5a callers omit it so the envelope-only test
   * surface is preserved.
   */
  applyControlState?: boolean;
  /**
   * PR #74 codex P1: when supplied alongside `applyControlState=true`, an
   * actual pause/resume/stop transition emits a `pause_resume` ledger row
   * with `result=applied` for audit-trail completeness.
   */
  controlAudit?: ControlAuditContext;
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
      // PR #74 codex P0 (gpt5.5): bindable signals (approve / reject /
      // request_rework) MUST NOT be markProcessed=applied by a non-binding
      // role — otherwise the outer-coordinator never sees them. Stay
      // pending so the next outer-coordinator drain cycle picks them up.
      if (BINDABLE_SIGNAL_TYPES[env.signal_type] === true && deps.binding == null) {
        results.push({
          kind: "deferred",
          signal_id: env.signal_id,
          reason: "no_binding_caller",
        });
        continue;
      }
      // Phase 7b: control signals (pause / resume / stop) drive the
      // persisted control-state machine BEFORE markProcessed so a daemon
      // pickup that races with markProcessed still sees the new state.
      let controlDetail: ApplyControlOutcome | undefined;
      const isControl =
        env.signal_type === "pause" ||
        env.signal_type === "resume" ||
        env.signal_type === "stop";
      if (isControl && deps.applyControlState === true) {
        controlDetail = await applyControlSignal(
          deps.store,
          deps.clock,
          env,
          deps.controlAudit,
        );
      }
      // Phase 5b.2: bind FIRST (before markProcessed) so the contribution
      // is visible to the next coordinator pickup. If binding emits a turn,
      // its idempotency_key is the SessionTurn's per_turn key — separate
      // from markProcessed's processed/<id>.json marker.
      let bindingDetail:
        | { kind: "appended"; session_id: string; turn_index: number }
        | { kind: "unsupported"; reason: string }
        | undefined;
      if (deps.binding != null) {
        const b = await bindHumanSignalToSession(env, deps.binding);
        if (b.kind === "no_session") {
          // Codex P2: do NOT markProcessed — signal stays pending so the
          // next drain cycle retries once the coordinator opens the
          // outer session. listPending will re-emit it.
          results.push({
            kind: "deferred",
            signal_id: env.signal_id,
            reason: b.reason,
          });
          continue;
        }
        if (b.kind === "invalid") {
          // Phase 9a (G2-4): team-membership check rejected the signal.
          // The binding hook already wrote a `signal_apply` ledger row
          // with `result=invalid`. Mark the signal record as invalid so
          // it stops being re-emitted by listPending.
          const r = await deps.signal.markProcessed({
            signalId: env.signal_id,
            state: "invalid",
            reason: b.reason,
            contributionId: null,
            appliedAt: now,
          });
          if (r.alreadyProcessed) continue;
          results.push({
            kind: "invalid",
            signal_id: env.signal_id,
            reason: b.reason,
          });
          continue;
        }
        if (b.kind === "appended") {
          bindingDetail = {
            kind: "appended",
            session_id: b.session_id,
            turn_index: b.turn_index,
          };
        } else {
          // unsupported — fall through to markProcessed=applied so the
          // queue moves on (signal_type isn't bindable, e.g. pause).
          bindingDetail = { kind: "unsupported", reason: b.reason };
        }
      }
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
        ...(bindingDetail != null ? { binding: bindingDetail } : {}),
        ...(controlDetail != null ? { control: controlDetail } : {}),
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

/**
 * Signal types that bind to an outer DialogueSession (see
 * `human-signal-binding.ts` VERDICT_FOR). Drain emits `deferred` for these
 * when invoked without binding deps so the outer-coordinator's next cycle
 * can consume them — a non-outer role MUST NOT markProcessed=applied them.
 */
const BINDABLE_SIGNAL_TYPES: Partial<
  Record<HumanSignalEnvelope["signal_type"], true>
> = {
  approve: true,
  reject: true,
  request_rework: true,
};

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
  // Phase 7b: `stop` joins pause/resume as the third control-state signal —
  // all three drive the persisted control-state machine.
  const SYSTEM_ONLY: Record<string, true> = {
    pause: true,
    resume: true,
    stop: true,
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
