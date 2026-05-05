# GitHub State Mapping

본 문서는 [`state-and-operation-contract.md`](../contracts/state-and-operation-contract.md)의 상태를 GitHub label, milestone description marker, PR/Issue marker로 표현하는 구현 매핑이다. 상태 의미와 허용 전이는 contract가 정의하며, 이 문서는 GitHub adapter의 encoding만 설명한다.

## Authority

- Authoritative states: [`SOC-STATES`](../contracts/state-and-operation-contract.md#SOC-STATES)
- Recovery semantics: [`RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY)
- Human signal execution: [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS)
- Transition ledger: [`RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER)

## Mapping Principles

- GitHub label/marker는 contract state의 encoding일 뿐이다.
- 상태 전이는 Caller만 수행한다.
- Agent는 label, marker, issue close, PR merge를 직접 수행하지 않는다.
- 사람은 label을 직접 고쳐 workflow를 전이하지 않는다. 사람의 개입은 Human Signal로 기록되고 Caller가 집행한다.
- 한 workflow object는 contract state를 하나만 가져야 한다. escalation은 별도 overlay로 허용한다.

## Milestone State Mapping

GitHub Milestone은 native label을 지원하지 않으므로 description의 hidden marker로 상태를 인코딩한다.

```text
<!-- llm-team:milestone-state:<STATE> -->
```

| Contract state | GitHub marker value | 의미 |
|---|---|---|
| `DISCOVERY_DRAFT` | `DISCOVERY_DRAFT` | Discovery phase 산출 대기 또는 회수 상태 |
| `DISCOVERY_AWAITING_HUMAN` | `DISCOVERY_AWAITING_HUMAN` | Discovery phase quorum 의 `human_approval` 대기 (legacy `PO_GATE` 의미를 흡수) |
| `SPECIFICATION_DRAFT` | `SPECIFICATION_DRAFT` | Specification phase 산출 대기 |
| `SPECIFICATION_AWAITING_HUMAN` | `SPECIFICATION_AWAITING_HUMAN` | Specification phase quorum 의 `human_approval` 대기 |
| `PLANNING_READY` | `PLANNING_READY` | Planning phase claim 대기 |
| `PLANNING_IN_PROGRESS` | `PLANNING_IN_PROGRESS` | Planning phase lead lease 보유 |
| `IMPLEMENTATION_IN_PROGRESS` | `IMPLEMENTATION_IN_PROGRESS` | 자식 Task 진행 중 |
| `INTEGRATION_READY` | `INTEGRATION_READY` | Integration phase claim 대기 |
| `INTEGRATION_IN_PROGRESS` | `INTEGRATION_IN_PROGRESS` | Integration phase lead lease 보유 |
| `VALIDATION_READY` | `VALIDATION_READY` | Validation phase claim 대기 |
| `VALIDATION_IN_PROGRESS` | `VALIDATION_IN_PROGRESS` | Validation phase lead lease 보유 |
| `DONE` | `DONE` | 마일스톤 완료 |
| `ESCALATED` | `ESCALATED` | governance 큐 (사람 개입 필요) |

이전 구현의 `po:in-progress`, `needs-scenarios`, `release:ready`, `PO_DRAFT`, `PM_GATE` 같은 label/marker 이름은 legacy alias 로만 취급한다. 새 구현은 contract state 값을 그대로 marker 에 기록하는 방식을 우선한다.

`*_AWAITING_HUMAN` 은 phase 의 quorum sub-state 다. 별도 governance gate state 가 아니라 `phase_policies.<phase>.required_reviewers=[human]` 인 phase 의 quorum 평가 도중 사람 contribution 을 기다리는 상태다 (`docs/contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION`).

## Task State Mapping

Task 는 GitHub Issue label 로 상태를 표현한다.

| Contract state | GitHub label | 의미 |
|---|---|---|
| `TASK_PENDING` | `task:pending` | dependency 대기 |
| `TASK_READY` | `task:ready` | Implementation phase (forge) claim 대기 |
| `TASK_IN_PROGRESS` | `task:in-progress` | Implementation phase forge lease 보유 |
| `TASK_REVIEW_READY` | `task:review-ready` | CodeReview phase (sentinel) claim 대기 |
| `TASK_REVIEW_IN_PROGRESS` | `task:review-in-progress` | CodeReview phase lead lease 보유 |
| `TASK_INTEGRATED` | `task:integrated` | Code CP 가 통합 브랜치에 병합됨 |
| `TASK_REJECTED` | `task:rejected` | request-changes 후 회수 직전 상태 |
| `ESCALATED` | `task:escalated` | governance 큐 |

Dependency는 Issue body의 marker로 표현할 수 있다.

```text
<!-- llm-team:blocked-by:#<issue-number> -->
```

Caller는 dependency graph를 기준으로 모든 dependency가 `TASK_INTEGRATED`가 되면 dependent Task를 `TASK_READY`로 전이한다.

## Change Proposal State Mapping

Change Proposal은 GitHub PR, branch, commit set, 또는 spec patch PR로 표현된다. 상태는 PR label 또는 body marker로 인코딩한다.

```text
<!-- llm-team:cp-state:<STATE> -->
<!-- llm-team:cp-kind:<spec|code|integration|milestone> -->
```

| Contract state | Marker value |
|---|---|
| `CP_DRAFT` | `CP_DRAFT` |
| `CP_AWAITING_QUORUM` | `CP_AWAITING_QUORUM` (Spec CP 가 Discovery / Specification phase 의 quorum 대기) |
| `CP_READY_FOR_REVIEW` | `CP_READY_FOR_REVIEW` (Code CP 가 CodeReview phase 의 quorum 대기) |
| `CP_READY_FOR_VERIFICATION` | `CP_READY_FOR_VERIFICATION` (Integration / Milestone CP 가 phase 의 quorum 대기) |
| `CP_APPROVED` | `CP_APPROVED` |
| `CP_MERGED` | `CP_MERGED` |
| `CP_REQUEST_CHANGES` | `CP_REQUEST_CHANGES` |
| `CP_CLOSED` | `CP_CLOSED` |
| `CP_STALE` | `CP_STALE` |

legacy `CP_READY_FOR_HUMAN_GATE` / `CP_HUMAN_APPROVED` 는 본 매핑에서 폐기되었다 — Spec CP 의 사람 승인은 Discovery / Specification phase 의 quorum 안의 `human_approval` contribution 으로 흡수된다.

Spec CP 는 phase coordinator 의 quorum_reached 후 Caller 가 `CP_AWAITING_QUORUM -> CP_APPROVED -> CP_MERGED` 로 집행한다 (사람 reject 시 `CP_REQUEST_CHANGES -> CP_CLOSED`). Code CP 는 CodeReview phase 의 quorum_reached 후 Caller 가 `CP_READY_FOR_REVIEW -> CP_APPROVED -> CP_MERGED` 또는 `CP_READY_FOR_REVIEW -> CP_REQUEST_CHANGES -> CP_CLOSED` 로 집행한다.

## Lease Encoding

Lease는 label만으로 표현하지 않는다. Caller는 lease record를 별도 artifact로 남긴다.

필수 필드는 [`RGC-PHASE-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-PHASE-LEASE) 를 따른다 (contribution lease 와 phase coordinator lease 두 종류). GitHub-only 구현에서는 Issue/PR/Milestone comment 또는 hidden marker 를 lease store 로 사용할 수 있으나, compare-and-set 성격을 보장해야 한다.

```text
<!-- llm-team:lease:<lease-id> -->
<!-- llm-team:lease-expires-at:<timestamp> -->
```

## Human Signal Encoding

Human Signal은 GitHub comment, PR review, issue form, 또는 별도 file artifact로 남길 수 있다. 어떤 매체를 쓰든 [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS)의 envelope를 만족해야 한다.

권장 comment marker:

```text
<!-- llm-team:human-signal
signal_id: <id>
signal_type: <approve|reject|request_rework|request_recover|pause|resume|amendment_approve|stop>
target_kind: <kind>
target_id: <id>
target_revision_pin: <pin>
related_change_proposal_id: <id>
related_change_proposal_revision_pin: <pin>
-->
```

Caller는 signal 검증 후에만 operational write를 수행한다.

## Recover Operation Mapping

[`SOC-RECOVERY-OPERATION`](../contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION) 의 4 trigger × ledger result 매트릭스가 GitHub label/marker 에 다음과 같이 인코딩된다.

| Trigger | label/marker 변화 | Ledger result |
|---|---|---|
| stale lease | `*_IN_PROGRESS` → 직전 ready 상태 | `recovered` |
| lease-expiry 진행 중 | `*_IN_PROGRESS` 유지 후 partial-fail rollback 결과로 분기 | `rolled_back` 또는 잔여 retry 시 `error` |
| human-revoke | 객체별 ready 상태 + signal marker close | `recovered` |
| partial-fail rollback | 부분 write 흔적(label/marker)을 caller 가 명시 제거 | `rolled_back` |

label/marker 갱신 자체는 contract operation 이 아니라 *Recover 의 부수효과* 다. 따라서 외부 사용자가 label/marker 를 직접 수정하면 contract 위반이다.

본 architecture 의 검출 한계: pin re-check([`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST))는 manifest entry 의 revision pin(예: `updatedAt`) 이 변하면 이를 감지한다. 영속 저장소가 label/marker 변경을 객체 revision pin 에 반영하면(예: GitHub 의 `updatedAt` 이 label 변경 시 갱신) 검출이 자동화된다. 그렇지 않은 어댑터에서는 외부 수정 검출은 best-effort 이며, 운영 정책으로 *외부 수정을 허용하지 않음* 을 알려야 한다(라벨 권한 격리, 외부 PR 본문 수정 차단 등). 검출 강화는 향후 architecture 갱신의 대상이다.

## Transition Ledger Encoding

모든 operational transition은 [`RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER)의 필드를 기록한다.

GitHub-only 구현에서는 다음 중 하나를 ledger store로 사용할 수 있다.

- target repository의 machine-readable ledger file
- Issue/PR/Milestone comment
- 별도 persistent DB

어떤 store를 쓰든 `transition_id`, `object_id`, `from_state`, `to_state`, `operation`, `idempotency_key`, `timestamp`는 검색 가능해야 한다.

## Legacy Mapping Notes

기존 label set이 이미 배포되어 있다면 adapter가 legacy label을 contract state로 해석할 수 있다. 단, 새 문서와 새 구현은 contract state 이름을 우선한다.

| Legacy label | Contract state |
|---|---|
| `needs-code` | `TASK_READY` |
| `code:in-progress` | `TASK_IN_PROGRESS` |
| `code:in-review` | `TASK_REVIEW_READY` |
| `code:rework-needed` | `TASK_READY` with previous rejection context |
| `merged-to-release` | `TASK_INTEGRATED` |
| `needs-human-review:engineer-failure` | `ESCALATED` |

Legacy milestone labels such as `needs-engineering`, `release:in-progress`, and `release:ready` should be migrated to explicit contract-state markers.
