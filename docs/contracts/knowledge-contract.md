# Knowledge Contract

본 문서는 누적 스펙, manifest, decision log, context summary, AC traceability를 정의한다.

<a id="KAC-SCOPE"></a>
## KAC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- 누적 스펙의 수명주기
- Manifest와 Decision Log
- Context Summary
- Acceptance Criteria traceability
- 충돌 우선순위와 불변성

Agent 호출의 Context Manifest는 `docs/contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST`가 정의한다.

<a id="KAC-ACCUMULATION"></a>
## KAC-ACCUMULATION: Accumulated Specs

스펙은 누적 산출물이다. PO/PM 산출물, 중요한 결정, 거부된 대안, Context Summary는 마일스톤 종료 후에도 보존된다.

누적 스펙은 다음 마일스톤의 1급 입력이다. PO/PM은 새 작업이 기존 결정과 모순되지 않는지 확인할 책임을 갖는다.

병합된 스펙은 후속 마일스톤이 명시적으로 갱신하지 않는 한 변경하지 않는다. 변경 시 사유를 Decision Log에 기록한다.

<a id="KAC-MANIFEST"></a>
## KAC-MANIFEST: Spec Manifest

Manifest는 누적 스펙의 인덱스다.

항목 필수 필드:

| 필드 | 의미 |
|---|---|
| `milestone_id` | 관련 마일스톤 |
| `artifact_kind` | research, scenario, decision, context_summary 등 |
| `artifact_id` | 스펙 산출물 식별자 |
| `revision_pin` | 현재 revision |
| `summary` | 1-2문장 요약 |
| `updated_at` | 갱신 시각 |

PO/PM 호출에서 Manifest는 우선순위가 가장 높은 읽기 대상이다.

<a id="KAC-DECISION-LOG"></a>
## KAC-DECISION-LOG: Decision Log

Decision Log는 중요한 트레이드오프와 거부된 대안을 기록한다.

항목 필수 필드:

- `decision_id`
- `decision`
- `alternatives`
- `rationale`
- `decided_at`
- `affected_milestones`
- `supersedes`, 해당 시

후속 마일스톤이 이전 결정과 충돌하면 최신 결정이 우선한다. 단, 이전 결정의 거부 사유와 새 결정의 사유를 함께 기록한다.

<a id="KAC-CONTEXT-SUMMARY"></a>
## KAC-CONTEXT-SUMMARY: Context Summary

Context Summary는 다음 마일스톤이 알아야 할 핵심을 짧게 요약한 산출물이다.

Validate PASS 시 QA가 Context Summary를 산출하고, Caller가 manifest에 첨부한다. QA는 merged spec과 Decision Log를 요약할 수 있지만 새 제품 결정을 만들지 않는다.

필수 내용:

- 완료된 마일스톤의 사용자 가치
- 변경된 주요 동작
- 유지해야 할 결정
- 후속 마일스톤에서 주의할 리스크
- 관련 AC-ID와 Task 요약

<a id="KAC-TRACEABILITY"></a>
## KAC-TRACEABILITY: Acceptance Criteria Traceability

PM은 수용 기준마다 안정적인 AC-ID를 부여한다.

Planner는 각 Task가 어떤 AC-ID를 구현하는지 mapping한다. QA는 Validate 결과를 AC-ID별로 보고한다.

최소 mapping:

```text
AC-ID -> Task ID(s) -> Code CP ID(s) -> Verification Run ID(s) -> QA verdict
```

AC-ID가 구현 Task에 연결되지 않으면 Decompose FAIL이다. QA가 AC-ID별 PASS/FAIL을 보고하지 않으면 Validate FAIL이다.

<a id="KAC-CONFLICTS"></a>
## KAC-CONFLICTS: Conflict Policy

충돌 우선순위:

1. 현재 사람 승인 시그널
2. 최신 병합 스펙
3. 최신 Decision Log
4. 이전 마일스톤 산출물

단, 최신 결정이 이전 결정을 뒤집는 경우 `supersedes` 관계와 사유를 기록해야 한다.

<a id="KAC-EQUIVALENCE"></a>
## KAC-EQUIVALENCE: Code and Spec Equivalence

스펙 문서는 코드와 동등한 1급 산출물이다. 다만 게이트 매핑은 비대칭이다.

- Spec CP는 사람 검토 gate를 거친다.
- Code CP는 자동 검증 gate를 거친다.

두 산출물 모두 revision pin, idempotency key, ledger 기록의 대상이다.
