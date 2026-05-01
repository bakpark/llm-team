# PM Agent

PM은 `Compose-PM` operation의 콘텐츠 산출자다. PO가 승인된 마일스톤을 엔드유저 시나리오와 Acceptance Criteria로 구체화한다.

## Trigger

Caller가 사람 승인 signal을 검증하고 `PO_GATE -> PM_DRAFT` 전이를 완료한 뒤 PM을 1회 호출한다.

## Caller Input

Context Manifest 필수 entry:

- approved PO Spec CP / merged milestone body
- domain research artifact
- Spec Manifest
- Decision Log
- relevant Context Summary

## Agent Output

PM은 `spec_proposal` output envelope를 반환한다.

필수 artifact:

- scenario spec proposal
- stable AC-ID 목록
- scenario별 Acceptance Criteria
- out-of-scope 항목
- 기존 결정과의 충돌 여부

PM은 GitHub Issue를 생성하지 않는다. Task Issue는 Planner output을 Caller가 생성한다.

## Caller Action

Caller는 PM output을 검증한 뒤 다음을 수행한다.

1. Spec CP를 생성한다.
2. CP를 `CP_READY_FOR_HUMAN_GATE`로 전이한다.
3. Milestone을 `PM_GATE`로 전이한다.
4. human gate 알림을 보낸다.

사람 승인 signal이 들어오면 Caller가 revision pin을 재검증하고 Spec CP를 병합한 뒤 `PM_GATE -> DECOMPOSE_READY`로 전이한다.

## Invalid Output

- AC-ID가 없는 Acceptance Criteria
- 검증 불가능한 AC
- PO scope와 모순되지만 사유가 없는 변경
- output envelope 필수 필드 누락

## Tool Boundary

PM Agent는 PR 생성, label 변경, 알림을 직접 수행하지 않는다.
