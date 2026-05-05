# State and Operation Contract

본 문서는 LLM Team workflow 의 객체 상태와 phase 별 operation 전이를 정의한다. 권한 경계는 `llm-team.md`, Agent output envelope 와 phase / agent_profile / contribution 정의는 `docs/contracts/agent-and-context-contract.md` 가 우선한다.

<a id="SOC-SCOPE"></a>
## SOC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- Milestone / Task / PhaseRun / Contribution / Change Proposal 상태
- Task dependency와 join condition
- phase 별 PhaseRun 산출 흐름, Caller action, idempotency key
- 통합 브랜치 병합·stale 정책

회수, retry, lease, 사람 contribution 집행의 공통 정책은 `docs/contracts/reliability-and-gate-contract.md` 가 정의한다. PhaseRun 의 quorum 평가와 final artifact 압축은 Caller (`application/phase_coordinator.sh`) 가 수행하며 `docs/contracts/target-config-contract.md#TCC-PHASE-POLICIES` 의 정책을 따른다.

### 어휘 주석

본 contract 는 "통합 브랜치", "병합" 같은 VCS 어휘를 *작업 단위* 와 *전이의 종착* 을 가리키는 추상 개념으로 사용한다. 어휘는 git 에서 빌렸으나 의미는 어댑터 중립이다. 다른 VCS(예: 패치 큐 기반, mercurial 등)로 매핑할 때는 동등 개념(통합 base, 통합 적용)으로 치환한다. 어휘 자체가 git 을 강제하지 않는다.

<a id="SOC-OBJECTS"></a>
## SOC-OBJECTS: Workflow Objects

| 객체 | 의미 |
|---|---|
| Milestone | 사람의 제품 목표가 `Discovery → Specification → Planning → Implementation → CodeReview → Integration → Validation` 7-phase 를 거쳐 완료되는 단위 |
| Task | `Planning` phase 가 생성한 구현 단위. 정확히 1개 Milestone 에 속한다. `Implementation` 과 `CodeReview` phase 의 작업 단위. |
| PhaseRun | 한 milestone 또는 task 에서 한 phase 의 1회 실행. 여러 contribution 을 가지며 quorum 평가의 단위. |
| Contribution | `(phase_run, agent_profile)` 호출의 산출. **persistent store 의 1급 객체**. `contribution_kind` enum 은 `docs/contracts/agent-and-context-contract.md#AGC-CONTRIBUTION` 가 정의 |
| Change Proposal | 영속 저장소에 적용 대기 중인 변경 후보 |
| Verification Run | Caller 가 실행한 결정적 검증의 로그와 결과 |
| System (non-workflow) | workflow 객체가 아닌 시스템 차원 entity. 전역 control state(`#RGC-PAUSE`) 와 Caller 군집 시작(`#RGC-DAEMON-STARTUP`) 의 ledger/signal 대상으로만 사용된다. workflow 전이는 가지지 않는다 |

Change Proposal 종류 (source phase 기준):

- Spec CP: `Discovery` 또는 `Specification` phase 의 final artifact
- Code CP: `Implementation` phase 의 final artifact
- Integration CP: `Integration` phase 의 final artifact (필요 시)
- Milestone CP: `Validation` phase 의 final artifact

<a id="SOC-PHASE-RUN"></a>
## SOC-PHASE-RUN: PhaseRun and Contribution

PhaseRun 은 한 milestone 또는 task 에서 한 phase 의 1회 실행이다. PhaseRun 은 여러 Contribution 을 가지며, 각 Contribution 은 `docs/contracts/agent-and-context-contract.md#AGC-CONTRIBUTION` 가 정의한 1급 영속 객체다.

### 영속화

- PhaseRun 은 영속 저장소의 1급 객체다. 식별자는 `phase_run_id` 이며 envelope 의 필수 필드다.
- Contribution 은 PhaseRun 에 종속된 영속 객체다. lifecycle 은 다음 4-state 다.

```text
[CONTRIB_PENDING]   -- Caller 가 lease 발급, Agent 가 아직 시작 안 함
   -> [CONTRIB_IN_PROGRESS]  -- Agent 호출 진행 중
   -> [CONTRIB_SUBMITTED]    -- Agent envelope 가 enrichment 완료, quorum 평가 입력
   -> [CONTRIB_CONSIDERED]   -- phase_coordinator 가 quorum 평가에 포함시켜 종결
   |  [CONTRIB_FAILED]       -- envelope invalid, lease 만료, agent timeout
   |  [CONTRIB_STALE]        -- 기준 revision pin 변동
```

`CONTRIB_SUBMITTED` 상태의 contribution 들이 quorum 평가의 입력이며, queue-based handoff (`llm-team.md` invariant 77) 는 contribution 단위로도 적용된다.

### Contribution Dispatch 순서 invariants

PhaseRun 안의 contribution 은 임의 순서로 ready 가 되지 않는다. Caller (contribution worker 의 pickup 단계, `pipeline-end-to-end.md` 단계 1) 는 다음 invariants 를 강제한다.

- **Lead-first**: `phase_policies.<phase>.lead` 의 `lead_draft` contribution 이 `CONTRIB_SUBMITTED` 또는 `CONTRIB_CONSIDERED` 가 되기 전까지 같은 PhaseRun 의 `review_verdict`, `evidence`, `summary`, `human_approval`, `rework_patch` contribution 은 ready 로 노출되지 않는다. reviewer 는 lead artifact 본문을 manifest entry 로 받아야 의미 있는 contribution 을 만들 수 있기 때문이다.
- **Rework-after-changes**: `rework_patch` contribution (Implementation 의 forge, 또는 Spec/Planning 의 atlas) 은 같은 PhaseRun 또는 그것이 위임받은 직전 PhaseRun 의 `review_verdict` 중 `verdict.result=request-changes` 가 1건 이상 `CONTRIB_SUBMITTED` 된 후에만 ready 가 된다.
- **Human-non-slot**: `agent_profile=human` contribution 은 worker daemon slot 을 점유하지 않으며 (`#RGC-PHASE-LEASE`), `application/human_signal.sh` 의 envelope 변환 path 로만 `CONTRIB_SUBMITTED` 가 된다.

위 invariants 위반 (예: lead 없이 reviewer 가 먼저 호출, request-changes 없이 rework_patch ready 노출) 은 ledger 에 `invalid` 로 기록되며 contribution 은 `CONTRIB_FAILED` 로 전이된다.

### Quorum 평가

- Caller (`application/phase_coordinator.sh`) 는 PhaseRun 안의 `CONTRIB_SUBMITTED` 상태 contribution 들을 모아 `phase_policies.<phase>.quorum` 을 평가한다.
- quorum 평가 결과는 다음 셋 중 하나다: `quorum_reached` / `awaiting_more_contributions` / `blocked_by_request_changes`.
- `quorum_reached` 시 phase_coordinator 는 lead contribution 의 산출을 final artifact 로 압축하여 Change Proposal 또는 phase 종착 transition 으로 dispatch 한다.
- `phase_policies.<phase>.required_reviewers` 에 포함된 profile (예: `human`) 의 contribution 이 누락되었으면 quorum 은 충족되지 않는다. 사람 결정의 권위는 절대적이다.
- `phase_policies.<phase>.quorum.request_changes_blocks=true` 일 때, contribution 중 1건이라도 `verdict.result=request-changes` 가 있으면 phase 는 final artifact 압축을 차단하고 lead 에게 rework_patch 를 요청한다.

<a id="SOC-STATES"></a>
## SOC-STATES: State Machines

각 phase 의 milestone-level state 는 `READY → IN_PROGRESS → AWAITING_QUORUM (→ AWAITING_HUMAN if required_reviewers contains human) → DONE | FAILED` 패턴을 따른다. AWAITING_QUORUM 은 lead contribution 이 submit 되었으나 reviewer / required contribution 이 부족한 상태이며, AWAITING_HUMAN 은 그 중 사람 contribution 만 누락된 sub-state 다.

### Milestone

```text
(intake)   -> [DISCOVERY_DRAFT] -> [DISCOVERY_AWAITING_HUMAN]
           -> [SPECIFICATION_DRAFT] -> [SPECIFICATION_AWAITING_HUMAN]
           -> [PLANNING_READY] -> [PLANNING_IN_PROGRESS]
           -> [IMPLEMENTATION_IN_PROGRESS]
           -> [INTEGRATION_READY] -> [INTEGRATION_IN_PROGRESS]
           -> [VALIDATION_READY] -> [VALIDATION_IN_PROGRESS]
           -> [DONE] | [ESCALATED]
```

`(intake)` 는 milestone 이 *처음 만들어지는* 진입점이며 자체 상태가 아니다. 진입 입력과 Caller action 은 `#SOC-INTAKE` 가 정의한다.

`DISCOVERY_AWAITING_HUMAN` 과 `SPECIFICATION_AWAITING_HUMAN` 은 phase 의 lead contribution 이 submit 된 뒤 `phase_policies.<phase>.required_reviewers=[human]` 이 충족될 때까지의 quorum sub-state 다. 별도 governance gate 는 두지 않는다 (사람 승인은 reviewer contribution 의 한 형태로 일원화).

### Task

```text
[TASK_PENDING] -> [TASK_READY] -> [TASK_IN_PROGRESS]
               -> [TASK_REVIEW_READY] -> [TASK_REVIEW_IN_PROGRESS]
               -> [TASK_INTEGRATED]
               -> [TASK_REJECTED] -> [TASK_READY]
               |  [ESCALATED]
```

`TASK_IN_PROGRESS` 는 `Implementation` phase 의 PhaseRun 단위이고 `TASK_REVIEW_IN_PROGRESS` 는 `CodeReview` phase 의 PhaseRun 단위다. `TASK_REJECTED` 는 CodeReview phase 의 request-changes 를 감사 가능하게 남기기 위한 관측 가능한 상태다. Caller 는 CodeReview request-changes 처리에서 Task 를 `TASK_REVIEW_IN_PROGRESS -> TASK_REJECTED -> TASK_READY` 순서로 수렴시킨다. 구현이 한 operation ledger 행으로 두 상태 write 를 묶더라도 영속 상태 이력 또는 `result_detail` 은 request-changes 경유를 보존해야 한다.

### Change Proposal

```text
Spec CP:
[CP_DRAFT] -> [CP_AWAITING_QUORUM]
           -> [CP_APPROVED] -> [CP_MERGED]
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

Spec CP 의 `CP_AWAITING_QUORUM` 은 Discovery / Specification phase 의 quorum (특히 `required_reviewers=[human]`) 이 충족되기를 기다리는 상태다. 충족 시 `CP_APPROVED → CP_MERGED` 로 전이된다. legacy `CP_READY_FOR_HUMAN_GATE` / `CP_HUMAN_APPROVED` 는 본 contract 에서 폐기되었다.

<a id="SOC-DEPENDENCIES"></a>
## SOC-DEPENDENCIES: Task Dependencies

`Planning` phase 는 Task dependency graph 를 산출한다. Caller 는 dependency graph 를 기준으로 Task 를 다음처럼 전이한다.

- dependency 가 있는 Task 는 `TASK_PENDING` 으로 생성한다.
- dependency 가 없거나 모든 dependency Task 가 `TASK_INTEGRATED` 이면 `TASK_READY` 로 전이한다.
- dependency Task 가 `TASK_REJECTED`, `TASK_READY`, `TASK_IN_PROGRESS`, `TASK_REVIEW_READY`, `TASK_REVIEW_IN_PROGRESS` 중 하나면 dependent Task 는 `TASK_PENDING` 에 머문다.
- dependency graph 에 cycle 이 있으면 Planning phase 의 lead contribution 이 FAIL 로 처리된다.

Milestone `IMPLEMENTATION_IN_PROGRESS -> INTEGRATION_READY` join condition 은 모든 자식 Task 가 `TASK_INTEGRATED` 일 때만 만족한다.

<a id="SOC-INTAKE"></a>
## SOC-INTAKE: Milestone Intake

milestone 은 외부 입력으로부터 `DISCOVERY_DRAFT` 로 처음 만들어진다. 입력 종류는 다음 둘이다.

| 입력 | 출처 | 진입 결과 |
|---|---|---|
| 사람이 남긴 milestone seed | governance/input write(예: 사람이 영속 저장소에 남긴 아이디어 객체) | Caller 가 새 milestone 을 `DISCOVERY_DRAFT` 로 영속화 |
| 후속 milestone trigger | 직전 milestone 의 Context Summary 또는 `KAC-DECISION-LOG` 의 후속 항목 | Caller 가 새 milestone 을 `DISCOVERY_DRAFT` 로 영속화하고 누적 스펙을 manifest entry 로 연결 |

intake 는 Agent 호출이 아니다. Caller 단독 operational write 이며 다음을 따른다.

- intake 는 *영속 저장소가 발급한 milestone 식별자* 가 결정된 시점에 ledger 한 줄을 남긴다. ledger 의 `from_state` 는 비어 있고 `to_state` 는 `DISCOVERY_DRAFT` 다.
- intake 의 idempotency_key 는 `(intake_source_kind, intake_source_id)` 다. 동일 source 가 두 milestone 을 만들면 invariant 위반이다.
- intake 입력의 정합성 검증(예: 중복 source 감지, governance signal 의 형식 검증)은 `#RGC-SIGNALS` 의 envelope 검증을 따른다.

intake 의 운영 형태(어떤 영속 저장소 객체가 seed 인지, 어떤 라벨로 식별되는지)는 architecture 영역이 결정한다. 본 contract 는 *intake 가 SOC 의 첫 시민 transition 임* 만을 강제한다.

<a id="SOC-OPERATIONS"></a>
## SOC-OPERATIONS: Operations

각 phase subsection 은 다음 구조를 갖는다.

본 절의 "Caller action on lead submit" 행은 contribution cycle (`pipeline-end-to-end.md` 단계 5) 이 lead contribution 의 submit 시점에 동시에 수행하는 영속 객체 준비 작업이다. CP 생성과 milestone/task 의 `*_AWAITING_*` 진입이 여기에 속한다 — quorum 평가가 필요하지 않다. "Caller action on quorum reached" 행은 phase coordinator cycle 이 quorum_reached 후에 dispatch 하는 phase 종착 전이 (CP 병합/종료, milestone 의 다음 phase `*_READY` 진입, 자식 객체 종료) 다. `quorum.rule=lead_only` phase 는 두 책임이 lead submit 시점에 결합되며, coordinator 는 ledger 기록 외 추가 dispatch 를 수행하지 않는다.

- **Lead profile** (예: `atlas`) — TCC `phase_policies.<phase>.lead`
- **Reviewer profiles** — `phase_policies.<phase>.reviewers[]`
- **Required reviewers** — `phase_policies.<phase>.required_reviewers[]` (예: `[human]`)
- **Allowed `contribution_kind` 셋** — `#AGC-CONTRIBUTION-OUTPUTS` 매트릭스의 해당 phase 행
- **Default quorum policy** — `phase_policies.<phase>.quorum`. Planning pilot 의 default 는 `{rule: min_approvals, threshold: 2, request_changes_blocks: true}`. 다른 phase 의 default 는 후속 PR 에서 결정한다.
- **Caller action on quorum reached** — `application/phase_coordinator.sh` 가 lead contribution 을 final artifact 로 압축하고 phase 종착 transition 을 적용
- **Idempotency key** — Caller enrichment 가 합성. 합성 항에 `phase_run_id`, `agent_profile`, `contribution_kind` 가 포함된다 (`#SOC-IDEMPOTENCY`)
- **Failure modes** — phase 별 invalid / stale / 한도초과 케이스

### Intake

- Agent: 없음(Caller only)
- Input state: 없음. 외부 seed 또는 후속 milestone trigger
- Agent output: 없음
- Caller action: milestone 을 생성하고 `DISCOVERY_DRAFT` 로 영속화
- Idempotency key: `intake_source_kind + intake_source_id`
- Output hash: 없음

### Discovery

- Lead profile: `atlas`
- Reviewer profiles: `sentinel`
- Required reviewers: `[human]`
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `human_approval`, `evidence`(optional)
- Input state: `DISCOVERY_DRAFT`
- Lead artifact: 마일스톤 본문 CP + 도메인 리서치 CP
- Caller action on lead submit: Spec CP 를 `CP_DRAFT -> CP_AWAITING_QUORUM` 로 영속화하고 Milestone 을 `DISCOVERY_AWAITING_HUMAN` 로 전이
- Caller action on quorum reached: Spec CP 의 quorum 결과에 따라 `CP_APPROVED -> CP_MERGED` 또는 `CP_REQUEST_CHANGES -> CP_CLOSED`. quorum 통과 시 Milestone 을 `SPECIFICATION_DRAFT` 로 전이
- Idempotency key (lead): `milestone_id + phase + phase_run_id + input_revision_pins`
- Failure: required human contribution 누락 (timeout 시 ESCALATED), envelope invalid

### Specification

- Lead profile: `atlas`
- Reviewer profiles: `forge`, `sentinel`
- Required reviewers: `[human]`
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `human_approval`, `rework_patch`(request-changes 후)
- Input state: `SPECIFICATION_DRAFT`
- Lead artifact: 시나리오 스펙 CP + AC-ID 목록
- Caller action on lead submit: Spec CP 를 `CP_AWAITING_QUORUM` 로 영속화하고 Milestone 을 `SPECIFICATION_AWAITING_HUMAN` 로 전이
- Caller action on quorum reached: Spec CP 를 `CP_APPROVED -> CP_MERGED`. Milestone 을 `PLANNING_READY` 로 전이
- Idempotency key (lead): `milestone_id + phase + phase_run_id + approved_discovery_spec_revision_pin`
- Failure: required human contribution 누락, AC-ID 중복

### Planning

- Lead profile: `atlas`
- Reviewer profiles: `forge`, `sentinel`
- Required reviewers: 없음 (사람 승인은 다음 phase 의 결과로 흡수되며 Planning 자체는 agent quorum 만)
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `rework_patch`
- Input state: `PLANNING_IN_PROGRESS`
- Lead artifact: Task Issue 본문 N개 + Task slug + AC-ID mapping + dependency graph + 통합 브랜치 명세
- Caller action on quorum reached: dependency graph 검증, 통합 브랜치 생성, Task 생성, dependency 없는 Task 를 `TASK_READY` 로 전이, Milestone 을 `IMPLEMENTATION_IN_PROGRESS` 로 전이
- Idempotency key (lead): `milestone_id + phase + phase_run_id + scenario_spec_revision_pin + task_slug`
- Failure: dependency cycle, 중복 slug, branch spec invalid, request-changes 누적이 한도 초과

### Implementation

- Lead profile: `forge`
- Reviewer profiles: 없음 (별도 review 는 CodeReview phase)
- Required reviewers: 없음
- Allowed contribution_kinds: `lead_draft`, `rework_patch`
- Input state: Task `TASK_IN_PROGRESS`
- Lead artifact (콘텐츠): 격리 작업 공간 diff, Code CP message
- Caller enrichment: Code CP 식별자, source revision pin, review 대상 식별자를 envelope 에 후주입 (`#AGC-OUTPUT-RUNTIME-ENRICH`).
- Caller action on lead submit (contribution cycle): diff 수집, Code CP 생성 (`CP_DRAFT -> CP_READY_FOR_REVIEW`), Task 를 `TASK_REVIEW_READY` 로 전이
- Caller action on quorum reached (phase coordinator): Implementation 의 `quorum.rule=lead_only` 정책상 lead submit 즉시 quorum_reached 로 평가되며, phase 종착물 (Code CP at `CP_READY_FOR_REVIEW` + Task at `TASK_REVIEW_READY`) 은 이미 contribution cycle 이 영속화한 상태이므로 coordinator 는 `quorum_decision=quorum_reached` 만 ledger 에 기록하고 추가 dispatch 를 수행하지 않는다
- Idempotency key: `task_id + phase + phase_run_id + task_revision_pin + integration_branch_base_revision_pin`

### CodeReview

- Lead profile: `sentinel`
- Reviewer profiles: `atlas`(architecture review), `forge`(rework 가능성 검토)
- Required reviewers: 없음
- Allowed contribution_kinds: `review_verdict`, `evidence`, `rework_patch`(request-changes 후 Implementation phase 로 위임)
- Input state: Task `TASK_REVIEW_IN_PROGRESS`
- Caller pre-action: Code CP 에 대해 결정적 검증 실행
- Lead artifact: approve 또는 request-changes verdict, 근거
- Caller enrichment: review 대상 식별자, stale 비교용 source revision pin, Code CP 식별자를 envelope 에 후주입.
- Caller action on quorum reached (approve): stale 비교 결과 변화가 없으면 Code CP 를 `CP_READY_FOR_REVIEW -> CP_APPROVED -> CP_MERGED` 로 전이하며 병합, Task 를 `TASK_INTEGRATED` 로 전이. stale 감지 시 CP 를 `CP_STALE` 로 전이하고 Task 를 `TASK_READY` 로 회수
- Caller action on quorum reached (request-changes): Code CP 를 `CP_READY_FOR_REVIEW -> CP_REQUEST_CHANGES -> CP_CLOSED` 로 전이하고 Task 를 `TASK_REJECTED -> TASK_READY` 로 전이 (Implementation phase 가 다시 시작)
- Idempotency key: `change_proposal_id + phase + phase_run_id + cp_revision_pin + verification_run_id`

### Integration

- Lead profile: `sentinel`
- Reviewer profiles: `scout`(재현/증거), `atlas`(위험 검토)
- Required reviewers: 없음
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `evidence`
- Input state: `INTEGRATION_IN_PROGRESS`
- Caller pre-action: 통합 브랜치 결정적 검증 실행
- Lead artifact (콘텐츠): PASS / FAIL / STALE verdict, 그리고 Integration CP 가 필요한 경우의 CP message. no-op 은 PASS + CP message 부재로 표현
- Caller enrichment: Integration CP 가 생성되면 CP 식별자를, PASS 후에는 통합 브랜치 HEAD 를 envelope 에 후주입.
- Caller action before verdict application: lead 가 CP message 를 산출했으면 Integration CP 를 `CP_DRAFT -> CP_READY_FOR_VERIFICATION` 로 영속화. 없으면 CP 를 만들지 않는다.
- Caller action on quorum reached (PASS): Integration CP 가 있으면 `CP_READY_FOR_VERIFICATION -> CP_APPROVED -> CP_MERGED` 로 전이하며 병합. no-op 이면 CP 전이 없이 근거만 ledger 에 기록. 이후 Milestone 을 `VALIDATION_READY` 로 전이
- Caller action on quorum reached (FAIL): Integration CP 가 있으면 `CP_REQUEST_CHANGES -> CP_CLOSED` 로 닫고, Milestone 을 재시도 한도 내에서 `INTEGRATION_READY` 로 회수
- Caller action on quorum reached (STALE): Integration CP 가 있으면 `CP_STALE` 로 전이하고, Milestone 을 `INTEGRATION_READY` 로 회수
- Idempotency key (lead): `integration_branch_head + phase + phase_run_id + verification_run_id + final_marker`

### Validation

- Lead profile: `sentinel`
- Reviewer profiles: `scout`(evidence), `atlas`(summary)
- Required reviewers: 없음 (사람 승인은 phase 외부 release governance 에서 별도)
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `evidence`, `summary`
- Input state: `VALIDATION_IN_PROGRESS`
- Caller pre-action: 통합 브랜치 결정적 검증 실행
- Lead artifact (콘텐츠): PASS / FAIL / STALE verdict, 마일스톤 본문, Context Summary, AC 별 결과, FAIL 시 책임 Task 식별
- Caller enrichment: Milestone CP 영속화 후 CP 식별자, release 식별자(있을 때) 를 envelope 에 후주입. 책임 Task 의 영속 저장소 식별 매핑도 Caller 책임.
- Caller action before verdict application: Milestone CP 를 `CP_DRAFT -> CP_READY_FOR_VERIFICATION` 로 영속화
- Caller action on quorum reached (PASS): Milestone CP 를 `CP_READY_FOR_VERIFICATION -> CP_APPROVED -> CP_MERGED` 로 전이하며 병합. Context Summary 를 영속화하고, 자식 Issue 를 종료하며, Milestone 을 `DONE` 으로 전이
- Caller action on quorum reached (FAIL): Milestone CP 를 `CP_REQUEST_CHANGES -> CP_CLOSED` 로 닫음. 책임 Task 만 `TASK_READY` 로 회수하고, 나머지 `TASK_INTEGRATED` 는 유지하며, Milestone 을 `IMPLEMENTATION_IN_PROGRESS` 로 전이
- Caller action on quorum reached (STALE): Milestone CP 를 `CP_STALE` 로 전이하고, Milestone 을 `VALIDATION_READY` 로 회수
- Idempotency key (lead): `integration_branch_head + phase + phase_run_id + scenario_spec_revision_pin + verification_run_id`

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
| contribution-stale | 단일 contribution 의 lease 만료 또는 기준 revision pin 변동 — PhaseRun 은 살아 있고 해당 contribution 만 `CONTRIB_STALE` 로 전이 |
| contribution-timeout | `phase_policies.<phase>.timeout` 안에 도착하지 않은 contribution (특히 required `human` contribution) — PhaseRun 을 직전 `*_READY` 로 회수 |
| coordinator-failure | `application/phase_coordinator.sh` 실행 도중 중단되어 quorum 평가가 미완 — PhaseRun 을 `AWAITING_QUORUM` 으로 유지하고 다음 cycle 에서 재평가 |

`stale` 과 `lease-expiry` 는 부분 중첩한다. `lease-expiry` 가 `stale` 의 한 원인이며, 본 contract는 두 trigger를 모두 가능한 진입점으로 인정한다.

### 객체 전이

Recover의 기본 전이는 다음과 같다.

```text
*_IN_PROGRESS → 직전 *_READY
*_IN_PROGRESS → ESCALATED
*_AWAITING_QUORUM → *_READY (contribution-timeout 또는 한도 초과 시)
*_AWAITING_HUMAN → *_READY (사람 contribution timeout 또는 명시적 회수)
CONTRIB_IN_PROGRESS → CONTRIB_FAILED 또는 CONTRIB_STALE (PhaseRun 은 보존)
```

직전 READY 가 없는 상태(`CP_CLOSED`, `CP_STALE`, `CP_MERGED`, terminal)에서의 처리 정책은 `#RGC-RECOVERY`가 표로 정의한다.

### Trigger × Ledger Result 매핑

Recover의 결과는 `#RGC-LEDGER`의 `result`로 다음과 같이 분류된다.

| Trigger | 일반 result | 회수 자체 실패 시 |
|---|---|---|
| stale | `recovered` | `escalated` |
| lease-expiry | `recovered` | `escalated` |
| human-revoke | `recovered` | `escalated` |
| partial-fail-rollback | `rolled_back` | `escalated` |
| contribution-stale | `recovered` | `escalated` |
| contribution-timeout | `recovered` | `escalated` |
| coordinator-failure | `recovered` (재평가 후 `applied`) | `escalated` |

회수가 성공해도 객체가 ESCALATED로 전이되는 경우(재시도 한도 초과 등)는 *회수 자체* 의 실패가 아니다. 이때 ledger의 `result`는 `recovered` 이며, 후속 ESCALATED 진입은 별도의 ledger 행으로 기록된다.

### Idempotency

같은 Recover trigger가 같은 객체에 대해 반복 발화될 수 있다. Caller는 Recover ledger idempotency key 를 `object_id + trigger + observed_revision_pin`으로 산출하여 중복 회수를 ledger의 `duplicate`로 흡수한다. contribution-단위 회수의 경우 `object_id` 는 `(phase_run_id, agent_profile, contribution_kind)` 셋의 합성이다. 이 키는 Agent output envelope 의 idempotency key 와 이름은 같지만 entity scope 가 다르므로 prose 에서는 항상 Recover ledger idempotency key 로 한정해 부른다.

<a id="SOC-DISPATCH-MATRIX"></a>
## SOC-DISPATCH-MATRIX: Dispatch Matrix

본 절은 `#SOC-OPERATIONS` 의 모든 분기를 *phase × phase_state × contribution_kind × output_kind × 종착* 으로 응축한 표다. 각 phase 절의 본문이 정본이며, 본 표는 단일 진입점으로의 인덱스 역할을 한다.

phase 종착 transition (CP 종착 포함) 은 `application/phase_coordinator.sh` 가 quorum 평가 통과 (`quorum_reached`) 시점에만 dispatch 한다. 단일 contribution 의 submit 은 객체 종착을 일으키지 않는다.

| Phase | phase_state (시작) | contribution_kind | `output_kind` / verdict | 종착 (quorum_reached 이후) |
|---|---|---|---|---|
| Intake | (없음) | (Caller only) | seed 입력(`#SOC-INTAKE`) | milestone `DISCOVERY_DRAFT` |
| Discovery | `DISCOVERY_DRAFT` | `lead_draft` (atlas) | `spec_proposal` | milestone `DISCOVERY_AWAITING_HUMAN`, Spec CP `CP_AWAITING_QUORUM` |
| Discovery | `DISCOVERY_AWAITING_HUMAN` | `human_approval` (human) | `verdict.result=approve` | milestone `SPECIFICATION_DRAFT`, Spec CP `CP_MERGED` |
| Discovery | `DISCOVERY_AWAITING_HUMAN` | `human_approval` (human) | `verdict.result=reject` | milestone `DISCOVERY_DRAFT` 회수, Spec CP `CP_CLOSED` |
| Specification | `SPECIFICATION_DRAFT` | `lead_draft` (atlas) | `spec_proposal` | milestone `SPECIFICATION_AWAITING_HUMAN`, Spec CP `CP_AWAITING_QUORUM` |
| Specification | `SPECIFICATION_AWAITING_HUMAN` | `human_approval` (human) | `verdict.result=approve` | milestone `PLANNING_READY`, Spec CP `CP_MERGED` |
| Specification | `SPECIFICATION_AWAITING_HUMAN` | `human_approval` (human) | `verdict.result=reject` | milestone `SPECIFICATION_DRAFT` 회수, Spec CP `CP_CLOSED` |
| Planning | `PLANNING_IN_PROGRESS` | `lead_draft` (atlas) + `review_verdict` (forge/sentinel, ≥2 approvals) | `task_plan` | milestone `IMPLEMENTATION_IN_PROGRESS`, ready Task `TASK_READY` |
| Planning | `PLANNING_IN_PROGRESS` | `lead_draft`+`failure` (cycle, 중복 slug, branch invalid) | `failure` | milestone `PLANNING_READY` 회수 또는 ESCALATED |
| Implementation | Task `TASK_IN_PROGRESS` | `lead_draft` (forge) | `patch` | task `TASK_REVIEW_READY`, Code CP `CP_READY_FOR_REVIEW` |
| Implementation | Task `TASK_IN_PROGRESS` | `rework_patch` (forge, request-changes 후) | `patch` | task `TASK_REVIEW_READY`, Code CP 신규 `CP_READY_FOR_REVIEW` |
| CodeReview | Task `TASK_REVIEW_IN_PROGRESS` | `review_verdict` (sentinel lead + atlas/forge) | `verdict.result=approve` (stale 아님) | task `TASK_INTEGRATED`, Code CP `CP_MERGED` |
| CodeReview | Task `TASK_REVIEW_IN_PROGRESS` | `review_verdict` | `verdict.result=approve` (stale 감지) | task `TASK_READY` 회수, Code CP `CP_STALE` |
| CodeReview | Task `TASK_REVIEW_IN_PROGRESS` | `review_verdict` | `verdict.result=request-changes` | task `TASK_READY` 회수, Code CP `CP_CLOSED` |
| Integration | `INTEGRATION_IN_PROGRESS` | `lead_draft` (sentinel) | `verdict.result=PASS` (CP 있음) | milestone `VALIDATION_READY`, Integration CP `CP_MERGED` |
| Integration | `INTEGRATION_IN_PROGRESS` | `lead_draft` | `verdict.result=PASS` (NO-OP) | milestone `VALIDATION_READY` |
| Integration | `INTEGRATION_IN_PROGRESS` | `lead_draft` | `verdict.result=FAIL` | milestone `INTEGRATION_READY` 회수 또는 ESCALATED, Integration CP `CP_CLOSED`(있을 때) |
| Integration | `INTEGRATION_IN_PROGRESS` | `lead_draft` | `verdict.result=STALE` | milestone `INTEGRATION_READY` 회수, Integration CP `CP_STALE`(있을 때) |
| Validation | `VALIDATION_IN_PROGRESS` | `lead_draft` (sentinel) + `summary` (atlas) | `verdict.result=PASS` | milestone `DONE`, 자식 task 종료, Milestone CP `CP_MERGED` |
| Validation | `VALIDATION_IN_PROGRESS` | `lead_draft` | `verdict.result=FAIL` | milestone `IMPLEMENTATION_IN_PROGRESS` 회수, 책임 task 만 `TASK_READY`, Milestone CP `CP_CLOSED` |
| Validation | `VALIDATION_IN_PROGRESS` | `lead_draft` | `verdict.result=STALE` | milestone `VALIDATION_READY` 회수, Milestone CP `CP_STALE` |
| Recover | (다양) | (Caller only) | trigger 별 — `#SOC-RECOVERY-OPERATION` | 직전 `*_READY` 또는 ESCALATED, 영향받은 CP 의 `CP_STALE`/`CP_CLOSED` |
| (any) | (any) | (any) | `failure` envelope | 상태 변경 없음. contribution 만 `CONTRIB_FAILED` |

ledger result 매핑(`applied`, `stale`, `recovered`, `rolled_back`, `escalated` 등)은 `#RGC-LEDGER`가 정의한다.

### Operation × Ledger Result 매트릭스

cycle 종료 시 ledger 한 줄이 어느 result 로 분류되는지를 operation 분기에서 일관되게 본다. `#RGC-LEDGER` 의 enum 을 재정의하지 않으며, *어느 분기가 어느 result 로 가는가* 만 응축한다.

| 분기 | Ledger result |
|---|---|
| 위 분기표의 정상 종착(`applied` 행으로 표기되는 모든 transition) | `applied` |
| lease claim 경쟁 패배 | `claim_failed` |
| 같은 idempotency_key 의 선행 ledger 발견 | `duplicate` |
| 전이 조건 미충족(예: dependency 미해소, ready 객체 부재) | `noop` |
| envelope 검증 실패(`#AGC-INVALID`) | `invalid` |
| revision pin 또는 lease_token 불일치 | `stale` |
| 인프라/어댑터 오류(`#ARC-EXIT-CLASSES` 의 `transport_error`/`adapter_unavailable` 등) | `error` |
| Recover 의 stale/lease-expiry/human-revoke 회수(`#SOC-RECOVERY-OPERATION`) | `recovered` |
| Recover 의 partial-fail-rollback 또는 multi-step 부분 적용 원복(`#RGC-FAILURE`) | `rolled_back` |
| 재시도 한도 초과 또는 회수 자체 실패 | `escalated` |

같은 normal cycle 에서 두 result 가 동시에 후보가 되면 우선순위는 다음과 같다: `claim_failed` > `duplicate` > `noop` > `stale` > `invalid` > `error` > 정상 분기(`applied`). 우선순위는 *최초로 만족한 조건* 으로 cycle 을 즉시 종료시키는 의미다.

`recovered`, `rolled_back`, `escalated` 는 위 normal cycle 우선순위 비교 대상이 아니다. 이 셋은 Recover 또는 failure handling 이 별도 ledger 행으로 기록하는 terminal result 다.

<a id="SOC-MERGE-POLICY"></a>
## SOC-MERGE-POLICY: Integration Branch Policy

Code CP 는 통합 브랜치를 base 로 한다. 병렬 Implementation phase 때문에 CP base 가 현재 통합 브랜치 HEAD 보다 낡을 수 있다.

Caller 는 CodeReview phase 의 quorum 이 approve 로 통과한 뒤 다음 순서로 처리한다.

1. CP base 가 현재 통합 브랜치 HEAD 와 같으면 병합을 시도한다.
2. CP base 가 낡았지만 deterministic merge/rebase 가 clean 이면 Caller 가 병합 후보를 갱신하고 결정적 검증을 다시 실행한다.
3. conflict 가 있거나 결정적 검증이 실패하면 CP 를 `CP_STALE` 또는 `CP_REQUEST_CHANGES` 로 닫고 Task 를 `TASK_READY` 로 회수한다.

Agent 는 병합 충돌을 직접 해결하지 않는다. 충돌 해결이 필요한 경우 Caller 는 새 Implementation phase PhaseRun 을 만든다.

<a id="SOC-IDEMPOTENCY"></a>
## SOC-IDEMPOTENCY: Idempotency Rules

멱등성 키는 입력 revision 을 기준으로 한다. LLM 산출 본문 hash 는 output identity 로 사용하고, primary idempotency key 로 사용하지 않는다.

phase 별 idempotency key 합성 항에는 `phase`, `phase_run_id`, `agent_profile`, `contribution_kind` 가 모두 포함되어 같은 PhaseRun 안의 서로 다른 contribution (예: lead_draft 와 review_verdict) 이 ledger 에 충돌 없이 기록된다. Caller enrichment 가 합성하며 Agent 는 산출하지 않는다 (`docs/contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH`).

중복 산출이 감지되면 Caller 는 새 객체를 만들지 않고 기존 객체를 재사용하거나 상태를 수렴시킨다.
