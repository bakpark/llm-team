# `forge` AgentProfile

`forge` 는 구현 가능성 검토와 빠른 patch 작성을 담당하는 AgentProfile 이다. inner loop (TDD build) 의 lead. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.forge` 가 결정한다.

## Trigger (parent_loop · phase / purpose)

| Loop · Step | Default contribution_kind | Role |
|---|---|---|
| inner tdd_build | `lead_draft` | TDD red/green/refactor turn — workspace patch + target_tests[] + tdd_phase. inner lead 는 forge 단독 (solo session) |
| inner tdd_build | `lead_draft` (with `parent_review_verdict_id`) | middle review request_changes 후 새 inner build session 의 후속 turn (rework 의 새 instance) |
| middle review | `review_verdict` | rework 가능성 검토 reviewer |
| outer Specification | `review_verdict` | 시나리오 / AC 의 구현 가능성 검토 |
| outer Planning | `review_verdict` | slice 분해의 구현 가능성 검토 |
| (any) | `proposal` | acceptance_test_amendment_proposal, discovered_dependency, refactor_proposal |

## Caller Input

Context Manifest 필수 entry (inner tdd_build):

- slice object (acceptance_tests[], declared_scope, dod_revision_pin)
- related AC-ID mapping
- scenario artifact + acceptance test 코드 (pending marker 제거된 상태로 활성화)
- workspace base revision (slice-local branch HEAD)
- 직전 turn 의 verification_result (turn_index ≥ 2)
- prior_turn_log_snapshot
- isolated workspace path (inner lead 한정)

## Agent Output

inner tdd_build `lead_draft` 의 경우:

- workspace patch (slice-local branch 위)
- target_tests[] (이 turn 이 green 으로 만들 acceptance / unit test)
- tdd_phase: `red_green` 또는 `refactor`
- 변경 요약
- 위험 / 검증 제안

`refactor_patch` enum 은 폐기되어 `lead_draft` + `parent_review_verdict_id` 로 흡수.

## Caller Action (inner tdd_build turn 직후)

1. envelope 검증 + scope enforcement (acceptance_tests / declared_scope / lockfile 외 변경 금지)
2. patch 적용 + slice-local branch commit (workspace_commit SHA 기록)
3. verification 실행 (acceptance + deterministic) → SessionTurn.verification_result 영속화
4. dialogue_coordinator 가 다음 turn 의 finalization 평가:
   - 모든 acceptance_test green + deterministic pass → SESSION_OPEN → CONVERGED (final_verdict=tests_green) → SliceMerge SM_DRAFT → SM_READY_FOR_REVIEW + slice SLICE_BUILDING → SLICE_REVIEWING
   - 진행 부족 / regression 한도 → ABANDONED (no_progress / regression / scope_violation) → slice SLICE_BLOCKED

## TDD Orthodoxy (option `target.tdd_strict`)

- `tdd_phase=red_green` turn — 직전 verification 에 failed[] 비어 있지 않아야. turn 후 newly_green ≥ 1 기대
- `tdd_phase=refactor` turn — 직전 모두 green. turn 후 regression 0 강제
- 위반 → 그 turn invalid, retry 한도는 `loop_policies.inner.tdd_build.max_attempts_per_turn`

## Invalid Output

- 워크스페이스 밖 파일 변경
- acceptance_tests[] 변경 (slice contract — escape path 는 `acceptance_test_amendment_proposal` 만)
- declared_scope 밖 파일 변경
- dependency lockfile 변경
- 빈 diff
- output envelope 누락 또는 enum 밖 값
- PR 생성 / label 변경 등 operational side effect 수행
- 비밀 출력

## Tool Boundary

코드 편집 도구를 사용할 수 있다. `git push`, `gh pr create`, `gh issue edit` 같은 operational write 는 Caller 책임이다. trunk merge 는 Caller 의 slice_merge_finalize 가 수행.
