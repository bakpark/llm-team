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
| `PO_DRAFT` | `PO_DRAFT` | PO 산출 대기 또는 PO 회수 상태 |
| `PO_GATE` | `PO_GATE` | PO Spec CP에 대한 human gate |
| `PM_DRAFT` | `PM_DRAFT` | PM 산출 대기 |
| `PM_GATE` | `PM_GATE` | PM Spec CP에 대한 human gate |
| `DECOMPOSE_READY` | `DECOMPOSE_READY` | Planner claim 대기 |
| `DECOMPOSE_IN_PROGRESS` | `DECOMPOSE_IN_PROGRESS` | Planner lease 보유 |
| `IMPLEMENTING` | `IMPLEMENTING` | 자식 Task 진행 중 |
| `REFACTOR_READY` | `REFACTOR_READY` | Integrator claim 대기 |
| `REFACTOR_IN_PROGRESS` | `REFACTOR_IN_PROGRESS` | Integrator lease 보유 |
| `VALIDATE_READY` | `VALIDATE_READY` | QA claim 대기 |
| `VALIDATE_IN_PROGRESS` | `VALIDATE_IN_PROGRESS` | QA lease 보유 |
| `DONE` | `DONE` | 마일스톤 완료 |
| `ESCALATED` | `ESCALATED` | human gate 큐 |

이전 구현의 `po:in-progress`, `needs-scenarios`, `release:ready` 같은 label 이름은 legacy alias로만 취급한다. 새 구현은 contract state 값을 그대로 marker에 기록하는 방식을 우선한다.

## Task State Mapping

Task는 GitHub Issue label로 상태를 표현한다.

| Contract state | GitHub label | 의미 |
|---|---|---|
| `TASK_PENDING` | `task:pending` | dependency 대기 |
| `TASK_READY` | `task:ready` | Coder claim 대기 |
| `TASK_IN_PROGRESS` | `task:in-progress` | Coder lease 보유 |
| `TASK_REVIEW_READY` | `task:review-ready` | Reviewer claim 대기 |
| `TASK_REVIEW_IN_PROGRESS` | `task:review-in-progress` | Reviewer lease 보유 |
| `TASK_INTEGRATED` | `task:integrated` | Code CP가 통합 브랜치에 병합됨 |
| `TASK_REJECTED` | `task:rejected` | request-changes 후 회수 직전 상태 |
| `ESCALATED` | `task:escalated` | human gate 큐 |

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
| `CP_READY_FOR_HUMAN_GATE` | `CP_READY_FOR_HUMAN_GATE` |
| `CP_READY_FOR_REVIEW` | `CP_READY_FOR_REVIEW` |
| `CP_READY_FOR_VERIFICATION` | `CP_READY_FOR_VERIFICATION` |
| `CP_HUMAN_APPROVED` | `CP_HUMAN_APPROVED` |
| `CP_APPROVED` | `CP_APPROVED` |
| `CP_MERGED` | `CP_MERGED` |
| `CP_REQUEST_CHANGES` | `CP_REQUEST_CHANGES` |
| `CP_CLOSED` | `CP_CLOSED` |
| `CP_STALE` | `CP_STALE` |

Spec CP는 human gate signal 후 Caller가 `CP_READY_FOR_HUMAN_GATE -> CP_HUMAN_APPROVED -> CP_MERGED`로 집행한다. Code CP는 Reviewer verdict 후 Caller가 `CP_READY_FOR_REVIEW -> CP_APPROVED -> CP_MERGED` 또는 `CP_READY_FOR_REVIEW -> CP_REQUEST_CHANGES -> CP_CLOSED`로 집행한다.

## Lease Encoding

Lease는 label만으로 표현하지 않는다. Caller는 lease record를 별도 artifact로 남긴다.

필수 필드는 [`RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE)를 따른다. GitHub-only 구현에서는 Issue/PR/Milestone comment 또는 hidden marker를 lease store로 사용할 수 있으나, compare-and-set 성격을 보장해야 한다.

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
