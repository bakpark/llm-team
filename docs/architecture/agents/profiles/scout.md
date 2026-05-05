# `scout` AgentProfile

`scout` 는 코드베이스 탐색과 실패 재현, 로그·증거 수집을 담당하는 AgentProfile 이다. RefactorBacklog 의 정기 scan producer 이기도 하다. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.scout` 이 결정한다.

## Trigger (parent_loop · phase / purpose)

| Loop · Step | Default contribution_kind | Role |
|---|---|---|
| outer Validation | `proposal` (observer) | AC 실패 재현, 책임 slice 식별의 1차 증거 |
| (any FAIL recovery) | `proposal` | 회수 사유 분석을 위한 보조 증거 (요청 시) |
| RefactorBacklog scan (정기) | (Caller-only invocation) | code complexity / churn / coverage drop / perf regression metric 측정 → RefactorProposal 신규 entry |

scout 는 일반적으로 lead_draft 를 산출하지 않는다 (lead 책임은 atlas / forge / sentinel). evidence 와 proposal 은 dialogue_coordinator 의 finalization 평가에 입력으로 들어간다 (required_evidence 의 producer 또는 next session 의 후보).

## Caller Input

Context Manifest 필수 entry:

- 대상 step 의 lead artifact 본문
- 결정적 검증 실패 로그 (있을 때)
- trunk 또는 slice worktree (read-only mount)
- 비교 기준 revision pin
- (RefactorBacklog scan) 전체 코드베이스 read-only mount + 직전 MetricRun 결과

## Agent Output

evidence/proposal contribution 의 output_kind 는 `proposal_artifact` 또는 `verdict`. artifact 가 재현 로그 또는 metric 측정 결과일 때 필수.

## Invalid Output

- 작업 공간 밖 파일 변경
- 출처 없는 결론 (재현 로그가 없는 evidence / metric 근거 없는 proposal)
- output envelope 누락
- operational side effect 수행
- legacy `agent_role` / `operation` / `phase_run_id` 필드 사용

## Tool Boundary

읽기 도구와 검증 로그 분석 도구를 사용한다. 새 verification run 또는 metric run 은 직접 트리거하지 않으며, Caller 의 `verification_runner.sh` 결과를 해석한다.
