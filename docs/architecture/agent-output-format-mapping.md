# Agent Output Format Mapping

본 문서는 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)의 output envelope를 GitHub PR body, Issue body, comment, markdown artifact로 표현하는 구현 매핑이다.

이 문서는 contract가 아니다. Agent output의 authoritative schema는 [`agent-and-context-contract.md`](../contracts/agent-and-context-contract.md)이며, 이 문서는 사람이 읽기 쉬운 markdown artifact 구조만 제안한다.

## Common Envelope

모든 Agent output은 envelope와 artifact를 분리한다. 아래 YAML은 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)을 설명하기 위한 **non-authoritative example**이다. 필드의 필수 여부와 의미는 contract 문서가 정의한다.

```yaml
output_kind: <spec_proposal|task_plan|patch|verdict|milestone_package|failure>
agent_role: <PO|PM|Planner|Coder|Reviewer|Integrator|QA>
operation: <Compose-PO|Compose-PM|Decompose|Implement|Review|Refactor|Validate>
object_id: <주 처리 대상 객체 id; TCC-IDENTITY.target_id 와 다른 개념>
manifest_id: <context manifest id>
input_revision_pins:
  - object_id: <id>
    revision_pin: <pin>
idempotency_key: <Caller enrichment 단계에서 SOC-OPERATIONS 식으로 합성>
summary: <short human-readable summary>
artifacts:
  - kind: <markdown|patch|task_spec|cp_message|context_summary>
    name: <artifact name>
    body: |
      <artifact body>
verdict:
  result: <approve|request-changes|PASS|FAIL|NEED_CONTEXT|null>
  rationale: <reason>
failure:
  type: <invalid_output|tool_failure|need_context|none>
  detail: <detail>
runtime_metadata:        # Caller enrichment 영역 (AGC-OUTPUT-RUNTIME-ENRICH)
  <key>: <value>
```

Caller may serialize this envelope as JSON, YAML, markdown front matter, or another structured representation. Markdown headings below are artifact body conventions only and must not be used as the primary validation contract.

## PO Spec Artifact

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

Caller creates the Spec CP and moves it to `CP_READY_FOR_HUMAN_GATE`.

## PM Scenario Artifact

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

## Planner Task Artifact

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

Caller creates Task objects and dependency edges. Planner does not create Issues directly.

## Coder Patch Artifact

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

Coder may modify the assigned isolated workspace. Caller collects the diff and creates the Code CP.

## Reviewer Verdict Artifact

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

Reviewer does not merge. Caller applies the verdict to the Code CP and Task state.

## Integrator Artifact

Artifact kind: `patch` or `markdown`  
Output kind: `milestone_package`

```markdown
## Refactor Verdict

Result: PASS|FAIL

## Integration Change

<summary or no-op rationale>

## Verification Evidence

<interpretation of Caller-provided verification run>
```

Caller creates an Integration CP when an integration patch exists. No-op output is recorded in the transition ledger.

## QA Artifact

Artifact kind: `markdown`  
Output kind: `milestone_package`

```markdown
## QA Verdict

Result: PASS|FAIL

## Acceptance Criteria Results

- [AC-001] PASS - <evidence>
- [AC-002] FAIL - <evidence>

## Responsible Tasks

- <task id>

## Context Summary

<summary for next milestone>
```

QA does not run tests, merge to default branch, close Issues, or notify humans. Caller executes deterministic verification before QA and applies the QA verdict afterward.

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
