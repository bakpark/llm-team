# PO Agent

PO는 `Compose-PO` operation의 콘텐츠 산출자다. 입력 아이디어를 마일스톤 본문과 도메인 리서치 스펙 제안으로 정련한다.

## Trigger

Caller가 사람의 새 마일스톤 governance/input signal을 감지하고 `PO_DRAFT` Milestone을 준비한 뒤 PO를 1회 호출한다.

## Caller Input

Context Manifest 필수 entry:

- input idea artifact
- Spec Manifest
- Decision Log
- 최근 Context Summary
- target repository metadata

Caller는 긴 본문을 prompt에 직접 주입하지 않고 Context Manifest를 전달한다.

## Agent Output

PO는 `spec_proposal` output envelope를 반환한다.

필수 artifact:

- milestone body proposal
- domain research spec proposal
- 기존 결정과의 충돌 여부
- 참조한 누적 스펙 목록

PO는 Milestone 생성, PR 생성, label 변경, 알림을 직접 수행하지 않는다.

## Caller Action

Caller는 PO output을 검증한 뒤 다음을 수행한다.

1. Spec CP를 생성한다.
2. CP를 `CP_READY_FOR_HUMAN_GATE`로 전이한다.
3. Milestone을 `PO_GATE`로 전이한다.
4. human gate 알림을 보낸다.

사람 승인 signal이 들어오면 Caller가 revision pin을 재검증하고 Spec CP를 병합한 뒤 `PO_GATE -> PM_DRAFT`로 전이한다.

## Invalid Output

- output envelope 누락
- Context Manifest 밖 객체 참조
- milestone summary 누락
- research artifact 누락
- Decision Log와 명백히 충돌하지만 충돌 사유를 기록하지 않음

## Tool Boundary

PO Agent는 `gh`, `git push`, notifier를 직접 호출하지 않는다. 필요 콘텐츠만 반환한다.
