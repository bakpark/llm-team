# GitHub State Mapping

본 문서는 [`state-and-operation-contract.md`](../contracts/state-and-operation-contract.md) 의 상태를 GitHub label, milestone description marker, PR/Issue marker 로 표현하는 구현 매핑이다. 상태 의미와 허용 전이는 contract 가 정의하며, 이 문서는 GitHub adapter 의 encoding 만 설명한다.

## Authority

- Authoritative states: [`SOC-MILESTONE-DUAL-SLOT`](../contracts/state-and-operation-contract.md#SOC-MILESTONE-DUAL-SLOT), [`SOC-SLICE-LIFECYCLE`](../contracts/state-and-operation-contract.md#SOC-SLICE-LIFECYCLE), [`SOC-SESSION-LIFECYCLE`](../contracts/state-and-operation-contract.md#SOC-SESSION-LIFECYCLE), [`SOC-SLICE-MERGE`](../contracts/state-and-operation-contract.md#SOC-SLICE-MERGE)
- Recovery semantics: [`RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY)
- Human signal execution: [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS)
- Transition ledger: [`RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER)

## Mapping Principles

- GitHub label/marker 는 contract state 의 encoding 일 뿐이다.
- 상태 전이는 Caller 만 수행한다.
- Agent 는 label, marker, issue close, PR merge 를 직접 수행하지 않는다.
- 사람은 label 을 직접 고쳐 workflow 를 전이하지 않는다. 사람의 개입은 Human Signal 로 기록되고 Caller 가 집행한다.
- 한 workflow object 는 contract state 를 하나만 가져야 한다.

## Milestone State Mapping

GitHub Milestone 의 description hidden marker:

```text
<!-- llm-team:milestone-state:<STATE> -->
<!-- llm-team:milestone-slot:<discovery|delivery|none> -->
```

| Contract state | Marker value | 의미 |
|---|---|---|
| `M_INTAKE_QUEUED` | `M_INTAKE_QUEUED` | seed 가 intake_queue 에 들어옴, slot 점유 전 |
| `M_DISCOVERY_DRAFT` | `M_DISCOVERY_DRAFT` | Discovery slot 점유 시작 |
| `M_DISCOVERY_AWAITING_HUMAN` | `M_DISCOVERY_AWAITING_HUMAN` | Discovery session 의 `human_approval` 대기 |
| `M_SPECIFICATION_DRAFT` | `M_SPECIFICATION_DRAFT` | Specification session 진행 |
| `M_SPECIFICATION_AWAITING_HUMAN` | `M_SPECIFICATION_AWAITING_HUMAN` | Specification session 의 `human_approval` 대기 |
| `M_SPEC_APPROVED` | `M_SPEC_APPROVED` | Discovery slot 해제, Delivery promotion 큐 진입 대기 |
| `M_DELIVERY_PLANNING` | `M_DELIVERY_PLANNING` | Delivery slot 점유, Planning ensemble session |
| `M_DELIVERY_BUILDING` | `M_DELIVERY_BUILDING` | slice 들의 inner/middle loop 진행 |
| `M_DELIVERY_VALIDATING` | `M_DELIVERY_VALIDATING` | cross-slice acceptance + Context Summary |
| `M_DONE` | `M_DONE` | milestone 완료, Delivery slot 해제 |
| `M_ESCALATED` | `M_ESCALATED` | governance 큐 |

이전 모형의 `IMPLEMENTATION_IN_PROGRESS` / `INTEGRATION_*` / `VALIDATION_*` marker 는 폐기되어 위 dual-stage 어휘로 흡수되었다.

`*_AWAITING_HUMAN` 은 outer session 의 quorum sub-state 다 — `loop_policies.outer.<phase>.required_participants=[human]` 인 phase 의 finalization 평가 도중 사람 contribution 을 기다리는 상태다 ([`#RGC-HUMAN-CONTRIBUTION`](../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION)).

## Slice State Mapping

Slice 는 GitHub Issue label + body marker 로 상태를 표현한다.

```text
<!-- llm-team:slice-state:<STATE> -->
<!-- llm-team:slice-kind:<feature|internal> -->
<!-- llm-team:slice-dod-revision:<pin> -->
<!-- llm-team:slice-dependencies:blocks=<id,id> coordinates_with=<id,id> -->
```

| Contract state | GitHub label |
|---|---|
| `SLICE_PENDING` | `slice:pending` |
| `SLICE_READY` | `slice:ready` |
| `SLICE_BUILDING` | `slice:building` |
| `SLICE_REVIEWING` | `slice:reviewing` |
| `SLICE_INTEGRATING` | `slice:integrating` |
| `SLICE_VALIDATED` | `slice:validated` |
| `SLICE_BLOCKED` | `slice:blocked` |

Caller 는 dependency graph 를 기준으로 모든 `blocks` dependency 가 `SLICE_VALIDATED` 가 되면 dependent Slice 를 `SLICE_READY` 로 전이한다. `coordinates_with` dependency 는 join 에 영향을 주지 않는다 (병렬 허용 — first-merger-wins, 후속은 SliceMerge `SM_STALE` 사이클).

이전 모형의 `Task` 어휘 (TASK_PENDING/READY/IN_PROGRESS/REVIEW_*/INTEGRATED/REJECTED) 는 폐기되어 위 7-state slice lifecycle 로 흡수되었다.

## DialogueSession State Mapping

DialogueSession 은 영속 저장소의 별도 영역 (예: `session_log/<session_id>/metadata.json`) 에 영속화된다. GitHub label 매핑은 다음과 같다 (parent slice / milestone 의 issue 에 보조 marker 로 표현 가능).

```text
<!-- llm-team:session-state:<STATE> -->
<!-- llm-team:session-final-verdict:<VERDICT> -->
<!-- llm-team:session-parent-loop:<outer|middle|inner> -->
<!-- llm-team:session-purpose:<purpose> -->
```

| Contract state | Marker value |
|---|---|
| `SESSION_OPEN` | `SESSION_OPEN` |
| `CONVERGED` | `CONVERGED` |
| `TIMEOUT` | `TIMEOUT` |
| `ABANDONED` | `ABANDONED` |
| `AWAITING_REVALIDATION` | `AWAITING_REVALIDATION` |

`final_verdict` ([`#SOC-SESSION-TERMINATION`](../contracts/state-and-operation-contract.md#SOC-SESSION-TERMINATION) 의 enum) 은 CONVERGED 시점에만 채워진다.

## SliceMerge State Mapping

SliceMerge 는 PR 또는 별도 영속 객체로 표현된다. GitHub PR label 또는 body marker:

```text
<!-- llm-team:slice-merge-state:<STATE> -->
<!-- llm-team:slice-id:<slice_id> -->
<!-- llm-team:slice-merge-pre-revision:<sha> -->
<!-- llm-team:slice-merge-revision:<sha> -->        # SM_MERGED 시점에 채움
```

| Contract state | Marker value |
|---|---|
| `SM_DRAFT` | `SM_DRAFT` |
| `SM_READY_FOR_REVIEW` | `SM_READY_FOR_REVIEW` |
| `SM_APPROVED` | `SM_APPROVED` |
| `SM_MERGED` | `SM_MERGED` |
| `SM_REQUEST_CHANGES` | `SM_REQUEST_CHANGES` |
| `SM_CLOSED` | `SM_CLOSED` |
| `SM_STALE` | `SM_STALE` |

이전 모형의 `Code CP` / `Integration CP` 의 7-state PR lifecycle 은 SliceMerge 7-state 로 흡수되었다. `Spec CP` 와 `Milestone CP` 는 별도로 유지되어 spec/doc 객체의 영속화 단위 역할을 한다.

> SliceMerge state 의 end-to-end 전이 sequence (Slice SLICE_BUILDING → SM_DRAFT → ... → SM_MERGED 또는 terminal failure) 는 [`worktree-pr-lifecycle.md`](worktree-pr-lifecycle.md) §4. PR review (approve / request_changes) 의 GitHub signal direction (outbound mirror, inbound 비신호) 은 같은 문서 §5.

## Spec CP / Milestone CP Marker

Spec CP 와 Milestone CP 는 spec/doc 객체이며 trunk 코드 병합 대상이 아니다. PR 또는 doc commit 에 다음 marker 가 적용될 수 있다.

```text
<!-- llm-team:cp-state:<STATE> -->
<!-- llm-team:cp-kind:<spec|milestone> -->
```

| State | 의미 |
|---|---|
| `CP_DRAFT` | Discovery / Specification / Validation lead 가 draft 작성 중 |
| `CP_AWAITING_HUMAN` | session 의 finalization 이 사람 contribution 대기 중 |
| `CP_APPROVED` | session CONVERGED 후 응축됨 |
| `CP_MERGED` | spec/doc 영속화 완료 |
| `CP_REQUEST_CHANGES` | session reject |
| `CP_CLOSED` | reject 후 닫힘 |
| `CP_STALE` | base revision 변경으로 stale |

## Lease Encoding

Lease 는 label 만으로 표현하지 않는다. Caller 는 4 lease kind 별로 lease record 를 별도 artifact 로 남긴다.

필수 필드는 [`RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS) 를 따른다. GitHub-only 구현에서는 Issue/PR/Milestone comment, hidden marker, 또는 별도 lease store 를 사용할 수 있으나, compare-and-set 성격을 보장해야 한다.

```text
<!-- llm-team:lease:<lease-id> -->
<!-- llm-team:lease-kind:<slot_lock|slice_lease|session_lease|turn_lease> -->
<!-- llm-team:lease-expires-at:<timestamp> -->
<!-- llm-team:lease-token:<monotonic-int> -->
```

`turn_lease` 는 turn_index CAS 권장 — separate lease 객체 두지 않고 session 의 `current_turn_index` 에 atomic CAS.

## Human Signal Encoding

```text
<!-- llm-team:human-signal
signal_id: <id>
signal_type: <approve|reject|request_rework|request_recover|pause|resume|amendment_approve|cross_milestone_amendment|acceptance_test_rename|purge_acceptance_tests|stop>
target_kind: <kind>
target_id: <id>
target_revision_pin: <pin>
related_object_id: <id>
related_object_revision_pin: <pin>
-->
```

Caller 는 signal 검증 후에만 operational write 를 수행한다.

## Recover Operation Mapping

[`SOC-RECOVERY-OPERATION`](../contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION) 의 trigger × ledger result 매트릭스가 GitHub label/marker 에 다음과 같이 인코딩된다.

| Trigger | label/marker 변화 | Ledger result |
|---|---|---|
| stale lease (slot/slice/session/turn) | 해당 객체의 state → 직전 ready 상태 | `recovered` |
| lease-expiry | partial-fail rollback 결과로 분기 | `rolled_back` 또는 잔여 retry 시 `error` |
| human-revoke | 객체별 ready 상태 + signal marker close | `recovered` |
| partial-fail-rollback | 부분 write 흔적(label/marker)을 caller 가 명시 제거 | `rolled_back` |
| session-stale / session-timeout | session state → AWAITING_REVALIDATION 또는 ABANDONED/TIMEOUT | `recovered` |
| inner-no-progress | slice → SLICE_BLOCKED | `recovered` |
| slice-merge-stale | SliceMerge → SM_STALE | `recovered` |

label/marker 갱신 자체는 contract operation 이 아니라 *Recover 의 부수효과* 다. 외부 사용자가 label/marker 를 직접 수정하면 contract 위반이다.

## Transition Ledger Encoding

모든 operational transition 은 [`RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 필드를 기록한다.

GitHub-only 구현에서는 다음 중 하나를 ledger store 로 사용할 수 있다.

- target repository 의 machine-readable ledger file
- Issue/PR/Milestone comment
- 별도 persistent DB

어떤 store 를 쓰든 신규 schema 의 `transition_id`, `object_id`, `object_kind`, `from_state`, `to_state`, `loop_kind`, `phase`, `slice_id`, `slice_kind`, `session_id`, `turn_index`, `slot_kind`, `agent_profile_id`, `contribution_kind`, `action_kind`, `final_verdict`, `idempotency_key`, `lease_kind`, `lease_token`, `result`, `timestamp` 가 검색 가능해야 한다.

legacy schema 의 row 는 immutable. parser 는 union read 로 양 schema 를 동시 지원 (Stage 2 ledger.sh rewrite 의 invariant).

## Legacy Mapping Notes

기존 label set 이 이미 배포되어 있다면 historical reader 가 legacy label 을 contract state 로 해석할 수 있다. 단, 새 구현은 위의 dual-stage / slice / session / SliceMerge marker 만 신규 row 에 적용한다.

| Legacy label | New marker |
|---|---|
| `task:ready` | `slice:ready` |
| `task:in-progress` | `slice:building` |
| `task:review-ready` | `slice:reviewing` (+ SliceMerge `SM_READY_FOR_REVIEW`) |
| `task:review-in-progress` | `slice:reviewing` |
| `task:integrated` | `slice:validated` |
| `task:rejected` | `slice:building` (재build) |
| `IMPLEMENTATION_IN_PROGRESS` | `M_DELIVERY_BUILDING` |
| `INTEGRATION_*` | `M_DELIVERY_BUILDING` 또는 `M_DELIVERY_VALIDATING` |
| `CP_READY_FOR_REVIEW` (Code) | SliceMerge `SM_READY_FOR_REVIEW` |
| `CP_MERGED` (Code) | SliceMerge `SM_MERGED` |
| `CP_AWAITING_QUORUM` (Spec) | Spec CP `CP_AWAITING_HUMAN` |

상세 환산은 [`docs/contracts/README.md#CONTRACT-MIGRATION-NOTES`](../contracts/README.md#CONTRACT-MIGRATION-NOTES) 가 단일 권위.
