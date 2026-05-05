# LLM Team Contracts

이 디렉토리는 `llm-team.md`의 철학을 구현 가능한 규약으로 구체화한다. `llm-team.md`가 Constitution이면, 이 디렉토리는 operational contract set이다.

<a id="CONTRACT-AUTHORITY"></a>
## CONTRACT-AUTHORITY: Authority

문서 권위 순서는 다음과 같다.

1. `llm-team.md`
2. `docs/contracts/*.md`
3. 구현 문서, 프롬프트, 스크립트, 상태 표지 매핑, 도구별 adapter

상위 문서와 하위 문서가 충돌하면 상위 문서가 우선한다. contract 문서끼리 충돌하면 더 구체적인 scope의 문서가 우선하되, 충돌 자체를 수정 대상으로 기록해야 한다.

`docs/architecture/`는 구현 설명 또는 기존 설계 자료로 간주한다. 이 디렉토리의 contract를 override하지 않는다.

<a id="CONTRACT-STRUCTURE"></a>
## CONTRACT-STRUCTURE: Directory Structure

```text
llm-team.md
docs/contracts/
  README.md
  agent-and-context-contract.md
  state-and-operation-contract.md
  reliability-and-gate-contract.md
  knowledge-contract.md
  target-config-contract.md
  agent-runner-port-contract.md
```

각 contract의 책임은 다음과 같다.

| 문서 | 책임 |
|---|---|
| `agent-and-context-contract.md` | AgentProfile, Phase, Contribution, Context Manifest, revision pin, output envelope, contribution 별 산출 계약, 영속 본문 렌더링 |
| `state-and-operation-contract.md` | Milestone / Task / PhaseRun / Contribution / Change Proposal 상태, 허용 전이, phase 별 Caller action, dispatch 매트릭스, Recover operation |
| `reliability-and-gate-contract.md` | lease, retry, stale recovery, deterministic verification, 사람 contribution, transition ledger, pause, daemon 시작 |
| `knowledge-contract.md` | 누적 스펙, manifest, decision log, context summary, AC traceability, manifest materialization |
| `target-config-contract.md` | target 식별·바인딩, AgentProfile 레지스트리, phase policy, lease TTL 정책, onboarding 게이트 설정, 설정 우선순위 |
| `agent-runner-port-contract.md` | agent runner 포트 시그니처, 호출 의미, 종료 분류, idempotency, adapter 교체 invariant |

<a id="CONTRACT-REFERENCE"></a>
## CONTRACT-REFERENCE: Reference Method

모든 안정 참조 대상 section은 명시적 HTML anchor를 가진다.

```md
<a id="AGC-OUTPUT"></a>
## AGC-OUTPUT: Output Contract
```

다른 문서에서 참조할 때는 repo root 기준 상대 경로로 다음 형식을 사용한다.

```text
<relative-path>#<section-id>
```

예:

- `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`
- `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH`
- `docs/contracts/agent-and-context-contract.md#AGC-ISSUE-BODY`
- `docs/contracts/state-and-operation-contract.md#SOC-INTAKE`
- `docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`
- `docs/contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX`
- `docs/contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION`
- `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER`
- `docs/contracts/reliability-and-gate-contract.md#RGC-DAEMON-STARTUP`
- `docs/contracts/knowledge-contract.md#KAC-TRACEABILITY`
- `docs/contracts/knowledge-contract.md#KAC-MANIFEST-FROM-KNOWLEDGE`
- `docs/contracts/target-config-contract.md#TCC-LEASE-CONFIG`
- `docs/contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE`

Section ID prefix는 문서별로 고정한다.

| Prefix | 문서 |
|---|---|
| `AGC` | Agent and Context Contract |
| `SOC` | State and Operation Contract |
| `RGC` | Reliability and Gate Contract |
| `KAC` | Knowledge Contract |
| `TCC` | Target Configuration Contract |
| `ARC` | Agent Runner Port Contract |
| `CONTRACT` | Contract README |

<a id="CONTRACT-ARCHITECTURE-MAPPING"></a>
## CONTRACT-ARCHITECTURE-MAPPING: Architecture Mapping Index

Contract 문서만 읽는 contributor 는 다음 표에서 구현 매핑 문서로 이동한다. Architecture 문서는 contract 를 override 하지 않으며, contract 절의 적용 위치와 구현 선택만 설명한다.

| Contract anchor | Architecture mapping |
|---|---|
| [`AGC-CONTEXT-MANIFEST`](agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) | [`context-snapshot.md`](../architecture/context-snapshot.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`AGC-OUTPUT`](agent-and-context-contract.md#AGC-OUTPUT), [`AGC-OUTPUT-RUNTIME-ENRICH`](agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH), [`AGC-ISSUE-BODY`](agent-and-context-contract.md#AGC-ISSUE-BODY) | [`agent-output-format-mapping.md`](../architecture/agent-output-format-mapping.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`SOC-OBJECTS`](state-and-operation-contract.md#SOC-OBJECTS), [`SOC-OPERATIONS`](state-and-operation-contract.md#SOC-OPERATIONS), [`SOC-DISPATCH-MATRIX`](state-and-operation-contract.md#SOC-DISPATCH-MATRIX) | [`state-machine.md`](../architecture/state-machine.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
| [`SOC-RECOVERY-OPERATION`](state-and-operation-contract.md#SOC-RECOVERY-OPERATION) | [`state-machine.md`](../architecture/state-machine.md), [`lease-and-recovery.md`](../architecture/lease-and-recovery.md) |
| [`RGC-PHASE-LEASE`](reliability-and-gate-contract.md#RGC-PHASE-LEASE), [`RGC-RECOVERY`](reliability-and-gate-contract.md#RGC-RECOVERY), [`RGC-FAILURE`](reliability-and-gate-contract.md#RGC-FAILURE), [`RGC-LEDGER`](reliability-and-gate-contract.md#RGC-LEDGER), [`RGC-HUMAN-CONTRIBUTION`](reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`daemons.md`](../architecture/daemons.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
| [`RGC-FAIRNESS`](reliability-and-gate-contract.md#RGC-FAIRNESS), [`RGC-DAEMON-STARTUP`](reliability-and-gate-contract.md#RGC-DAEMON-STARTUP) | [`daemons.md`](../architecture/daemons.md) |
| [`RGC-VERIFICATION`](reliability-and-gate-contract.md#RGC-VERIFICATION) | [`tools.md`](../architecture/tools.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`KAC-MANIFEST-FROM-KNOWLEDGE`](knowledge-contract.md#KAC-MANIFEST-FROM-KNOWLEDGE), [`KAC-TRACEABILITY`](knowledge-contract.md#KAC-TRACEABILITY) | [`context-snapshot.md`](../architecture/context-snapshot.md), [`application-modules.md`](../architecture/application-modules.md) |
| [`TCC-LEASE-CONFIG`](target-config-contract.md#TCC-LEASE-CONFIG), [`TCC-ONBOARDING`](target-config-contract.md#TCC-ONBOARDING), [`TCC-AGENT-PROFILES`](target-config-contract.md#TCC-AGENT-PROFILES), [`TCC-PHASE-POLICIES`](target-config-contract.md#TCC-PHASE-POLICIES) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md) |
| [`ARC-PORT-SIGNATURE`](agent-runner-port-contract.md#ARC-PORT-SIGNATURE), [`ARC-EXIT-CLASSES`](agent-runner-port-contract.md#ARC-EXIT-CLASSES), [`ARC-ADAPTER-SUBSTITUTION`](agent-runner-port-contract.md#ARC-ADAPTER-SUBSTITUTION) | [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md), [`adapter-inventory.md`](../architecture/adapter-inventory.md) |

<a id="CONTRACT-GLOSSARY"></a>
## CONTRACT-GLOSSARY: Vocabulary

본 contract set 의 1급 어휘 정의. 모든 contract 와 architecture 문서는 동일한 의미로 이 어휘를 사용한다.

| 어휘 | 정의 |
|---|---|
| **Phase** | workflow 의 단계. canonical 7-phase sequence 는 `Discovery → Specification → Planning → Implementation → CodeReview → Integration → Validation`. |
| **AgentProfile** | 모델 + 성격 + 권한 묶음의 추상. canonical id: `atlas`, `forge`, `sentinel`, `scout`, `human`. 모델명·엔진은 본 contract set 어디에도 등장하지 않으며 `target-config-contract.md` 가 단일 권위. |
| **Contribution** | 하나의 `(phase_run, agent_profile)` 호출이 남기는 산출. `contribution_kind` 는 enum (`lead_draft`, `review_verdict`, `rework_patch`, `evidence`, `summary`, `human_approval` 등). **persistent store 의 1급 객체**이며, queue-based handoff 는 contribution 단위로도 적용된다. |
| **PhaseRun** | 한 milestone/task 안의 phase 1회 실행. 여러 contribution 을 가진다. |
| **Quorum** | PhaseRun 의 최종화 조건. `phase_policies.<phase>.quorum` 으로 설정. enum: `lead_only`, `min_approvals`, `all_reviewers`, `any_request_changes_blocks`. |
| **Required reviewers** | quorum 에 반드시 포함되어야 하는 AgentProfile 목록. `human` 을 포함하면 사람 승인이 필수. `phase_policies.<phase>.required_reviewers` 로 설정. |
| **Phase coordinator** | quorum 평가와 final artifact 압축을 수행하는 Caller 컴포넌트. 위치는 architecture 결정 (`application/phase_coordinator.sh`). |

Envelope canonical 필드는 다음과 같다 (상세는 `agent-and-context-contract.md#AGC-OUTPUT`):

```text
phase, agent_profile, contribution_kind, phase_run_id, output_kind, failure?
```

<a id="CONTRACT-MIGRATION-NOTES"></a>
## CONTRACT-MIGRATION-NOTES: Legacy Role → Phase / AgentProfile Migration

기존 7-Role 모델 (`PO / PM / Planner / Coder / Reviewer / Integrator / QA`) 은 본 contract set 에서 완전히 폐기된다. legacy 어휘를 본 contract 어디에도 사용하지 않는다 (REPLACE without alias). 본 절은 도구·테스트·운영 코드를 마이그레이션할 때만 참조하기 위한 단일 환산표다.

### Phase 환산

| Legacy Role | New Phase | Lead Profile | Reviewers | Required Reviewers |
|---|---|---|---|---|
| PO | `Discovery` | `atlas` | `sentinel` | `[human]` |
| PM | `Specification` | `atlas` | `forge`, `sentinel` | `[human]` |
| Planner | `Planning` | `atlas` | `forge`, `sentinel` | — |
| Coder | `Implementation` | `forge` | (task 단위 병렬) | — |
| Reviewer | `CodeReview` | `sentinel` | `atlas`, `forge` | — |
| Integrator | `Integration` | `sentinel` | `scout`, `atlas` | — |
| QA | `Validation` | `sentinel` | `scout`, `atlas` | — |

`required_reviewers=[human]` 인 phase 는 legacy `PO_GATE` / `PM_GATE` 의 사람 승인을 흡수한다. 별도 governance gate state 는 없다.

### Anchor 환산

| Legacy Anchor | 새 Anchor |
|---|---|
| `AGC-ROLES` | `AGC-PHASES` + `AGC-AGENT-PROFILES` + `AGC-CONTRIBUTION` |
| `AGC-ROLE-OUTPUTS` | `AGC-CONTRIBUTION-OUTPUTS` |
| `TCC-AGENT-RUNNER-MAP` | `TCC-AGENT-PROFILES` (+ 신규 `TCC-PHASE-POLICIES`) |
| `RGC-LEASE` (역할별 worker slot) | `RGC-PHASE-LEASE` (AgentProfile + PhaseRun coordinator slot) |
| `RGC-HUMAN-GATES` | `RGC-HUMAN-CONTRIBUTION` |

### State label 환산

| Legacy state | 새 state |
|---|---|
| `PO_DRAFT` | `DISCOVERY_DRAFT` |
| `PO_GATE` | `DISCOVERY_AWAITING_HUMAN` (quorum sub-state) |
| `PM_DRAFT` | `SPECIFICATION_DRAFT` |
| `PM_GATE` | `SPECIFICATION_AWAITING_HUMAN` (quorum sub-state) |
| `DECOMPOSE_*` | `PLANNING_*` |
| `IMPLEMENTING` | `IMPLEMENTATION_*` |
| `REFACTOR_*` | `INTEGRATION_*` |
| `VALIDATE_*` | `VALIDATION_*` |

### Envelope 필드 환산

| Legacy 필드 | 새 필드 | 비고 |
|---|---|---|
| `agent_role` | 제거 | `agent_profile` 로 대체. 호환 alias 없음 |
| (없음) | `phase` | 신규 필수 |
| (없음) | `agent_profile` | 신규 필수 |
| (없음) | `contribution_kind` | 신규 필수 |
| (없음) | `phase_run_id` | 신규 필수 |
| `output_kind` | `output_kind` | 유지 |

### Config key 환산 (TCC)

| Legacy key | 새 key |
|---|---|
| `agent_runner.by_role` | `agent_profiles.<id>.runner` |
| `lease.ttl_by_role` | `lease.ttl_by_agent_profile` (+ optional `lease.ttl_by_phase`) |
| (없음) | `agent_profiles.<id>.model` (모델명 단일 권위) |
| (없음) | `phase_policies.<phase>.{lead, reviewers, required_reviewers, quorum, timeout}` |

본 환산표는 본 절에서만 권위를 갖는다. 다른 contract 또는 architecture 문서가 동일 환산을 중복 정의하면 본 절이 우선한다.

<a id="CONTRACT-CHANGE"></a>
## CONTRACT-CHANGE: Change Rules

- Contract 변경은 변경 제안으로 제출한다.
- 본질적 철학이나 권한 경계를 바꾸는 변경은 먼저 `llm-team.md`를 수정해야 한다.
- 상태명, 필드명, operation semantics를 바꾸면 참조 문서와 구현 adapter를 함께 갱신해야 한다.
- 같은 개념을 여러 문서에 중복 정의하지 않는다. 한 문서는 authoritative source가 되고, 다른 문서는 reference만 둔다.
- enum 값을 추가·변경하면 contract 본문, 구현 값, ledger/dashboard 집계 값이 같은 어휘를 쓰는지 확인해야 한다.
- 같은 필드명이 다른 entity에서 쓰이면 scope를 명시해야 한다. 예: Agent output envelope idempotency key 와 Recover ledger idempotency key 는 같은 `idempotency_key` 필드명을 쓰지만 entity scope 가 다르다.
- anchor 를 추가·변경하면 `#CONTRACT-CONFORMANCE` matrix 를 함께 갱신해야 한다. 구현이 아직 없으면 contract 를 forward-looking prose 로 숨기지 말고 `spec-only` 또는 `partial` 로 표시한다.

<a id="CONTRACT-STATUS"></a>
## CONTRACT-STATUS: Status

현재 contract set은 Active로 간주한다. 구현이 contract를 충족하지 못하면 구현을 수정하거나, 사람 승인으로 contract 변경 제안을 제출해야 한다.

<a id="CONTRACT-CONFORMANCE"></a>
## CONTRACT-CONFORMANCE: Anchor Conformance Matrix

`CONTRACT-STATUS=Active` 는 contract set 이 권위 있는 규약이라는 뜻이다. 각 anchor 가 현재 구현에서 어느 정도 보장되는지는 아래 matrix 가 따로 정의한다.

Status enum:

| Status | 의미 |
|---|---|
| `active` | 현재 production path 또는 문서 권위 구조가 해당 anchor 를 보장한다 |
| `partial` | 일부 production path 만 보장하거나 알려진 미구현 path 가 남아 있다 |
| `spec-only` | contract/helper/문서 정의는 있으나 production binding 이 없다 |
| `deprecated` | 더 이상 새 구현이 의존하면 안 되는 anchor 다 |

### Contract README

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `CONTRACT-AUTHORITY` | active | contract authority | 문서 권위 순서 |
| `CONTRACT-STRUCTURE` | active | repository layout | contract file set |
| `CONTRACT-REFERENCE` | active | markdown anchors | stable reference rule |
| `CONTRACT-GLOSSARY` | active | this README | Phase / AgentProfile / Contribution 1급 어휘 정의 |
| `CONTRACT-MIGRATION-NOTES` | active | this README | legacy role → phase / agent_profile 환산표 단일 출처 |
| `CONTRACT-CHANGE` | active | review checklist | 변경 규칙과 drift guardrail |
| `CONTRACT-STATUS` | active | contract prose | contract set 의 권위 상태 |
| `CONTRACT-CONFORMANCE` | active | this matrix | anchor 별 구현 conformance 상태 |

### Agent and Context

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `AGC-SCOPE` | active | contract authority | 문서 scope anchor |
| `AGC-PHASES` | spec-only | contract prose | 7-phase enum. 구현 (`lib/phases.sh`) 은 후속 PR |
| `AGC-AGENT-PROFILES` | spec-only | contract prose | 5-profile enum (atlas/forge/sentinel/scout/human). 구현 (`lib/profiles.sh`) 과 prompts 전환은 후속 PR |
| `AGC-CONTRIBUTION` | spec-only | contract prose | contribution_kind enum + persistent first-class 정책. SOC-PHASE-RUN 과 함께 후속 PR |
| `AGC-CALL-BOUNDARY` | partial | `application/agent_io.sh`, `lib/ports/*` | port 경계는 있으나 모든 adapter side-effect surface 자동 검증은 아님 |
| `AGC-CONTEXT-MANIFEST` | partial | `lib/context.sh`, `scheduler/runner.sh` | manifest 생성·검증·첨부 path 구현. contribution_kind 별 fetch_scope 기본값은 spec-only |
| `AGC-OUTPUT` | spec-only | contract prose | envelope schema 가 phase / agent_profile / contribution_kind / phase_run_id 로 전환됨. 기존 helper(`lib/output.sh`, `application/agent_io.sh`) 는 legacy envelope 기준이므로 후속 PR 에서 catch-up |
| `AGC-OUTPUT-RUNTIME-ENRICH` | spec-only | contract prose | runtime metadata / idempotency enrichment 순서. 합성 항에 phase_run_id / agent_profile / contribution_kind 포함 |
| `AGC-CONTRIBUTION-OUTPUTS` | spec-only | contract prose | phase × contribution_kind × output_kind × verdict matrix 가 contract 정본 |
| `AGC-WORKSPACE` | partial | `adapters/workspace/*`, `application/caller_dispatch.sh` | Implementation phase 의 forge contribution 격리 worktree path 검증은 있으나 cleanup/recovery path 는 부분 구현 |
| `AGC-ISSUE-BODY` | spec-only | `docs/architecture/agent-output-format-mapping.md` | rendering 규약은 있으나 parser/enforcer 없음 |
| `AGC-INVALID` | partial | `application/agent_io.sh`, `lib/output.sh` | manifest 외 참조·secret·path 검증은 있음. phase / contribution_kind enum 검증과 body layer 검증은 spec-only |

### State and Operation

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `SOC-SCOPE` | active | contract authority | 문서 scope anchor |
| `SOC-OBJECTS` | spec-only | contract prose | PhaseRun / Contribution 객체가 추가됨. legacy `lib/state.sh` 는 milestone/task/CP 만 다룸 |
| `SOC-PHASE-RUN` | spec-only | contract prose | PhaseRun + Contribution lifecycle (CONTRIB_PENDING..CONTRIB_CONSIDERED). 영속화 helper 는 후속 PR |
| `SOC-STATES` | spec-only | contract prose | state label 이 phase-based 로 전환됨 (DISCOVERY_*, SPECIFICATION_*, PLANNING_*, IMPLEMENTATION_*, INTEGRATION_*, VALIDATION_*). 기존 helper(`application/caller_dispatch.sh`, `application/human_signal.sh`) 는 legacy label 기준이므로 후속 PR 에서 catch-up |
| `SOC-DEPENDENCIES` | partial | `application/ready_object.sh`, `application/caller_dispatch.sh` | dependency 대기 path 구현. cycle/edge 전수 검증은 Planning lead path 에 의존 |
| `SOC-INTAKE` | active | `application/feature_request.sh` | feature request promote path. 진입 to_state 만 `DISCOVERY_DRAFT` 로 rename 필요 |
| `SOC-OPERATIONS` | spec-only | contract prose | 7-phase operation set (Intake, Discovery, Specification, Planning, Implementation, CodeReview, Integration, Validation, Recover) 으로 재구성. quorum 평가는 phase_coordinator.sh (후속 PR) |
| `SOC-RECOVERY-OPERATION` | partial | `application/recovery.sh` | stale / lease-expiry 회수 구현. contribution-stale / contribution-timeout / coordinator-failure trigger 는 spec-only |
| `SOC-DISPATCH-MATRIX` | spec-only | contract prose | phase × contribution_kind × output_kind 기반으로 재구성. 기존 helper 는 legacy operation 기준 |
| `SOC-MERGE-POLICY` | spec-only | contract prose | adapter-neutral merge policy. deterministic merge/rebase helper 없음 |
| `SOC-IDEMPOTENCY` | partial | `application/caller_dispatch.sh`, `lib/ledger.sh` | `applied`/`duplicate` ledger 는 active. 합성 항에 phase_run_id / agent_profile / contribution_kind 추가는 spec-only |

### Reliability and Gate

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `RGC-SCOPE` | active | contract authority | 문서 scope anchor |
| `RGC-WRITES` | active | `application/caller_dispatch.sh`, `application/human_signal.sh`, `lib/ports/*` | governance/input write 와 operational write 분리 |
| `RGC-SIGNALS` | spec-only | contract prose | approve/reject 가 `human` profile 의 `human_approval` contribution envelope 으로 변환되는 path 가 신규. 기존 `application/human_signal.sh` 는 legacy gate 직접 집행 path 이므로 후속 PR 에서 catch-up |
| `RGC-PHASE-LEASE` | spec-only | contract prose | contribution lease + phase coordinator lease 두 종류. 기존 `lib/lease.sh` 는 단일 (object, role) lease 만 다룸 |
| `RGC-RECOVERY` | spec-only | contract prose | `*_AWAITING_*` / `CONTRIB_FAILED` / `CONTRIB_STALE` 회수 정책 신규. 기존 `application/recovery.sh` 는 legacy state 기준 |
| `RGC-FAILURE` | partial | `application/recovery.sh`, `scripts/cli/daemon.sh` | daemon startup rollback 은 구현. generic multi-step rollback 은 미구현 |
| `RGC-VERIFICATION` | active | `application/verification_runner.sh` | verification run persistence + manifest attach |
| `RGC-HUMAN-CONTRIBUTION` | spec-only | contract prose | governance gate 폐기, `human` AgentProfile 의 contribution path 신규. 변환 절차 (signal → envelope → 영속 큐 → quorum) 후속 PR 에서 구현 |
| `RGC-LEDGER` | spec-only | contract prose | 필수 필드에 phase / phase_run_id / agent_profile / contribution_kind / quorum_decision / lease_kind 추가, agent_role / operation 폐기. 기존 `lib/ledger.sh` 는 legacy schema 기준 |
| `RGC-PAUSE` | active | `lib/signals.sh`, `scripts/cli/control.sh`, `application/human_signal.sh` | `RUNNING`, `PAUSED`, `STOPPED` |
| `RGC-NOTIFICATION` | partial | `lib/notifier.sh`, `adapters/notifier/*` | no-op default + notifier adapter. 알림 coverage 는 제한적 |
| `RGC-FAIRNESS` | partial | `application/ready_object.sh`, `scheduler/runner.sh` | ready object 선택은 구현. priority 예외 ledger 검증은 없음 |
| `RGC-DAEMON-STARTUP` | partial | `scripts/cli/daemon.sh` | partial startup rollback ledger 포함. AgentProfile worker + phase coordinator 의 atomic 기동은 후속 PR |

### Knowledge

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `KAC-SCOPE` | active | contract authority | 문서 scope anchor |
| `KAC-ACCUMULATION` | partial | `application/knowledge.sh`, `scheduler/runner.sh` | merged/context summary 누적 일부 구현. rejected spec 사유 누적은 catch-up 필요 |
| `KAC-MANIFEST` | partial | `lib/context.sh`, `application/knowledge.sh` | manifest entry 형식은 구현. 누적 spec index 완전성은 부분 |
| `KAC-MANIFEST-FROM-KNOWLEDGE` | partial | `scheduler/runner.sh` | PO/PM context summary auto-inject path |
| `KAC-DECISION-LOG` | active | `application/knowledge.sh`, tests | alternatives/decision field gate |
| `KAC-CONTEXT-SUMMARY` | partial | `application/knowledge.sh`, `scheduler/runner.sh` | summary snapshot/inject 구현. QA 품질 검증은 없음 |
| `KAC-TRACEABILITY` | partial | `application/agent_io.sh`, tests | Planner/QA AC mapping 검증 일부 |
| `KAC-CONFLICTS` | spec-only | contract prose | conflict resolver 구현 없음 |
| `KAC-EQUIVALENCE` | spec-only | contract prose | spec/code 동등성 원칙. 별도 enforcer 없음 |

### Target Configuration

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `TCC-SCOPE` | active | contract authority | 문서 scope anchor |
| `TCC-IDENTITY` | active | `scripts/cli/target.sh`, `lib/ledger.sh` | `target_id` ledger 분리 |
| `TCC-LEASE-CONFIG` | spec-only | contract prose | key schema 가 `lease.ttl_by_agent_profile` (+ optional `lease.ttl_by_phase`) 로 전환. 기존 `lib/config.sh` 의 `ttl_by_role` lookup 은 후속 PR 에서 catch-up |
| `TCC-ONBOARDING` | partial | `scripts/cli/target.sh`, `application/onboarding/*` | preset/checklist path 구현. skip governance 검증은 제한적 |
| `TCC-AGENT-PROFILES` | spec-only | contract prose | `agent_profiles.<id>.{runner, model, capabilities}` schema. 모델명 단일 권위. `human` profile 의 `github_human_signal` 어댑터는 후속 PR |
| `TCC-PHASE-POLICIES` | spec-only | contract prose | `phase_policies.<phase>.{lead, reviewers, required_reviewers, quorum.{rule, threshold, request_changes_blocks}, timeout}` schema. Planning pilot default 명시. phase_coordinator.sh 가 본 정책 소비 |
| `TCC-PRECEDENCE` | partial | `lib/config.sh`, env loading | lease/config 일부에 적용. agent_profiles / phase_policies key 적용은 spec-only |
| `TCC-CHANGE-RULES` | spec-only | contract prose | target config 변경 ledger helper 없음. `agent_profiles.<id>.model` 변경의 governance ledger 는 후속 PR |

### Agent Runner Port

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `ARC-SCOPE` | active | contract authority | 문서 scope anchor |
| `ARC-PORT-SIGNATURE` | spec-only | contract prose | input 이 `agent_profile`, `phase`, `contribution_kind`, `phase_run_id` 등으로 전환됨. legacy `role` / `operation` 제거. 기존 helper(`lib/ports/llm_runner.sh`) 는 legacy signature 기준이므로 후속 PR 에서 catch-up |
| `ARC-CALL-SEMANTICS` | active | `scheduler/runner.sh`, `adapters/llm_runner/*` | stdin prompt handoff + timeout path |
| `ARC-EXIT-CLASSES` | active | `lib/ports/llm_runner.sh` | `lr_classify_exit` raw-code mapping |
| `ARC-IDEMPOTENCY` | spec-only | contract prose | tuple 이 `(agent_profile, phase, contribution_kind, phase_run_id, manifest_id, idempotency_key)` 로 전환. ledger 합성 catch-up 후속 PR |
| `ARC-ADAPTER-SUBSTITUTION` | spec-only | contract prose | `same agent_profile` 기준으로 전환. target profile binding 은 `TCC-AGENT-PROFILES` 미구현 |
| `ARC-FAILURE-MODES` | active | `lib/ports/llm_runner.sh`, `scheduler/runner.sh` | timeout/transport/malformed output 분류 |
