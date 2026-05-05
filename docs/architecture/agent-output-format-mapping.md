# Agent Output Format Mapping

본 문서는 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT) 의 output envelope 와 [`AGC-CONTRIBUTION-OUTPUTS`](../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS) 매트릭스를 GitHub PR body, Issue body, comment, markdown artifact 로 표현하는 구현 매핑이다.

이 문서는 contract 가 아니다. Agent output 의 authoritative schema 는 [`agent-and-context-contract.md`](../contracts/agent-and-context-contract.md) 이며, 본 문서는 사람이 읽기 쉬운 markdown artifact 구조만 제안한다.

cross-link:
- 입력 (1-shot prompt 본문) 측 직렬화: [`AGC-PROMPT-SERIALIZATION`](../contracts/agent-and-context-contract.md#AGC-PROMPT-SERIALIZATION) + 구체 형식 [`prompt-build-pipeline.md`](prompt-build-pipeline.md)
- provider-native 응답 ↔ envelope normalize: [`AGC-LLM-NEUTRALITY`](../contracts/agent-and-context-contract.md#AGC-LLM-NEUTRALITY)
- 외부 surface (Issue / PR / Milestone) 매핑: [`external-tracking-mapping.md`](external-tracking-mapping.md)

## Common Envelope

모든 Agent output 은 envelope 와 artifact 를 분리한다. 아래 YAML 은 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT) 을 설명하기 위한 **non-authoritative example** 이다. 필드의 필수 여부와 의미는 contract 문서가 정의한다.

```yaml
session_id: <Caller-issued DialogueSession id>
turn_index: <0-based monotonic int within session>
parent_loop: <outer|middle|inner>
phase_or_purpose: <outer 한정: Discovery|Specification|Planning|Validation; middle: review|merge; inner: tdd_build>
agent_profile_id: <atlas|forge|sentinel|scout|human>
agent_role_in_session: <lead|reviewer|observer>
contribution_kind: <lead_draft|review_verdict|proposal|human_approval>
parent_review_verdict_id: <직전 review_verdict 의 contribution id; rework lead_draft 한정>
output_kind: <spec_proposal|task_plan|slice_decomposition|patch|verdict|milestone_package|proposal_artifact|failure>
object_id: <주 처리 대상 객체 id; TCC-IDENTITY.target_id 와 다른 개념>
manifest_id: <context manifest id>
input_revision_pins:
  - object_id: <id>
    revision_pin: <pin>
idempotency_key: <Caller enrichment 가 합성 — 3-scope per-turn / per-session-outcome / per-merge>
summary: <short human-readable summary>
artifacts:
  - kind: <markdown|patch|slice_spec|cp_message|context_summary|metric_report>
    name: <artifact name>
    body: |
      <artifact body>
verdict:
  result: <approve|request_changes|validation_pass|validation_fail|validation_stale|null>
  rationale: <reason>
next_action_request:                # AGC-NEXT-ACTION-REQUEST (★)
  addressed_to: <agent_profile_id|null>
  intent: <ask_review|ask_evidence|propose_finalize|none>
  rationale: <reason>
failure:
  type: <invalid_output|tool_failure|need_context|none>
  detail: <detail>
runtime_metadata:                   # Caller enrichment 영역 (AGC-OUTPUT-RUNTIME-ENRICH)
  <key>: <value>
```

legacy `agent_role` / `operation` / `phase_run_id` / `phase` 필드는 envelope 에서 폐기되었다. `(session_id, turn_index, parent_loop, agent_profile_id, contribution_kind)` 셋이 단일 식별자다.

폐기된 contribution_kind: `rework_patch` (→ `lead_draft` + `parent_review_verdict_id`), `evidence` (→ `proposal` + RequiredEvidence/VerificationRun/MetricRun 인프라), `summary` (→ outer Validation `lead_draft` artifact).

Caller may serialize this envelope as JSON, YAML, markdown front matter, or another structured representation. Markdown headings below are artifact body conventions only and must not be used as the primary validation contract.

`(parent_loop, phase_or_purpose, contribution_kind)` × `output_kind` × `verdict.result` 의 authoritative matrix 는 [`AGC-CONTRIBUTION-OUTPUTS`](../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS) 가 정의한다. 아래 loop step 별 절은 markdown artifact 예시이며 enum 검증 권위가 아니다.

## Outer Discovery — Spec Proposal Artifact

parent_loop: `outer`, phase_or_purpose: `Discovery`, lead: atlas (`lead_draft`)
Artifact kind: `markdown`
Output kind: `spec_proposal`

```markdown
# <Milestone Title>

## Research Summary

<domain background, comparable systems, constraints, user value>

## Product Scope

- <scope item>

## Constraints

- <constraint>

## Source Input

<input object id or path>

## Accumulated Spec References

- <spec artifact id + revision pin>
```

dialogue_coordinator 는 finalization 평가 (사람 `human_approval` 필수) 후 caller_dispatch 가 Spec CP 를 영속화하고 milestone state 를 `M_DISCOVERY_AWAITING_HUMAN` → `M_SPECIFICATION_DRAFT` 로 전이한다.

## Outer Specification — Scenario Artifact

parent_loop: `outer`, phase_or_purpose: `Specification`, lead: atlas (`lead_draft`)
Artifact kind: `markdown`
Output kind: `spec_proposal`

```markdown
# <Milestone Title> - Scenarios

## Scenario: <title>

### User Story

As a <role>, I want <action>, so that <benefit>.

### Acceptance Criteria

- [AC-001] <verifiable criterion>
- [AC-002] <verifiable criterion>

### Out of Scope

- <excluded item>

## Acceptance Criteria Index

- [AC-001] <criterion summary>
- [AC-002] <criterion summary>
```

AC-ID 는 필수다. Traceability 는 [`KAC-TRACEABILITY`](../contracts/knowledge-contract.md#KAC-TRACEABILITY).

## Outer Planning — Slice Plan Artifact

parent_loop: `outer`, phase_or_purpose: `Planning`, lead: atlas (`lead_draft`)
Artifact kind: `slice_spec`
Output kind: `slice_decomposition`

```markdown
## Slice

<slice 의 가치 단위 — 코드 변경량이 아니라 사용자 가치/내부 invariant 단위>

## Slice Class

<feature|internal>

## Acceptance Criteria Mapping

- [AC-001]
- [AC-002]

## Implementation Guidance

- <guidance>

## Impact Scope

- <file/module>

## Dependencies

- blocks: [<slice slug 또는 object id>]
- coordinates_with: [<slice slug 또는 object id>]
```

caller_dispatch 가 Slice 객체 + dependency edge (`blocks` / `coordinates_with`) 를 영속화한 뒤 milestone state 를 `M_DELIVERY_BUILDING` 으로 전이. Planning lead contribution 은 Issue 를 직접 생성하지 않는다.

## Inner tdd_build — Patch Artifact (forge solo)

parent_loop: `inner`, purpose: `tdd_build`, lead: forge (`lead_draft`)
Artifact kind: `patch` 또는 `cp_message`
Output kind: `patch`

```markdown
## Turn Classification

<red_green|refactor>

## Change Summary

<what changed>

## Verification Notes

<commands suggested or observations from local reasoning>

## Risk

<known risks>
```

inner loop 은 forge solo session — turn 별로 verification cycle 이 자동 트리거되어 SessionTurn.verification_result 에 결과가 합성된다. inner CONVERGED 시 caller_dispatch 가 SliceMerge 를 `SM_DRAFT` → `SM_READY_FOR_REVIEW` 로 promote.

## Middle Review — Verdict Artifact

parent_loop: `middle`, phase_or_purpose: `review`, lead: sentinel
Artifact kind: `markdown`
Output kind: `verdict`

contribution_kind = `review_verdict` (lead 산출). rework loop 의 forge re-draft 는 `lead_draft` + `parent_review_verdict_id` 로 진입한다.

Approve:

```markdown
## Review Verdict

Result: approve

## Required Evidence

- VerificationRun: <id> (PASS)
- MetricRun: <id> (within target.refactor_metrics threshold)

## Rationale

<why this satisfies the slice AC + slice_class gate>
```

Request changes:

```markdown
## Review Verdict

Result: request_changes

## Failed Criteria

- [AC-001] <reason>

## Required Rework

- <specific rework instruction>
```

middle review verdict 는 직접 trunk merge 하지 않는다. caller_dispatch 가 SliceMerge state 를 `SM_READY_FOR_REVIEW` ↔ `SM_REQUEST_CHANGES` ↔ `SM_APPROVED` 로 전이한 뒤, `SM_APPROVED` → `SM_MERGED` 게이트에서 trunk 병합이 일어난다.

## Outer Validation — Milestone Package Artifact

parent_loop: `outer`, phase_or_purpose: `Validation`, lead: sentinel (`lead_draft`)
Artifact kind: `markdown`
Output kind: `milestone_package`

legacy `summary` contribution_kind 는 폐기 — Validation 의 Context Summary 는 본 lead_draft artifact 의 일부로 흡수된다.

```markdown
## Validation Verdict

Result: validation_pass | validation_fail | validation_stale

## Acceptance Criteria Results

- [AC-001] PASS - <evidence: VerificationRun/MetricRun id>
- [AC-002] FAIL - <evidence>

## Responsible Slices

- <slice id>

## Context Summary

<summary for next milestone — KAC-DECISION-LOG / RefactorBacklog 항목 포함>
```

Validation contribution 은 테스트를 직접 실행하거나 default branch 에 merge 하거나 Issue 를 close 하거나 사람에게 알림을 보내지 않는다. Caller 가 dispatch pre-action 에서 결정적 검증을 실행하고, dialogue_coordinator finalization 후 caller_dispatch 가 verdict 를 적용해 milestone 을 `M_DONE` 으로 전이한다.

## Scout Proposal Artifact

parent_loop: any (관찰자 / RefactorBacklog scan), agent_profile_id: scout (`proposal`)
Artifact kind: `markdown` 또는 `metric_report`
Output kind: `proposal`

```markdown
## Proposal Kind

<reproduction_evidence | refactor_proposal | metric_observation>

## Subject

<slice id, milestone id, 또는 codebase area>

## Observation

<재현 로그 / metric 측정 결과 / design smell 근거>

## Suggested Next Step

<next session 후보 또는 RefactorBacklog entry>
```

scout 는 일반적으로 lead_draft 를 산출하지 않는다 (lead 책임은 atlas / forge / sentinel). evidence/proposal 은 dialogue_coordinator 의 finalization 평가에 입력 (required_evidence producer 또는 next session 후보) 으로 들어간다.

## Issue Body 2-Layer Rendering

[`AGC-ISSUE-BODY`](../contracts/agent-and-context-contract.md#AGC-ISSUE-BODY) 가 정의하는 human-narrative + machine-metadata 의 2-layer 분리는 다음 markdown 구조로 렌더링한다.

```markdown
<!-- ↓ Human narrative (first-class, 사람이 읽는 본문) -->
## 배경

<요약, 결정 동기, 영향 범위>

## 진행 메모

<현재 상태와 다음 단계의 사람 친화적 설명>

<!-- ↓ Machine metadata block (collapsible, Caller 가 작성/소비) -->
<details>
<summary>llm-team metadata</summary>

<!-- llm-team:milestone-state:<STATE> -->
<!-- llm-team:slice-state:<STATE> -->
<!-- llm-team:slice-merge-state:<STATE> -->
<!-- llm-team:cp-kind:<spec|milestone> -->

```json
{
  "lease_token": "<token>",
  "lease_kind": "<slot_lock|slice_lease|session_lease|turn_lease>",
  "manifest_id": "<id>",
  "links": {"milestone": "<id>", "slice": "<id>", "slice_merge": "<id>", "blocks": ["<id>"]}
}
```

</details>
```

규칙:

- machine block 은 항상 `<details>` 안. 사람의 가독성을 우선한다.
- 모든 marker (`<!-- llm-team:*-state:* -->`) 는 machine block *안에만* 위치한다. human narrative 영역에 marker 가 섞이면 [`#AGC-ISSUE-BODY`](../contracts/agent-and-context-contract.md#AGC-ISSUE-BODY) 위반.
- Agent 는 human narrative 만 산출한다. machine block 은 Caller 가 [`#AGC-OUTPUT-RUNTIME-ENRICH`](../contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH) 에 따라 합성한다.

### `<details>` 미지원 영역(milestone description 등)

GitHub milestone description 처럼 `<details>` 가 렌더되지 않거나 어색한 본문 영역에서는 다음 변형을 따른다.

- 기계 계층은 본문 *말미* 의 단일 영역에 모은다. `---` 같은 분리선으로 사람 계층과 시각적으로 분리한다.
- 영역 시작은 `<!-- llm-team:metadata-begin -->`, 종료는 `<!-- llm-team:metadata-end -->` 로 감싼다. Caller 는 이 두 토큰 사이만 파싱한다.
- 두 토큰 사이가 아닌 위치에 marker 가 있으면 invalid 본문으로 간주한다 (`#AGC-ISSUE-BODY` 의 "두 계층의 토큰이 섞이면 invalid").
- 사람 계층은 분리선 *위* 에만 위치한다. Caller 가 본문 갱신 시 분리선 아래 영역만 갱신하고 위 영역은 보존한다 (사람 수동 편집 보존).

## Invalid Legacy Patterns

The following legacy patterns are no longer authoritative:

- first-line-only `RESULT: PASS|FAIL` without output envelope
- grep/awk-only parsing as the primary contract
- Agent-authored labels or state markers
- Agent-created PR reviews that also imply merge authority
- envelope 의 `phase` / `phase_run_id` / `agent_role` / `operation` field 사용 (모두 폐기)
- contribution_kind ∈ {`rework_patch`, `evidence`, `summary`} (폐기 — 위 매트릭스 참조)

Implementations may continue to render markdown bodies for human readability, but Caller must validate the structured output envelope first.
