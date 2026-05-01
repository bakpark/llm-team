# Agent Output Format Mapping

본 문서는 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)의 output envelope를 GitHub PR body, Issue body, comment, markdown artifact로 표현하는 구현 매핑이다.

이 문서는 contract가 아니다. Agent output의 authoritative schema는 [`agent-and-context-contract.md`](../contracts/agent-and-context-contract.md)이며, 이 문서는 사람이 읽기 쉬운 markdown artifact 구조만 제안한다.

## Common Envelope

모든 Agent output은 envelope와 artifact를 분리한다. 아래 YAML은 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)을 설명하기 위한 **non-authoritative example**이다. 필드의 필수 여부와 의미는 contract 문서가 정의한다.

```yaml
output_kind: <spec_proposal|task_plan|patch|verdict|milestone_package|failure>
agent_role: <PO|PM|Planner|Coder|Reviewer|Integrator|QA>
operation: <Compose-PO|Compose-PM|Decompose|Implement|Review|Refactor|Validate>
target_id: <object id>
manifest_id: <context manifest id>
input_revision_pins:
  - object_id: <id>
    revision_pin: <pin>
idempotency_key: <key>
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

## Invalid Legacy Patterns

The following legacy patterns are no longer authoritative:

- first-line-only `RESULT: PASS|FAIL` without output envelope
- grep/awk-only parsing as the primary contract
- Agent-authored labels or state markers
- Agent-created PR reviews that also imply merge authority

Implementations may continue to render markdown bodies for human readability, but Caller must validate the structured output envelope first.
