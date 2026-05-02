# State and Operation Contract

본 문서는 LLM Team workflow의 객체 상태와 operation 전이를 정의한다. 권한 경계는 `llm-team.md`, Agent output은 `docs/contracts/agent-and-context-contract.md`가 우선한다.

<a id="SOC-SCOPE"></a>
## SOC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- Milestone / Task / Change Proposal 상태
- Task dependency와 join condition
- operation별 Agent 산출, Caller action, idempotency key
- 통합 브랜치 병합·stale 정책

회수, retry, lease, gate 집행의 공통 정책은 `docs/contracts/reliability-and-gate-contract.md`가 정의한다.

<a id="SOC-OBJECTS"></a>
## SOC-OBJECTS: Workflow Objects

| 객체 | 의미 |
|---|---|
| Milestone | 사람의 제품 목표가 PO/PM/Planner/Coder/Reviewer/Integrator/QA를 거쳐 완료되는 단위 |
| Task | Planner가 생성한 구현 단위. 정확히 1개 Milestone에 속한다. |
| Change Proposal | 영속 저장소에 적용 대기 중인 변경 후보 |
| Verification Run | Caller가 실행한 결정적 검증의 로그와 결과 |

Change Proposal 종류:

- Spec CP: PO/PM 산출물
- Code CP: Coder 산출물
- Integration CP: Integrator 산출물
- Milestone CP: QA 산출물

<a id="SOC-STATES"></a>
## SOC-STATES: State Machines

### Milestone

```text
[PO_DRAFT] -> [PO_GATE] -> [PM_DRAFT] -> [PM_GATE]
           -> [DECOMPOSE_READY] -> [DECOMPOSE_IN_PROGRESS]
           -> [IMPLEMENTING]
           -> [REFACTOR_READY] -> [REFACTOR_IN_PROGRESS]
           -> [VALIDATE_READY] -> [VALIDATE_IN_PROGRESS]
           -> [DONE] | [ESCALATED]
```

### Task

```text
[TASK_PENDING] -> [TASK_READY] -> [TASK_IN_PROGRESS]
               -> [TASK_REVIEW_READY] -> [TASK_REVIEW_IN_PROGRESS]
               -> [TASK_INTEGRATED]
               -> [TASK_REJECTED] -> [TASK_READY]
               |  [ESCALATED]
```

### Change Proposal

```text
Spec CP:
[CP_DRAFT] -> [CP_READY_FOR_HUMAN_GATE]
           -> [CP_HUMAN_APPROVED] -> [CP_MERGED]
           |  [CP_REQUEST_CHANGES] -> [CP_CLOSED]
           |  [CP_STALE]

Code CP:
[CP_DRAFT] -> [CP_READY_FOR_REVIEW]
           -> [CP_APPROVED] -> [CP_MERGED]
           |  [CP_REQUEST_CHANGES] -> [CP_CLOSED]
           |  [CP_STALE]

Integration CP / Milestone CP:
[CP_DRAFT] -> [CP_READY_FOR_VERIFICATION]
           -> [CP_APPROVED] -> [CP_MERGED]
           |  [CP_REQUEST_CHANGES] -> [CP_CLOSED]
           |  [CP_STALE]
```

<a id="SOC-DEPENDENCIES"></a>
## SOC-DEPENDENCIES: Task Dependencies

Planner는 Task dependency graph를 산출한다. Caller는 dependency graph를 기준으로 Task를 다음처럼 전이한다.

- dependency가 있는 Task는 `TASK_PENDING`으로 생성한다.
- dependency가 없거나 모든 dependency Task가 `TASK_INTEGRATED`이면 `TASK_READY`로 전이한다.
- dependency Task가 `TASK_REJECTED`, `TASK_READY`, `TASK_IN_PROGRESS`, `TASK_REVIEW_READY`, `TASK_REVIEW_IN_PROGRESS` 중 하나면 dependent Task는 `TASK_PENDING`에 머문다.
- dependency graph에 cycle이 있으면 Decompose FAIL로 처리한다.

Milestone `IMPLEMENTING -> REFACTOR_READY` join condition은 모든 자식 Task가 `TASK_INTEGRATED`일 때만 만족한다.

<a id="SOC-OPERATIONS"></a>
## SOC-OPERATIONS: Operations

### Compose-PO

- Agent: PO
- Input state: `PO_DRAFT`
- Agent output: 마일스톤 본문 CP + 도메인 리서치 CP
- Caller action: Spec CP를 `CP_READY_FOR_HUMAN_GATE`로 영속화하고 Milestone을 `PO_GATE`로 전이
- Idempotency key: `milestone_id + operation + input_revision_pin`
- Output hash: 본문 hash

### Compose-PM

- Agent: PM
- Input state: `PM_DRAFT`
- Agent output: 시나리오 스펙 CP + AC-ID 목록
- Caller action: Spec CP를 `CP_READY_FOR_HUMAN_GATE`로 영속화하고 Milestone을 `PM_GATE`로 전이
- Idempotency key: `milestone_id + operation + approved_po_spec_revision_pin`
- Output hash: 본문 hash

### Decompose

- Agent: Planner
- Input state: `DECOMPOSE_IN_PROGRESS`
- Agent output: Task Issue 본문 N개 + Task slug + AC-ID mapping + dependency graph + 통합 브랜치 명세
- Caller action: dependency graph 검증, 통합 브랜치 생성, Task 생성, dependency 없는 Task를 `TASK_READY`로 전이, Milestone을 `IMPLEMENTING`으로 전이
- Idempotency key: `milestone_id + scenario_spec_revision_pin + task_slug`
- Failure: dependency cycle, 중복 slug, branch spec invalid

### Implement

- Agent: Coder
- Input state: `TASK_IN_PROGRESS`
- Agent output(콘텐츠): 격리 작업 공간 diff, Code CP message
- Caller enrichment: Code CP 식별자, source revision pin, review 대상 식별자를 envelope 에 후주입한다(`docs/contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH`).
- Caller action: diff 수집, Code CP 생성, CP를 `CP_READY_FOR_REVIEW`로 전이, Task를 `TASK_REVIEW_READY`로 전이
- Idempotency key: `task_id + task_revision_pin + integration_branch_base_revision_pin`

### Review

- Agent: Reviewer
- Input state: `TASK_REVIEW_IN_PROGRESS`
- Caller pre-action: Code CP에 대해 결정적 검증 실행
- Agent output(콘텐츠): approve 또는 request-changes verdict, 근거
- Caller enrichment: review 대상 식별자, stale 비교용 source revision pin, Code CP 식별자를 envelope 에 후주입한다. 대상 식별은 manifest 와 Caller lookup 의 책임이며 Agent 산출이 아니다.
- Caller action on approve: stale 비교 결과 변화가 없으면 Code CP를 `CP_READY_FOR_REVIEW -> CP_APPROVED -> CP_MERGED`로 전이하며 병합하고, Task를 `TASK_INTEGRATED`로 전이한다. stale 감지 시 CP를 `CP_STALE`로 전이하고 Task를 `TASK_READY`로 회수한다.
- Caller action on request-changes: Code CP를 `CP_READY_FOR_REVIEW -> CP_REQUEST_CHANGES -> CP_CLOSED`로 전이하고, Task를 `TASK_REJECTED -> TASK_READY`로 전이
- Idempotency key: `change_proposal_id + cp_revision_pin + verification_run_id + reviewer_role`

### Refactor

- Agent: Integrator
- Input state: `REFACTOR_IN_PROGRESS`
- Caller pre-action: 통합 브랜치 결정적 검증 실행
- Agent output(콘텐츠): PASS / FAIL / NO-OP verdict, 그리고 Integration CP 가 필요한 경우의 CP message
- Caller enrichment: Integration CP 가 생성되면 CP 식별자를, PASS 후에는 통합 브랜치 HEAD 를 envelope 에 후주입한다. CP 의 영속 식별자는 Agent 산출이 아니다.
- Caller action before verdict application: Agent 가 CP message 를 산출했으면 Integration CP를 `CP_DRAFT -> CP_READY_FOR_VERIFICATION`로 영속화하고, 없으면 CP를 만들지 않는다.
- Caller action on PASS: Integration CP가 있으면 `CP_READY_FOR_VERIFICATION -> CP_APPROVED -> CP_MERGED`로 전이하며 병합한다. no-op이면 CP 전이 없이 근거만 ledger에 기록한다. 이후 Milestone을 `VALIDATE_READY`로 전이한다.
- Caller action on FAIL: Integration CP가 있으면 `CP_REQUEST_CHANGES -> CP_CLOSED`로 닫고, Milestone을 재시도 한도 내에서 `REFACTOR_READY`로 회수한다.
- Caller action on STALE: Integration CP가 있으면 `CP_STALE`로 전이하고, Milestone을 `REFACTOR_READY`로 회수한다.
- Idempotency key: `integration_branch_head + verification_run_id + final_marker`

### Validate

- Agent: QA
- Input state: `VALIDATE_IN_PROGRESS`
- Caller pre-action: 통합 브랜치 결정적 검증 실행
- Agent output(콘텐츠): PASS / FAIL / STALE verdict, 마일스톤 본문, Context Summary, AC별 결과, FAIL 시 책임 Task 식별
- Caller enrichment: Milestone CP 영속화 후 CP 식별자를, release 가 발행되면 release 식별자를 envelope 에 후주입한다. 책임 Task 의 영속 저장소 식별 매핑도 Caller 책임이다.
- Caller action before verdict application: Milestone CP를 `CP_DRAFT -> CP_READY_FOR_VERIFICATION`로 영속화한다.
- Caller action on PASS: Milestone CP를 `CP_READY_FOR_VERIFICATION -> CP_APPROVED -> CP_MERGED`로 전이하며 병합한다. Context Summary를 영속화하고, 자식 Issue를 종료하며, Milestone을 `DONE`으로 전이한다.
- Caller action on FAIL: Milestone CP를 `CP_REQUEST_CHANGES -> CP_CLOSED`로 닫는다. 책임 Task만 `TASK_READY`로 회수하고, 나머지 `TASK_INTEGRATED`는 유지하며, Milestone을 `IMPLEMENTING`으로 전이한다.
- Caller action on STALE: Milestone CP를 `CP_STALE`로 전이하고, Milestone을 `VALIDATE_READY`로 회수한다.
- Idempotency key: `integration_branch_head + scenario_spec_revision_pin + verification_run_id`

### Recover

Recover의 진입 트리거와 객체 수준 결과 분류는 본 절(`#SOC-RECOVERY-OPERATION`)이 정의한다. 회수 메커니즘(lease 만료 검출, sweeper, 회수 시각 결정)은 `docs/contracts/reliability-and-gate-contract.md#RGC-RECOVERY`가 정의한다.

<a id="SOC-RECOVERY-OPERATION"></a>
## SOC-RECOVERY-OPERATION: Recover Operation

Recover는 다른 operation과 달리 Agent를 호출하지 않는다. Caller(또는 Caller가 위임한 sweeper)가 비정상 상태의 객체를 수습하기 위해 직접 수행하는 operational write다.

### 진입 트리거

| Trigger | 설명 |
|---|---|
| stale | lease 만료, timeout, revision pin 불일치 |
| lease-expiry | lease의 `expires_at` 도과 |
| human-revoke | 사람이 회수 요청 시그널을 남김 |
| partial-fail-rollback | multi-step operational write의 부분 적용을 원복 |

`stale` 과 `lease-expiry` 는 부분 중첩한다. `lease-expiry` 가 `stale` 의 한 원인이며, 본 contract는 두 trigger를 모두 가능한 진입점으로 인정한다.

### 객체 전이

Recover의 기본 전이는 다음과 같다.

```text
*_IN_PROGRESS → 직전 *_READY
*_IN_PROGRESS → ESCALATED
```

직전 READY가 없는 상태(`*_GATE`, `CP_CLOSED`, `CP_STALE`, `CP_MERGED`, terminal)에서의 처리 정책은 `#RGC-RECOVERY`가 표로 정의한다.

### Trigger × Ledger Result 매핑

Recover의 결과는 `#RGC-LEDGER`의 `result`로 다음과 같이 분류된다.

| Trigger | 일반 result | 회수 자체 실패 시 |
|---|---|---|
| stale | `recovered` | `escalated` |
| lease-expiry | `recovered` | `escalated` |
| human-revoke | `recovered` | `escalated` |
| partial-fail-rollback | `rolled_back` | `escalated` |

회수가 성공해도 객체가 ESCALATED로 전이되는 경우(재시도 한도 초과 등)는 *회수 자체* 의 실패가 아니다. 이때 ledger의 `result`는 `recovered` 이며, 후속 ESCALATED 진입은 별도의 ledger 행으로 기록된다.

### Idempotency

같은 Recover trigger가 같은 객체에 대해 반복 발화될 수 있다. Caller는 `idempotency_key`를 `object_id + trigger + observed_revision_pin`으로 산출하여 중복 회수를 ledger의 `duplicate`로 흡수한다.

<a id="SOC-DISPATCH-MATRIX"></a>
## SOC-DISPATCH-MATRIX: Dispatch Matrix

본 절은 `#SOC-OPERATIONS`의 모든 분기를 *operation × Agent 산출(또는 verdict) × Caller 종착 처리* 로 응축한 표다. 각 operation 절의 본문이 정본이며, 본 표는 단일 진입점으로의 인덱스 역할을 한다.

| Operation | Agent | Agent 산출 / verdict | 객체 종착 상태 | 관련 CP 종착 |
|---|---|---|---|---|
| Compose-PO | PO | `spec_proposal` | milestone `PO_GATE` | Spec CP `READY_FOR_HUMAN_GATE` |
| Compose-PM | PM | `spec_proposal` | milestone `PM_GATE` | Spec CP `READY_FOR_HUMAN_GATE` |
| Decompose | Planner | `task_plan` | milestone `IMPLEMENTING`, ready Task `TASK_READY` | (없음) |
| Decompose | Planner | `failure` (cycle, 중복 slug, branch invalid) | milestone `DECOMPOSE_READY` 회수 또는 ESCALATED | (없음) |
| Implement | Coder | `patch` | task `TASK_REVIEW_READY` | Code CP `READY_FOR_REVIEW` |
| Review | Reviewer | `verdict=approve` (stale 아님) | task `TASK_INTEGRATED` | Code CP `MERGED` |
| Review | Reviewer | `verdict=approve` (stale 감지) | task `TASK_READY` 회수 | Code CP `STALE` |
| Review | Reviewer | `verdict=request-changes` | task `TASK_READY` 회수 | Code CP `CLOSED` |
| Refactor | Integrator | `verdict=PASS` (CP 있음) | milestone `VALIDATE_READY` | Integration CP `MERGED` |
| Refactor | Integrator | `verdict=PASS` (NO-OP) | milestone `VALIDATE_READY` | (없음) |
| Refactor | Integrator | `verdict=FAIL` | milestone `REFACTOR_READY` 회수 또는 ESCALATED | Integration CP `CLOSED`(있을 때) |
| Refactor | Integrator | `verdict=STALE` | milestone `REFACTOR_READY` 회수 | Integration CP `STALE`(있을 때) |
| Validate | QA | `verdict=PASS` | milestone `DONE`, 자식 task 종료 | Milestone CP `MERGED` |
| Validate | QA | `verdict=FAIL` | milestone `IMPLEMENTING` 회수, 책임 task만 `TASK_READY` | Milestone CP `CLOSED` |
| Validate | QA | `verdict=STALE` | milestone `VALIDATE_READY` 회수 | Milestone CP `STALE` |
| Recover | (Caller only) | trigger 별 — `#SOC-RECOVERY-OPERATION` | 직전 READY 또는 ESCALATED | 영향받은 CP의 STALE/CLOSED |
| (any) | (Agent) | `failure` envelope | 상태 변경 없음 | (없음) |

ledger result 매핑(`success`, `stale`, `recovered`, `rolled_back`, `escalated` 등)은 `#RGC-LEDGER`가 정의한다.

<a id="SOC-MERGE-POLICY"></a>
## SOC-MERGE-POLICY: Integration Branch Policy

Code CP는 통합 브랜치를 base로 한다. 병렬 Task 때문에 CP base가 현재 통합 브랜치 HEAD보다 낡을 수 있다.

Caller는 Review approve 후 다음 순서로 처리한다.

1. CP base가 현재 통합 브랜치 HEAD와 같으면 병합을 시도한다.
2. CP base가 낡았지만 deterministic merge/rebase가 clean이면 Caller가 병합 후보를 갱신하고 결정적 검증을 다시 실행한다.
3. conflict가 있거나 결정적 검증이 실패하면 CP를 `CP_STALE` 또는 `CP_REQUEST_CHANGES`로 닫고 Task를 `TASK_READY`로 회수한다.

Agent는 병합 충돌을 직접 해결하지 않는다. 충돌 해결이 필요한 경우 Caller가 새 Coder 호출을 만든다.

<a id="SOC-IDEMPOTENCY"></a>
## SOC-IDEMPOTENCY: Idempotency Rules

멱등성 키는 입력 revision을 기준으로 한다. LLM 산출 본문 hash는 output identity로 사용하고, primary idempotency key로 사용하지 않는다.

중복 산출이 감지되면 Caller는 새 객체를 만들지 않고 기존 객체를 재사용하거나 상태를 수렴시킨다.
