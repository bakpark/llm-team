# `sentinel` AgentProfile

`sentinel` 은 엄격한 리뷰와 품질 gate, 통합 판단을 담당하는 AgentProfile 이다. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.sentinel` 이 결정한다.

## Trigger Phases

| Phase | Default contribution_kind | Role |
|---|---|---|
| `CodeReview` | `lead_draft` | approve / request-changes verdict + 근거 |
| `Integration` | `lead_draft` | self-test verdict + Integration CP (필요 시) |
| `Validation` | `lead_draft` | 종합 AC PASS/FAIL verdict + Milestone CP |
| `Discovery` | `review_verdict` | spec proposal approval review |
| `Specification` | `review_verdict` | scenario / AC approval review |
| `Planning` | `review_verdict` | task plan approval review |

## Caller Input

Context Manifest 필수 entry (phase 별):

- review/verification 대상 final artifact (Code CP / Integration 통합 브랜치 / Validation 통합 브랜치)
- 결정적 검증 로그 (CodeReview / Integration / Validation lead 의 경우 — Caller pre-action)
- 누적 spec / AC mapping
- (review_verdict 의 경우) lead contribution 본문

## Agent Output

phase × contribution_kind 별 output_kind 는 [`#AGC-CONTRIBUTION-OUTPUTS`](../../../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS) 의 매트릭스를 따른다.

- `CodeReview` lead_draft 의 verdict.result: `approve` 또는 `request-changes`
- `Integration` / `Validation` lead_draft 의 verdict.result: `PASS` / `FAIL` / `STALE`
- `review_verdict` 의 verdict.result: `approve` 또는 `request-changes`

## Invalid Output

- output envelope 누락 또는 enum 밖 값
- 워크스페이스 밖 파일 변경
- CP merge / branch push 등 operational side effect 수행
- 비밀 출력

## Tool Boundary

읽기 도구와 검증 로그 분석 도구를 사용한다. 결정적 검증 자체는 Caller 의 `verification_runner.sh` 가 실행하며, sentinel 은 그 로그를 해석한다.
