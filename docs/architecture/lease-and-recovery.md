# Lease and Recovery

본 문서는 [`docs/contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS), [`#RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY), [`#RGC-FAILURE`](../contracts/reliability-and-gate-contract.md#RGC-FAILURE), [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 구현 매핑을 기록한다. contract 본문이 정의하는 invariant 를 어디서 어떻게 적용하는지만 적고, 새로운 규약은 만들지 않는다.

## 1. 4-Lease Kind 구현 매핑

| Lease kind | 보호 대상 | 구현 위치 |
|---|---|---|
| `slot_lock` | milestone 의 Discovery / Delivery slot 점유 (short transaction) | `lib/lease.sh` `lease_claim()` (kind=slot_lock) — `mkdir`-atomic, max-ttl 강제 (수 초). LLM 호출 / verification 차단 |
| `slice_lease` | slice workspace 점유 (long-running) | `lib/lease.sh` `lease_claim()` (kind=slice_lease) |
| `session_lease` | DialogueSession turn append 직렬화 (long-running) | `lib/lease.sh` `lease_claim()` (kind=session_lease) |
| `turn_lease` | 개별 agent 호출 lock | turn_index CAS 권장. separate lease 객체를 두면 `lib/lease.sh` `lease_claim()` (kind=turn_lease) |

| 책임 | 구현 위치 |
|---|---|
| atomic claim | `lib/lease.sh` `lease_claim()` — `mkdir`(POSIX atomic) 으로 lease dir 선점 |
| lease body 작성 | `lease_claim()` — `lease_id`, `lease_kind`, `holder`(=`worker_id`), `acquired_at`(=`claimed_at`), `ttl`(→ `expires_at`), `lease_token` |
| 만료 스캔 | `lib/lease.sh` `lease_expire_scan()` — kind 별로 분리 |
| 정상 release | `lib/lease.sh` `lease_release()` |
| acquisition order CI | `lib/lease.sh` 의 stack-tracking — outer-to-inner 순서 위반 시 hard fail (Stage 2 always_hard) |
| cycle wait detection | `lib/lease.sh` 의 sweeper — lower-priority forceful release + escalate |

`lease_id` 는 lease 자체 식별자. `lease_token` 은 같은 객체의 lease 들 사이 *순서* 를 보증하는 split-brain 감지용 monotonic 값이다.

## 2. TTL 적용 위치

[`#RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS) 의 우선순위를 [`docs/contracts/target-config-contract.md#TCC-PRECEDENCE`](../contracts/target-config-contract.md#TCC-PRECEDENCE) 에 따라 lookup.

1. worker 환경변수
2. **Slot lock**: `lease.ttl_by_lease_kind.slot_lock` (수 초 한도)
3. **Slice lease**: `lease.ttl_by_lease_kind.slice_lease` 또는 `lease.ttl_by_phase.<phase>`
4. **Session lease**: `lease.ttl_by_lease_kind.session_lease` 또는 `loop_policies.<loop>.<phase>.timeout`
5. **Turn lease**: `lease.ttl_by_agent_profile.<id>`
6. `lease.ttl_default`
7. 시스템 기본값 (`lib/config.sh`)

legacy `lease.ttl_by_role` lookup 은 폐기되었다.

## 3. Recovery 구현 매핑

trigger × ledger result 의 분류는 [`#SOC-RECOVERY-OPERATION`](../contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION) 가 정의한다.

| Trigger | 구현 진입 |
|---|---|
| stale | `lease_expire_scan()` 결과를 받아 `recovery_scan()` 이 객체 상태를 이전 ready 로 되돌림 |
| lease-expiry | `lease_expire_scan()` → `recovery_scan()` |
| human-revoke | `application/human_signal.sh` 가 revoke 신호 처리 후 `recovery_scan()` 호출 |
| partial-fail-rollback | multi-step write 실패 시 호출자가 직접 `_recovery_rollback_for_operation()` 호출 |
| session-stale / session-timeout | `recovery_scan()` 이 session 을 ABANDONED / TIMEOUT / AWAITING_REVALIDATION 으로 전이 |
| inner-no-progress | turn worker 또는 dialogue_coordinator 가 newly_green=0 streak 한도 초과 감지 시 `recovery_scan()` 호출 → slice SLICE_BUILDING → SLICE_BLOCKED |
| slice-merge-stale | trunk rebase 후 verification 재실행 fail 감지 시 `recovery_scan()` 호출 → SliceMerge SM_STALE |
| coordinator-failure | dialogue_coordinator 또는 dual_track_scheduler lease 만료 시 `recovery_scan()` 이 lock 정리 후 다음 cycle 에서 재평가 |

Recovery 자체는 idempotent. 같은 lease 가 두 cycle 에 걸쳐 두 번 회수 대상으로 스캔되면 두 번째 호출은 `noop` 로 종료한다.

## 4. 운영적 한계

- `mkdir`-atomic 은 같은 파일시스템 내에서만 atomic 이다. lease 디렉토리 (`workdir/<target>/leases/`) 를 NFS 등 분산 파일시스템에 두면 invariant 는 보증되지 않는다.
- 강제 종료된 worker 는 lease 를 release 하지 못한다. 이 경우 회수는 `lease_expire_scan()` 의 TTL 만료에 의존하므로, lease_kind 별 TTL 의 하한은 *재시작 지연 허용 한도* 다.
- clock skew 는 `lease_token` monotonic 검사로 흡수된다.
- slot_lock 은 short transaction 만 허용 — LLM 호출 또는 verification 보유 중이면 invariant 위반 (always_hard).

## 5. Ledger 와의 결합

`recovery_scan()` 의 모든 결과는 `_recovery_ledger_write()` 가 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 result enum 으로 기록한다. ledger 의 `lease_kind` 필드가 4 kind 중 하나로 채워지며, 신규 row 는 새 schema 만 사용 (legacy schema 의 row 는 immutable, parser 는 union read).

운영 분석은 ledger 에서 시작한다. lease 디렉토리 자체는 휘발성 운영 상태로 본다.
