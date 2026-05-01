# Reliability and Gate Contract

본 문서는 lease, stale recovery, retry, human gate, deterministic verification, transition ledger, pause 정책을 정의한다.

<a id="RGC-SCOPE"></a>
## RGC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- governance/input write와 operational write 집행
- lease와 worker slot
- stale, FAIL, ESCALATED 처리
- deterministic verification
- human gate
- transition ledger
- notification과 pause

상태명과 operation별 전이는 `docs/contracts/state-and-operation-contract.md`가 정의한다.

<a id="RGC-WRITES"></a>
## RGC-WRITES: Write Classes

영속 저장소 write는 두 종류다.

| 종류 | 주체 | 예 |
|---|---|---|
| governance/input write | Human | 아이디어 입력, 승인·거부·중단·회수 시그널, 모델 수정 승인 |
| operational write | Caller | 상태 전이, 라벨 변경, CP 생성·병합, Issue 생성·종료, lease, 알림, 회수 |

사람의 governance/input write는 workflow를 직접 전이하지 않는다. Caller가 이를 감지하고 revision pin을 재검증한 뒤 operational write로 집행한다.

<a id="RGC-SIGNALS"></a>
## RGC-SIGNALS: Human Signal Schema

모든 governance/input signal은 공통 envelope를 가져야 한다.

| 필드 | 필수 | 의미 |
|---|---|---|
| `signal_id` | yes | signal 식별자 |
| `signal_type` | yes | `approve`, `reject`, `request_rework`, `request_recover`, `pause`, `resume`, `amendment_approve`, `stop` 중 하나 |
| `target_kind` | yes | milestone, task, change_proposal, system, contract 등 |
| `target_id` | yes | 대상 객체 식별자. system-wide signal이면 `system` |
| `target_revision_pin` | conditional | 대상 객체가 revision을 제공하면 필수 |
| `related_change_proposal_id` | conditional | gate 승인·거부가 CP에 연결될 때 필수 |
| `related_change_proposal_revision_pin` | conditional | 관련 CP가 있을 때 필수 |
| `actor` | yes | signal을 남긴 사람 |
| `created_at` | yes | signal 생성 시각 |
| `rationale` | recommended | 승인·거부·중단·모델 수정 사유 |

Caller는 signal 집행 전에 다음을 검증한다.

- `signal_type`이 대상 상태에서 허용되는지
- `target_revision_pin`이 현재 대상 revision과 일치하는지
- 관련 CP가 있으면 `related_change_proposal_revision_pin`이 현재 CP revision과 일치하는지
- 동일 `signal_id`가 이미 집행되지 않았는지

검증 실패 시 Caller는 signal을 stale 또는 invalid로 기록하고 operational transition을 수행하지 않는다. 사람이 새 signal을 남겨야 한다.

Signal별 허용 대상과 기본 집행:

| `signal_type` | 허용 대상 | 허용 상태 | Caller action |
|---|---|---|---|
| `approve` | milestone + related Spec CP | `PO_GATE`, `PM_GATE` | 관련 Spec CP 병합 후 다음 milestone 상태로 전이 |
| `reject` | milestone + related Spec CP | `PO_GATE`, `PM_GATE` | 관련 Spec CP를 `CP_REQUEST_CHANGES -> CP_CLOSED`로 닫고 draft 상태로 회수 |
| `request_rework` | task 또는 change_proposal | `ESCALATED`, `CP_REQUEST_CHANGES`, `CP_CLOSED` | 대상 Task를 `TASK_READY`로 회수하거나 새 CP 생성을 허용 |
| `request_recover` | milestone, task, change_proposal | `ESCALATED`, `CP_STALE`, stale gate state | 가장 가까운 safe READY 상태로 회수 |
| `pause` | system | `RUNNING` | 전역 control state를 `PAUSED`로 전이 |
| `resume` | system | `PAUSED` | 전역 control state를 `RUNNING`으로 전이 |
| `amendment_approve` | contract 또는 concept document | pending amendment CP | Caller가 amendment CP를 병합 |
| `stop` | system, milestone, task | any non-terminal state | 새 lease claim 중단. 대상이 있으면 ESCALATED로 전이 |

<a id="RGC-LEASE"></a>
## RGC-LEASE: Lease and Worker Slots

Caller는 `*_READY -> *_IN_PROGRESS` 전이 시 lease를 발급한다.

Lease 필수 속성:

- `lease_id`
- `object_id`
- `operation`
- `worker_id`
- `claimed_at`
- `expires_at`
- `input_revision_pins`

동일 객체에는 동시에 하나의 active lease만 존재할 수 있다. 다중 Caller 구현은 객체 단위 compare-and-set, lock, 또는 lease 원자성을 제공해야 한다.

Worker slot은 역할별로 독립된다. Coder slot과 Reviewer slot은 서로 영향을 주지 않는다.

<a id="RGC-RECOVERY"></a>
## RGC-RECOVERY: Recovery

Recover는 Caller 또는 Caller가 위임한 sweeper가 수행한다. 사람은 회수 요청 시그널을 남길 수 있지만 실제 회수 전이는 Caller가 수행한다.

Recover 입력:

- lease 만료
- 임계 시간 초과
- revision pin 재검증 실패
- invalid Agent output
- 사람의 회수 요청 시그널

Recover 전이:

```text
*_IN_PROGRESS -> 직전 *_READY
*_IN_PROGRESS -> ESCALATED
```

직전 READY 상태가 없는 상태는 다음 정책을 따른다.

| 현재 상태 | 자동 recover | 사람 signal 필요 | 처리 |
|---|---|---|---|
| `PO_GATE` | no | yes | stale approval이면 gate 유지. reject/request_recover signal이면 `PO_DRAFT` 회수 |
| `PM_GATE` | no | yes | stale approval이면 gate 유지. reject/request_recover signal이면 `PM_DRAFT` 회수 |
| `CP_CLOSED` | no | yes | 자동 재개방 금지. request_rework signal 후 새 CP로 재진입 |
| `CP_STALE` | no | optional | 동일 입력 revision이면 새 CP 생성. 대상 revision이 변했으면 재호출 필요 |
| `CP_MERGED` | no | no | terminal. 후속 변경은 새 CP로 처리 |
| `DONE` | no | no | terminal. 후속 작업은 새 Milestone으로 처리 |
| `ESCALATED` | no | yes | 사람 signal에 따라 회수, 중단, amendment, 재시도 중 하나 집행 |

<a id="RGC-FAILURE"></a>
## RGC-FAILURE: Failure Classes

| 종류 | 의미 | 기본 처리 |
|---|---|---|
| STALE | lease 만료, timeout, revision mismatch | 직전 READY로 회수 |
| FAIL | Agent 실패 결정문, 결정적 검증 실패, invalid output | 재시도 한도 내 회수 |
| ESCALATED | 자동 복구 불가, 재시도 한도 초과, 정책 위반 | human gate |

자동 재시도는 유한하다. 한도 초과 시 ESCALATED로 전이한다.

결정적 검증 실패는 LLM 해석 없이도 FAIL의 1급 증거다. 다만 책임 Task 식별이나 설명이 필요하면 Reviewer/QA를 호출할 수 있다.

<a id="RGC-VERIFICATION"></a>
## RGC-VERIFICATION: Deterministic Verification

빌드, 테스트, 린트, 타입체크, 정적 분석은 Caller가 실행한다. Agent는 실행하지 않고 로그를 해석한다.

Verification Run 필수 필드:

- `verification_run_id`
- `target_id`
- `target_revision`
- `commands_or_checks`
- `environment_fingerprint`
- `started_at`
- `finished_at`
- `result`
- `log_ref`

검증 환경과 실행 조건은 재현 가능해야 한다. 로그는 Context Manifest entry로 Agent에 전달된다.

<a id="RGC-HUMAN-GATES"></a>
## RGC-HUMAN-GATES: Human Gates

표준 gate는 3개다.

1. PO 산출물 검토
2. PM 산출물 검토
3. ESCALATED 객체 검토

Gate 진입 객체는 사람의 승인·거부 시그널 전까지 다음 큐로 진행하지 않는다. Caller 프로세스는 다른 큐 처리를 계속한다.

사람의 승인·거부는 직접 병합이나 직접 상태 전이가 아니다. Caller는 다음을 확인한 뒤 집행한다.

- `RGC-SIGNALS` envelope 유효성
- 대상 객체 revision pin 일치
- 관련 Change Proposal revision pin 일치
- gate 대상과 승인 시그널의 target 일치
- 정책 위반 없음

승인 시그널 이후 대상 객체가 변했으면 stale approval로 보고 재승인을 요구한다.

Gate별 기본 집행:

- PO 승인: 관련 Spec CP를 `CP_READY_FOR_HUMAN_GATE -> CP_HUMAN_APPROVED -> CP_MERGED`로 전이하며 병합, `PO_GATE -> PM_DRAFT`
- PO 거부: `PO_DRAFT` 회수 또는 ESCALATED
- PM 승인: 관련 Spec CP를 `CP_READY_FOR_HUMAN_GATE -> CP_HUMAN_APPROVED -> CP_MERGED`로 전이하며 병합, `PM_GATE -> DECOMPOSE_READY`
- PM 거부: `PM_DRAFT` 회수 또는 ESCALATED
- ESCALATED: 사람 시그널에 따라 재시도, 회수, 중단, 모델 수정 승인 중 하나를 Caller가 집행

<a id="RGC-LEDGER"></a>
## RGC-LEDGER: Transition Ledger

모든 operational transition은 ledger에 기록되어야 한다.

필수 필드:

| 필드 | 의미 |
|---|---|
| `transition_id` | 전이 식별자 |
| `object_id` | 대상 객체 |
| `object_kind` | milestone, task, change_proposal 등 |
| `from_state` | 이전 상태 |
| `to_state` | 다음 상태 |
| `operation` | 전이를 만든 operation |
| `caller_id` | 전이를 집행한 Caller |
| `agent_role` | 관련 Agent 역할, 없으면 null |
| `manifest_id` | 관련 Context Manifest |
| `input_revision_pins` | 입력 revision pin 집합 |
| `output_hash` | Agent output 또는 산출물 hash |
| `verification_run_id` | 관련 검증 실행, 없으면 null |
| `idempotency_key` | 중복 방지 키 |
| `timestamp` | 전이 시각 |

Ledger는 감사, 재현, 장애 복구의 기준이다.

<a id="RGC-PAUSE"></a>
## RGC-PAUSE: System Pause

시스템은 전역 control state를 가진다.

```text
RUNNING | PAUSED
```

`PAUSED` 상태에서 Caller는 새 lease를 claim하지 않는다. 이미 진행 중인 lease는 정책에 따라 완료를 기다리거나 stale recovery 대상이 된다. 사람은 governance/input signal로 pause와 resume을 요청하고, Caller가 이를 집행한다.

<a id="RGC-NOTIFICATION"></a>
## RGC-NOTIFICATION: Notification

모든 알림은 Caller가 송신한다. Agent는 알림 채널을 직접 호출하지 않는다.

알림은 push-only이며 사람 응답을 기다리지 않는다. 작업 차단은 알림이 아니라 gate 상태로 표현한다.

<a id="RGC-FAIRNESS"></a>
## RGC-FAIRNESS: Scheduler Fairness

동일 우선순위의 ready 객체는 oldest-ready-first로 claim한다. 명시적 priority가 있는 경우에만 예외를 허용한다. priority 예외도 transition ledger에 기록해야 한다.
