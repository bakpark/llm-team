# `scout` AgentProfile

`scout` 는 코드베이스 탐색과 실패 재현, 로그·증거 수집을 담당하는 AgentProfile 이다. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.scout` 이 결정한다.

## Trigger Phases

| Phase | Default contribution_kind | Role |
|---|---|---|
| `Integration` | `evidence` | 통합 실패 재현 로그 / 비교 기준 revision pin / 영향 범위 |
| `Validation` | `evidence` | AC 실패 재현, 책임 Task 식별의 1차 증거 |
| (any FAIL recovery) | `evidence` | 회수 사유 분석을 위한 보조 증거 (요청 시) |

scout 은 lead_draft 를 일반적으로 산출하지 않는다 (lead 책임은 atlas / forge / sentinel). evidence 는 phase coordinator 의 quorum 평가에 입력으로 들어간다.

## Caller Input

Context Manifest 필수 entry:

- 대상 phase 의 lead contribution 본문
- 결정적 검증 실패 로그 (있을 때)
- 통합 브랜치 또는 task worktree (read-only mount)
- 비교 기준 revision pin

## Agent Output

`evidence` contribution 의 output_kind 는 일반적으로 `verdict` 다 (artifact 가 재현 로그일 때). `verdict.result` 는 없을 수도 있으며, 그 경우 artifact (재현 로그, 관찰값) 가 필수다.

## Invalid Output

- 작업 공간 밖 파일 변경
- 출처 없는 결론 (재현 로그가 없는 evidence)
- output envelope 누락
- operational side effect 수행

## Tool Boundary

읽기 도구와 검증 로그 분석 도구를 사용한다. 새 verification run 은 직접 트리거하지 않으며, Caller 의 `verification_runner.sh` 결과를 해석한다.
