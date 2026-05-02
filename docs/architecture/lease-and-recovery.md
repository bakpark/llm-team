# Lease and Recovery

본 문서는 [`docs/contracts/reliability-and-gate-contract.md#RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE), [`#RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY), [`#RGC-FAILURE`](../contracts/reliability-and-gate-contract.md#RGC-FAILURE), [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 구현 매핑을 기록한다. contract 본문이 정의하는 invariant 를 어디서 어떻게 적용하는지만 적고, 새로운 규약은 만들지 않는다.

## 1. Lease 구현 매핑

| 책임 | 구현 위치 |
|---|---|
| atomic claim | `lib/lease.sh` `lease_claim()` — `mkdir`(POSIX atomic) 으로 lease dir 선점, 실패 시 즉시 반환 |
| lease body 작성 | `lease_claim()` — `lease_id`, `holder`(=`worker_id`), `acquired_at`(=`claimed_at`), `ttl`(→ `expires_at`), `lease_token` 을 lease dir 안에 기록 |
| 만료 스캔 | `lib/lease.sh` `lease_expire_scan()` — `acquired_at + ttl` 초과 lease 를 식별 |
| 정상 release | `lib/lease.sh` `lease_release()` — operation 종료 시 holder 가 호출 |

`lease_id` 는 [`#RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE) 의 lease 자체 식별자(같은 객체에 시간 차로 발급된 두 lease 는 서로 다른 `lease_id` 를 가진다). `lease_token` 은 같은 객체의 lease 들 사이 *순서* 를 보증하는 split-brain 감지용 monotonic 값이다. 모든 operational write 는 `lease_token` 을 ledger 에 기록하며, 이후 같은 객체에 더 작은 token 의 write 가 도착하면 거부된다.

## 2. TTL 적용 위치

[`#RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE) 의 우선순위(env > target > 시스템 기본값)는 [`docs/contracts/target-config-contract.md#TCC-PRECEDENCE`](../contracts/target-config-contract.md#TCC-PRECEDENCE) 에 따른다. 구현은 다음 순서로 lookup 한다.

1. worker 환경변수(`LLM_TEAM_LEASE_TTL_<ROLE>` 형태로 명시된 경우)
2. `targets/*.yaml` 의 `lease.ttl_by_role[<role>]`
3. `targets/*.yaml` 의 `lease.ttl_default`
4. 시스템 기본값(`lib/config.sh`)

해석 결과는 `lease_claim()` 호출 시 `ttl` 인자로 전달된다. 동적 갱신은 contract 가 out-of-scope 로 두며, 구현도 갱신 API 를 제공하지 않는다.

## 3. Recovery 구현 매핑

trigger × ledger result 의 분류는 [`#SOC-RECOVERY-OPERATION`](../contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION) 가 정의한다. 본 절은 그 분류를 `application/recovery.sh` 의 어느 진입 함수가 처리하는지만 매핑한다.

| Trigger (contract) | 구현 진입 |
|---|---|
| stale | `lease_expire_scan()` 결과를 받아 `recovery_scan()` 이 객체 상태를 이전 ready 로 되돌림 |
| lease-expiry | `lease_expire_scan()` → `recovery_scan()` (stale 의 한 원인으로 contract 가 인정) |
| human-revoke | `application/human_signal.sh` 가 revoke 신호 처리 후 `recovery_scan()` 을 호출 |
| partial-fail-rollback | multi-step write 실패 시 호출자가 직접 `_recovery_rollback_for_operation()` 호출 |

Recovery 자체는 idempotent 다. 같은 lease 가 두 cycle 에 걸쳐 두 번 회수 대상으로 스캔되면 두 번째 호출은 `noop` 로 종료한다([`#SOC-RECOVERY-OPERATION`](../contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION) 의 idempotency 규칙).

## 4. 운영적 한계

- `mkdir`-atomic 은 같은 파일시스템 내에서만 atomic 이다. lease 디렉토리(`workdir/<target>/leases/`)를 NFS 등 분산 파일시스템에 두면 invariant 는 보증되지 않는다.
- 강제 종료된 worker 는 lease 를 release 하지 못하고 사라진다. 이 경우 회수는 `lease_expire_scan()` 의 TTL 만료에 의존하므로, role-specific TTL 의 하한은 *재시작 지연 허용 한도* 다.
- clock skew 는 `lease_token` monotonic 검사로 흡수된다. timestamp 비교만으로 일관성을 판정하지 않는다.

## 5. Ledger 와의 결합

`recovery_scan()` 의 모든 결과는 `_recovery_ledger_write()` 가 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 result enum 으로 기록한다. 운영 분석은 ledger 에서 시작하며, lease 디렉토리 자체는 휘발성 운영 상태로 본다.
