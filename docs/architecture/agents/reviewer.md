# Reviewer Agent

Reviewer는 `Review` operation의 콘텐츠 산출자다. Code CP와 Caller가 실행한 결정적 검증 로그를 해석해 approve 또는 request-changes verdict를 반환한다.

## Trigger

Caller가 `TASK_REVIEW_READY` Task를 claim하여 `TASK_REVIEW_IN_PROGRESS` lease를 획득하고, Code CP에 대한 Verification Run을 생성한 뒤 1회 호출한다.

## Caller Input

Context Manifest 필수 entry:

- Task object
- Code CP
- Code CP diff
- Verification Run log
- relevant AC-ID mapping
- scenario artifact

## Agent Output

Reviewer는 `verdict` output envelope를 반환한다.

허용 verdict:

- `approve`
- `request-changes`
- `FAIL`
- `NEED_CONTEXT`

필수 근거:

- AC-ID별 충족 여부
- 결정적 검증 로그 해석
- request-changes인 경우 구체 rework 지시

Reviewer는 PR review API 호출, merge, label 변경을 직접 수행하지 않는다.

## Caller Action

Approve:

1. Code CP를 병합한다.
2. CP를 `CP_APPROVED -> CP_MERGED`로 전이한다.
3. Task를 `TASK_INTEGRATED`로 전이한다.
4. dependency 해제 조건을 재평가한다.

Request changes:

1. CP를 `CP_REQUEST_CHANGES -> CP_CLOSED`로 전이한다.
2. Task를 `TASK_REJECTED -> TASK_READY`로 회수한다.
3. retry 한도를 초과하면 `ESCALATED`로 전이한다.

## Tool Boundary

Reviewer는 `gh pr review`, `gh pr merge`, `gh issue edit`을 실행하지 않는다. 필요한 review body는 artifact로 반환하고 Caller가 집행한다.
