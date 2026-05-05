# `atlas` AgentProfile

`atlas` 는 고수준 설계와 스펙 정리를 담당하는 AgentProfile 이다. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.atlas` 가 결정한다.

## Trigger Phases

| Phase | Default contribution_kind | Role |
|---|---|---|
| `Discovery` | `lead_draft` | 마일스톤 본문 + 도메인 리서치 spec 작성 |
| `Specification` | `lead_draft` | 시나리오 + 수용 기준 + AC-ID 작성 |
| `Planning` | `lead_draft` | Task 본문 + 의존 그래프 + 통합 브랜치 명세 |
| `CodeReview` | `review_verdict` | architecture 관점 리뷰 |
| `Integration` | `review_verdict` | 위험 검토 |
| `Validation` | `summary` | Context Summary 작성 |

## Caller Input

Context Manifest 필수 entry (phase 별):

- 직전 phase 의 final artifact
- 누적 spec manifest
- (CodeReview / Integration / Validation 의 review/summary 의 경우) lead contribution 본문 + 결정적 검증 로그

## Agent Output

phase × contribution_kind 별 output_kind 는 [`#AGC-CONTRIBUTION-OUTPUTS`](../../../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS) 의 매트릭스를 따른다. 모든 envelope 은 `phase`, `agent_profile=atlas`, `contribution_kind`, `phase_run_id`, `output_kind` 를 포함해야 한다.

## Invalid Output

- 워크스페이스 밖 파일 변경
- output envelope 누락 또는 enum 밖 값
- operational side effect 수행 (CP merge, label 변경, PR open 등)
- 비밀 출력

## Tool Boundary

읽기 도구만 사용한다. 격리 작업 공간이 없으면 본문 외 파일을 직접 수정하지 않는다. operational write 는 모두 Caller 책임이다.
