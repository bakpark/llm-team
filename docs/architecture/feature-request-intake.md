# Feature Request Intake

본 문서는 사람의 피드백/요구를 영속 저장소에서 milestone 으로 *입수* 하는 흐름을 contract 에 매핑한다. 권위는 다음 순으로 우선한다.

1. [`llm-team.md`](../../llm-team.md)
2. [`docs/contracts/state-and-operation-contract.md#SOC-OBJECTS`](../contracts/state-and-operation-contract.md#SOC-OBJECTS)
3. [`docs/contracts/reliability-and-gate-contract.md#RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS)

## 입수 채널

| 채널 | 트리거 | 객체 | 처리 use case |
|---|---|---|---|
| Feature request | 사람이 `feature-request` 라벨로 issue 생성(milestone 미연결) | issue → milestone(`PO_DRAFT`) | `feature_request_promote` |
| Human signal | 사람이 RGC-SIGNALS envelope 을 별도 채널로 발행 | signal envelope → 적용 대상 객체 | `human_signal_drain` |

본 문서는 **Feature request** 채널만 다룬다. Human signal 은 `RGC-SIGNALS` 가 정의한다.

## Feature Request 입수 절차

```text
사람                   영속 저장소(GitHub)            Caller (runner cycle 진입부)
 │                          │                             │
 │ create issue             │                             │
 │  + label "feature-request"                             │
 │ ───────────────────────▶│                             │
 │                          │                             │ 1. ready_object_pick / runner 진입부
 │                          │                             │    feature_request_promote(repo)
 │                          │  list label="feature-request"
 │                          │   --no-milestone (oldest)   │
 │                          │ ◀───────────────────────────│
 │                          │                             │
 │                          │  it_milestone_create        │
 │                          │   (title, body)             │
 │                          │ ◀───────────────────────────│
 │                          │                             │ 2. milestone PO_DRAFT 전이
 │                          │  it_milestone_set_state     │
 │                          │   PO_DRAFT                  │
 │                          │ ◀───────────────────────────│
 │                          │                             │ 3. issue ↔ milestone 링크
 │                          │  it_issue_link_to_milestone │
 │                          │ ◀───────────────────────────│
 │                          │                             │ 4. 라벨 전이
 │                          │  add  feature-request:accepted │
 │                          │  remove feature-request     │
 │                          │ ◀───────────────────────────│
 │                          │                             │
 │                          │                             ▼
 │                          │                       이후 cycle 에서 PO 가 PO_DRAFT 픽업
```

## 정렬·공정성

- 후보 issue 는 `created_at asc` 로 정렬된다(가장 오래된 1건만 선택).
- 한 cycle 당 1건만 promote. 다수 처리는 cycle 반복으로 흡수한다.
- PO 픽업 시 PO 는 두 후보 풀(feature-request, `PO_DRAFT`)을 본다. 후보 풀 간 공정성은 [`pipeline-end-to-end.md`](pipeline-end-to-end.md#1-pickup-oldest-ready-first) 의 Pickup 절과 [`daemons.md`](daemons.md#scheduling-fairness) 의 Scheduling Fairness 절을 따른다(현재 known limitation: tier-1 우선 → starvation 가능).

## 멱등성

- 라벨 전이(`feature-request` → `feature-request:accepted`) 가 동일 issue 의 재picking 을 차단한다.
- 사람이 라벨을 수동 복원하면 milestone 이 중복 생성될 수 있다. 입수 use case 는 라벨 상태에 의존하며, 재진입 방지의 책임은 운영자(라벨 관리)에게 있다.

## Caller 책임 (`AGC-CALL-BOUNDARY`)

- application 모듈은 `gh`/`git`/`curl` 을 직접 호출하지 않는다. `it_*` port 만 사용한다.
- 본 use case 는 영속 저장소에 *operational write* 를 수행한다(milestone 생성, 상태 전이, 라벨 변경). 이는 헌법 Inv#3 의 Caller 권한 안에 있다.
- 본 use case 는 LLM 을 호출하지 않는다. 따라서 `AGC-OUTPUT*`, `AGC-CONTEXT-MANIFEST` 가 적용되지 않는다. 입수 후 PO 호출에서 비로소 manifest 와 envelope 이 등장한다.

## ledger 기록

본 use case 는 `RGC-LEDGER` 의 result 컬럼에 다음 중 하나를 남긴다(operation = `feature-request-intake`).

| 결과 | 의미 |
|---|---|
| `applied` | 1건 promote 완료 |
| `noop` | 처리할 issue 없음 |
| `error` | 영속 저장소 lookup/write 실패 |

## 알려진 한계

- issue title/body 의 *원문* 인용은 현재 port 미지원으로 placeholder body 만 사용된다. PO 호출 시 milestone body 를 enrich 하는 단계가 별도로 필요하다(`feature_request.sh` 모듈 주석 참조).
- 사람의 라벨 회전이 빈번한 경우 starvation 또는 중복 promote 가능. 현재 별도 starvation sweep 은 없으며, 운영자는 ledger/queue 관측 후 라벨 상태를 수동 정리한다.
