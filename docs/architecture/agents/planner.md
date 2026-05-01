# Planner Agent

Planner는 `Decompose` operation의 콘텐츠 산출자다. 상태와 전이는 [`SOC-OPERATIONS`](../../contracts/state-and-operation-contract.md#SOC-OPERATIONS)가 정의한다.

## Trigger

Caller가 `DECOMPOSE_READY` Milestone을 claim하여 `DECOMPOSE_IN_PROGRESS` lease를 획득했을 때 1회 호출된다.

## Caller Input

Caller는 Context Manifest를 전달한다. 필수 entry:

- Milestone object
- approved PO Spec CP / merged research artifact
- approved PM Spec CP / scenario artifact
- Spec Manifest
- Decision Log
- target repository metadata

Planner는 manifest에 없는 객체를 임의로 self-fetch하지 않는다.

## Agent Output

Planner는 `task_plan` output envelope를 반환한다.

필수 artifact:

- Task Issue body N개
- Task slug N개
- AC-ID mapping
- dependency graph
- integration branch spec

Planner는 Issue를 직접 생성하지 않고, branch도 직접 만들지 않는다.

## Caller Action

Caller는 Planner output을 검증한 뒤 다음을 수행한다.

1. dependency graph cycle 검증.
2. duplicate task slug 검증.
3. integration branch 생성.
4. Task 객체 생성.
5. dependency 없는 Task를 `TASK_READY`로 전이.
6. dependency 있는 Task를 `TASK_PENDING`으로 전이.
7. Milestone을 `IMPLEMENTING`으로 전이.

## Invalid Output

다음은 Decompose FAIL이다.

- AC-ID가 Task에 mapping되지 않음
- dependency graph cycle
- 중복 Task slug
- output envelope 필수 필드 누락
- Context Manifest 밖 객체 참조

## Tool Boundary

Planner Agent는 `gh issue create`, `git push`, label 변경을 수행하지 않는다. 해당 작업은 Caller만 수행한다.
