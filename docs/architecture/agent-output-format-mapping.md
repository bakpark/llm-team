# Agent Output Format Mapping

본 문서는 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)의 output envelope를 GitHub PR body, Issue body, comment, markdown artifact로 표현하는 구현 매핑이다.

이 문서는 contract가 아니다. Agent output의 authoritative schema는 [`agent-and-context-contract.md`](../contracts/agent-and-context-contract.md)이며, 이 문서는 사람이 읽기 쉬운 markdown artifact 구조만 제안한다.

## Common Envelope

모든 Agent output은 envelope와 artifact를 분리한다. 아래 YAML은 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)을 설명하기 위한 **non-authoritative example**이다. 필드의 필수 여부와 의미는 contract 문서가 정의한다.

```yaml
phase: <Discovery|Specification|Planning|Implementation|CodeReview|Integration|Validation>
agent_profile: <atlas|forge|sentinel|scout|human>
contribution_kind: <lead_draft|rework_patch|review_verdict|evidence|summary|human_approval>
phase_run_id: <Caller-issued PhaseRun id>
output_kind: <spec_proposal|task_plan|patch|verdict|milestone_package|failure>
object_id: <주 처리 대상 객체 id; TCC-IDENTITY.target_id 와 다른 개념>
manifest_id: <context manifest id>
input_revision_pins:
  - object_id: <id>
    revision_pin: <pin>
idempotency_key: <Caller enrichment 단계에서 phase + phase_run_id + agent_profile + contribution_kind + input pin 으로 합성>
summary: <short human-readable summary>
artifacts:
  - kind: <markdown|patch|task_spec|cp_message|context_summary>
    name: <artifact name>
    body: |
      <artifact body>
verdict:
  result: <approve|request-changes|PASS|FAIL|STALE|NEED_CONTEXT|null>
  rationale: <reason>
failure:
  type: <invalid_output|tool_failure|need_context|none>
  detail: <detail>
runtime_metadata:        # Caller enrichment 영역 (AGC-OUTPUT-RUNTIME-ENRICH)
  <key>: <value>
```

legacy `agent_role` / `operation` 필드는 envelope 에서 폐기되었다. `(phase, agent_profile, contribution_kind, phase_run_id)` 셋이 단일 식별자다.

Caller may serialize this envelope as JSON, YAML, markdown front matter, or another structured representation. Markdown headings below are artifact body conventions only and must not be used as the primary validation contract.

`(phase, contribution_kind)` × `output_kind` × `verdict.result` 의 authoritative matrix 는 [`AGC-CONTRIBUTION-OUTPUTS`](../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS) 가 정의한다. 아래 phase별 절은 markdown artifact 예시이며 enum 검증 권위가 아니다.

## Discovery Spec Artifact

Phase: `Discovery` (lead_draft, atlas)  
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

Phase coordinator creates the Spec CP and moves it to `CP_AWAITING_QUORUM` upon Discovery quorum_reached.

## Specification Scenario Artifact

Phase: `Specification` (lead_draft, atlas)  
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

AC-ID is required. Traceability is defined by [`KAC-TRACEABILITY`](../contracts/knowledge-contract.md#KAC-TRACEABILITY).

## Planning Task Artifact

Phase: `Planning` (lead_draft, atlas)  
Artifact kind: `task_spec`  
Output kind: `task_plan`

```markdown
## Task

<implementation task>

## Acceptance Criteria Mapping

- [AC-001]
- [AC-002]

## Implementation Guidance

- <guidance>

## Impact Scope

- <file/module>

## Dependencies

- <task slug or object id>
```

Phase coordinator creates Task objects and dependency edges upon Planning quorum_reached. Planning lead contribution does not create Issues directly.

## Implementation Patch Artifact

Phase: `Implementation` (lead_draft / rework_patch, forge)  
Artifact kind: `patch` or `cp_message`  
Output kind: `patch`

```markdown
## Change Summary

<what changed>

## Verification Notes

<commands suggested or observations from local reasoning>

## Risk

<known risks>
```

The forge contribution may modify the assigned isolated workspace. Caller collects the diff and creates the Code CP. Implementation phase 의 quorum 은 lead_only 이므로 lead contribution 의 submit 이 곧 phase 종착을 트리거한다.

## CodeReview Verdict Artifact

Phase: `CodeReview` (lead_draft = sentinel review_verdict)  
Artifact kind: `markdown`  
Output kind: `verdict`

Approve:

```markdown
## Review Verdict

Result: approve

## Evidence

- <verification log or diff evidence>

## Rationale

<why this satisfies the task>
```

Request changes:

```markdown
## Review Verdict

Result: request-changes

## Failed Criteria

- [AC-001] <reason>

## Required Rework

- <specific rework instruction>
```

CodeReview contribution 은 직접 merge 하지 않는다. phase coordinator 가 quorum_reached 시점에 verdict 를 Code CP 와 Task state 에 적용한다.

## Integration Artifact

Phase: `Integration` (lead_draft, sentinel)  
Artifact kind: `patch` or `markdown`  
Output kind: `milestone_package`

```markdown
## Integration Verdict

Result: PASS|FAIL|STALE

## Integration Change

<summary or no-op rationale. no-op 은 PASS + Integration CP message 부재로 표현>

## Verification Evidence

<interpretation of Caller-provided verification run>
```

phase coordinator 는 lead 가 CP message 를 산출했으면 Integration CP 를 생성한다. no-op output 은 transition ledger 에 기록만 된다.

## Validation Artifact

Phase: `Validation` (lead_draft = sentinel + summary contribution = atlas)  
Artifact kind: `markdown`  
Output kind: `milestone_package`

```markdown
## Validation Verdict

Result: PASS|FAIL

## Acceptance Criteria Results

- [AC-001] PASS - <evidence>
- [AC-002] FAIL - <evidence>

## Responsible Tasks

- <task id>

## Context Summary

<summary for next milestone>
```

Validation contribution 은 테스트를 직접 실행하거나 default branch 에 merge 하거나 Issue 를 close 하거나 사람에게 알림을 보내지 않는다. Caller 가 dispatch pre-action 에서 deterministic verification 을 실행하고, phase coordinator 가 quorum_reached 시점에 verdict 를 적용한다.

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
<!-- llm-team:cp-state:<STATE> -->
<!-- llm-team:cp-kind:<spec|code|integration|milestone> -->

```json
{
  "lease_token": "<token>",
  "manifest_id": "<id>",
  "links": {"milestone": "<id>", "blockers": ["<id>"]}
}
```

</details>
```

규칙:

- machine block 은 항상 `<details>` 안. 사람의 가독성을 우선한다.
- 모든 marker(`<!-- llm-team:*-state:* -->`) 는 machine block *안에만* 위치한다. human narrative 영역에 marker 가 섞이면 [`#AGC-ISSUE-BODY`](../contracts/agent-and-context-contract.md#AGC-ISSUE-BODY) 위반.
- Agent 는 human narrative 만 산출한다. machine block 은 Caller 가 [`#AGC-OUTPUT-RUNTIME-ENRICH`](../contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH) 에 따라 합성한다.

### `<details>` 미지원 영역(milestone description 등)

GitHub milestone description 처럼 `<details>` 가 렌더되지 않거나 어색한 본문 영역에서는 다음 변형을 따른다.

- 기계 계층은 본문 *말미* 의 단일 영역에 모은다. `---` 같은 분리선으로 사람 계층과 시각적으로 분리한다.
- 영역 시작은 `<!-- llm-team:metadata-begin -->`, 종료는 `<!-- llm-team:metadata-end -->` 로 감싼다. Caller 는 이 두 토큰 사이만 파싱한다.
- 두 토큰 사이가 아닌 위치에 marker 가 있으면 invalid 본문으로 간주한다(`#AGC-ISSUE-BODY` 의 "두 계층의 토큰이 섞이면 invalid").
- 사람 계층은 분리선 *위* 에만 위치한다. Caller 가 본문 갱신 시 분리선 아래 영역만 갱신하고 위 영역은 보존한다(사람 수동 편집 보존).

## Invalid Legacy Patterns

The following legacy patterns are no longer authoritative:

- first-line-only `RESULT: PASS|FAIL` without output envelope
- grep/awk-only parsing as the primary contract
- Agent-authored labels or state markers
- Agent-created PR reviews that also imply merge authority

Implementations may continue to render markdown bodies for human readability, but Caller must validate the structured output envelope first.
