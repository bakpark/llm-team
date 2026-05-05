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

스펙은 누적 산출물이다. `Discovery` / `Specification` phase 의 final artifact, 중요한 결정, 거부된 대안, Context Summary 는 마일스톤 종료 후에도 보존된다.

누적 스펙은 다음 마일스톤의 1급 입력이다. `Discovery` / `Specification` phase 의 lead contribution 은 새 작업이 기존 결정과 모순되지 않는지 확인할 책임을 갖는다.

병합된 스펙은 후속 마일스톤이 명시적으로 갱신하지 않는 한 변경하지 않는다. 변경 시 사유를 Decision Log 에 기록한다.

거부되거나 회수된 Spec CP 는 병합된 스펙으로 누적하지 않는다. 다만 거부 사유, 회수 사유, 반복 금지해야 할 대안은 `KAC-DECISION-LOG` 의 `alternatives` 와 `rationale` 로 누적한다. 다음 `Discovery` / `Specification` phase 호출의 manifest 는 현재 scope 와 관련된 최근 거부 사유를 decision entry 로 포함해야 하며, 이를 생략하면 후속 마일스톤이 같은 거부 사유를 반복할 수 있으므로 invalid manifest 로 본다.

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

`Discovery` / `Specification` phase 호출에서 Manifest 는 우선순위가 가장 높은 읽기 대상이다.

<a id="KAC-MANIFEST-FROM-KNOWLEDGE"></a>
## KAC-MANIFEST-FROM-KNOWLEDGE: Manifest Materialization

다음 마일스톤의 `Discovery` / `Specification` phase 호출에서 누적 스펙은 `AGC-CONTEXT-MANIFEST` 의 entry 로 변환되어 입력된다. 본 절은 그 변환 규약을 정의한다.

### 변환 규칙

Caller 는 `KAC-MANIFEST` 의 항목을 manifest entry 로 변환할 때 다음을 따른다.

- `artifact_kind` 는 manifest entry 의 `object_kind` 에 매핑한다. 변환 시 의미가 좁아지지 않도록 1:1 또는 그룹화로 매핑하며, 임의로 폐기하지 않는다.
- `artifact_id` 는 entry 의 `object_id` 로, `revision_pin` 은 entry 의 `revision_pin` 으로 그대로 보존한다. 새로 발급하지 않는다.
- `summary` 는 entry 의 `purpose` 또는 부속 메타로 사용한다. 본문은 self-fetch 로 얻으며, 본 절이 본문을 manifest 에 직접 임베드하지 않는다. self-fetch 의 `fetch_scope` 기본값은 `AGC-CONTEXT-MANIFEST` 의 contribution_kind 별 default 표를 따른다 (lead_draft contribution 의 경우 `body`).
- 동일 마일스톤에서 결정 우선순위가 다른 항목이 충돌하면 `KAC-CONFLICTS` 의 우선순위에 따라 *상위* 항목만 entry 로 포함한다. 폐기된 항목은 `KAC-DECISION-LOG` 의 `supersedes` 추적으로 참조 가능하다.

### 필수 entry

`Discovery` / `Specification` phase 호출의 manifest 는 최소 다음을 포함한다.

- 직전 마일스톤의 Context Summary
- 현재 사람 승인 시그널 (또는 `human_approval` contribution) 이 인용한 스펙(있을 때)
- 최신 병합된 Discovery / Specification phase 의 final artifact
- 최근 Decision Log 중 현재 마일스톤 scope 과 관련된 항목. 여기에는 거부되거나 회수된 Spec CP 의 사유가 포함된다

이 entry 들은 `required: true` 로 표시한다. 누락은 invalid manifest 이며, Caller 는 호출 전에 생성을 보장해야 한다.

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

`Validation` phase 의 PASS 종착 시 lead contribution (`sentinel`) 또는 `summary` contribution (`atlas`) 이 Context Summary 를 산출하고, Caller 가 manifest 에 첨부한다. Validation phase 는 merged spec 과 Decision Log 를 요약할 수 있지만 새 제품 결정을 만들지 않는다.

필수 내용:

- 완료된 마일스톤의 사용자 가치
- 변경된 주요 동작
- 유지해야 할 결정
- 후속 마일스톤에서 주의할 리스크
- 관련 AC-ID와 Task 요약

<a id="KAC-TRACEABILITY"></a>
## KAC-TRACEABILITY: Acceptance Criteria Traceability

`Specification` phase 는 수용 기준마다 안정적인 AC-ID 를 부여한다.

`Planning` phase 는 각 Task 가 어떤 AC-ID 를 구현하는지 mapping 한다. `Validation` phase 는 결과를 AC-ID 별로 보고한다.

최소 mapping:

```text
AC-ID -> Task ID(s) -> Code CP ID(s) -> Verification Run ID(s) -> Validation verdict
```

AC-ID 가 구현 Task 에 연결되지 않으면 `Planning` phase FAIL 이다. `Validation` phase 가 AC-ID 별 PASS/FAIL 을 보고하지 않으면 Validation phase FAIL 이다.

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

스펙 문서는 코드와 동등한 1급 산출물이다. 다만 quorum 정책은 비대칭이다.

- Spec CP 는 `Discovery` / `Specification` phase 의 quorum (필수 `human_approval` contribution 포함) 을 거친다.
- Code CP 는 `CodeReview` phase 의 결정적 검증 + agent quorum 을 거친다.

두 산출물 모두 revision pin, idempotency key, ledger 기록의 대상이다.
