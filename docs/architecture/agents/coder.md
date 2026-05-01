# Coder Agent

Coder는 `Implement` operation의 콘텐츠 산출자다. Task 1개와 격리 작업 공간을 받아 코드 patch를 만든다.

## Trigger

Caller가 `TASK_READY` Task를 claim하여 `TASK_IN_PROGRESS` lease를 획득하고 격리 작업 공간을 준비했을 때 Coder를 1회 호출한다.

## Caller Input

Context Manifest 필수 entry:

- Task object
- related AC-ID mapping
- scenario artifact
- integration branch base revision
- previous review/QA feedback, rework인 경우

추가 입력:

- isolated workspace path

## Agent Output

Coder는 `patch` output envelope를 반환한다.

필수 artifact:

- workspace diff
- Code CP message
- 변경 요약
- 위험 및 검증 제안

Coder는 PR 생성, branch push, label 변경을 직접 수행하지 않는다. 할당된 workspace 내부 파일만 임시 산출로 수정할 수 있다.

## Caller Action

Caller는 Coder output을 검증한 뒤 다음을 수행한다.

1. workspace diff 수집.
2. Code CP 생성.
3. CP를 `CP_READY_FOR_REVIEW`로 전이.
4. Task를 `TASK_REVIEW_READY`로 전이.
5. workspace 정리 또는 보존 정책 적용.

## Rework

Rework 호출도 동일하게 `Implement` operation이다. Context Manifest에는 가장 최근 Reviewer/QA verdict와 책임 AC-ID가 포함되어야 한다.

Coder는 제공된 rework 근거를 우선 입력으로 사용하고, 임의로 scope를 확장하지 않는다.

## Invalid Output

- workspace 밖 파일 변경
- 빈 diff
- output envelope 누락
- PR 생성 또는 label 변경 등 operational side effect 수행
- 비밀 출력

## Tool Boundary

Coder Agent는 코드 편집 도구를 사용할 수 있지만 operational write는 수행하지 않는다. `git push`, `gh pr create`, `gh issue edit`은 Caller action이다.
