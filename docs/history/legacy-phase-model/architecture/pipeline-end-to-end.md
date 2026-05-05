# Pipeline End-to-End

본 문서는 Caller 단일 cycle 의 단계와 책임을 contract 에 매핑한다. 본 문서는 contract 를 override 하지 않는다. 권위는 다음 순으로 우선한다.

1. [`llm-team.md`](../../llm-team.md)
2. [`docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`](../contracts/state-and-operation-contract.md#SOC-OPERATIONS), [`#SOC-PHASE-RUN`](../contracts/state-and-operation-contract.md#SOC-PHASE-RUN)
3. [`docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT) / [`#AGC-OUTPUT-RUNTIME-ENRICH`](../contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH)
4. [`docs/contracts/reliability-and-gate-contract.md#RGC-PHASE-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-PHASE-LEASE) / [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) / [`#RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY)
5. [`docs/contracts/target-config-contract.md#TCC-PHASE-POLICIES`](../contracts/target-config-contract.md#TCC-PHASE-POLICIES)

## Cycle 개요

Caller 는 두 종류의 cycle 을 가진다.

1. **Contribution cycle**: AgentProfile worker 가 `(phase, contribution_kind, target)` 단위로 ready unit 을 pickup 하여 contribution 을 submit 까지 끌고 가는 6단계.
2. **Phase coordinator cycle**: `application/phase_coordinator.sh` 가 `(phase_run_id, target)` 단위로 `CONTRIB_SUBMITTED` 들을 모아 quorum 평가 후 final artifact 를 dispatch 하는 4단계.

### Contribution Cycle (6 단계)

```text
┌─────────────┐   ┌─────────────┐   ┌──────────────────┐
│ 1. Pickup   │──▶│ 2. Lease    │──▶│ 3. Manifest +    │
│ (ready unit)│   │ (atomic     │   │    Workspace +   │
│             │   │  claim +    │   │    Prompt        │
│             │   │  recovery)  │   │                  │
└─────────────┘   └─────────────┘   └──────────────────┘
                                            │
                                            ▼
┌─────────────┐   ┌────────────────┐   ┌──────────────────┐
│ 6. Cleanup  │◀──│ 5. Submit      │◀──│ 4. Invoke +      │
│  + Ledger   │   │ contribution   │   │    Validate +    │
│             │   │ (CONTRIB_      │   │    Pin recheck   │
│             │   │  SUBMITTED)    │   │                  │
└─────────────┘   └────────────────┘   └──────────────────┘
```

contribution cycle 과 phase coordinator cycle 의 dispatch 경계는 다음과 같다.

- **contribution cycle 책임**: CP 생성 (`CP_DRAFT -> CP_AWAITING_QUORUM` / `CP_READY_FOR_REVIEW` / `CP_READY_FOR_VERIFICATION`), milestone 의 `*_AWAITING_*` 진입, Task 의 `TASK_REVIEW_READY` 진입. 모두 contribution submit 시점의 영속 객체 준비 작업이며 quorum 평가가 필요하지 않다.
- **phase coordinator cycle 책임**: quorum 평가 후의 *phase 종착* 전이 — CP 병합 (`CP_APPROVED -> CP_MERGED`) 또는 종료 (`CP_REQUEST_CHANGES -> CP_CLOSED`), milestone 의 다음 phase `*_READY` 진입, 자식 Task 종료, Context Summary 영속화.
- **`quorum.rule=lead_only` phase (예: Implementation)**: lead submit 시 contribution cycle 이 만든 객체 자체가 phase 종착물 (Code CP at `CP_READY_FOR_REVIEW` + Task at `TASK_REVIEW_READY`) 이다. phase_coordinator 는 다음 cycle 에서 trivial quorum_reached 만 ledger 에 기록하고 추가 dispatch 는 수행하지 않는다.

각 단계는 contract 의 책임을 하나씩 *적용* 만 한다. 단계 사이에서는 envelope · ledger · lease 가 인터페이스다.

## Contribution Cycle 단계별 책임

### 1. Pickup (oldest-ready-first)

Caller 는 `(agent_profile, target)` worker daemon 단위로 1개의 ready contribution unit 만 선점한다. ready unit 은 `(phase, phase_run_id, contribution_kind)` 셋으로 식별되며, 선택 기준은 PhaseRun 의 phase_state 와 dependency join 이다.

| Phase × contribution_kind | ready unit 후보 | 정렬 / 선택 기준 |
|---|---|---|
| Discovery lead_draft | `feature-request` 라벨 + 미연결 issue, 또는 `DISCOVERY_DRAFT` milestone (PhaseRun 미생성) | createdAt asc (입수 흐름은 [feature-request-intake.md](feature-request-intake.md)) |
| Specification lead_draft | `SPECIFICATION_DRAFT` milestone (PhaseRun 미생성) | createdAt asc |
| Planning lead_draft | `PLANNING_READY` milestone | createdAt asc |
| Implementation lead_draft / rework_patch | `TASK_READY` task 중 모든 blocker 가 `TASK_INTEGRATED` | createdAt asc |
| CodeReview review_verdict | `TASK_REVIEW_READY` task 의 PhaseRun 에서 reviewer profile 의 미submit slot | createdAt asc |
| Integration lead_draft | `INTEGRATION_READY` milestone | createdAt asc |
| Validation lead_draft / summary | `VALIDATION_READY` milestone | createdAt asc |
| (any) review_verdict / evidence (parallel) | 진행 중 PhaseRun 의 `phase_policies.<phase>.reviewers[]` slot | phase_run createdAt asc |

Pickup 단계는 *읽기 전용* 이다. 상태 전이는 단계 2 에서 수행된다.

### 2. Lease + Recovery

Pickup 직후 Caller 는 atomic contribution lease(`RGC-PHASE-LEASE`) 를 시도한다. 성공하면 contribution 을 `CONTRIB_PENDING -> CONTRIB_IN_PROGRESS` 로 전이하고, 실패하면 cycle 을 *no-op* 으로 종료한다. PhaseRun 자체의 milestone-level state 전이 (`*_IN_PROGRESS`) 는 PhaseRun 의 첫 lead contribution 이 시작될 때 phase coordinator 가 수행한다.

매 cycle 시작 시 `recovery_scan`(SOC `Recover` operation, `RGC-RECOVERY`) 이 만료된 lease 를 스윕한다. contribution 단위 stale 은 PhaseRun 을 보존하면서 해당 contribution 만 `CONTRIB_STALE` 로 전이하고, PhaseRun 단위 stale 은 직전 `*_READY` 로 회수한다.

### 3. Manifest + Workspace + Prompt

Caller 는 `AGC-CONTEXT-MANIFEST` 에 따라 manifest 를 생성하고, 필요 시 격리 작업 공간(`AGC-WORKSPACE`)을 준비한 뒤, `(phase, contribution_kind, agent_profile)` 별 system/user prompt 와 manifest 를 합쳐 LLM 입력을 구성한다.

| Phase × contribution_kind | 작업 공간 |
|---|---|
| Discovery / Specification / Planning lead_draft | 읽기 전용 marker 디렉토리 (작업 공간 불필요) |
| Implementation lead_draft / rework_patch | target 의 worktree (forge 격리 작업 공간) |
| CodeReview / Integration / Validation lead_draft | 통합 브랜치 clone |
| review_verdict / evidence / summary (병렬 reviewer) | 읽기 전용 marker 또는 통합 브랜치 clone (read-only) |
| human_approval | (worker daemon 점유 없음 — 외부 신호 변환 path) |

prompt 는 *콘텐츠 필드만* LLM 에게 요구한다. runtime metadata 는 `AGC-OUTPUT-RUNTIME-ENRICH` 에 따라 Caller 가 후주입한다. fetch_scope 기본값은 contribution_kind 별 default (`AGC-CONTEXT-MANIFEST`).

### 4. Invoke + Validate + Pin Recheck

Caller 는 LLM 어댑터(`claude_code`, `fake`, `github_human_signal` 등) 를 통해 호출하고, 응답에서 fenced JSON envelope 을 추출한다. 추출 직후 다음 순서를 따른다.

1. **Enrichment** (`AGC-OUTPUT-RUNTIME-ENRICH`): `phase_run_id`, `agent_profile`, `contribution_kind`, runtime metadata 후주입.
2. **Envelope validation** (`AGC-OUTPUT`, `AGC-INVALID`): 필수 필드, `(phase, contribution_kind)` 매트릭스 일치, manifest 포함 여부, 비밀 grep, 작업 공간 외 파일 변경 검사.
3. **Pin recheck**: 모든 `required` manifest entry 의 revision pin 이 호출 직전과 동일한지 재검증. 변경 시 `stale`.

이 단계의 결과는 다음 중 하나로 ledger result 에 매핑된다: `applied` 후속 단계 진행 / `invalid` / `stale` / `error` / `claim_failed` / `duplicate`.

### 5. Submit Contribution

contribution 을 `CONTRIB_IN_PROGRESS -> CONTRIB_SUBMITTED` 로 전이하고 envelope 을 영속 큐에 enqueue 한다. lead contribution 이 첫 submit 되면 contribution cycle 이 동시에 다음을 수행한다 (`SOC-OPERATIONS` 의 phase 별 "Caller action on lead submit" 행).

- 해당 phase 의 CP 생성 (`CP_DRAFT -> CP_AWAITING_QUORUM` / `CP_READY_FOR_REVIEW` / `CP_READY_FOR_VERIFICATION`)
- milestone 또는 task 의 sub-state 진입 (`*_AWAITING_QUORUM`, `*_AWAITING_HUMAN`, `TASK_REVIEW_READY` 등)

위 객체 준비는 quorum 평가가 필요하지 않으므로 contribution cycle 이 직접 수행한다. *phase 종착* 전이 (CP 병합/종료, 다음 phase `*_READY` 진입, 자식 객체 종료) 만 phase coordinator cycle 이 quorum_reached 후에 dispatch 한다.

`output_kind=failure` 인 envelope 은 contribution 을 `CONTRIB_FAILED` 로 전이하고 `result_detail` 에 사유를 기록한다.

### 6. Cleanup + Ledger

Caller 는 contribution lease 를 release 하고 임시 작업 공간을 정리하며, `RGC-LEDGER` 한 줄을 append 한다 (`idempotency_key` 기준 중복 시 부작용 없이 동일 결과 반환). ledger 의 `phase`, `phase_run_id`, `agent_profile`, `contribution_kind`, `lease_kind=contribution` 필드가 채워진다.

## Phase Coordinator Cycle (4 단계)

```text
┌──────────────────┐   ┌──────────────────┐
│ A. Phase pickup  │──▶│ B. Coordinator   │
│ (PhaseRun in     │   │    lease + recov │
│  *_AWAITING_*)   │   │                  │
└──────────────────┘   └──────────────────┘
                              │
                              ▼
┌──────────────────┐   ┌──────────────────┐
│ D. Cleanup +     │◀──│ C. Quorum eval + │
│    ledger        │   │    Dispatch (CP, │
│ (phase_run-      │   │    state, child) │
│  scoped)         │   │                  │
└──────────────────┘   └──────────────────┘
```

### A. Phase Pickup

`application/phase_coordinator.sh` 는 `*_AWAITING_QUORUM` 또는 `*_AWAITING_HUMAN` 상태의 PhaseRun 을 ready 로 본다. 후보 정렬은 PhaseRun createdAt asc.

### B. Coordinator Lease + Recovery

PhaseRun 단위 coordinator lease (`lease_kind=phase_coordinator`) 를 atomic claim 한다. 만료된 coordinator lease 가 있으면 `coordinator-failure` trigger 로 회수한다 (PhaseRun 은 보존되며 다음 cycle 에서 quorum 재평가).

### C. Quorum Evaluation + Dispatch

`phase_policies.<phase>` 를 읽어 PhaseRun 안의 `CONTRIB_SUBMITTED` 들을 모은다. 평가 결과:

- `quorum_reached` → lead contribution 의 산출을 final artifact 로 압축하고 `SOC-DISPATCH-MATRIX` 의 phase 종착 row 를 dispatch (CP 병합/종료, milestone 의 다음 phase `*_READY` 전이, 자식 객체 처리). `quorum_decision=quorum_reached` 로 ledger 기록. `quorum.rule=lead_only` phase 는 lead submit 시점에 phase 종착물이 contribution cycle 에서 이미 영속화되어 있으므로, coordinator 는 ledger 기록만 수행하고 추가 dispatch 를 생략한다.
- `awaiting_more_contributions` → no-op. `awaiting_more_contributions` ledger 행만 남기고 다음 cycle 까지 대기. `phase_policies.<phase>.timeout` 도과 시 `contribution-timeout` recover.
- `blocked_by_request_changes` → `request_changes_blocks=true` 정책에 따라 phase 종착을 차단. lead 에게 rework_patch 또는 다음 phase 회수 요청. `human` reject 인 경우 직전 `*_DRAFT` 로 milestone 회수.

dispatch 의 side-effect 는 모두 Caller (`application/caller_dispatch.sh` 호출) 가 수행한다.

### D. Cleanup + Ledger

coordinator lease 를 release 하고 PhaseRun-scoped ledger 행을 append 한다. quorum 평가 결과는 `quorum_decision` 필드에 기록.

## 외부 운영 (daemon)

contribution cycle 은 `scheduler/runner.sh` 가 AgentProfile worker daemon 단위로 실행한다 (`scheduler/daemon.sh` 가 `daemon/agent/<profile>.lock/` lockdir 로 격리). phase coordinator cycle 은 `--phase-coordinator` daemon 이 별도 프로세스로 실행하며 `daemon/phase_coordinator.lock/` lockdir 로 격리된다. 운영 세부는 [`daemons.md`](daemons.md), 도구 매핑은 [`tools.md`](tools.md), 모듈 책임은 [`application-modules.md`](application-modules.md) 를 참조한다.

## 정합성 점검 포인트

본 문서는 다음 invariant 의 *매핑* 만 보여준다. 위반 여부는 contract 에서 판정한다.

- Inv stateless 1회 호출: contribution cycle 단계 4 의 invoke 는 stateless 단일 호출.
- Inv Context Manifest + revision pin: contribution cycle 단계 3 의 manifest 와 단계 4 의 pin recheck.
- Inv Caller-only operational write: phase 종착 transition 은 phase coordinator cycle C 단계가 dispatch. contribution cycle 자체는 contribution submit 까지만 책임. 모든 side-effect 가 Caller 책임 (LLM 산출에는 없음 — `AGC-OUTPUT-RUNTIME-ENRICH`).
- Inv PhaseRun and Contribution parallelism by lease: contribution cycle 단계 2 의 contribution lease + phase coordinator cycle B 단계의 coordinator lease.
- Inv Quorum-based PhaseRun finalization: phase coordinator cycle C 단계의 quorum 평가.
- Inv Required human contribution: `human_approval` contribution 이 누락된 채 phase coordinator C 단계에서 quorum_reached 로 가지 못함.
- Inv Deterministic verification by Caller: contribution cycle 단계 4 의 deterministic verification (CodeReview / Integration / Validation phase 의 Caller pre-action).
- Inv Finite retry: phase coordinator C 단계의 attempt count 와 ESCALATED 분기.
- Inv Contribution as persistent first-class object: contribution cycle 단계 5 의 영속 큐 enqueue.
