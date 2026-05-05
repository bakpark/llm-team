# `forge` AgentProfile

`forge` 는 구현 가능성 검토와 빠른 patch 작성을 담당하는 AgentProfile 이다. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.forge` 가 결정한다.

## Trigger Phases

| Phase | Default contribution_kind | Role |
|---|---|---|
| `Implementation` | `lead_draft` | Task 1개에 대한 코드 patch + Code CP message |
| `Implementation` | `rework_patch` | 직전 review_verdict 의 request_changes 사유를 해소한 patch |
| `Specification` | `review_verdict` | 시나리오 / AC 의 구현 가능성 검토 |
| `Planning` | `review_verdict` | Task 분해의 구현 가능성 검토 |
| `CodeReview` | `rework_patch` (트리거) | reviewer 의 request_changes 후 새 Implementation PhaseRun 으로 위임 |

## Caller Input

Context Manifest 필수 entry:

- Task object (Implementation 의 경우)
- related AC-ID mapping
- scenario artifact
- integration branch base revision
- 직전 review_verdict / Validation feedback (rework_patch 의 경우)
- isolated workspace path (lead_draft / rework_patch 한정)

## Agent Output

phase × contribution_kind 별 output_kind 는 [`#AGC-CONTRIBUTION-OUTPUTS`](../../../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS) 의 매트릭스를 따른다.

`Implementation` lead_draft / rework_patch 의 경우:

- workspace diff
- Code CP message
- 변경 요약
- 위험 및 검증 제안

## Caller Action

`Implementation` phase 의 lead_draft 또는 rework_patch contribution 이 submit 되면, contribution worker cycle 은 다음을 수행한다.

1. workspace diff 수집
2. Code CP 생성, `CP_READY_FOR_REVIEW` 로 전이
3. Task 를 `TASK_REVIEW_READY` 로 전이
4. workspace 정리 또는 보존 정책 적용

(Implementation phase 의 quorum 은 lead_only 이므로 phase coordinator 의 별도 quorum 평가 단계는 필요 없다.)

## Invalid Output

- 워크스페이스 밖 파일 변경
- 빈 diff
- output envelope 누락 또는 enum 밖 값
- PR 생성 / label 변경 등 operational side effect 수행
- 비밀 출력

## Tool Boundary

코드 편집 도구를 사용할 수 있다. `git push`, `gh pr create`, `gh issue edit` 같은 operational write 는 Caller 책임이다.
