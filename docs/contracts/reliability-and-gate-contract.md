# Reliability and Gate Contract

본 문서는 lease, stale recovery, retry, 사람 contribution, deterministic verification, transition ledger, pause 정책을 정의한다. AgentProfile 별 worker slot 과 PhaseRun coordinator 의 lease 메커닉, 그리고 사람 결정의 권위를 보존하는 quorum 통합 규칙을 다룬다.

<a id="RGC-SCOPE"></a>
## RGC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- governance/input write 와 operational write 집행
- AgentProfile 별 worker slot 과 PhaseRun coordinator 의 lease
- stale, FAIL, ESCALATED 처리, contribution 단위 회수
- deterministic verification
- 사람 contribution (`human` AgentProfile) 의 처리와 권위 보장
- transition ledger
- notification 과 pause

상태명과 phase 별 전이는 `docs/contracts/state-and-operation-contract.md` 가, AgentProfile / phase policy schema 는 `docs/contracts/target-config-contract.md` 가 정의한다.

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
| `target_id` | yes | signal 의 *대상* 식별자. system-wide signal이면 `system`. `TCC-IDENTITY.target_id`(작업 영역 식별자)와 다른 개념이며, 본 표의 `target_kind` 가 둘을 구분한다 |
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

Signal 별 허용 대상과 기본 집행:

| `signal_type` | 허용 대상 | 허용 상태 | Caller action |
|---|---|---|---|
| `approve` | milestone + related Spec CP | `DISCOVERY_AWAITING_HUMAN`, `SPECIFICATION_AWAITING_HUMAN` | signal 을 `human` AgentProfile 의 `human_approval` contribution envelope 으로 변환하여 영속 큐에 enqueue. `application/phase_coordinator.sh` 가 quorum 평가 후 Spec CP 병합 + 다음 milestone 상태로 전이 |
| `reject` | milestone + related Spec CP | `DISCOVERY_AWAITING_HUMAN`, `SPECIFICATION_AWAITING_HUMAN` | signal 을 `human_approval` (verdict.result=reject) contribution 으로 변환. quorum 평가는 `request_changes_blocks=true` 정책을 따라 phase 종착을 차단하고 직전 `*_DRAFT` 로 회수, 관련 Spec CP 를 `CP_REQUEST_CHANGES -> CP_CLOSED` 로 닫음 |
| `request_rework` | task 또는 change_proposal | `ESCALATED`, `CP_REQUEST_CHANGES`, `CP_CLOSED` | 대상 Task 를 `TASK_READY` 로 회수하거나 새 CP 생성을 허용 |
| `request_recover` | milestone, task, change_proposal, phase_run, contribution | `ESCALATED`, `CP_STALE`, stale `*_AWAITING_*` state, stale contribution | 가장 가까운 safe READY 상태로 회수 (contribution 단위는 `CONTRIB_FAILED` 또는 `CONTRIB_STALE` 로 전이) |
| `pause` | system | `RUNNING` | 전역 control state 를 `PAUSED` 로 전이 |
| `resume` | system | `PAUSED` | 전역 control state 를 `RUNNING` 으로 전이 |
| `amendment_approve` | contract 또는 concept document | pending amendment CP | Caller 가 amendment CP 를 병합 |
| `stop` | system, milestone, task, phase_run | any non-terminal state | system 대상이면 전역 control state 를 `STOPPED` 로 전이하고 새 lease claim 을 중단. workflow 대상이 있으면 ESCALATED 로 전이 |

`approve` / `reject` 신호는 별도 governance gate 가 아니라 `human` AgentProfile 의 contribution 으로 일원화된다 (`#RGC-HUMAN-CONTRIBUTION`). 사람 결정의 권위는 absolute 이며, agent quorum 이 사람 contribution 을 대체할 수 없다.

<a id="RGC-PHASE-LEASE"></a>
## RGC-PHASE-LEASE: Lease and Worker Slots

Caller 는 다음 두 종류의 lease 를 발급한다.

1. **Contribution lease**: AgentProfile 별 worker 가 `(phase_run_id, agent_profile, contribution_kind)` 단위로 발급. `CONTRIB_PENDING -> CONTRIB_IN_PROGRESS` 전이를 보호한다.
2. **PhaseRun coordinator lease**: `application/phase_coordinator.sh` 가 PhaseRun 별로 발급. `*_AWAITING_QUORUM` 상태에서 quorum 평가와 final artifact 압축을 보호한다.

Lease 필수 속성:

- `lease_id`
- `lease_kind` (`contribution` 또는 `phase_coordinator`)
- `object_id` (contribution lease 면 `(phase_run_id, agent_profile, contribution_kind)`, coordinator lease 면 `phase_run_id`)
- `phase`
- `agent_profile` (contribution lease 한정)
- `contribution_kind` (contribution lease 한정)
- `worker_id`
- `claimed_at`
- `expires_at`
- `input_revision_pins`
- `lease_token`

동일 객체에는 동시에 하나의 active lease 만 존재할 수 있다. 다중 Caller 구현은 객체 단위 compare-and-set, lock, 또는 lease 원자성을 제공해야 한다.

Worker slot 은 AgentProfile 별로 독립된다. `forge` slot 과 `sentinel` slot 은 서로 영향을 주지 않는다. PhaseRun coordinator slot 은 별도 차원이며 contribution worker slot 과 격리된다. `human` AgentProfile 은 외부 신호 대기형이므로 일반 worker slot 을 점유하지 않으며, `#RGC-SIGNALS` 의 envelope 변환 path 가 contribution 을 만든다.

### Lease Token (split-brain 감지)

`lease_token` 은 lease 마다 고유하며 단조 증가하는 값이다. 같은 `object_id` 로 발급된 새 lease 는 직전 lease 보다 큰 `lease_token` 을 가진다.

Caller 는 lease 보유 중 수행하는 모든 operational write 에 `lease_token` 을 인용한다. 영속 저장소 또는 ledger 는 동일 객체에 대해 더 작은 `lease_token` 을 인용한 write 가 도착하면 거부한다.

이 규칙은 다음 상황에서 split-brain 을 감지한다.

- 클럭 스큐 또는 timeout 오인으로 만료되지 않은 lease 가 회수되어 두 worker 가 동시에 점유한 경우
- worker 프로세스가 비정상 종료(예: trap 미실행) 후 새 worker 가 같은 객체를 claim 한 동안 이전 worker 가 늦게 깨어나 write 를 시도한 경우

write 거부는 `#RGC-LEDGER` 에 `stale` 또는 `rolled_back` 으로 기록한다.

### Lease TTL 정책

`expires_at` 은 `claimed_at + ttl` 로 산출한다. `ttl` 은 다음 우선순위를 따른다.

1. worker 별 환경에서 명시적으로 지정된 값
2. **Contribution lease**: target 단위 `lease.ttl_by_agent_profile.<id>` (`docs/contracts/target-config-contract.md#TCC-LEASE-CONFIG`)
3. **Coordinator lease**: target 단위 `lease.ttl_by_phase.<phase>` 또는 `phase_policies.<phase>.timeout`
4. 시스템 기본값 (`lease.ttl_default`)

`forge` 처럼 호출당 시간이 긴 profile 은 `atlas` 같은 짧은 profile 보다 큰 ttl 을 허용한다. `human` profile 은 사람 응답을 기다리므로 일반적으로 매우 큰 ttl 또는 별도 timeout 정책을 갖는다.

ttl 의 *동적 갱신*(in-flight extend, heartbeat) 은 본 contract 의 scope 밖이다. ttl 만료 전에 작업이 완료되지 않으면 stale recovery 가 진행된다(`#RGC-RECOVERY`).

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
| `DISCOVERY_AWAITING_HUMAN` | timeout 시 yes | optional | `phase_policies.Discovery.timeout` 도과 시 `DISCOVERY_DRAFT` 회수. stale `human_approval` 이면 contribution 만 `CONTRIB_STALE` 로 전이하고 phase 재오픈 |
| `SPECIFICATION_AWAITING_HUMAN` | timeout 시 yes | optional | 위와 동일. `SPECIFICATION_DRAFT` 회수 |
| `*_AWAITING_QUORUM` (agent quorum 만 대기) | yes | no | `phase_policies.<phase>.timeout` 도과 시 직전 `*_READY` 또는 `*_DRAFT` 로 회수. lead 의 lease 가 만료되었으면 contribution 만 stale 로 전이하고 재호출 |
| `CP_CLOSED` | no | yes | 자동 재개방 금지. `request_rework` signal 후 새 CP 로 재진입 |
| `CP_STALE` | no | optional | 동일 입력 revision 이면 새 CP 생성. 대상 revision 이 변했으면 재호출 필요 |
| `CP_MERGED` | no | no | terminal. 후속 변경은 새 CP 로 처리 |
| `CONTRIB_FAILED` / `CONTRIB_STALE` | yes | no | PhaseRun 은 보존. coordinator 가 다음 cycle 에서 quorum 재평가하며, 필요 시 lead 또는 reviewer contribution 을 새로 발급 |
| `DONE` | no | no | terminal. 후속 작업은 새 Milestone 으로 처리 |
| `ESCALATED` | no | yes | 사람 signal 에 따라 회수, 중단, amendment, 재시도 중 하나 집행 |

<a id="RGC-FAILURE"></a>
## RGC-FAILURE: Failure Classes

| 종류 | 의미 | 기본 처리 |
|---|---|---|
| STALE | lease 만료, timeout, revision mismatch | 직전 READY로 회수 |
| FAIL | Agent 실패 결정문, 결정적 검증 실패, invalid output | 재시도 한도 내 회수 |
| ESCALATED | 자동 복구 불가, 재시도 한도 초과, 정책 위반 | human gate |

자동 재시도는 유한하다. 한도 초과 시 ESCALATED로 전이한다.

결정적 검증 실패는 LLM 해석 없이도 FAIL 의 1급 증거다. 다만 책임 Task 식별이나 설명이 필요하면 `CodeReview` 또는 `Validation` phase 의 review/evidence contribution 을 추가로 발급할 수 있다.

### Multi-step operational write의 부분 실패

하나의 operation이 다단 operational write로 구성되는 경우(예: 여러 객체를 일괄 생성, 여러 라벨을 순차 변경) Caller는 다음을 따른다.

- 단계 사이의 부분 실패는 실패로 간주한다. 일부 단계만 적용된 상태를 그대로 두지 않는다.
- Caller는 이미 적용된 단계를 *원복* 한다. 원복은 직전 단계의 역연산으로 정의되며, 가능하지 않은 경우 객체를 ESCALATED로 전이한다.
- 원복 결과는 `RGC-LEDGER`의 `result`로 분류한다. 부분 적용분이 모두 원복되면 `rolled_back`, 원복 자체가 실패하면 `escalated`로 기록한다.
- 원복 단계 자체도 ledger에 기록한다.

부분 실패의 흔적이 영속 저장소에 남으면 후속 cycle의 입력이 오염된다. 따라서 부분 적용 상태를 유지하는 것은 invariant 위반으로 본다.

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

<a id="RGC-HUMAN-CONTRIBUTION"></a>
## RGC-HUMAN-CONTRIBUTION: Human Contribution

사람 승인은 별도 governance gate 가 아니라 `human` AgentProfile 의 contribution 으로 일원화된다 (`docs/contracts/agent-and-context-contract.md#AGC-AGENT-PROFILES`). `phase_policies.<phase>.required_reviewers` 에 `human` 이 포함된 phase 는 `human` contribution 없이 final artifact 로 응축되지 않는다. 사람 결정의 권위는 절대적이며, agent quorum 이 사람 승인을 대체할 수 없다.

### Contribution 변환 path

`#RGC-SIGNALS` 의 `approve` / `reject` 신호는 다음 절차로 contribution 으로 변환된다.

1. Caller 가 signal envelope 유효성을 검증 (서명, target_revision_pin, related_change_proposal_revision_pin, signal_id 중복).
2. 검증을 통과한 signal 을 `human` profile 의 `human_approval` contribution envelope 으로 변환:
   - `phase`, `phase_run_id`: signal 의 target 객체로부터 lookup
   - `agent_profile = "human"`, `contribution_kind = "human_approval"`
   - `verdict.result = "approve"` 또는 `"reject"`
   - `summary`, `rationale`: signal 의 `rationale`
3. envelope 을 영속 큐에 enqueue. `application/phase_coordinator.sh` 가 다음 cycle 에서 quorum 평가에 포함시킨다.

### 권위 보장

- `phase_policies.<phase>.required_reviewers` 에 `human` 이 있는 phase 에서 `human_approval` contribution 이 누락된 채 quorum 을 종착시키는 것은 invariant 위반이다.
- `verdict.result=reject` 인 `human_approval` 은 `phase_policies.<phase>.quorum.request_changes_blocks=true` 에 의해 phase 종착을 차단한다. 다른 reviewer 의 approve 가 reject 를 압도하지 않는다.
- 사람 contribution 도착 후 대상 객체가 변했으면 stale 로 판정하고 재승인을 요구한다 (lease_token / revision_pin 비교).

### 표준 사용 phase

| Phase | 기본 `required_reviewers` 권장 | 의미 |
|---|---|---|
| `Discovery` | `[human]` | 마일스톤 본문이 사람의 product 의도와 일치하는지 확인 |
| `Specification` | `[human]` | 시나리오·AC 가 사람의 결정과 일치하는지 확인 |
| 기타 phase | (운영 결정) | 자동 진행이 안전하면 `[]`. 사람 개입이 필요한 운영 모드면 `[human]` 추가 |

### ESCALATED 객체

`ESCALATED` 객체는 phase 와 무관한 governance state 다. `request_recover` / `request_rework` / `amendment_approve` / `stop` 신호 중 하나를 사람이 남기면 Caller 가 집행한다.

<a id="RGC-LEDGER"></a>
## RGC-LEDGER: Transition Ledger

모든 operational transition은 ledger에 기록되어야 한다.

필수 필드:

| 필드 | 의미 |
|---|---|
| `transition_id` | 전이 식별자 |
| `target_id` | 전이가 발생한 작업 영역의 식별자(`docs/contracts/target-config-contract.md#TCC-IDENTITY`). 다중 target 운영의 ledger 분리 기준 |
| `object_id` | 대상 객체. `target_id` 와 다른 개념이며, 작업 영역 내부의 milestone/task/change_proposal/phase_run/contribution 등을 가리킨다 |
| `object_kind` | `#SOC-OBJECTS` 의 객체 종류 중 하나(`milestone`, `task`, `phase_run`, `contribution`, `change_proposal`, `verification_run`, `system`) |
| `from_state` | 이전 상태 |
| `to_state` | 다음 상태 |
| `phase` | 전이가 속한 phase. phase 무관한 transition (intake, recover) 은 null |
| `phase_run_id` | 관련 PhaseRun 식별자, 없으면 null |
| `agent_profile` | 관련 AgentProfile id (`atlas / forge / sentinel / scout / human`), 없으면 null |
| `contribution_kind` | 관련 contribution_kind, 없으면 null |
| `quorum_decision` | quorum 평가 결과 (`quorum_reached / awaiting_more_contributions / blocked_by_request_changes`), 없으면 null. phase_coordinator 가 final artifact 압축 행에 기입 |
| `caller_id` | 전이를 집행한 Caller |
| `manifest_id` | 관련 Context Manifest |
| `input_revision_pins` | 입력 revision pin 집합 |
| `output_hash` | Agent output 또는 산출물 hash |
| `verification_run_id` | 관련 검증 실행, 없으면 null |
| `idempotency_key` | 중복 방지 키 |
| `lease_token` | 전이를 보호한 lease token, 없으면 null |
| `lease_kind` | `contribution` 또는 `phase_coordinator`, lease 미사용 시 null |
| `result` | 전이 결과 분류 |
| `result_detail` | 결과의 부가 분류, 없으면 null |
| `timestamp` | 전이 시각 |

legacy `agent_role`, `operation` 필드는 본 ledger 에서 폐기되었다 (`agent_profile` + `phase` + `contribution_kind` 셋이 대체).

Ledger는 감사, 재현, 장애 복구의 기준이다.

### Result 분류

`result`는 전이의 종착 분류를 표현한다. 모든 ledger 기록은 다음 중 하나를 가져야 한다.

| 값 | 의미 |
|---|---|
| `applied` | 전이가 의도대로 완료 |
| `noop` | 전이 조건이 충족되지 않아 부작용 없이 종료 |
| `claim_failed` | lease 점유 경쟁에서 패배 |
| `duplicate` | 동일 idempotency key의 선행 기록을 발견하여 부작용 없이 수렴 |
| `invalid` | Agent output 또는 입력 검증 실패 |
| `stale` | 입력 revision pin 또는 lease token이 현재 상태와 불일치 |
| `error` | 인프라 오류 |
| `recovered` | sweeper가 만료 lease를 회수 |
| `rolled_back` | multi-step 전이의 부분 적용을 원복 (`#RGC-FAILURE`) |
| `escalated` | 자동 복구가 불가능하여 human gate로 진입 |

### Result Detail

`result_detail`은 `result`의 동일 분류 안에서 원인을 더 좁힌다. 자유 식별자이며 운영 분석과 retry 정책 결정에 사용된다.

같은 `result`라도 `result_detail`이 다르면 별개의 사례로 본다. 예: `invalid` 안의 envelope 형식 위반과 권한 경계 위반은 서로 다른 retry 처리를 받을 수 있다.

`result_detail`의 어휘는 본 contract가 고정 enum으로 정의하지 않는다. 운영 안정성을 위해 어휘 자체는 `RGC-LEDGER`에 기록되는 값들의 합으로만 정의되며, 각 어휘는 영속 저장소를 통해 사람이 검토 가능해야 한다.

<a id="RGC-PAUSE"></a>
## RGC-PAUSE: System Pause

시스템은 전역 control state를 가진다.

```text
RUNNING | PAUSED | STOPPED
```

`PAUSED` 상태에서 Caller는 새 lease를 claim하지 않는다. 이미 진행 중인 lease는 정책에 따라 완료를 기다리거나 stale recovery 대상이 된다. 사람은 governance/input signal로 pause와 resume을 요청하고, Caller가 이를 집행한다.

`STOPPED` 상태도 새 lease claim을 차단한다. `STOPPED` 는 운영자가 현재 군집을 종료하려는 terminal-ish control state 이며, `resume` signal 의 직접 대상이 아니다. 다시 실행하려면 운영자는 새 daemon/caller 시작 절차를 수행해야 하며, 그 시작은 `#RGC-DAEMON-STARTUP` 의 atomicity 정책을 따른다.

<a id="RGC-NOTIFICATION"></a>
## RGC-NOTIFICATION: Notification

모든 알림은 Caller가 송신한다. Agent는 알림 채널을 직접 호출하지 않는다.

알림은 push-only이며 사람 응답을 기다리지 않는다. 작업 차단은 알림이 아니라 gate 상태로 표현한다.

<a id="RGC-FAIRNESS"></a>
## RGC-FAIRNESS: Scheduler Fairness

동일 우선순위의 ready 객체는 oldest-ready-first로 claim한다. 명시적 priority가 있는 경우에만 예외를 허용한다. priority 예외도 transition ledger에 기록해야 한다.

<a id="RGC-DAEMON-STARTUP"></a>
## RGC-DAEMON-STARTUP: Daemon Startup Atomicity

다중 AgentProfile worker 와 PhaseRun coordinator 를 동시에 기동하는 Caller 군집은 *원자적* 으로 시작해야 한다. 부분 시작은 invariant 위반으로 본다.

### 시작 전 조건

Caller 군집은 새 worker를 띄우기 전에 다음을 모두 만족해야 한다.

- 기존 worker와의 lock 충돌이 없음을 사전 검사한다. 충돌이 있으면 *어떤* 새 worker도 기동하지 않는다.
- 운영 진입 게이트(예: 환경 점검, 필수 설정 검증)가 통과한 상태여야 한다. 게이트 실패 시 군집 전체 시작을 중단한다.

### 부분 실패 처리

군집 시작 중 특정 worker 기동이 실패한 경우 Caller는 다음을 수행한다.

- 이미 기동된 sibling worker를 모두 정지시킨다.
- 정지 결과는 `#RGC-LEDGER`에 `rolled_back`으로 기록한다. 본 ledger 행의 `object_kind` 는 `system`, `object_id` 는 군집 식별자다.
- 정지가 불가능한 sibling이 있으면 시작을 *전체 미시작* 상태로 수렴시킬 수 없으므로 사람에게 즉시 알리고 군집 시작 자체를 중단한다. ledger result 는 `escalated`로 기록한다. 이는 객체 상태로서의 ESCALATED(`#SOC-STATES`)가 아니라 *시스템 차원* 의 사람 개입 요구다.

### 운영 의의

부분적으로만 기동된 군집은 `#RGC-FAIRNESS` 의 oldest-ready-first 가정을 깨고, 일부 AgentProfile 의 큐가 무한히 적체되거나 PhaseRun coordinator 부재로 quorum 평가가 멈춘다. 따라서 모든 기동은 "전체 성공" 또는 "전체 미시작" 두 상태만 허용한다.

stop/resume signal에 의한 정상 종료·재개는 본 절의 atomicity 와 무관하다. 본 절은 *시작 시점* 에만 적용된다.
