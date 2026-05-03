# Pipeline End-to-End

본 문서는 Caller 단일 cycle 의 단계와 책임을 contract 에 매핑한다. 본 문서는 contract 를 override 하지 않는다. 권위는 다음 순으로 우선한다.

1. [`llm-team.md`](../../llm-team.md)
2. [`docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`](../contracts/state-and-operation-contract.md#SOC-OPERATIONS)
3. [`docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT) / [`#AGC-OUTPUT-RUNTIME-ENRICH`](../contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH)
4. [`docs/contracts/reliability-and-gate-contract.md#RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE) / [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) / [`#RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY)

## Cycle 개요

Caller 의 한 cycle 은 *하나의* `(role, target)` 쌍에 대해 다음 6 단계를 수행하고 ledger 한 줄을 남기며 종료한다.

```text
┌─────────────┐   ┌─────────────┐   ┌──────────────────┐
│ 1. Pickup   │──▶│ 2. Lease    │──▶│ 3. Manifest +    │
│ (ready obj) │   │ (atomic     │   │    Workspace +   │
│             │   │  claim +    │   │    Prompt        │
│             │   │  recovery)  │   │                  │
└─────────────┘   └─────────────┘   └──────────────────┘
                                            │
                                            ▼
┌─────────────┐   ┌──────────────┐   ┌──────────────────┐
│ 6. Cleanup  │◀──│ 5. Dispatch  │◀──│ 4. Invoke +      │
│  + Ledger   │   │ (per role ×  │   │    Validate +    │
│             │   │  output_kind)│   │    Pin recheck   │
└─────────────┘   └──────────────┘   └──────────────────┘
```

각 단계는 contract 의 책임을 하나씩 *적용* 만 한다. 단계 사이에서는 envelope · ledger · lease 가 인터페이스다.

## 단계별 책임

### 1. Pickup (oldest-ready-first)

Caller 는 *역할 × target* 단위로 1개의 ready 객체만 선점한다. 선택 기준은 pre-claim READY 후보와 dependency join 이다. lease claim 이 성공하면 단계 2 에서 SOC 의 input state 인 `*_IN_PROGRESS` 로 전이한다.

| 역할 | 후보 객체 | 정렬 / 선택 기준 |
|---|---|---|
| PO | `feature-request` 라벨 + 미연결 issue, 또는 `PO_DRAFT` milestone | createdAt asc (입수 흐름은 [feature-request-intake.md](feature-request-intake.md)) |
| PM | `PM_DRAFT` milestone | createdAt asc |
| Planner | `DECOMPOSE_READY` milestone | createdAt asc |
| Coder | `TASK_READY` task 중 모든 blocker 가 `TASK_INTEGRATED` | createdAt asc |
| Reviewer | `TASK_REVIEW_READY` task | createdAt asc |
| Integrator | `REFACTOR_READY` milestone | createdAt asc |
| QA | `VALIDATE_READY` milestone | createdAt asc |

Pickup 단계는 *읽기 전용* 이다. 상태 전이는 단계 2 에서 수행된다.

### 2. Lease + Recovery

Pickup 직후 Caller 는 atomic lease(`RGC-LEASE`) 를 시도한다. 성공하면 객체를 `*_IN_PROGRESS` 로 전이하고, 실패하면 cycle 을 *no-op* 로 종료한다.

매 cycle 시작 시 `recovery_scan`(SOC `Recover` operation, `RGC-RECOVERY`) 이 만료된 lease 를 스윕하여 객체를 회수 가능한 이전 상태로 되돌린다. 회수 결과는 ledger 에 `recovered` 로 기록된다.

### 3. Manifest + Workspace + Prompt

Caller 는 `AGC-CONTEXT-MANIFEST` 에 따라 manifest 를 생성하고, 필요 시 격리 작업 공간(`AGC-WORKSPACE`)을 준비한 뒤, 역할별 system/user prompt 와 manifest 를 합쳐 LLM 입력을 구성한다.

- PO/PM/Planner: 읽기 전용 marker 디렉토리(작업 공간 불필요)
- Coder/Reviewer/Integrator/QA: target 의 worktree 또는 통합 브랜치 clone

prompt 는 *콘텐츠 필드만* LLM 에게 요구한다. runtime metadata 는 `AGC-OUTPUT-RUNTIME-ENRICH` 에 따라 Caller 가 후주입한다.

### 4. Invoke + Validate + Pin Recheck

Caller 는 LLM 어댑터(현 구현: `claude_code`, `fake`) 를 통해 호출하고, 응답에서 fenced JSON envelope 을 추출한다. 추출 직후 다음 순서를 따른다.

1. **Enrichment** (`AGC-OUTPUT-RUNTIME-ENRICH`): runtime metadata 후주입.
2. **Envelope validation** (`AGC-OUTPUT`, `AGC-INVALID`): 필수 필드, manifest 포함 여부, 비밀 grep, 작업 공간 외 파일 변경 검사.
3. **Pin recheck**: 모든 `required` manifest entry 의 revision pin 이 호출 직전과 동일한지 재검증. 변경 시 `stale`.

이 단계의 결과는 다음 중 하나로 ledger result 에 매핑된다: `applied` 후속 단계 진행 / `invalid` / `stale` / `error` / `claim_failed` / `duplicate`.

### 5. Dispatch (per role × output_kind)

`SOC-OPERATIONS` 의 Caller action 을 *role × verdict/output_kind* 분기로 적용한다.

| 역할 | output_kind / verdict | 주요 side-effect | 종착 상태 |
|---|---|---|---|
| PO | `spec_proposal` | Spec CP 생성 | milestone `PO_GATE`, CP `READY_FOR_HUMAN_GATE` |
| PM | `spec_proposal` | Spec CP 생성 | milestone `PM_GATE`, CP `READY_FOR_HUMAN_GATE` |
| Planner | `task_plan` | dependency cycle 검증 → task issue 일괄 생성 → blocked_by wiring | milestone `IMPLEMENTING`, ready task 들 `TASK_READY` |
| Coder | `patch` | workspace patch apply → branch publish → PR open → Code CP 생성 | task `TASK_REVIEW_READY`, CP `READY_FOR_REVIEW` |
| Reviewer | `verdict=approve` | stale check(pr_head_sha 비교) → CP merge → PR squash-merge | task `TASK_INTEGRATED`, CP `MERGED` |
| Reviewer | `verdict=request-changes` | CP close, PR close | task `TASK_READY`, CP `CLOSED` |
| Integrator | `verdict=PASS` | Integration CP 있으면 merge, 없으면 ledger 기록만 | milestone `VALIDATE_READY` |
| Integrator | `verdict=FAIL` | CP close, attempt count 증가 | milestone `REFACTOR_READY` 또는 `ESCALATED` |
| Integrator | `verdict=PASS` (NO-OP) | ledger only | milestone `VALIDATE_READY` |
| Integrator | `verdict=STALE` | CP `STALE` | milestone `REFACTOR_READY` |
| QA | `verdict=PASS` | Milestone CP merge, release publish, child task 종료, decision-log/context-summary 영속화 | milestone `DONE` |
| QA | `verdict=FAIL` | 책임 task 만 `TASK_READY` 회수 | milestone `IMPLEMENTING` |
| QA | `verdict=STALE` | CP `STALE` | milestone `VALIDATE_READY` |
| (any) | `failure` | ledger 기록만 | 상태 변경 없음 |

각 분기는 단계 4 의 enrichment 가 envelope 의 `runtime_metadata` 영역에 후주입한 키들(예: 영속 저장소가 발급한 식별자, 통합 단위 HEAD)을 입력으로 사용한다. 키의 구체 이름은 영속 저장소 어댑터가 결정한다.

### 6. Cleanup + Ledger

Caller 는 lease 를 release 하고 임시 작업 공간을 정리하며, `RGC-LEDGER` 한 줄을 append 한다(`idempotency_key` 기준 중복 시 부작용 없이 동일 결과 반환).

## 외부 운영 (daemon)

본 cycle 은 `scheduler/runner.sh` 가 실행하며, daemon(`scheduler/daemon.sh`)이 `(role × target)` 별 lockdir 로 다중 워커를 띄운다. 운영 세부는 [`daemons.md`](daemons.md), 도구 매핑은 [`tools.md`](tools.md), 모듈 책임은 [`application-modules.md`](application-modules.md) 를 참조한다.

## 정합성 점검 포인트

본 문서는 다음 invariant 의 *매핑* 만 보여준다. 위반 여부는 contract 에서 판정한다.

- Inv#1: 단계 4 의 invoke 는 stateless 단일 호출.
- Inv#2: 단계 3 의 manifest 와 단계 4 의 pin recheck.
- Inv#3: 단계 5 의 모든 side-effect 가 Caller 책임. LLM 산출에는 없음(`AGC-OUTPUT-RUNTIME-ENRICH`).
- Inv#6: 단계 2 의 lease atomic claim.
- Inv#7: 단계 4 의 deterministic verification(Reviewer/Integrator/QA pre-action).
- Inv#9: 단계 5 의 attempt count 와 ESCALATED 분기.
