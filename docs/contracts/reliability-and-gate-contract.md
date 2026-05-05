# Reliability and Gate Contract

본 문서는 lease (4-kind 계층 + acquisition order), stale recovery, retry, 사람 contribution, deterministic verification, transition ledger, pause, dual-slot fairness, promotion guard 정책을 정의한다.

<a id="RGC-SCOPE"></a>
## RGC-SCOPE: Scope

이 문서의 authoritative scope 는 다음이다.

- governance/input write 와 operational write 집행
- 4-lease kind 계층 (Slot lock / Slice lease / Session lease / Turn lease) 과 acquisition order
- Slot lock 의 short-transaction 정책, dual-slot fairness, promotion guard, cross-slot stale, dual-gate queue
- Slice / DialogueSession / SliceMerge 단위의 회수 (`SOC-RECOVERY-OPERATION` 의 mechanism 영역)
- Deterministic verification 과 required evidence (`SOC-SESSION-TERMINATION` 의 인프라 영역)
- 사람 contribution (`human` AgentProfile, feature slice 한정 게이트) 의 처리와 권위 보장
- transition ledger (slice / session / turn / merge / slot 차원)
- notification 과 pause
- daemon 군집의 atomic startup

상태명과 loop 별 전이는 `docs/contracts/state-and-operation-contract.md` 가, AgentProfile / loop policy schema 는 `docs/contracts/target-config-contract.md` 가 정의한다.

<a id="RGC-WRITES"></a>
## RGC-WRITES: Write Classes

영속 저장소 write 는 두 종류다.

| 종류 | 주체 | 예 |
|---|---|---|
| governance/input write | Human | 아이디어 입력, 승인·거부·중단·회수 시그널, 모델 수정 승인, cross-milestone amendment 승인 |
| operational write | Caller | 상태 전이, 라벨 변경, SliceMerge 생성·병합, slot promotion, session lifecycle 진행, Issue 생성·종료, lease, 알림, 회수 |

사람의 governance/input write 는 workflow 를 직접 전이하지 않는다. Caller 가 이를 감지하고 revision pin 을 재검증한 뒤 operational write 로 집행한다.

<a id="RGC-SIGNALS"></a>
## RGC-SIGNALS: Human Signal Schema

모든 governance/input signal 은 공통 envelope 를 가져야 한다.

| 필드 | 필수 | 의미 |
|---|---|---|
| `signal_id` | yes | signal 식별자 |
| `signal_type` | yes | `approve`, `reject`, `request_rework`, `request_recover`, `pause`, `resume`, `amendment_approve`, `cross_milestone_amendment`, `acceptance_test_rename`, `purge_acceptance_tests`, `stop` 중 하나 |
| `target_kind` | yes | milestone, slice, slice_merge, dialogue_session, change_proposal, system, contract 등 |
| `target_id` | yes | signal 의 *대상* 식별자. system-wide signal 이면 `system`. `TCC-IDENTITY.target_id` 와 다른 개념 |
| `target_revision_pin` | conditional | 대상 객체가 revision 을 제공하면 필수 |
| `related_object_id` | conditional | 승인·거부가 관련 SliceMerge 또는 Spec CP 에 연결될 때 필수 |
| `related_object_revision_pin` | conditional | 관련 객체가 있을 때 필수 |
| `actor` | yes | signal 을 남긴 사람 |
| `created_at` | yes | signal 생성 시각 |
| `rationale` | recommended | 승인·거부·중단·모델 수정 사유 |

Caller 는 signal 집행 전에 다음을 검증한다.

- `signal_type` 이 대상 상태에서 허용되는지
- `target_revision_pin` 이 현재 대상 revision 과 일치하는지
- 관련 객체가 있으면 `related_object_revision_pin` 이 현재 revision 과 일치하는지
- 동일 `signal_id` 가 이미 집행되지 않았는지

검증 실패 시 Caller 는 signal 을 stale 또는 invalid 로 기록하고 operational transition 을 수행하지 않는다. 사람이 새 signal 을 남겨야 한다.

Signal 별 허용 대상과 기본 집행:

| `signal_type` | 허용 대상 | 허용 상태 | Caller action |
|---|---|---|---|
| `approve` | milestone (feature 게이트의 outer Discovery / Specification) + 관련 Spec CP | `M_DISCOVERY_AWAITING_HUMAN`, `M_SPECIFICATION_AWAITING_HUMAN` 또는 session 의 awaiting-human equivalent | signal 을 `human` profile 의 `human_approval` contribution envelope 으로 변환하여 영속 큐에 enqueue. dialogue_coordinator 가 다음 cycle 에서 session termination 평가에 포함 |
| `reject` | 동일 | 동일 | signal 을 `human_approval` (verdict.result=reject) contribution 으로 변환. session termination 의 finalization rule 이 차단 → 직전 `*_DRAFT` 회수 |
| `request_rework` | slice 또는 SliceMerge | `SLICE_BLOCKED`, `SM_REQUEST_CHANGES`, `SM_CLOSED` | 대상 slice 를 `SLICE_READY` 또는 `SLICE_BUILDING` 으로 회수 |
| `request_recover` | milestone, slice, slice_merge, dialogue_session | `ESCALATED`, `SM_STALE`, stale `*_AWAITING_*`, stale session | 가장 가까운 safe READY 상태로 회수. session 단위는 ABANDONED 또는 AWAITING_REVALIDATION 으로 전이 |
| `pause` | system | `RUNNING` | 전역 control state 를 `PAUSED` 로 전이 |
| `resume` | system | `PAUSED` | 전역 control state 를 `RUNNING` 으로 전이 |
| `amendment_approve` | contract 또는 concept document | pending amendment CP | Caller 가 amendment CP 를 병합 |
| `cross_milestone_amendment` | milestone | non-terminal | Discovery N+1 의 발견을 N 의 scope 변경으로 흡수 — N 에 새 slice 또는 acceptance test 추가 |
| `acceptance_test_rename` | slice | feature slice | acceptance_tests[] 의 path/name 변경 권한 부여 |
| `purge_acceptance_tests` | slice | `SLICE_BLOCKED` 또는 abandoned | pending marker 가 붙은 채 trunk 에 남아 있는 acceptance test 의 명시적 제거 |
| `stop` | system, milestone, slice, dialogue_session | any non-terminal state | system 대상이면 전역 control state 를 `STOPPED` 로 전이하고 새 lease claim 을 중단. workflow 대상이 있으면 ESCALATED 로 전이 |

`approve` / `reject` 신호는 별도 governance gate 가 아니라 `human` AgentProfile 의 contribution 으로 일원화된다 (`#RGC-HUMAN-CONTRIBUTION`).

<a id="RGC-LEASE-KINDS"></a>
## RGC-LEASE-KINDS: Lease Hierarchy (4-kind)

Caller 는 다음 4 종의 lease 를 명시적 계층으로 운영한다.

```text
┌──────────────────────────────────────────────────────┐
│ Slot Lock        (milestone-level Discovery/Delivery)│
│   - SHORT TRANSACTION ONLY (entry/exit/promotion)    │
│   - long agent call 중 보유 금지                       │
│   ┌────────────────────────────────────────────────┐ │
│   │ Slice Lease  (slice workspace 점유)              │ │
│   │   - long-running OK                            │ │
│   │   ┌────────────────────────────────────────┐   │ │
│   │   │ Session Lease  (turn append 직렬화)       │   │ │
│   │   │   - per session, long-running OK        │   │ │
│   │   │   ┌──────────────────────────────────┐ │   │ │
│   │   │   │ Turn Lease  (개별 agent 호출 lock) │ │   │ │
│   │   │   │   - turn_index CAS 로 대체 권장      │ │   │ │
│   │   │   └──────────────────────────────────┘ │   │ │
│   │   └────────────────────────────────────────┘   │ │
│   └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Lease 종류

| Lease | 보호 대상 | 보유 형태 | 동시성 정책 |
|---|---|---|---|
| `slot_lock` | milestone 의 Discovery/Delivery slot 점유 | short transaction (entry/exit/promotion 한정) | 동일 slot 에 1 active. LLM 호출 또는 verification 중 보유 금지 |
| `slice_lease` | slice 의 workspace 점유 | long-running (slice 의 lifecycle 동안) | 동일 slice 에 1 active. inner / middle session 이 같은 slice 의 workspace 를 동시에 commit 하지 않도록 보호 |
| `session_lease` | DialogueSession 의 turn append 직렬화 | long-running (session 의 lifecycle 동안) | 동일 session 에 1 active. 같은 session 의 두 turn 이 동시에 진행되지 않도록 보호 |
| `turn_lease` | 개별 agent 호출 lock | short-running (호출 1회) | 동일 (session, turn_index) 에 1 active. **turn_index CAS 로 대체 권장** — separate lease 객체 두지 않고 session 의 `current_turn_index` 에 대한 atomic CAS |

### Lease 필수 속성

- `lease_id`
- `lease_kind` (`slot_lock` / `slice_lease` / `session_lease` / `turn_lease`)
- `object_id` (lease_kind 별: slot_lock 은 `(milestone_id, slot_kind)`, slice_lease 는 `slice_id`, session_lease 는 `session_id`, turn_lease 는 `(session_id, turn_index)` 또는 CAS-based 면 없음)
- `worker_id`
- `claimed_at`
- `expires_at`
- `lease_token`
- `agent_profile_id` (lease_kind 가 turn 또는 session 한정 시)

### Acquisition Order Rules

1. Caller 는 **outer-to-inner** 순서로만 lease 획득. 역순 시도는 invariant 위반 (CI 로 강제 — Stage 2 DoD).
2. **Slot lock 은 transactional only**: promotion / intake-bind / slot-release 같은 짧은 critical section 에서만. 그 안에서 LLM 호출 또는 verification 금지.
3. **Turn lease 는 turn_index CAS 권장**: separate lease 객체 두지 않고 session 의 `current_turn_index` 에 대한 atomic CAS.
4. **Cross-lease conflict**: 동일 slice 의 inner / middle loop session 은 별도 session_id → 별도 session_lease. workspace 점유는 slice_lease 가 보호하므로 두 session 동시 commit 안 됨.
5. **Cycle wait detection**: lease 만료 외에도 sweeper 가 cycle 감지. lower-priority forceful release + escalate.

### Lease Token (split-brain 감지)

`lease_token` 은 lease 마다 고유하며 단조 증가하는 값이다. 같은 `object_id` 로 발급된 새 lease 는 직전 lease 보다 큰 `lease_token` 을 가진다.

Caller 는 lease 보유 중 수행하는 모든 operational write 에 `lease_token` 을 인용한다. 영속 저장소 또는 ledger 는 동일 객체에 대해 더 작은 `lease_token` 을 인용한 write 가 도착하면 거부한다 (`#RGC-LEDGER` 의 `stale` 또는 `rolled_back`).

### Lease TTL 정책

`expires_at` 은 `claimed_at + ttl` 로 산출한다. `ttl` 은 다음 우선순위를 따른다.

1. worker 별 환경에서 명시적으로 지정된 값
2. **Slot lock**: `lease.ttl_by_lease_kind.slot_lock` (transactional 이므로 매우 짧음, 초 단위)
3. **Slice lease**: `lease.ttl_by_lease_kind.slice_lease` 또는 `lease.ttl_by_phase.<phase>`
4. **Session lease**: `lease.ttl_by_lease_kind.session_lease` 또는 `loop_policies.<loop>.<phase>.timeout`
5. **Turn lease**: `lease.ttl_by_agent_profile.<id>` (호출 단위 timeout)
6. 시스템 기본값 (`lease.ttl_default`)

`forge` 처럼 호출당 시간이 긴 profile 은 `atlas` 같은 짧은 profile 보다 큰 turn lease ttl 을 허용한다. `human` profile 은 사람 응답을 기다리므로 일반적으로 매우 큰 session lease ttl 또는 별도 timeout 정책을 갖는다 (단 `human` 은 worker slot 을 점유하지 않음).

ttl 만료 전에 작업이 완료되지 않으면 stale recovery 가 진행된다(`#RGC-RECOVERY`).

<a id="RGC-SLOT-LOCK"></a>
## RGC-SLOT-LOCK: Slot Lock (Short Transaction)

milestone 의 Discovery / Delivery slot 점유는 `slot_lock` (위 lease kind) 으로 보호된다. **short transaction only**.

### Critical Section 후보

| Operation | Critical section |
|---|---|
| Intake → Discovery promotion | M_INTAKE_QUEUED → M_DISCOVERY_DRAFT (Discovery slot 점유) |
| Discovery → Delivery promotion | M_SPEC_APPROVED → M_DELIVERY_PLANNING (Delivery slot 점유, Discovery slot 해제) |
| Delivery 종료 | M_DONE 또는 M_ESCALATED (Delivery slot 해제) |

### 금지 사항

slot_lock 보유 중에는 다음을 금지한다.

- LLM 호출
- verification 실행
- 사람 입력 대기

slot_lock 은 ledger row append + slot_state 갱신 + intake queue dispatch 같은 *결정적이고 빠른* 영속 작업에 한정된다.

### Atomic Promotion

slot promotion 은 다음을 atomic 하게 한다.

1. promotion guard (`#RGC-PROMOTION-GUARD`) 평가.
2. slot 의 from_state 검증 (slot_kind, milestone_state, lease_token).
3. slot 의 to_state 영속화 + ledger row append + 영향 받은 milestone state 전이.
4. slot_lock 해제.

위 4 단계가 부분 실패 시 `#RGC-FAILURE` 의 multi-step 부분 실패 처리에 따라 원복.

<a id="RGC-PROMOTION-GUARD"></a>
## RGC-PROMOTION-GUARD: Promotion Guard

Discovery → Delivery 의 promotion 은 dual-slot serialization 의 핵심이다. 다음을 만족하지 않으면 `M_SPEC_APPROVED → M_DELIVERY_PLANNING` 전이가 차단된다.

| Guard | 의미 |
|---|---|
| Direct Delivery slot 비어 있음 | 직전 Delivery milestone N 이 `M_DONE` 또는 `M_ESCALATED` 가 아닌 한 새 promotion 차단 |
| Discovery slot 의 spec 이 N+1 의 manifest 와 정합 | N+1 의 input_revision_pins 가 N 의 final Delivery 결과와 일치 |
| RefactorBacklog SCHEDULED 슬롯 capacity | `target.refactor_metrics.scheduled_capacity` 초과 시 promotion 보류 (옵션) |

guard 차단은 ledger 의 `noop` (preflight) + `result_detail=promotion_guard_blocked` 로 기록된다. 사람이 `cross_milestone_amendment` signal 로 우회 가능 (운영자 결정).

<a id="RGC-CROSS-SLOT-STALE"></a>
## RGC-CROSS-SLOT-STALE: Cross-Slot Staleness Detection

Discovery N+1 이 Delivery N 의 객체를 read-only 로 inject 한 상태에서 N 의 객체가 변하면 N+1 의 영향 받은 session 을 자동 stale 로 전이.

### 감지 기준

- N+1 manifest 의 `read_base_revision_pin` 이 현재 N 의 객체 revision 과 다름
- N 의 SliceMerge 가 새로 SM_MERGED 됨 (trunk 가 전진)
- N 의 RefactorBacklog 에 새 architectural debt indicator 가 등록됨 (Discovery 의 input 으로 사용된 항목 한정)

### Caller Action

| 감지 대상 | 전이 |
|---|---|
| N+1 의 outer Discovery / Specification session | SESSION_OPEN → AWAITING_REVALIDATION |
| N+1 의 milestone state | 변경 없음 (session 만 stale) |
| N+1 의 manifest | 다음 turn 시작 시 자동 재계산 |

AWAITING_REVALIDATION 의 exit path 는 `#SOC-SESSION-LIFECYCLE` 표를 따른다.

<a id="RGC-CROSS-SLOT-FAIRNESS"></a>
## RGC-CROSS-SLOT-FAIRNESS: Cross-Slot Fairness

dual-track (Delivery N + Discovery N+1) 의 worker slot 공유는 다음을 따른다.

### Resource Sharing 정책

| 정책 | 의미 |
|---|---|
| AgentProfile slot 은 milestone-agnostic | atlas 1 worker 가 N+1 Discovery + N Planning 을 번갈아 servicing |
| `target.dual_track.priority` | `delivery_first` (default) / `balanced` / `discovery_first` — TCC-DUAL-TRACK |
| WIP limit per profile | `loop_policies.<loop>.<phase|purpose>.concurrent_sessions` |
| Fairness oscillation 차단 | promotion guard 가 우선 enforce. fairness telemetry 누적 후 enable (Stage 4 까지 warn) |

### Telemetry

cross-slot fairness 위반 (예: 한 slot 이 다른 slot 의 worker 를 starve) 은 ledger 에 별도 entry 로 기록되지 않으나, `loop_policies.<loop>.<phase|purpose>.session_idle_seconds_p99` 같은 metric 으로 관측한다 (TCC-DUAL-TRACK).

<a id="RGC-DUAL-GATE-QUEUE"></a>
## RGC-DUAL-GATE-QUEUE: Dual-Gate Queue

intake → Discovery → Delivery 의 promotion 을 단일 gate-queue 로 처리한다.

### Queue 구조

| Queue | 진입 | 출입 |
|---|---|---|
| `intake_queue` | `M_INTAKE_QUEUED` 의 milestone | Discovery slot 빔 + slot_lock 획득 시 dequeue → `M_DISCOVERY_DRAFT` |
| `delivery_promotion_queue` | `M_SPEC_APPROVED` 의 milestone | Delivery slot 빔 + promotion_guard 통과 + slot_lock 획득 시 dequeue → `M_DELIVERY_PLANNING` |

### Queue 처리 정책

- FIFO (oldest-ready-first) — `#RGC-FAIRNESS` 의 within-queue 정책.
- Promotion guard 차단된 항목은 큐에서 빠지지 않고 다음 cycle 에서 재평가.
- Queue 의 head 가 차단되어도 tail 은 평가되지 않음 (직렬화).

### Idempotency

같은 milestone_id 가 큐에 중복 enqueue 되면 ledger 의 `duplicate` 로 흡수한다.

<a id="RGC-RECOVERY"></a>
## RGC-RECOVERY: Recovery

Recover 는 Caller 또는 Caller 가 위임한 sweeper 가 수행한다. 사람은 회수 요청 시그널을 남길 수 있지만 실제 회수 전이는 Caller 가 수행한다.

Recover 입력:

- lease 만료 (slot / slice / session / turn 의 어느 lease 든)
- 임계 시간 초과
- revision pin 재검증 실패
- invalid Agent output
- 사람의 회수 요청 시그널
- inner loop 의 no_progress / regression / scope_violation 한도 초과

Recover 전이는 `docs/contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION` 의 표를 따른다.

직전 READY 상태가 없는 상태는 다음 정책을 따른다.

| 현재 상태 | 자동 recover | 사람 signal 필요 | 처리 |
|---|---|---|---|
| `M_*_AWAITING_HUMAN` | timeout 시 yes | optional | `loop_policies.outer.<phase>.timeout` 도과 시 `*_DRAFT` 회수. stale `human_approval` 이면 contribution 만 stale 처리하고 session 재오픈 |
| `SLICE_BLOCKED` | no | yes | 자동 재개방 금지. `request_rework` signal 후 `SLICE_READY` 회수 |
| `SM_STALE` | yes (한도 내) | optional | trunk rebase + verification 재실행. 한도 초과 시 SLICE_BLOCKED |
| `SM_CLOSED` | no | no | terminal. 후속 변경은 새 SliceMerge |
| `SM_MERGED` | no | no | terminal |
| `SLICE_VALIDATED` | no | no | terminal-ish (Validation 결과로 회수될 수 있음) |
| `SESSION_OPEN` (lease 만료) | yes | no | 다음 turn 의 input 합성 시 manifest 재계산 + verification 재실행. 같은 turn_index CAS 로 동시성 보호 |
| `AWAITING_REVALIDATION` | yes (한도 내) | optional | verification 재실행 — pass 시 SESSION_OPEN 복귀, 한도 초과 시 TIMEOUT |
| `M_DONE` | no | no | terminal |
| `M_ESCALATED` | no | yes | 사람 signal 에 따라 회수, 중단, amendment, 재시도 중 하나 집행 |

<a id="RGC-FAILURE"></a>
## RGC-FAILURE: Failure Classes

| 종류 | 의미 | 기본 처리 |
|---|---|---|
| STALE | lease 만료, timeout, revision mismatch | 직전 READY 로 회수 |
| FAIL | Agent 실패 결정문, 결정적 검증 실패, invalid output | 재시도 한도 내 회수 |
| ESCALATED | 자동 복구 불가, 재시도 한도 초과, 정책 위반 | human gate (governance signal) |

자동 재시도는 유한하다. 한도 초과 시 ESCALATED 로 전이한다 (`llm-team.md` Finite retry).

### Retry / Escalation 운영 정책 (헌법이 위임한 영역)

| 영역 | 정책 |
|---|---|
| Inner loop max_turns | `loop_policies.inner.tdd_build.max_turns` (default: 보수적, dogfood 후 조정) |
| Inner no_progress threshold | `loop_policies.inner.tdd_build.no_progress_streak` (default: 3 turn newly_green=0) |
| Inner regression threshold | `loop_policies.inner.tdd_build.regression_streak` (default: 1 — refactor turn 의 즉시 rollback 외 한도) |
| Middle review max_attempts | `loop_policies.middle.review.max_attempts` |
| Outer Discovery / Specification timeout | `loop_policies.outer.<phase>.timeout` |
| SliceMerge revalidation 한도 | `loop_policies.middle.merge.max_revalidation_attempts` |
| Acceptance test scope violation 한도 | `loop_policies.inner.tdd_build.max_attempts_per_turn` |

위 매개변수는 모두 TCC 의 운영 결정이며, 본 contract 는 *유한* 만 보장한다. 한도 초과 시 객체는 ESCALATED 로 전이하고 governance signal 대기.

결정적 검증 실패는 LLM 해석 없이도 FAIL 의 1급 증거다.

### Multi-step operational write 의 부분 실패

하나의 operation 이 다단 operational write 로 구성되는 경우 (예: slot promotion 의 4 단계, slice DAG 일괄 영속화) Caller 는 다음을 따른다.

- 단계 사이의 부분 실패는 실패로 간주한다. 일부 단계만 적용된 상태를 그대로 두지 않는다.
- Caller 는 이미 적용된 단계를 *원복* 한다. 원복은 직전 단계의 역연산으로 정의되며, 가능하지 않은 경우 객체를 ESCALATED 로 전이한다.
- 원복 결과는 `RGC-LEDGER` 의 `result` 로 분류한다. 부분 적용분이 모두 원복되면 `rolled_back`, 원복 자체가 실패하면 `escalated` 로 기록한다.
- 원복 단계 자체도 ledger 에 기록한다.

부분 실패의 흔적이 영속 저장소에 남으면 후속 cycle 의 입력이 오염된다.

<a id="RGC-VERIFICATION"></a>
## RGC-VERIFICATION: Deterministic Verification & Required Evidence

빌드, 테스트, 린트, 타입체크, 정적 분석, metric 측정, interface diff 는 Caller 가 실행한다. Agent 는 실행하지 않고 로그를 해석한다.

### VerificationRun

| 필드 | 의미 |
|---|---|
| `verification_run_id` | 식별자 |
| `target_id` | 대상 작업 영역 |
| `target_revision` | 검증 시점의 trunk 또는 workspace SHA |
| `commands_or_checks` | 실행한 명령 / check 식별자 |
| `environment_fingerprint` | 환경 식별 hash (의존, 도구 버전 등) |
| `started_at` / `finished_at` | 시각 |
| `result` | enum: `pass` / `fail` / `error` |
| `failed_tests[]` | acceptance 또는 deterministic test 실패 목록 |
| `log_ref` | 상세 로그 참조 |

### MetricRun

| 필드 | 의미 |
|---|---|
| `metric_run_id` | 식별자 |
| `metric_name` | `target.refactor_metrics.<name>` 의 항목 |
| `target_revision` | 측정 시점 revision |
| `value` | 측정값 |
| `comparator` / `threshold` | 정책 |
| `result` | `met` / `unmet` |

### Required Evidence 평가

session termination 시 `required_evidence[]` 의 각 항목이 충족되었는지 Caller 가 평가한다 (`SOC-SESSION-TERMINATION` 의 `composite_rule`).

| Evidence Kind | 만족 조건 |
|---|---|
| `verification_green` | 가장 최근 VerificationRun.result=pass + acceptance_tests 의 failed[] 빈 |
| `metric_threshold` | 가장 최근 MetricRun.result=met |
| `interface_diff_clean` | VerificationRun 의 interface diff 항목 0건 |
| `coverage_threshold` | VerificationRun 의 coverage value ≥ threshold |

evidence 의 권위는 agent verdict 보다 우위다 (`llm-team.md` Inv #6).

검증 환경과 실행 조건은 재현 가능해야 한다. 로그는 Context Manifest entry 로 Agent 에 전달된다.

### 실행 시점 (Loop 별)

VerificationRun 의 실행은 loop 별로 schedule 이 다르다. dialogue coordinator 가 단일 권위로 schedule 하며, agent 가 직접 호출하지 않는다.

| Loop · Phase / Purpose | 실행 시점 | 동기 / 비동기 |
|---|---|---|
| inner tdd_build | turn 직후 (turn worker 가 patch 적용 + commit 직후 즉시) | **동기** — 결과가 다음 turn 의 `prior_verification_result_ref` 입력이 되므로, 결과가 영속화되기 전에는 다음 turn enqueue 금지 |
| middle review | session_outcome 응축 직전 또는 SliceMerge 전이 시점 | **비동기** — required_evidence 평가 완료 후 진행. evidence 부재 시 session 은 `AWAITING_REVALIDATION` 으로 보류 |
| outer Validation | acceptance 평가 단계 | **비동기** — cross-slice 검증을 위해 trunk merge 이후 별도 schedule |
| outer Discovery / Specification / Planning | (기본 미실행) | spec/ADR 산출은 결정적 검증 대상이 아님. metric run 이 evidence 로 명시된 경우에 한해 실행 |

VerificationRun 의 storage path 와 ID 발급 알고리즘은 본 contract 가 정의하지 않으며 architecture 문서가 결정한다 (KAC-SESSION-LOG-STORAGE 가 session_log 와 분리됨을 명시한다 — verification 본문은 SessionTurn 의 `verification_result` 필드가 식별자만 보유한다).

<a id="RGC-HUMAN-CONTRIBUTION"></a>
## RGC-HUMAN-CONTRIBUTION: Human Contribution

사람 승인은 별도 governance gate 가 아니라 `human` AgentProfile 의 contribution 으로 일원화된다. **`feature` slice 의 outer Discovery / Specification** 에서 필수.

### Scope

- `feature` slice 의 outer Discovery / Specification 의 session termination 에서 `human` participant 의 `human_approval` contribution 이 final artifact 응축 조건에 포함되어야 한다.
- `internal` slice 는 `target.internal_escalation_rules` (TCC-SLICE-CLASS-RULES) 의 1개라도 hit 시 자동 `feature` 게이트로 승격되어 `human` contribution 이 요구된다 — Caller 가 slice promotion 시점에 escalation 평가 후 결정.

### Contribution 변환 path

1. Caller 가 signal envelope 유효성을 검증 (서명, target_revision_pin, related_object_revision_pin, signal_id 중복).
2. 검증을 통과한 signal 을 `human` profile 의 `human_approval` contribution envelope 으로 변환:
   - `session_id`, `turn_index`: signal 의 target session 과 다음 turn_index
   - `agent_profile_id = "human"`, `contribution_kind = "human_approval"`
   - `verdict.result = "approve"` 또는 `"reject"`
   - `summary`, `rationale`: signal 의 `rationale`
3. envelope 을 영속 큐에 enqueue. dialogue_coordinator 가 다음 cycle 에서 session termination 평가에 포함시킨다.

### 권위 보장

- `feature` slice 의 outer Discovery / Specification 에서 `human_approval` contribution 이 누락된 채 session 을 CONVERGED 로 종착시키는 것은 invariant 위반이다.
- `verdict.result=reject` 인 `human_approval` 은 finalization rule (`quorum_then_lead`) 의 `human` required 조건에 의해 session 을 차단한다. 다른 reviewer 의 approve 가 reject 를 압도하지 않는다.
- 사람 contribution 도착 후 대상 객체가 변했으면 stale 로 판정하고 재승인을 요구한다 (lease_token / revision_pin 비교).

### 표준 사용

| Loop · Phase | 기본 `required_participants` 권장 (feature slice) | 의미 |
|---|---|---|
| outer Discovery | `human` | milestone 본문이 사람의 product 의도와 일치하는지 확인 |
| outer Specification | `human` | 시나리오·AC 가 사람의 결정과 일치하는지 확인 |
| middle review | (default 없음, 단 internal escalation hit 시 추가) | escalation rule hit 시 |
| outer Validation | (default 없음, release governance 외부 처리) | — |

### ESCALATED 객체

`ESCALATED` 객체는 loop 와 무관한 governance state 다. `request_recover` / `request_rework` / `amendment_approve` / `cross_milestone_amendment` / `stop` 신호 중 하나를 사람이 남기면 Caller 가 집행한다.

<a id="RGC-LEDGER"></a>
## RGC-LEDGER: Transition Ledger

모든 operational transition 은 ledger 에 기록되어야 한다.

### 필수 필드

| 필드 | 의미 |
|---|---|
| `transition_id` | 전이 식별자 |
| `target_id` | 전이가 발생한 작업 영역의 식별자(`docs/contracts/target-config-contract.md#TCC-IDENTITY`) |
| `object_id` | 대상 객체 (milestone / slice / dialogue_session / session_turn / slice_merge / verification_run / metric_run / system) |
| `object_kind` | 위 enum 중 하나 |
| `from_state` | 이전 상태 |
| `to_state` | 다음 상태 |
| `loop_kind` | `outer` / `middle` / `inner` / 없으면 null. 사용처: session 단위 transition 분류 |
| `phase` | outer-loop transition 한정 (`Discovery` / `Specification` / `Planning` / `Validation`). 그 외 null |
| `slice_id` | 관련 slice 식별자 (slice / inner / middle transition), 없으면 null |
| `slice_kind` | 관련 slice class (`feature` / `internal`), 없으면 null |
| `dod_revision` | slice 의 dod_revision_pin (slice 단위 transition 한정), 없으면 null |
| `session_id` | 관련 DialogueSession 식별자, 없으면 null |
| `turn_index` | session-local turn 인덱스, 없으면 null |
| `slot_kind` | `discovery` / `delivery` (slot 관련 transition 한정), 없으면 null |
| `agent_profile_id` | 관련 AgentProfile id, 없으면 null. legacy `agent_role` 폐기 |
| `contribution_kind` | 관련 contribution_kind, 없으면 null |
| `action_kind` | 폭넓은 분류 — `intake` / `slot_promotion` / `session_progress` / `session_finalize` / `slice_merge` / `verification` / `recover` / `pause_resume` / `signal_apply`. legacy `operation` 폐기 |
| `final_verdict` | session_finalize 시 (state, final_verdict) tuple 의 verdict, 없으면 null |
| `caller_id` | 전이를 집행한 Caller |
| `manifest_id` | 관련 Context Manifest |
| `input_revision_pins` | 입력 revision pin 집합 |
| `output_hash` | Agent output 또는 산출물 hash |
| `verification_run_id` | 관련 검증 실행, 없으면 null |
| `metric_run_id` | 관련 metric 측정, 없으면 null |
| `idempotency_key` | 중복 방지 키 (3-scope 중 하나 — `SOC-IDEMPOTENCY`) |
| `lease_token` | 전이를 보호한 lease token, 없으면 null |
| `lease_kind` | `slot_lock` / `slice_lease` / `session_lease` / `turn_lease`, lease 미사용 시 null |
| `result` | 전이 결과 분류 |
| `result_detail` | 결과의 부가 분류, 없으면 null |
| `timestamp` | 전이 시각 |

### Append-compatible 정책

legacy schema 의 row 는 immutable. 신규 row 는 새 schema 로 작성. parser 는 union read 로 양 schema 를 동시 지원 (Stage 2 ledger.sh rewrite 의 invariant — `docs/superpowers/specs/2026-05-05-loop-based-workflow-design.md` §12).

legacy `agent_role`, `operation`, `phase_run_id`, `quorum_decision` 필드는 본 ledger 에서 폐기 (신규 row 한정. 과거 row 는 보존되며 historical reader 가 union read).

### Result 분류

`result` 는 전이의 종착 분류를 표현한다.

| 값 | 의미 |
|---|---|
| `applied` | 전이가 의도대로 완료 |
| `noop` | 전이 조건이 충족되지 않아 부작용 없이 종료 |
| `claim_failed` | lease 점유 경쟁에서 패배 |
| `duplicate` | 동일 idempotency key 의 선행 기록을 발견하여 부작용 없이 수렴 |
| `invalid` | Agent output 또는 입력 검증 실패 |
| `stale` | 입력 revision pin 또는 lease token 이 현재 상태와 불일치 |
| `error` | 인프라 오류 |
| `recovered` | sweeper 가 만료 lease 를 회수 |
| `rolled_back` | multi-step 전이의 부분 적용을 원복 (`#RGC-FAILURE`) |
| `escalated` | 자동 복구가 불가능하여 human gate 로 진입 |

### Result Detail

`result_detail` 은 `result` 의 동일 분류 안에서 원인을 더 좁힌다. 자유 식별자이며 운영 분석과 retry 정책 결정에 사용된다.

같은 `result` 라도 `result_detail` 이 다르면 별개의 사례로 본다.

`result_detail` 의 어휘는 본 contract 가 고정 enum 으로 정의하지 않는다.

<a id="RGC-PAUSE"></a>
## RGC-PAUSE: System Pause

시스템은 전역 control state 를 가진다.

```text
RUNNING | PAUSED | STOPPED
```

`PAUSED` 상태에서 Caller 는 새 lease (어떤 kind 든) 를 claim 하지 않는다. 이미 진행 중인 lease 는 정책에 따라 완료를 기다리거나 stale recovery 대상이 된다.

`STOPPED` 상태도 새 lease claim 을 차단한다. `STOPPED` 는 운영자가 현재 군집을 종료하려는 terminal-ish control state 이며, `resume` signal 의 직접 대상이 아니다. 다시 실행하려면 운영자는 새 daemon/caller 시작 절차를 수행해야 하며, 그 시작은 `#RGC-DAEMON-STARTUP` 의 atomicity 정책을 따른다.

<a id="RGC-NOTIFICATION"></a>
## RGC-NOTIFICATION: Notification

모든 알림은 Caller 가 송신한다. Agent 는 알림 채널을 직접 호출하지 않는다.

알림은 push-only 이며 사람 응답을 기다리지 않는다. 작업 차단은 알림이 아니라 gate 상태로 표현한다.

<a id="RGC-FAIRNESS"></a>
## RGC-FAIRNESS: Within-Scope Scheduler Fairness

같은 scope (slot queue, slice queue, session queue) 의 동일 우선순위 ready 객체는 oldest-ready-first 로 claim 한다. 명시적 priority 가 있는 경우에만 예외를 허용한다. priority 예외도 transition ledger 에 기록해야 한다.

cross-slot fairness 는 `#RGC-CROSS-SLOT-FAIRNESS` 가 별도로 정의한다.

### Concurrent Sessions Hard Default

dialogue coordinator 가 동시에 SESSION_OPEN 상태로 진행하는 session 의 수는 default 로 **1 (fail-serial)** 이다. 본 default 는 session 진행의 직렬화를 보장하여 turn worker 의 race 와 ledger 충돌을 차단한다.

`target.concurrent_sessions` (`docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES`) 가 명시된 경우에 한해 1 보다 큰 값으로 override 할 수 있다. override 시 다음을 만족해야 한다.

- slice_lease 의 acquisition order 가 보존되어야 한다 (`#RGC-LEASE-KINDS`).
- 동일 slice 의 inner session 과 middle session 이 동시에 진행되는 상황은 어떤 override 값에서도 허용되지 않는다 (`docs/contracts/state-and-operation-contract.md#SOC-SESSION-LIFECYCLE` 의 dispatch 책임 절).

override 값이 명시되지 않은 시스템은 정량 cap 1 을 적용한다.

<a id="RGC-DAEMON-STARTUP"></a>
## RGC-DAEMON-STARTUP: Daemon Startup Atomicity

다중 AgentProfile worker 와 dialogue_coordinator + dual_track_scheduler 를 동시에 기동하는 Caller 군집은 *원자적* 으로 시작해야 한다. 부분 시작은 invariant 위반으로 본다.

### 시작 전 조건

Caller 군집은 새 worker 를 띄우기 전에 다음을 모두 만족해야 한다.

- 기존 worker 와의 lock 충돌이 없음을 사전 검사한다. 충돌이 있으면 *어떤* 새 worker 도 기동하지 않는다.
- 운영 진입 게이트 (예: 환경 점검, 필수 설정 검증, lease.sh 의 acquisition order CI 통과) 가 통과한 상태여야 한다. 게이트 실패 시 군집 전체 시작을 중단한다.

### 부분 실패 처리

군집 시작 중 특정 worker 기동이 실패한 경우 Caller 는 다음을 수행한다.

- 이미 기동된 sibling worker 를 모두 정지시킨다.
- 정지 결과는 `#RGC-LEDGER` 에 `rolled_back` 으로 기록한다. 본 ledger 행의 `object_kind` 는 `system`, `object_id` 는 군집 식별자다.
- 정지가 불가능한 sibling 이 있으면 시작을 *전체 미시작* 상태로 수렴시킬 수 없으므로 사람에게 즉시 알리고 군집 시작 자체를 중단한다. ledger result 는 `escalated` 로 기록한다.

### 운영 의의

부분적으로만 기동된 군집은 `#RGC-FAIRNESS` 의 oldest-ready-first 가정을 깨고, 일부 AgentProfile 의 큐가 무한히 적체되거나 dialogue_coordinator 부재로 session termination 평가가 멈춘다. 따라서 모든 기동은 "전체 성공" 또는 "전체 미시작" 두 상태만 허용한다.

stop/resume signal 에 의한 정상 종료·재개는 본 절의 atomicity 와 무관하다. 본 절은 *시작 시점* 에만 적용된다.
