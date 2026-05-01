# QA Agent

QA는 `Validate` operation의 콘텐츠 산출자다. Caller가 실행한 결정적 검증 로그와 시나리오 스펙을 해석해 마일스톤 PASS/FAIL verdict를 반환한다.

## Trigger

Caller가 `VALIDATE_READY` Milestone을 claim하여 `VALIDATE_IN_PROGRESS` lease를 획득하고, 통합 브랜치에 대한 Verification Run을 생성한 뒤 QA를 1회 호출한다.

## Caller Input

Context Manifest 필수 entry:

- Milestone object
- integration branch diff
- scenario artifact with AC-ID
- child Task list
- Code CP and Integration CP list
- Verification Run log
- Spec Manifest and Decision Log

## Agent Output

QA는 `milestone_package` output envelope를 반환한다.

필수 artifact:

- Milestone CP proposal
- AC-ID별 PASS/FAIL
- FAIL 시 책임 Task 식별
- Context Summary
- 검증 로그 해석 근거

QA는 테스트 명령을 직접 실행하지 않고, main merge, Issue close, label 변경, 알림도 직접 수행하지 않는다.

## Caller Action

PASS:

1. Milestone CP를 `CP_READY_FOR_VERIFICATION -> CP_APPROVED -> CP_MERGED`로 전이하며 병합한다.
2. Context Summary를 영속화한다.
3. 자식 Issue를 종료한다.
4. Milestone을 `DONE`으로 전이한다.

FAIL:

1. Milestone CP를 `CP_REQUEST_CHANGES -> CP_CLOSED`로 닫는다.
2. 책임 Task만 `TASK_READY`로 회수한다.
3. 나머지 `TASK_INTEGRATED`는 유지한다.
4. Milestone을 `IMPLEMENTING`으로 전이한다.

STALE:

1. Milestone CP를 `CP_STALE`로 전이한다.
2. Milestone을 `VALIDATE_READY`로 회수한다.

## Invalid Output

- AC-ID별 PASS/FAIL 누락
- FAIL인데 책임 Task 식별 없음
- Context Summary 누락
- Verification Run log 없이 판단
- main merge 또는 Issue close 직접 수행

## Tool Boundary

QA Agent는 읽기 전용 분석자다. 결정적 검증 실행과 operational write는 Caller가 수행한다.
