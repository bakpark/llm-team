# LLM Team Contracts

이 디렉토리는 `llm-team.md`의 철학을 구현 가능한 규약으로 구체화한다. `llm-team.md`가 Constitution 이면, 이 디렉토리는 operational contract set 이다.

<a id="CONTRACT-AUTHORITY"></a>
## CONTRACT-AUTHORITY: Authority

문서 권위 순서는 다음과 같다.

1. `llm-team.md`
2. `docs/contracts/*.md`
3. 구현 문서, 프롬프트, 스크립트, 상태 표지 매핑, 도구별 adapter

상위 문서와 하위 문서가 충돌하면 상위 문서가 우선한다. contract 문서끼리 충돌하면 더 구체적인 scope 의 문서가 우선하되, 충돌 자체를 수정 대상으로 기록해야 한다.

`docs/architecture/` 는 구현 설명 또는 기존 설계 자료로 간주한다. 이 디렉토리의 contract 를 override 하지 않는다. `docs/history/legacy-phase-model/` 은 amendment 이전의 archive 이며 신규 코드 / 문서가 의존하지 않는다 (lint rule 으로 강제, historical reader / fixture / migration tooling 만 예외).

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
docs/history/legacy-phase-model/        # archive (read-only, historical reference 만)
```

각 contract 의 책임은 다음과 같다.

| 문서 | 책임 |
|---|---|
| `agent-and-context-contract.md` | AgentProfile, outer-loop Phase, Contribution, Context Manifest, revision pin, output envelope, DialogueSession 입력·next-action 규약 |
| `state-and-operation-contract.md` | Milestone (dual-slot) / Slice / DialogueSession / SessionTurn / SliceMerge 상태와 loop 별 Caller action, dispatch 매트릭스, Recover operation, idempotency 3 scope |
| `reliability-and-gate-contract.md` | 4-lease kind 계층 + acquisition order, slot lock, slice/session/turn lease, cross-slot stale, promotion guard, fairness, dual-gate queue, recovery, retry, deterministic verification, 사람 contribution, transition ledger, pause |
| `knowledge-contract.md` | 누적 스펙, manifest, decision log, context summary, AC traceability, RefactorBacklog, turn_log compaction, slice telemetry inject path |
| `target-config-contract.md` | target 식별·바인딩, AgentProfile 레지스트리, loop policy, slice class escalation rule, dual-track 정책, refactor metric, invariant enforcement 등급, lease TTL, runner 매핑 |
| `agent-runner-port-contract.md` | agent runner 포트 시그니처 (turn 단위), 호출 의미, 종료 분류, 3-scope idempotency, adapter 교체 invariant |

<a id="CONTRACT-REFERENCE"></a>
## CONTRACT-REFERENCE: Reference Method

모든 안정 참조 대상 section 은 명시적 HTML anchor 를 가진다.

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
- `docs/contracts/agent-and-context-contract.md#AGC-SESSION-INPUT`
- `docs/contracts/agent-and-context-contract.md#AGC-NEXT-ACTION-REQUEST`
- `docs/contracts/state-and-operation-contract.md#SOC-LOOPS`
- `docs/contracts/state-and-operation-contract.md#SOC-MILESTONE-DUAL-SLOT`
- `docs/contracts/state-and-operation-contract.md#SOC-SLICE-LIFECYCLE`
- `docs/contracts/state-and-operation-contract.md#SOC-SESSION-LIFECYCLE`
- `docs/contracts/state-and-operation-contract.md#SOC-SESSION-TERMINATION`
- `docs/contracts/state-and-operation-contract.md#SOC-SLICE-MERGE`
- `docs/contracts/state-and-operation-contract.md#SOC-IDEMPOTENCY`
- `docs/contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS`
- `docs/contracts/reliability-and-gate-contract.md#RGC-SLOT-LOCK`
- `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER`
- `docs/contracts/knowledge-contract.md#KAC-REFACTOR-BACKLOG`
- `docs/contracts/knowledge-contract.md#KAC-TURN-LOG-COMPACTION`
- `docs/contracts/knowledge-contract.md#KAC-SLICE-TELEMETRY`
- `docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES`
- `docs/contracts/target-config-contract.md#TCC-SLICE-CLASS-RULES`
- `docs/contracts/target-config-contract.md#TCC-DUAL-TRACK`
- `docs/contracts/target-config-contract.md#TCC-ENFORCEMENT`
- `docs/contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE`
- `docs/contracts/agent-runner-port-contract.md#ARC-IDEMPOTENCY`

Section ID prefix 는 문서별로 고정한다.

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
| [`AGC-CONTEXT-MANIFEST`](agent-and-context-contract.md#AGC-CONTEXT-MANIFEST), [`AGC-SESSION-INPUT`](agent-and-context-contract.md#AGC-SESSION-INPUT) | [`context-snapshot.md`](../architecture/context-snapshot.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`AGC-OUTPUT`](agent-and-context-contract.md#AGC-OUTPUT), [`AGC-OUTPUT-RUNTIME-ENRICH`](agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH), [`AGC-NEXT-ACTION-REQUEST`](agent-and-context-contract.md#AGC-NEXT-ACTION-REQUEST), [`AGC-ISSUE-BODY`](agent-and-context-contract.md#AGC-ISSUE-BODY) | [`agent-output-format-mapping.md`](../architecture/agent-output-format-mapping.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`SOC-OBJECTS`](state-and-operation-contract.md#SOC-OBJECTS), [`SOC-LOOPS`](state-and-operation-contract.md#SOC-LOOPS), [`SOC-MILESTONE-DUAL-SLOT`](state-and-operation-contract.md#SOC-MILESTONE-DUAL-SLOT), [`SOC-SLICE-LIFECYCLE`](state-and-operation-contract.md#SOC-SLICE-LIFECYCLE), [`SOC-SLICE-DEPENDENCIES`](state-and-operation-contract.md#SOC-SLICE-DEPENDENCIES), [`SOC-SESSION-LIFECYCLE`](state-and-operation-contract.md#SOC-SESSION-LIFECYCLE), [`SOC-SLICE-MERGE`](state-and-operation-contract.md#SOC-SLICE-MERGE), [`SOC-DISPATCH-MATRIX`](state-and-operation-contract.md#SOC-DISPATCH-MATRIX) | [`state-machine.md`](../architecture/state-machine.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
| [`SOC-RECOVERY-OPERATION`](state-and-operation-contract.md#SOC-RECOVERY-OPERATION) | [`state-machine.md`](../architecture/state-machine.md), [`lease-and-recovery.md`](../architecture/lease-and-recovery.md) |
| [`RGC-LEASE-KINDS`](reliability-and-gate-contract.md#RGC-LEASE-KINDS), [`RGC-SLOT-LOCK`](reliability-and-gate-contract.md#RGC-SLOT-LOCK), [`RGC-PROMOTION-GUARD`](reliability-and-gate-contract.md#RGC-PROMOTION-GUARD), [`RGC-CROSS-SLOT-STALE`](reliability-and-gate-contract.md#RGC-CROSS-SLOT-STALE), [`RGC-CROSS-SLOT-FAIRNESS`](reliability-and-gate-contract.md#RGC-CROSS-SLOT-FAIRNESS), [`RGC-DUAL-GATE-QUEUE`](reliability-and-gate-contract.md#RGC-DUAL-GATE-QUEUE), [`RGC-RECOVERY`](reliability-and-gate-contract.md#RGC-RECOVERY), [`RGC-FAILURE`](reliability-and-gate-contract.md#RGC-FAILURE), [`RGC-LEDGER`](reliability-and-gate-contract.md#RGC-LEDGER), [`RGC-HUMAN-CONTRIBUTION`](reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`daemons.md`](../architecture/daemons.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
| [`RGC-FAIRNESS`](reliability-and-gate-contract.md#RGC-FAIRNESS), [`RGC-DAEMON-STARTUP`](reliability-and-gate-contract.md#RGC-DAEMON-STARTUP) | [`daemons.md`](../architecture/daemons.md) |
| [`RGC-VERIFICATION`](reliability-and-gate-contract.md#RGC-VERIFICATION) | [`tools.md`](../architecture/tools.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`KAC-MANIFEST-FROM-KNOWLEDGE`](knowledge-contract.md#KAC-MANIFEST-FROM-KNOWLEDGE), [`KAC-TRACEABILITY`](knowledge-contract.md#KAC-TRACEABILITY), [`KAC-SESSION-LOG-STORAGE`](knowledge-contract.md#KAC-SESSION-LOG-STORAGE), [`KAC-TURN-LOG-COMPACTION`](knowledge-contract.md#KAC-TURN-LOG-COMPACTION), [`KAC-REFACTOR-BACKLOG`](knowledge-contract.md#KAC-REFACTOR-BACKLOG), [`KAC-SLICE-TELEMETRY`](knowledge-contract.md#KAC-SLICE-TELEMETRY) | [`context-snapshot.md`](../architecture/context-snapshot.md), [`application-modules.md`](../architecture/application-modules.md) |
| [`TCC-LEASE-CONFIG`](target-config-contract.md#TCC-LEASE-CONFIG), [`TCC-ONBOARDING`](target-config-contract.md#TCC-ONBOARDING), [`TCC-AGENT-PROFILES`](target-config-contract.md#TCC-AGENT-PROFILES), [`TCC-LOOP-POLICIES`](target-config-contract.md#TCC-LOOP-POLICIES), [`TCC-SLICE-CLASS-RULES`](target-config-contract.md#TCC-SLICE-CLASS-RULES), [`TCC-DUAL-TRACK`](target-config-contract.md#TCC-DUAL-TRACK), [`TCC-REFACTOR-METRICS`](target-config-contract.md#TCC-REFACTOR-METRICS), [`TCC-ENFORCEMENT`](target-config-contract.md#TCC-ENFORCEMENT), [`TCC-GOVERNANCE`](target-config-contract.md#TCC-GOVERNANCE) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md), [`daemons.md`](../architecture/daemons.md), [`external-tracking-mapping.md`](../architecture/external-tracking-mapping.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
| [`ARC-PORT-SIGNATURE`](agent-runner-port-contract.md#ARC-PORT-SIGNATURE), [`ARC-IDEMPOTENCY`](agent-runner-port-contract.md#ARC-IDEMPOTENCY), [`ARC-EXIT-CLASSES`](agent-runner-port-contract.md#ARC-EXIT-CLASSES), [`ARC-ADAPTER-SUBSTITUTION`](agent-runner-port-contract.md#ARC-ADAPTER-SUBSTITUTION) | [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md), [`adapter-inventory.md`](../architecture/adapter-inventory.md) |
| [`CONTRACT-GLOSSARY`](#CONTRACT-GLOSSARY) | [`agent-domain-consumer-guide.md`](../architecture/agent-domain-consumer-guide.md) (advisory — manifest 소비 순서 / 미정의 용어 처리) |

<a id="CONTRACT-GLOSSARY"></a>
## CONTRACT-GLOSSARY: Vocabulary

본 contract set 의 1급 어휘 정의. 모든 contract 와 architecture 문서는 동일한 의미로 이 어휘를 사용한다.

| 어휘 | 정의 |
|---|---|
| **Loop** | 3-loop nested model 의 한 차원. `outer` (milestone, dual-slot) / `middle` (slice) / `inner` (TDD build) |
| **Phase** (outer-loop only) | outer loop 의 step. canonical 4 phase: `Discovery → Specification → Planning → Validation`. Implementation/CodeReview/Integration 어휘는 폐기 |
| **Slice** | user-observable thin end-to-end (`feature` class) 또는 behavior-preserving change (`internal` class). milestone 단위 DAG. middle/inner loop 의 작업 단위. 7-state lifecycle |
| **Slice class** | `feature` (사람 게이트 필수) / `internal` (사람 게이트 면제, escalation rule hit 시 자동 승격) |
| **DialogueSession** | turn-based agent deliberation. parent_loop ∈ {outer, middle, inner}, purpose ∈ {design, build, review, tdd_build, planning_decompose, validation}. 5-state lifecycle (`SOC-SESSION-LIFECYCLE`) |
| **SessionTurn** | session 의 1 turn. `(session_id, turn_index)` globally unique. envelope + workspace_commit (inner) + verification_result + caller_routing_decision |
| **AgentProfile** | 모델 + 성격 + 권한 묶음의 추상. canonical id: `atlas`, `forge`, `sentinel`, `scout`, `human`. 모델명·엔진은 본 contract set 어디에도 등장하지 않으며 `target-config-contract.md` 가 단일 권위 |
| **Contribution** | SessionTurn 호출이 남기는 산출. **persistent store 의 1급 객체**. `contribution_kind` enum (`lead_draft`, `review_verdict`, `human_approval`, `session_outcome`, `proposal`) |
| **SliceMerge** | slice 의 trunk merge 후보 객체. 7-state lifecycle (`SM_DRAFT → SM_READY_FOR_REVIEW → SM_APPROVED → SM_MERGED` + STALE/REQUEST_CHANGES/CLOSED). Code CP / Integration CP 의 후신 |
| **Spec CP / Milestone CP** | 보존된 CP 종류. outer Discovery / Specification / Validation 의 산출물. trunk 코드 병합 대상이 아닌 spec/doc 객체의 영속화 단위 |
| **Finalization rule** | session 종료 평가의 *의사결정 수렴* 규칙. enum: `lead_only`, `unanimous_approve`, `quorum_then_lead`, `any_request_changes_blocks`, `timeout_only` |
| **Required evidence** | session 종료 평가의 *결정적 증거* 항목. kind: `verification_green`, `metric_threshold`, `interface_diff_clean`, `coverage_threshold` |
| **Composite rule** | finalization × evidence 결합 규칙. enum: `finalization_AND_evidence`, `evidence_only`, `finalization_only` |
| **final_verdict** | session CONVERGED 시점의 verdict. enum: `approve`, `request_changes`, `tests_green`, `spec_accept`, `spec_reject`, `plan_accept`, `validation_pass`, `validation_fail`, `validation_stale`, `no_progress`, `regression`, `scope_violation` |
| **Required participants** | session termination 에 반드시 포함되어야 하는 AgentProfile 목록. `human` 을 포함하면 사람 승인이 필수. `loop_policies.<loop>.<phase\|purpose>.required_participants` |
| **Slot lock / Slice lease / Session lease / Turn lease** | 4-lease kind 계층. outer-to-inner 순서로만 획득. slot_lock 은 short transaction only |
| **Dual-slot serialization** | Discovery slot 1 + Delivery slot 1 (default). Discovery N+1 의 manifest 에 Delivery N 의 live telemetry inject |
| **RefactorBacklog / RefactorProposal** | KAC 의 1급 객체. 6-state lifecycle (`PROPOSED/CURATED/SCHEDULED/DONE/DROPPED/SUPERSEDED`). internal slice promotion path |
| **Turn log compaction** | session 의 turn_log 가 누적될 때 수렴적 압축 — turn 누적 / size / wallclock trigger |
| **Slice telemetry** | Discovery N+1 manifest 에 자동 inject 되는 Delivery N 의 진행 상태 |

Envelope canonical 필드는 다음과 같다 (상세는 `agent-and-context-contract.md#AGC-OUTPUT`):

```text
session_id, turn_index, parent_loop, phase?, slice_id?, slice_kind?, tdd_phase?,
agent_profile_id, agent_role_in_session, contribution_kind, parent_review_verdict_id?,
output_kind, object_id, manifest_id, input_revision_pins,
idempotency_key (caller-enriched), summary, artifacts?, verdict?,
next_action_request?, failure?, runtime_metadata?
```

legacy `agent_role`, `operation`, `phase_run_id` 는 신규 row 에 등장하지 않는다 (historical reader 만 union read).

<a id="CONTRACT-MIGRATION-NOTES"></a>
## CONTRACT-MIGRATION-NOTES: Legacy Phase Model → Loop-Based Migration

이전 *7-phase Workflow Shape + parallel quorum review* 모형 (`docs/history/legacy-phase-model/` archive) 은 본 contract set 에서 완전히 폐기되어 *3-loop nested model + DialogueSession + dual-slot serialization* 으로 치환되었다. legacy 어휘를 본 contract 어디에도 사용하지 않는다 (REPLACE without alias). 본 절은 도구·테스트·운영 코드를 마이그레이션할 때만 참조하기 위한 단일 환산표다.

### Vocabulary 환산

| Legacy | New | 비고 |
|---|---|---|
| `Task` | `Slice` | 책임 확장 (코드 → 가치). 7-state lifecycle 도입 |
| `PhaseRun` | `DialogueSession` | turn-based 추가, 5-state lifecycle |
| `Phase` (7개 — Discovery/Specification/Planning/Implementation/CodeReview/Integration/Validation) | outer loop step (4개 — Discovery/Specification/Planning/Validation) + middle/inner loop | Implementation / CodeReview / Integration 흡수 |
| `agent_role` | `agent_profile_id` | rename, 의미 동일 |
| `operation` | `action_kind` | rename + 의미 확장 (intake / slot_promotion / session_progress / session_finalize / slice_merge / verification / recover / pause_resume / signal_apply) |
| `phase_run_id` | `session_id + turn_index` | session-local turn_index, (session_id, turn_index) globally unique |
| `Code CP` | `SliceMerge` | 7-state lifecycle 흡수 |
| `Integration CP` | `SliceMerge` | 동일 |
| `Spec CP` | `Spec CP` | 보존 — outer loop 산출물, trunk merge 대상 아님 |
| `Milestone CP` | `Milestone CP` | 보존 — milestone-level summary, trunk merge 대상 아님 |
| `TASK_*` state | `SLICE_*` state | 7-state |
| `IMPLEMENTATION_IN_PROGRESS` / `INTEGRATION_*` / `VALIDATION_*` milestone state | `M_DELIVERY_BUILDING` / `M_DELIVERY_VALIDATING` (dual-slot) | dual-slot serialization |
| `phase_policies.<phase>` | `loop_policies.<loop>.<phase\|purpose>` | TCC anchor |
| `lease.ttl_by_role` (deprecated 첫 번째 라운드에서) → `lease.ttl_by_agent_profile` | `lease.ttl_by_lease_kind.<kind>` (4 종) + `lease.ttl_by_agent_profile.<id>` (turn lease) + `lease.ttl_by_phase.<phase>` (fallback) | 4 lease kind 분기 |
| `quorum.rule` (5 종 — lead_only/min_approvals/all_reviewers/any_request_changes_blocks 등) | `session_termination.{finalization_rule, required_evidence, composite_rule}` | finalization × evidence 분리 |
| `evidence` contribution_kind | `RequiredEvidence` + `VerificationRun` + `MetricRun` | 인프라 객체로 re-home |
| `rework_patch` contribution_kind | `lead_draft` + `parent_review_verdict_id` field | enum 축소 |
| `summary` contribution_kind | outer Validation `lead_draft` artifact | enum 축소 |
| `RGC-PHASE-LEASE` (2 종) | `RGC-LEASE-KINDS` (4 종) + `RGC-SLOT-LOCK` + `RGC-CROSS-SLOT-FAIRNESS` 등 | 4-lease 계층 |
| `quorum_decision` ledger 필드 | `final_verdict` + `action_kind` ledger 필드 | session_finalize action 의 일부 |
| Single-milestone serialization | Dual-slot (Discovery + Delivery) serialization | `target.dual_track.discovery_wip` 로 확장 가능 |
| Spec CP `CP_AWAITING_QUORUM` | Spec CP `CP_AWAITING_HUMAN` | session 의 awaiting-human equivalent |

### Anchor 환산

| Legacy Anchor | New Anchor |
|---|---|
| `SOC-PHASE-RUN` | (폐기 — `SOC-SESSION-LIFECYCLE` 가 흡수) |
| `SOC-STATES` | `SOC-MILESTONE-DUAL-SLOT` + `SOC-SLICE-LIFECYCLE` + `SOC-SESSION-LIFECYCLE` + `SOC-SLICE-MERGE` |
| `SOC-DEPENDENCIES` | `SOC-SLICE-DEPENDENCIES` |
| `RGC-PHASE-LEASE` | `RGC-LEASE-KINDS` (+ `RGC-SLOT-LOCK`) |
| `TCC-PHASE-POLICIES` | `TCC-LOOP-POLICIES` |

### State Label 환산

| Legacy state | New state |
|---|---|
| `DISCOVERY_DRAFT` | `M_DISCOVERY_DRAFT` |
| `DISCOVERY_AWAITING_HUMAN` | `M_DISCOVERY_AWAITING_HUMAN` |
| `SPECIFICATION_DRAFT` | `M_SPECIFICATION_DRAFT` |
| `SPECIFICATION_AWAITING_HUMAN` | `M_SPECIFICATION_AWAITING_HUMAN` |
| `PLANNING_READY` / `PLANNING_IN_PROGRESS` | `M_DELIVERY_PLANNING` |
| `IMPLEMENTATION_IN_PROGRESS` | `M_DELIVERY_BUILDING` |
| `INTEGRATION_READY` / `INTEGRATION_IN_PROGRESS` | `M_DELIVERY_BUILDING` 또는 `M_DELIVERY_VALIDATING` (단계 분리됨) |
| `VALIDATION_READY` / `VALIDATION_IN_PROGRESS` | `M_DELIVERY_VALIDATING` |
| `DONE` | `M_DONE` |
| `ESCALATED` | `M_ESCALATED` |
| `TASK_PENDING` / `TASK_READY` / `TASK_IN_PROGRESS` | `SLICE_PENDING` / `SLICE_READY` / `SLICE_BUILDING` |
| `TASK_REVIEW_READY` / `TASK_REVIEW_IN_PROGRESS` | `SLICE_REVIEWING` |
| `TASK_INTEGRATED` | `SLICE_VALIDATED` |
| `TASK_REJECTED` | `SLICE_BUILDING` (회수 후 재build) |
| (없음) | `SLICE_INTEGRATING` |
| (없음) | `SLICE_BLOCKED` |
| `CP_DRAFT` (Code) → `CP_READY_FOR_REVIEW` → `CP_APPROVED` → `CP_MERGED` | `SM_DRAFT → SM_READY_FOR_REVIEW → SM_APPROVED → SM_MERGED` (SliceMerge) |
| `CP_REQUEST_CHANGES` (Code) | `SM_REQUEST_CHANGES` |
| `CP_CLOSED` (Code) | `SM_CLOSED` |
| `CP_STALE` (Code/Integration) | `SM_STALE` |
| `CP_AWAITING_QUORUM` (Spec) | `CP_AWAITING_HUMAN` (Spec, session awaiting-human equivalent) |
| (없음) | `M_INTAKE_QUEUED`, `M_SPEC_APPROVED` (slot 점유/해제 boundary) |
| (없음) | `SESSION_OPEN` / `CONVERGED` / `TIMEOUT` / `ABANDONED` / `AWAITING_REVALIDATION` (DialogueSession) |

### Envelope 필드 환산

| Legacy 필드 | New 필드 | 비고 |
|---|---|---|
| `agent_role` | (폐기) | `agent_profile_id` 가 대체 |
| `agent_profile` | `agent_profile_id` | rename (정규형) |
| (없음) | `session_id` | 신규 필수 |
| (없음) | `turn_index` | 신규 필수 |
| (없음) | `parent_loop` | 신규 필수 |
| `phase_run_id` | (폐기) | (session_id, turn_index) tuple 이 대체 |
| `phase` | `phase` | parent_loop=outer 일 때 한정 (4 enum) |
| (없음) | `slice_id`, `slice_kind` | parent_loop ∈ {middle, inner} 일 때 |
| (없음) | `tdd_phase` | parent_loop=inner 일 때 |
| (없음) | `agent_role_in_session` | lead/reviewer/observer |
| (없음) | `parent_review_verdict_id` | rework instance 의 lead_draft |
| (없음) | `next_action_request` | mediated addressing 제안 |
| `output_kind` | `output_kind` | enum 확장 (`slice_decomposition`, `proposal_artifact` 추가) |

### Config Key 환산 (TCC)

| Legacy key | New key |
|---|---|
| `phase_policies.<phase>` | `loop_policies.<loop>.<phase\|purpose>` |
| `lease.ttl_by_role` | (폐기 — `lease.ttl_by_agent_profile` 1차, `lease.ttl_by_lease_kind` 2차) |
| `lease.ttl_by_agent_profile.<id>` | (보존, turn_lease scope 명시) |
| (없음) | `lease.ttl_by_lease_kind.<kind>` (4 종) |
| (없음) | `target.internal_escalation_rules` (TCC-SLICE-CLASS-RULES) |
| (없음) | `target.dual_track.{enabled, discovery_wip, priority, telemetry_refresh_interval, scheduled_capacity}` |
| (없음) | `target.refactor_metrics.{scan_interval, metrics, alert_threshold}` |
| (없음) | `target.invariant_enforcement.{always_hard, stage_graded}` |

### Contribution Kind 환산

| Legacy enum | New enum |
|---|---|
| `lead_draft` | `lead_draft` (보존) |
| `review_verdict` | `review_verdict` (보존) |
| `human_approval` | `human_approval` (보존) |
| `rework_patch` | `lead_draft` + `parent_review_verdict_id` field |
| `evidence` | RequiredEvidence + VerificationRun + MetricRun (인프라) |
| `summary` | outer Validation `lead_draft` artifact |
| (없음) | `session_outcome` (Caller-only, session 종료 응축) |
| (없음) | `proposal` (acceptance_test_amendment / discovered_dependency / refactor / cross_milestone_amendment 등) |

### 첫 번째 라운드의 Legacy Role → Phase 환산

이전 라운드의 amendment (`docs/history/legacy-phase-model/contracts/README.md` 의 CONTRACT-MIGRATION-NOTES) 가 polled `PO / PM / Planner / Coder / Reviewer / Integrator / QA` role → 7-phase 환산을 단일 권위로 가졌다. 본 amendment 는 그 7-phase 도 폐기하므로, 더 거슬러 올라가는 *role → loop* 직접 환산은 다음과 같다.

| Legacy Role (1st round) | Loop · Phase / Purpose | Lead Profile | Required Participants |
|---|---|---|---|
| PO | outer Discovery | atlas | `[human]` |
| PM | outer Specification | atlas | `[human]` |
| Planner | outer Planning | atlas | (없음) |
| Coder | inner tdd_build | forge | (없음) |
| Reviewer | middle review | sentinel | (없음, internal escalation 시 `[human]`) |
| Integrator | (흡수됨) middle review approve + SliceMerge merge | (Caller) | — |
| QA | outer Validation | sentinel | (없음, release governance 외부) |

본 환산표는 본 절에서만 권위를 갖는다. 다른 contract 또는 architecture 문서가 동일 환산을 중복 정의하면 본 절이 우선한다. 더 상세한 phase model archive 는 `docs/history/legacy-phase-model/contracts/README.md#CONTRACT-MIGRATION-NOTES` 참조.

<a id="CONTRACT-CHANGE"></a>
## CONTRACT-CHANGE: Change Rules

- Contract 변경은 변경 제안으로 제출한다.
- 본질적 철학이나 권한 경계를 바꾸는 변경은 먼저 `llm-team.md` 를 수정해야 한다.
- 상태명, 필드명, operation semantics 를 바꾸면 참조 문서와 구현 adapter 를 함께 갱신해야 한다.
- 같은 개념을 여러 문서에 중복 정의하지 않는다. 한 문서는 authoritative source 가 되고, 다른 문서는 reference 만 둔다.
- enum 값을 추가·변경하면 contract 본문, 구현 값, ledger/dashboard 집계 값이 같은 어휘를 쓰는지 확인해야 한다.
- 같은 필드명이 다른 entity 에서 쓰이면 scope 를 명시해야 한다. 예: per-turn / per-session-outcome / per-merge idempotency_key 는 모두 `idempotency_key` 라는 같은 필드명을 쓰지만 entity scope 가 다르다 (`SOC-IDEMPOTENCY`).
- anchor 를 추가·변경하면 `#CONTRACT-CONFORMANCE` matrix 를 함께 갱신해야 한다. 구현이 아직 없으면 contract 를 forward-looking prose 로 숨기지 말고 `spec-only` 또는 `partial` 로 표시한다.

<a id="CONTRACT-STATUS"></a>
## CONTRACT-STATUS: Status

현재 contract set 은 Active 로 간주한다. 구현이 contract 를 충족하지 못하면 구현을 수정하거나, 사람 승인으로 contract 변경 제안을 제출해야 한다.

amendment 직후의 enforcement 상태는 `target.invariant_enforcement` (TCC-ENFORCEMENT) 의 always_hard 와 stage_graded 가 정의한다 — Stage 2~4 동안 일부 invariant 는 warn 모드로 운영되며, Stage 5 진입 시 전체 block.

<a id="CONTRACT-CONFORMANCE"></a>
## CONTRACT-CONFORMANCE: Anchor Conformance Matrix

`CONTRACT-STATUS=Active` 는 contract set 이 권위 있는 규약이라는 뜻이다. 각 anchor 가 현재 구현에서 어느 정도 보장되는지는 본 matrix 가 따로 정의한다.

### Metadata Field 정의

본 matrix 는 anchor 마다 다음 4 field 를 기록한다.

| Field | 의미 | Enum / Format |
|---|---|---|
| `status` | 현재 구현 / 문서 권위 상태 | `active` / `partial` / `spec-only` / `deprecated` |
| `implementation_surface` | anchor 를 보장하는 구현 / 검증 표면 (path, helper 이름, 또는 `contract prose` 단독) | 자유 식별자 |
| `enforcement` | 위반 시 invariant_enforcement 분류. `TCC-ENFORCEMENT` 의 always_hard / stage_graded list 와 정합 | `always_hard` / `stage_graded:<name>=warn\|block` / `n/a` |
| `active_since` | 본 anchor 가 (현재 형태로) active 상태에 진입한 시점. amendment id 또는 `original` | `2026-05-05-loop` / `phase-pivot` / `original` |

`status` enum 의미:

| Status | 의미 |
|---|---|
| `active` | 현재 production path 또는 문서 권위 구조가 해당 anchor 를 보장한다 |
| `partial` | 일부 production path 만 보장하거나 알려진 미구현 path 가 남아 있다 |
| `spec-only` | contract/helper/문서 정의는 있으나 production binding 이 없다 |
| `deprecated` | 더 이상 새 구현이 의존하면 안 되는 anchor 다. 신규 row 사용 금지, historical reader / fixture / migration tooling 은 예외 |

### Contract README

| Anchor | Status | Implementation Surface | Enforcement | Active Since |
|---|---|---|---|---|
| `CONTRACT-AUTHORITY` | active | contract authority | n/a | original |
| `CONTRACT-STRUCTURE` | active | repository layout | n/a | original |
| `CONTRACT-REFERENCE` | active | markdown anchors | n/a | original |
| `CONTRACT-ARCHITECTURE-MAPPING` | active | this README | n/a | phase-pivot (anchor refresh 2026-05-05-loop) |
| `CONTRACT-GLOSSARY` | active | this README | n/a | 2026-05-05-loop (loop-based 어휘 전면 갱신) |
| `CONTRACT-MIGRATION-NOTES` | active | this README | n/a | 2026-05-05-loop (legacy phase model → loop-based 환산표) |
| `CONTRACT-CHANGE` | active | review checklist | n/a | original |
| `CONTRACT-STATUS` | active | contract prose | n/a | original |
| `CONTRACT-CONFORMANCE` | active | this matrix | n/a | phase-pivot (4-field metadata 확장 2026-05-05-loop) |

### Agent and Context

| Anchor | Status | Implementation Surface | Enforcement | Active Since |
|---|---|---|---|---|
| `AGC-SCOPE` | active | contract authority | n/a | original |
| `AGC-PHASES` | spec-only | contract prose | always_hard (enum 검증) | 2026-05-05-loop (4 phase 로 격하) |
| `AGC-AGENT-PROFILES` | spec-only | contract prose | always_hard (enum 검증) | phase-pivot |
| `AGC-CONTRIBUTION` | partial | `src/domain/schema/contribution.ts` (`ContributionKind`, `OutputKind`, `FinalVerdict`, `ParentLoop`, `AgentProfileId`, `AgentRoleInSession`, `TddPhase` zod enums) | always_hard (enum 검증) | 2026-05-05-loop (enum 정정) |
| `AGC-CALL-BOUNDARY` | partial | `application/agent_io.sh`, `lib/ports/*` | always_hard (caller_only_operational_write) | 2026-05-05-loop (turn 단위로 재정의) |
| `AGC-SESSION-INPUT` ★ | spec-only | contract prose | always_hard (manifest_external_read_write) | 2026-05-05-loop |
| `AGC-PROMPT-SERIALIZATION` ★ | partial | `src/application/prompt-compose.ts` (frontmatter 7 필드 + Context/Instruction/Output Schema 4-part 조립), `src/adapters/llm-runner/common/prompt-relay.ts` (`assertFourPartLayout` preflight), `src/application/agent-io.ts` (`checkHeaderEcho` 7-field 검증) | always_hard (4-part layout + header echo 7 필드) | 2026-05-05-loop |
| `AGC-NEXT-ACTION-REQUEST` ★ | spec-only | contract prose | always_hard (direct_invocation_forbidden, decision_reason 필수) | 2026-05-05-loop |
| `AGC-TURN-ORDERING` ★ | spec-only | contract prose + `dialogue_coordinator.sh` (Stage 2) | always_hard (priority + fairness) | 2026-05-05-loop |
| `AGC-CONFLICT-RESOLUTION` ★ | spec-only | contract prose + `dialogue_coordinator.sh` (Stage 2) | always_hard (re-dispatch / human escalation) | 2026-05-05-loop |
| `AGC-CONTEXT-MANIFEST` | partial | `src/domain/schema/manifest.ts` (`ContextManifest`, `ManifestEntry`, `FetchScope`), `src/application/manifest-builder.ts` (`ManifestBuilder.build` + `recheckPins` via `RevisionPinResolver` port) | always_hard (manifest_external_read_write) | 2026-05-05-loop (turn manifest 추가) |
| `AGC-CONTEXT-BUDGET` ★ | spec-only | contract prose. cap 적용은 Caller (Stage 2) | always_hard (overflow → invalid envelope) | 2026-05-05-loop |
| `AGC-OUTPUT` | partial | `src/domain/schema/envelope.ts` (`AgentAuthoredEnvelope` pre-enrichment + `Envelope` canonical shapes), `src/application/envelope.ts` (`parseAgentAuthored` + `validateEnvelope`) | always_hard (enum + envelope shape) | 2026-05-05-loop (envelope schema 전면 교체) |
| `AGC-OUTPUT-RUNTIME-ENRICH` | partial | `src/application/envelope.ts` (`enrichEnvelope` injects `idempotency_key` + `runtime_metadata`, rejects key collisions and agent-authored caller-only fields) | always_hard | 2026-05-05-loop (3-scope idempotency 매핑) |
| `AGC-LLM-NEUTRALITY` ★ | spec-only | contract prose. adapter normalize 책임 (`adapters/llm_runner/*`) | always_hard (provider-native → envelope normalize) | 2026-05-05-loop |
| `AGC-CONTRIBUTION-OUTPUTS` | partial | `src/application/envelope-extended-validator.ts` (data-driven (parent_loop, phase_or_purpose, contribution_kind) → output_kind / verdict.result matrix) | always_hard (output_kind 매트릭스 검증) | 2026-05-05-loop |
| `AGC-WORKSPACE` | partial | `src/ports/workspace.ts` (`WorkspacePort.prepareInnerWorkspace` + `prepareReadOnlyCheckout` + `rebaseOntoTrunk` + `commit` + `head`), `src/adapters/workspace/git-worktree.ts` (slice-local worktree + read-only checkout + rebase), `src/adapters/workspace/fake.ts` (in-memory deterministic worktree, conflict 주입 옵션), `src/application/agent-workspace.ts` (`prepareAgentWorkspace` — (parent_loop, role) 매트릭스 dispatch) | stage_graded:scope_violation=warn (Stage 3b block) | 2026-05-05-loop (inner scope enforcement) |
| `AGC-ISSUE-BODY` | spec-only | `docs/architecture/agent-output-format-mapping.md` | n/a (rendering 규약) | original |
| `AGC-INVALID` | partial | `src/application/envelope.ts` (`AGC_INVALID_REASONS` enum, `AgcInvalidError`, parser/enricher/matrix classification surface). TDD strict / session_id collision / scope_violation 분기는 phase 2+ catch-up | always_hard | 2026-05-05-loop (TDD strict / session_id 충돌 추가) |

### State and Operation

| Anchor | Status | Implementation Surface | Enforcement | Active Since |
|---|---|---|---|---|
| `SOC-SCOPE` | active | contract authority | n/a | original |
| `SOC-OBJECTS` | spec-only | contract prose. legacy `lib/state.sh` 는 milestone/task/CP 만 — Stage 2 rewrite | always_hard | 2026-05-05-loop (Slice/DialogueSession/SessionTurn/SliceMerge 신설) |
| `SOC-LOOPS` ★ | spec-only | contract prose | always_hard (loop_kind 분류) | 2026-05-05-loop |
| `SOC-MILESTONE-DUAL-SLOT` ★ | spec-only | `lib/dual_track_scheduler.sh` (Stage 4) | stage_graded:dual_slot_fairness=warn (Stage 5 block) | 2026-05-05-loop |
| `SOC-SLICE-LIFECYCLE` ★ | partial | `src/domain/schema/slice.ts` (7-state schema), `src/application/ready-object.ts` (`pickReadyInnerTurn`: SLICE_READY → SLICE_BUILDING + session open), `src/application/turn-worker.ts` (`runOneInnerTurn`: SLICE_BUILDING → SLICE_REVIEWING on tests_green), `src/application/dialogue-coordinator.ts` (`runOneMiddleReviewTurn`: SLICE_REVIEWING → SLICE_INTEGRATING → SLICE_VALIDATED on middle approve), `src/application/caller-dispatch.ts` (slice state transitions per dispatch matrix). SLICE_BLOCKED 진입은 phase 4 failure-policy 가 보강 | always_hard (state machine) | 2026-05-05-loop |
| `SOC-SLICE-DEPENDENCIES` ★ | partial | `src/domain/schema/slice.ts` (`SliceDependency` + `SliceDependencyEdge`), `src/application/slice-dag.ts` (`validateSliceDag` cycle/missing/duplicate detection + `topologicalOrder` blocks-only + `computeReadySlices` join condition). Planning ensemble의 lead artifact 호출은 phase 5b | always_hard (cycle detection) | 2026-05-05-loop |
| `SOC-SLICE-CLASS` ★ | partial | `src/domain/schema/slice.ts` (`SliceKind`), `src/application/slice-class.ts` (`classifySlice` 6-rule escalation evaluator), `src/config/target-schema.ts` (`InternalEscalationRules`). Caller 가 plan_accept 직후 호출하는 wiring 은 phase 5b | always_hard (escalation 평가) | 2026-05-05-loop |
| `SOC-SESSION-LIFECYCLE` ★ | partial | `src/domain/schema/dialogue-session.ts` (`DialogueSession` 5-state schema + `Participant`), `src/domain/schema/session-turn.ts` (`SessionTurn` + `CallerRoutingDecision`), `src/application/dialogue-coordinator.ts` (`pickReadyMiddleReview` + `runOneMiddleReviewTurn` — middle review SESSION_OPEN → CONVERGED dispatch). outer-loop coordinators는 phase 5 | always_hard (state machine) | 2026-05-05-loop |
| `SOC-SESSION-TERMINATION` ★ | partial | `src/domain/schema/dialogue-session.ts` (`SessionTermination` block: `FinalizationRule`, `RequiredEvidence`, `CompositeRule`), `src/application/termination-evaluator.ts` (`evaluateTermination` 순수 함수 — finalization × evidence × composite_rule 평가, inner `lead_only` + `evidence_only`, middle `any_request_changes_blocks` + `finalization_AND_evidence` 커버) | stage_graded:required_evidence_unmet=warn (Stage 3b block) | 2026-05-05-loop |
| `SOC-SLICE-MERGE` ★ | partial | `src/domain/schema/slice-merge.ts` (7-state schema), `src/application/turn-worker.ts` (`openSliceMergeReadyForReview`: SM_DRAFT → SM_READY_FOR_REVIEW), `src/application/slice-merge.ts` (`promoteSliceMergeToApproved` / `integrateSliceMerge` — SM_APPROVED → trunk rebase + reverify → SM_MERGED on clean+green / SM_STALE on conflict-or-fail; `closeSliceMergeRequestChanges` / `closeSliceMergeBlocked`), `src/application/caller-dispatch.ts` (dispatch matrix executor) | always_hard (state machine) | 2026-05-05-loop |
| `SOC-DUAL-MILESTONE-BRANCH` ★ | spec-only | trunk 정책 (`SOC-MERGE-POLICY` 와 결합) | always_hard | 2026-05-05-loop |
| `SOC-CROSS-MILESTONE-REFERENCE` ★ | spec-only | `application/dialogue_coordinator.sh` 의 cross-slot stale 감지 (Stage 4) | stage_graded:telemetry_enrichment_missing=warn | 2026-05-05-loop |
| `SOC-INTAKE` | partial | `src/domain/schema/feature-request.ts` (`FeatureRequest` 3-state record), `src/application/feature-request-intake.ts` (`runFeatureRequestIntake` — FS-channel 1-per-cycle promotion + ledger `intake` row + idempotent re-run). GitHub adapter는 phase 6b | always_hard (idempotency_key) | 2026-05-05-loop (M_INTAKE_QUEUED 도입) |
| `SOC-OPERATIONS` | partial | `src/application/dialogue-coordinator.ts` (middle review `runOneMiddleReviewTurn`), `src/application/turn-worker.ts` (inner `runOneInnerTurn`), `src/application/outer-turn.ts` (outer LLM-call orchestration `runOneOuterTurn` — Discovery/Specification/Planning/Validation pickup + invoke + persist + finalize), `src/application/caller-dispatch-outer.ts` (`dispatchOuterOutcome`), `src/application/outer-session.ts` (`openOuterSession` + `pickReadyOuterSession` — outer-loop session lifecycle), `src/application/human-signal-binding.ts` (AWAITING_HUMAN signal → SessionTurn), `src/application/dual-track-scheduler.ts` (`runOneDualTrackTurn` — phase 6a slot promotion driver), `src/cli/daemon.ts` (`--role outer-coordinator` / `--role dual-track-scheduler` daemon drivers) | always_hard | 2026-05-05-loop (loop·purpose 기반 재구성) |
| `SOC-DISPATCH-MATRIX` | partial | `src/domain/dispatch-matrix.ts` (data-driven `DISPATCH_MATRIX` + `lookupDispatch` — 5b.1 에서 outer 4 phase × 5 verdict = 17 신규 행 추가), `src/application/caller-dispatch.ts` (slice-anchored `dispatchOutcome`), `src/application/caller-dispatch-outer.ts` (milestone-anchored `dispatchOuterOutcome`: spec_accept / spec_reject / plan_accept / validation_pass / validation_fail / TIMEOUT / ABANDONED 모두 커버), `src/application/dual-track-scheduler.ts` (`runOneDualTrackTurn` — `--role dual-track-scheduler` daemon entrypoint for intake → Discovery + spec_approved → Delivery slot promotions) | always_hard | 2026-05-05-loop ((state, final_verdict) tuple 분기) |
| `SOC-RECOVERY-OPERATION` | partial | `application/recovery.sh` | always_hard | 2026-05-05-loop (session-stale / inner-no-progress / slice-merge-stale trigger 추가) |
| `SOC-MERGE-POLICY` | partial | `src/ports/workspace.ts` (`WorkspacePort.rebaseOntoTrunk` — 결과 `clean` / `conflict` 분리), `src/adapters/workspace/git-worktree.ts` + `src/adapters/workspace/fake.ts` (rebase 어댑터), `src/application/slice-merge.ts` (`integrateSliceMerge`: 1회 rebase + reverify, conflict / fail → SM_STALE). 자동 재시도 한도와 first-merger-wins lock은 phase 4 lease 도입으로 보강 | always_hard (first-merger-wins) | 2026-05-05-loop (SliceMerge first-merger-wins) |
| `SOC-IDEMPOTENCY` | partial | `src/application/ledger.ts` (3-scope `idempotencyKey` compositor); 미도입 dispatch 는 추후 phase | always_hard | 2026-05-05-loop (3-scope 분리) |
| `SOC-PHASE-RUN` ✕ | deprecated | `docs/history/legacy-phase-model/contracts/state-and-operation-contract.md` | stage_graded:legacy_writer=warn (Stage 5 block) | (deprecated 2026-05-05-loop) |

### Reliability and Gate

| Anchor | Status | Implementation Surface | Enforcement | Active Since |
|---|---|---|---|---|
| `RGC-SCOPE` | active | contract authority | n/a | original |
| `RGC-WRITES` | active | `application/caller_dispatch.sh`, `application/human_signal.sh`, `lib/ports/*` | always_hard (caller_only_operational_write) | original |
| `RGC-SIGNALS` | partial | `src/domain/schema/human-signal.ts` (`HumanSignalEnvelope` + `HumanSignalRecord` 11-type enum), `src/ports/human-signal.ts` (`HumanSignalPort` listPending/markProcessed), `src/adapters/human-signal/fs.ts` (`FsHumanSignal` — drop dir + processed/ idempotency), `src/application/human-signal-drain.ts` (`runHumanSignalDrain` envelope structural validation). Session-termination 흡수 + Caller operational write는 phase 5b | always_hard (envelope 검증) | 2026-05-05-loop (cross_milestone_amendment 등 신규 signal) |
| `RGC-LEASE-KINDS` ★ | partial | `src/domain/schema/lease.ts` (4-kind discriminated union), `src/ports/lease.ts` (`LeasePort` claim/release/renew/sweepStale/list with CAS + monotonic token semantics), `src/adapters/lease/fs.ts` (`FsLease` — lockdir CAS + bumped seq token + leases/active + leases/records layout), `src/application/lease-acquisition-order.ts` (`assertCanAcquire` + `checkCanAcquire` outer→inner enforcement), `src/application/lease-ttl-resolver.ts` (TTL lookup chain). slot_lock 의 short transaction 강제 + 실제 wiring 은 phase 6a | always_hard (lease_acquisition_order, always_hard list) | 2026-05-05-loop |
| `RGC-SLOT-LOCK` ★ | partial | `src/domain/schema/lease.ts` (`SlotLockLease` variant with milestone_id + slot_kind), `src/adapters/lease/fs.ts` (slot_lock 도 일반 lease CAS 경로 사용), `src/application/dual-track-scheduler.ts` (phase 6a — atomic 4-step promotion: re-read milestone → claim slot_lock → persist new state + ledger row → release lock; short-transaction guarantee, no LLM/verification while held) | always_hard (short transaction) | 2026-05-05-loop |
| `RGC-PROMOTION-GUARD` ★ | partial | `src/application/promotion-guard.ts` (`evaluatePromotionGuard` — direct slot empty + RefactorBacklog SCHEDULED capacity), `src/application/dual-track-scheduler.ts` (preflight gate: blocked candidate → `slot_promotion` noop ledger row + `result_detail=promotion_guard_blocked:<reason>`). Manifest coherence guard (third row) deferred to KAC-SLICE-TELEMETRY inject (5c/6b) | always_hard | 2026-05-05-loop |
| `RGC-CROSS-SLOT-STALE` ★ | partial | `src/application/cross-slot-stale.ts` (`detectCrossSlotStaleSessions` — Discovery N+1 SESSION_OPEN with updated_at < latest Delivery N updated_at → AWAITING_REVALIDATION + `recover` ledger row, idempotent), `src/application/dual-track-scheduler.ts` (runs detection after each promotion / on noop). Per-manifest read_base_revision_pin replay needs telemetry inject (5c/6b) | stage_graded:telemetry_enrichment_missing=warn | 2026-05-05-loop |
| `RGC-CROSS-SLOT-FAIRNESS` ★ | partial | `src/application/cross-slot-fairness.ts` (`orderByCrossSlotPriority` — delivery_first / discovery_first / balanced selector), `src/application/dual-track-scheduler.ts` (caller; reads `target.dual_track.priority`) | stage_graded:dual_slot_fairness=warn (Stage 5 block) | 2026-05-05-loop |
| `RGC-DUAL-GATE-QUEUE` ★ | partial | `src/application/dual-gate-queue.ts` (`enumerateIntakeQueue` / `enumerateDeliveryPromotionQueue` / `snapshotDualGateQueues` / `flattenSnapshot` — FIFO oldest-by-updated_at, idempotency via shared `slot_promotion` idempotency_key), `src/application/dual-track-scheduler.ts` (consumer) | always_hard (FIFO + idempotency) | 2026-05-05-loop |
| `RGC-RECOVERY` | partial | `src/application/recovery.ts` (`runRecoverySweep` — 만료 lease 4 kind 감지 + ledger `recovered` row + session_lease 만료 시 SESSION_OPEN → AWAITING_REVALIDATION). slot_lock recovery + slice-merge-stale auto-retry + cross-slot stale 는 phase 5/6a 가 보강 | always_hard | 2026-05-05-loop (loop-aware trigger) |
| `RGC-FAILURE` | partial | `src/application/failure-policy.ts` (`evaluateRetry` + `DEFAULT_RETRY_CONFIG` — no_progress/regression/scope_violation/middle_review/slice_merge_revalidation 한도 평가, 한도 초과 시 ESCALATED 분류), `src/cli/daemon.ts` (cycle-loop 의 sweep 진입점) | always_hard | 2026-05-05-loop (retry/escalation 운영 정책 매핑) |
| `RGC-VERIFICATION` | partial | `src/domain/schema/verification.ts` (`VerificationRun` + `MetricRun` schemas), `src/ports/verification.ts` (`VerificationPort.runBuild/runTest/runLint/runMetric`), `src/adapters/verification/shell.ts` (실 실행), `src/adapters/verification/fake.ts` (테스트), `src/application/verification-runner.ts` (`runInnerVerification` — inner 동기 실행 + VerificationRun 영속). middle / outer 비동기 trigger 는 phase 3 | always_hard (deterministic_verification_authority) | 2026-05-05-loop (VerificationRun + MetricRun + required_evidence) |
| `RGC-HUMAN-CONTRIBUTION` | partial | `src/application/human-signal-drain.ts` (envelope drain + optional binding pass), `src/application/human-signal-binding.ts` (`bindHumanSignalToSession` — RGC-SIGNALS envelope → `human_approval` SessionTurn appended at outer session's current_turn_index, atomic via withFileLock(sessionMetadata)), `src/application/outer-turn.ts` (`runOneOuterTurn` skips `human` participants — emits `awaiting_human` outcome so the binding can complete the round out-of-band) | always_hard (required human contribution) | 2026-05-05-loop (feature slice 한정 scope) |
| `RGC-LEDGER` | partial | `src/domain/schema/ledger.ts` (필수 필드 schema), `src/application/ledger.ts` (`FileLedger.appendTransition` + audit_hash chain), `src/domain/audit-hash.ts` (sha256 canonical-json [prevHash, row]) | always_hard (필수 필드) | 2026-05-05-loop (slice/session/turn/loop_kind/action_kind/final_verdict 추가) |
| `RGC-PAUSE` | active | `lib/signals.sh`, `scripts/cli/control.sh`, `application/human_signal.sh` | always_hard | original |
| `RGC-NOTIFICATION` | partial | `lib/notifier.sh`, `adapters/notifier/*` | n/a (push-only) | original |
| `RGC-FAIRNESS` | partial | `src/application/fairness.ts` (`sortFairly` + `pickFairly` — within-scope oldest-ready-first + priority overrides, stable; inner-only). cross-slot fairness 는 `src/application/cross-slot-fairness.ts` (RGC-CROSS-SLOT-FAIRNESS, phase 6a) | stage_graded:fairness_violation=warn | 2026-05-05-loop (within-scope vs cross-slot 분리) |
| `RGC-DAEMON-STARTUP` | partial | `src/cli/daemon.ts` (`daemonMain` — per-role PID lockdir, recovery sweep on every cycle, SIGINT/SIGTERM graceful shutdown). acquisition order CI gate via `tests/conformance/phase-4.test.ts` exhaustive (held, requested) matrix. multi-process atomic 시작 + sibling 종료 정책은 phase 5/6a 가 보강 | always_hard (atomic startup) | 2026-05-05-loop (acquisition order CI startup gate) |
| `RGC-PHASE-LEASE` ✕ | deprecated | `docs/history/legacy-phase-model/contracts/reliability-and-gate-contract.md` | stage_graded:legacy_writer=warn | (deprecated 2026-05-05-loop, 대체: RGC-LEASE-KINDS) |

### Knowledge

| Anchor | Status | Implementation Surface | Enforcement | Active Since |
|---|---|---|---|---|
| `KAC-SCOPE` | active | contract authority | n/a | original |
| `KAC-ACCUMULATION` | partial | `application/knowledge.sh`, `scheduler/runner.sh` | always_hard (knowledge accumulation) | 2026-05-05-loop (live telemetry 절 추가) |
| `KAC-MANIFEST` | partial | `lib/context.sh`, `application/knowledge.sh` | always_hard | 2026-05-05-loop (audit_hash 정책 추가) |
| `KAC-MANIFEST-FROM-KNOWLEDGE` | partial | `scheduler/runner.sh` | always_hard | 2026-05-05-loop (turn manifest + slice telemetry inject) |
| `KAC-DECISION-LOG` | partial | `src/domain/schema/knowledge.ts` (`DecisionEntry` + `DecisionKind` 6-kind enum), `src/application/knowledge.ts` (`recordDecision` writer + audit_hash chain), `src/application/caller-dispatch-outer.ts` (Planning plan_accept 시 자동 product_decision row). atlas / sentinel producer wiring 은 phase 5c | always_hard | 2026-05-05-loop (decision_kind enum 확장) |
| `KAC-CONTEXT-SUMMARY` | partial | `src/domain/schema/knowledge.ts` (`ContextSummary` + `ContextSummarySliceRef`), `src/application/knowledge.ts` (`snapshotContextSummary` writer), `src/application/caller-dispatch-outer.ts` (`finalize_milestone_done` 효과 — Validation pass → snapshot persist → milestone.context_summary_id 연결) | always_hard | 2026-05-05-loop (slice telemetry 요약 포함) |
| `KAC-TRACEABILITY` | partial | `application/agent_io.sh`, tests | always_hard (AC mapping 검증) | 2026-05-05-loop (AC → Slice → SliceMerge → VerificationRun) |
| `KAC-CONFLICTS` | spec-only | contract prose | n/a (resolver 없음) | original |
| `KAC-EQUIVALENCE` | spec-only | contract prose | n/a (enforcer 없음) | 2026-05-05-loop (feature/internal 비대칭) |
| `KAC-SESSION-LOG-STORAGE` ★ | spec-only | `lib/session.sh` storage layout (Stage 2) | stage_graded:turn_log_compaction_delay=warn | 2026-05-05-loop |
| `KAC-TURN-LOG-COMPACTION` ★ | partial | `src/application/turn-log-compaction.ts` (`shouldCompactTurnLog` — turn-count trigger 결정 함수). size / wallclock trigger는 phase 5, 스냅샷 저장은 후속 phase 가 보강 | stage_graded:turn_log_compaction_delay=warn | 2026-05-05-loop |
| `KAC-REFACTOR-BACKLOG` ★ | partial | `src/domain/schema/knowledge.ts` (`RefactorBacklogItem` + `RefactorBacklogState` 6-state), `src/application/persistence-layout.ts` (`layout.refactorProposal`). 6-state lifecycle 전이 모듈 + scout/forge/sentinel producer wiring은 phase 5c | stage_graded:refactor_metric_missing=warn | 2026-05-05-loop |
| `KAC-SLICE-TELEMETRY` ★ | partial | `src/domain/schema/knowledge.ts` (`SliceTelemetry` + 4 sub-records), `src/application/persistence-layout.ts` (`layout.sliceTelemetry`). emit + Discovery N+1 manifest inject는 phase 5c/6a | stage_graded:telemetry_enrichment_missing=warn | 2026-05-05-loop |

### Target Configuration

| Anchor | Status | Implementation Surface | Enforcement | Active Since |
|---|---|---|---|---|
| `TCC-SCOPE` | active | contract authority | n/a | 2026-05-05-loop (scope 확장) |
| `TCC-IDENTITY` | active | `src/config/target-schema.ts` (`Identity` block: target_id 필수, workdir_path / audit_hash_seed / label_prefix optional), `src/application/config-validator.ts` (process-startup 전수 검증) | always_hard (target_id 변경 invariant) | original |
| `TCC-LEASE-CONFIG` | partial | `src/config/target-schema.ts` (`LeaseConfig` block — `ttl_default_ms` / `ttl_by_lease_kind` / `ttl_by_agent_profile` / `ttl_by_phase` 모두 positive integer refinement), `src/application/lease-ttl-resolver.ts` (lookup chain: worker_override → ttl_by_phase → ttl_by_agent_profile → ttl_by_lease_kind → ttl_default → 60s hardcoded) | always_hard (TTL > 0) | 2026-05-05-loop (4 lease kind 분기) |
| `TCC-ONBOARDING` | partial | `scripts/cli/target.sh`, `application/onboarding/*` | always_hard | 2026-05-05-loop (required_lib startup gate 추가) |
| `TCC-AGENT-PROFILES` | spec-only | `lib/config.sh` rewrite (Stage 2) | always_hard (agent_profile abstraction) | phase-pivot |
| `TCC-LOOP-POLICIES` ★ | spec-only | `lib/config.sh` rewrite + `dialogue_coordinator.sh` (Stage 2) | always_hard | 2026-05-05-loop |
| `TCC-SLICE-CLASS-RULES` ★ | partial | `src/config/target-schema.ts` (`InternalEscalationRules` 6-rule Zod block, default-on), `src/application/slice-class.ts` (`classifySlice` glob-match + threshold 평가 + multi-rule report). plan_accept 호출자 wiring은 phase 5b | always_hard (escalation 평가) | 2026-05-05-loop |
| `TCC-DUAL-TRACK` ★ | partial | `src/config/target-schema.ts` (`DualTrack` Zod block: `priority` ∈ {delivery_first (default), balanced, discovery_first} + optional `refactor_scheduled_capacity` + `scout_scan` cron entry; `Identity.kind` ∈ {external (default), self-hosting} + optional `agent_cwd`), `src/application/config-validator.ts` (self-hosting cross-field invariant — `agent_cwd` MUST be outside `workdir_path`), `src/application/dual-track-scheduler.ts` (consumer of `dual_track.priority` + `refactor_scheduled_capacity`). `loop_policies.<phase>.session_idle_seconds_p99` telemetry는 5c/6b | stage_graded:dual_slot_fairness=warn | 2026-05-05-loop |
| `TCC-REFACTOR-METRICS` ★ | spec-only | `application/knowledge.sh` + scout scan (Stage 4) | stage_graded:refactor_metric_missing=warn | 2026-05-05-loop |
| `TCC-ENFORCEMENT` ★ | spec-only | invariant enforcement lookup (Stage 2 가 always_hard, Stage 5 가 모든 stage_graded → block) | always_hard (값 자체의 schema) | 2026-05-05-loop |
| `TCC-PRECEDENCE` | partial | `lib/config.sh`, env loading | always_hard | original |
| `TCC-CHANGE-RULES` | spec-only | contract prose. ledger helper (Stage 2) | always_hard (변경 ledger 기록) | 2026-05-05-loop (invariant_enforcement 변경 ledger 추가) |
| `TCC-GOVERNANCE` ★ | partial | `src/config/target-schema.ts` (Zod parse) — runtime consumer 미구현 (drain / dispatch / observer 후속 plan) | always_hard (governance schema 검증) | 2026-05-06-human-github-boundary |
| `TCC-PHASE-POLICIES` ✕ | deprecated | `docs/history/legacy-phase-model/contracts/target-config-contract.md` | stage_graded:legacy_writer=warn | (deprecated 2026-05-05-loop, 대체: TCC-LOOP-POLICIES) |

### Agent Runner Port

| Anchor | Status | Implementation Surface | Enforcement | Active Since |
|---|---|---|---|---|
| `ARC-SCOPE` | active | contract authority | n/a | 2026-05-05-loop (AGC vs ARC 책임 분리 추가) |
| `ARC-PORT-SIGNATURE` | partial | `src/ports/llm-runner.ts` (`LlmRunnerPort` interface + `LlmRunnerInput` / `LlmRunnerResult` 시그니처), `src/ports/llm-runner-executor.ts` (`runInvoke` 4-tuple 보장). | always_hard (signature shape) | 2026-05-05-loop (session_id/turn_index/parent_loop/agent_role_in_session/session_context_ref 필수) |
| `ARC-CALL-SEMANTICS` | partial | `src/ports/llm-runner-executor.ts` (`runInvoke` — turn 단위 stateless invoke + 4-tuple 결과), `src/adapters/llm-runner/runtime-port.ts` (`AdapterRunnerPort` — provider adapter 를 contract-shaped port 로 노출), `src/application/agent-io.ts` (`callAgent` consumer — session state 미보유 호출). | always_hard (stateless per call) | 2026-05-05-loop (turn 단위 strict + session state 미보유) |
| `ARC-EXIT-CLASSES` | active | `lib/ports/llm_runner.sh` `lr_classify_exit` | n/a (분류) | original |
| `ARC-IDEMPOTENCY` | spec-only | `application/caller_dispatch.sh` + ledger (Stage 2) | always_hard | 2026-05-05-loop (3-scope per-turn / per-session-outcome / per-merge) |
| `ARC-ADAPTER-PROMPT-CONTRACT` ★ | partial | `src/adapters/llm-runner/common/prompt-relay.ts` (`assertFourPartLayout`), `src/ports/llm-runner-executor.ts` (preflight before adapter spawn), `src/adapters/llm-runner/claude-code.ts`, `src/adapters/llm-runner/codex-cli.ts`, `src/adapters/llm-runner/fake.ts` (provider adapters relay stdin verbatim) | always_hard (4-part layout 보존) | 2026-05-05-loop |
| `ARC-ADAPTER-SUBSTITUTION` | spec-only | `TCC-AGENT-PROFILES` binding (Stage 2) | always_hard (agent_profile_id 기반) | phase-pivot |
| `ARC-FAILURE-MODES` | active | `lib/ports/llm_runner.sh`, `scheduler/runner.sh` | n/a (분류) | original |
