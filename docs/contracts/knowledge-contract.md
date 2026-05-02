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

<a id="KAC-MANIFEST-FROM-KNOWLEDGE"></a>
## KAC-MANIFEST-FROM-KNOWLEDGE: Manifest Materialization

다음 마일스톤의 PO/PM 호출에서 누적 스펙은 `AGC-CONTEXT-MANIFEST`의 entry로 변환되어 입력된다. 본 절은 그 변환 규약을 정의한다.

### 변환 규칙

Caller는 `KAC-MANIFEST` 의 항목을 manifest entry로 변환할 때 다음을 따른다.

- `artifact_kind`는 manifest entry의 `object_kind`에 매핑한다. 변환 시 의미가 좁아지지 않도록 1:1 또는 그룹화로 매핑하며, 임의로 폐기하지 않는다.
- `artifact_id`는 entry의 `object_id`로, `revision_pin`은 entry의 `revision_pin`으로 그대로 보존한다. 새로 발급하지 않는다.
- `summary`는 entry의 `purpose` 또는 부속 메타로 사용한다. 본문은 self-fetch로 얻으며, 본 절이 본문을 manifest에 직접 임베드하지 않는다. self-fetch 의 `fetch_scope` 기본값은 `AGC-CONTEXT-MANIFEST` 의 역할별 default 표를 따른다(PO/PM 호출의 경우 `body`).
- 동일 마일스톤에서 결정 우선순위가 다른 항목이 충돌하면 `KAC-CONFLICTS`의 우선순위에 따라 *상위* 항목만 entry로 포함한다. 폐기된 항목은 `KAC-DECISION-LOG`의 `supersedes` 추적으로 참조 가능하다.

### 필수 entry

PO/PM 호출의 manifest는 최소 다음을 포함한다.

- 직전 마일스톤의 Context Summary
- 현재 사람 승인 시그널이 인용한 스펙(있을 때)
- 최신 병합된 PO/PM 산출물
- 최근 Decision Log 중 현재 마일스톤 scope과 관련된 항목

이 entry들은 `required: true`로 표시한다. 누락은 invalid manifest이며, Caller는 호출 전에 생성을 보장해야 한다.

### 변환의 책임

manifest 생성은 Caller 단독 책임이다. Agent는 manifest 외부 객체를 self-fetch하지 않는다(`AGC-CONTEXT-MANIFEST`). 따라서 누적 스펙이 다음 마일스톤에 *전달되지 않으면* 그 결정은 시스템적으로 보이지 않게 되며, 이는 헌법 Inv#10 위반이다.

<a id="KAC-DECISION-LOG"></a>
## KAC-DECISION-LOG: Decision Log

Decision Log는 중요한 트레이드오프와 거부된 대안을 기록한다.

항목 필수 필드:

- `decision_id`
- `decision`
- `alternatives`
- `rationale`
- `decided_at` — ISO-8601(UTC). 호출자가 결정 시각을 사전 주입하지 않은 경우, ledger 기록 helper는 append-time(저장 시각)으로 자동 채운다. 이는 결정의 *시점* 이 저장 시점과 일치하지 않을 수 있을 때(예: 사후 정리) caller가 명시적으로 사전 주입해야 함을 의미한다
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
