import type { HumanSignalEnvelope } from "../domain/schema/human-signal.js";

/**
 * RGC-SIGNALS — Caller 가 사람의 raw signal 을 입수하는 port.
 *
 * 두 어댑터 (`fs` 직접 drop / `github_comment` Issue comment) 가 동일 환경에서
 * 공존할 수 있어야 한다. 본 인터페이스는 둘 모두를 만족하는 최소 surface.
 *
 * Idempotency: `signal_id` 가 동일하면 재읽기/재처리 무해여야 한다 — 어댑터가
 * 이미 처리된 signal 은 list 에서 제외하거나 caller 가 markProcessed 후 skip
 * 한다.
 */
export interface HumanSignalPort {
  /**
   * Pending (yet-unprocessed) signal envelope 목록을 반환한다.
   * 정렬: 어댑터 정의 — FS adapter 는 `created_at asc`.
   */
  listPending(): Promise<HumanSignalEnvelope[]>;

  /**
   * 단일 signal 을 caller 가 처리 완료로 표시한다.
   * `applied` (operational write 발생) / `stale` (revision mismatch) /
   * `invalid` (envelope 검증 실패) 를 reason 과 함께 영속화한다.
   */
  markProcessed(input: {
    signalId: string;
    state: "applied" | "stale" | "invalid";
    reason: string | null;
    contributionId: string | null;
    appliedAt: string;
  }): Promise<void>;
}
