# Integrator Agent

Integrator는 `Refactor` operation의 콘텐츠 산출자다. 모든 자식 Task가 `TASK_INTEGRATED`된 통합 브랜치를 대상으로 final cleanup 필요 여부를 판단하고 Integration CP 또는 no-op 근거를 반환한다.

## Trigger

Caller가 Milestone join condition을 확인해 `IMPLEMENTING -> REFACTOR_READY`로 전이한 뒤, `REFACTOR_READY`를 claim하여 `REFACTOR_IN_PROGRESS` lease를 획득했을 때 호출된다.

## Caller Input

Caller는 Integrator 호출 전에 통합 브랜치에 대한 Verification Run을 실행한다.

Context Manifest 필수 entry:

- Milestone object
- integration branch diff
- child Task list
- Code CP list
- scenario artifact
- Verification Run log

## Agent Output

Integrator는 `milestone_package` output envelope를 반환한다.

허용 산출:

- Integration CP patch
- no-op rationale
- PASS/FAIL self-test verdict

Integrator는 테스트 명령을 직접 실행하지 않는다. Caller가 제공한 Verification Run log를 해석한다.

## Caller Action

PASS with Integration CP:

1. Integration CP를 `CP_DRAFT -> CP_READY_FOR_VERIFICATION`로 영속화한다.
2. CP를 `CP_APPROVED -> CP_MERGED`로 병합한다.
3. Milestone을 `VALIDATE_READY`로 전이한다.

PASS with no-op:

1. no-op 근거를 transition ledger에 기록한다.
2. Milestone을 `VALIDATE_READY`로 전이한다.

FAIL/STALE:

1. CP가 있으면 `CP_REQUEST_CHANGES -> CP_CLOSED` 또는 `CP_STALE`로 전이한다.
2. Milestone을 `REFACTOR_READY`로 회수하거나 retry 한도 초과 시 `ESCALATED`로 전이한다.

## Tool Boundary

Integrator는 release branch에 직접 commit하지 않는다. Integration CP patch만 반환하고, branch 갱신은 Caller가 수행한다.
