# LLM Team

본 문서는 LLM 에이전트와 사람이 협업해 소프트웨어를 만드는 최상위 Concept 문서다. 도구·플랫폼 중립적이며, 어떤 이슈 트래커·버전 관리 시스템·알림 채널·런타임 위에서도 동일한 원칙으로 구현 가능해야 한다.

이 문서는 모델의 철학과 불변식을 정의한다. 구체 상태명, 출력 형식, 전이 조건, 회수 정책, 누적 지식 형식, lease 종류와 운영 정책은 `docs/contracts/` 아래 contract 문서가 정의한다. contract 문서나 구현이 본 문서와 충돌하면 **본 문서가 우선**한다.

---

## Document Set

규범 문서는 두 층으로 나뉜다.

| 문서 | 역할 |
|---|---|
| `llm-team.md` | 최상위 Concept / Constitution. 철학, layer, 권한 경계, 핵심 invariant를 정의한다. |
| `docs/contracts/README.md` | Contract 문서 색인, 권위 순서, reference 규칙, 어휘 glossary, legacy → loop-based migration notes를 정의한다. |
| `docs/contracts/agent-and-context-contract.md` | AgentProfile, outer-loop Phase, Contribution, Context Manifest, revision pin, output envelope, DialogueSession 입력·next-action 규약을 정의한다. |
| `docs/contracts/state-and-operation-contract.md` | Milestone (dual-slot) / Slice / DialogueSession / SessionTurn / SliceMerge 상태와 loop별 Caller operation 전이를 정의한다. |
| `docs/contracts/reliability-and-gate-contract.md` | 4단계 lease 계층, 회수, 검증, 사람 contribution, transition ledger, pause, dual-slot fairness, promotion guard를 정의한다. |
| `docs/contracts/knowledge-contract.md` | 누적 스펙, manifest, decision log, context summary, AC traceability, RefactorBacklog, turn_log compaction, slice telemetry inject path를 정의한다. |
| `docs/contracts/target-config-contract.md` | AgentProfile 레지스트리, loop policy, slice class rule, dual-track 정책, refactor metric, invariant enforcement 등급, lease TTL, runner 매핑을 정의한다. |
| `docs/contracts/agent-runner-port-contract.md` | agent runner 포트 시그니처, exit 분류, idempotency 3-scope (turn / session-outcome / merge)를 정의한다. |

`docs/architecture/` 등 다른 문서는 구현 또는 설명 문서로 간주한다. 그 문서들은 본 문서와 contract 문서를 보완할 수 있지만, override하지 않는다. 예: [`docs/architecture/agent-domain-consumer-guide.md`](docs/architecture/agent-domain-consumer-guide.md) 는 agent self-fetch manifest 의 *소비 측 권고* 만 다루는 non-normative 가이드다 — manifest validity 를 정의하지 않으며, 권위는 [`docs/contracts/README.md#CONTRACT-GLOSSARY`](docs/contracts/README.md#CONTRACT-GLOSSARY) (어휘) + [`docs/contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST`](docs/contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) (manifest 구성) 가 각각 단일 유지한다.

---

## Core Idea

LLM에게 소프트웨어를 만들게 하는 흔한 접근은 둘 중 하나다. 단일 LLM에게 거대한 작업을 한 번에 끝까지 끌고 가게 하거나, 여러 에이전트를 직접 호출·메모리 공유로 묶어 자율적으로 협업시키는 것이다. 전자는 컨텍스트 폭주와 검증 부재로 무너지고, 후자는 race condition·책임 분산·비멱등성으로 무너진다. 사람이 모든 검토를 떠안으면 처리량이 한계가 된다.

본 모델의 접근은 다르다. **에이전트는 무상태 1회 호출로 콘텐츠만 만들고, 호출자(스케줄러)는 workflow 의 operational transition 과 dialogue session 의 turn coordination 을 수행하며, 사람은 governance/input signal 과 feature slice 의 사람 게이트로 스펙·게이트를 정의한다.** 세 주체는 영속 저장소 위에서 협업하고, 핸드오프는 직접 호출이 아니라 영속 객체 (Slice / DialogueSession / SessionTurn / SliceMerge / contribution) 로만 일어난다.

한 호출은 단일 SessionTurn — 즉 한 `(session, turn_index, agent_profile)` 의 산출 — 만 만든다. 같은 session 안의 multi-turn 합성은 Caller 가 직전 turn_log 를 다음 호출의 input 에 합쳐 재구성한다 (agent 자체는 호출 사이 메모리를 보유하지 않는다). agent 간 직접 합의나 공유 메모리는 없다.

핵심 통찰은 한 줄이다.

> 에이전트는 콘텐츠만 — 호출자는 operational transition 과 turn coordination 을 — 사람은 governance signal 과 feature slice 의 게이트를.

이 책임 격리가 신뢰성을 만든다. 어떤 에이전트도 상태 표지를 바꾸거나 변경 제안을 병합하지 못하므로 race 가 구조적으로 줄어든다. 모든 결정과 산출은 영속 저장소에 기록되므로 LLM 의 무상태 한계를 self-fetch 와 turn_log replay 로 보완할 수 있다. 검증되지 않은 변경은 사람 게이트 (feature slice) 또는 deterministic verification (internal slice) 을 통과하지 못한다.

---

## Architecture

시스템은 4개의 layer로 구성된다.

1. **People**
   스펙 입력, feature slice 의 게이트 승인·거부, 회수 요청, 시스템 일시정지 요청, 본 모델 수정 승인. 사람은 영속 저장소에 governance/input write 를 직접 남길 수 있다. 호출자는 그 시그널을 해석해 workflow 전이를 집행한다. 사람 결정은 `human` AgentProfile 의 contribution envelope 으로 변환되어 quorum 평가에 들어간다.

2. **Agents**
   무상태 1회 호출로 콘텐츠만 생성한다. 콘텐츠는 마크다운, 코드 patch, 코멘트, 결정문, 요약문, 다음 호출 후보 제안 (`next_action_request`) 이다. 에이전트는 Context Manifest 에 지정된 대상을 읽기 전용 self-fetch 하고, 영속 저장소에 직접 쓰지 않는다. 에이전트는 AgentProfile id 로만 식별되며 — canonical id 는 `atlas | forge | sentinel | scout | human` — 한 호출은 한 SessionTurn 의 한 contribution 만 생산한다. 같은 session 안에서 여러 AgentProfile 이 turn-based dialogue 로 참여할 수 있으나 서로 직접 호출하지 않으며, turn 의 routing 권한과 session 종료 결정은 Caller 가 갖는다.

3. **Caller**
   에이전트를 호출하고, turn 별 결과를 검증하며, 모든 operational write 를 수행한다. 상태 전이, slice / session / merge lifecycle 진행, SliceMerge 의 trunk merge, 알림, workspace lifecycle, lease, 결정적 검증, 자동 회수, dialogue session 의 turn coordination (입력 합성·종료 판정·next-action routing 권위) 은 호출자의 영역이다.

4. **Persistent Store**
   이슈 트래커, 버전 관리 시스템, 누적 스펙 저장소를 묶어 부르는 추상 layer 다. 단일 진실 원천 (Slice / DialogueSession / SessionTurn / SliceMerge / contribution / RefactorBacklog / Milestone CP / Spec CP) 과 큐 (intake / dual-slot promotion / Caller dispatch) 를 동시에 담당한다.

Layer 간 직접 통신은 제한된다. Agent 간 직접 통신은 금지된다. Agent 의 출력은 반드시 영속 저장소 객체로 영속화된 뒤 다음 Agent 의 입력이 된다.

---

## Authority Boundaries

| 주체 | 허용 | 금지 |
|---|---|---|
| Human | governance/input write, feature slice 게이트 승인·거부, 회수·중단 요청, 모델 수정 승인 | 자동 workflow 전이의 비공식 우회 |
| Agent | Context Manifest 기반 self-fetch, 콘텐츠 생성, 할당 workspace 내부 임시 수정, DialogueSession 안 `next_action_request.addressed_to` 로 *제안 형태* 의 mediated addressing | 영속 저장소 직접 쓰기, 상태 변경, trunk merge, Issue 생성·종료, 알림, lease 획득·해제, 결정적 검증 실행, 다른 agent 직접 호출 |
| Caller | 모든 operational write, slice/session/merge 상태 전이, 검증 실행, 회수, 알림, trunk merge, DialogueSession turn coordination (입력 합성, finalization rule + required evidence 평가, 종료 판정, next-action routing 결정), lease 4 종 획득·해제 | 본 Concept 문서의 원칙 우회 |

사람이 직접 산출한 콘텐츠도 동일 영속 큐와 동일 멱등성 규칙으로 처리한다. 산출자가 사람이든 에이전트든 operational transition 과 session finalization 은 Caller 가 수행한다.

---

## Core Invariants

본 절의 9 invariant 는 본 헌법의 권위 영역이다. Lease 종류·재시도 한도·escalation 운영 규칙·세부 ledger schema 등 운영 정책은 contract 가 정의하며, 본 헌법은 *유한* 과 *원칙* 만 보장한다.

1. **Stateless per call, contextual within session** — 모든 Agent 호출은 호출 사이 메모리를 보유하지 않는다. 한 호출은 한 SessionTurn 만 생산한다. 같은 DialogueSession 안의 multi-turn 합성은 Caller 가 직전 turn_log 와 직전 verification result 를 다음 호출의 input 으로 합성하는 책임이며, agent 자체에 추가되는 것은 아니다.

2. **Direct invocation forbidden, mediated addressing allowed** — Agent 가 다른 Agent 를 직접 호출하는 것은 금지된다. DialogueSession 안에서 agent 가 envelope 의 `next_action_request.addressed_to` 로 다음 turn 의 후보 (수신자 + 의도) 를 *제안* 할 수 있으나, 그 제안의 routing 권한과 reject/override 권한은 Caller 가 단독 보유한다.

3. **Dual-slot milestone serialization** — 한 시점에 진행 중인 milestone 의 *Delivery* slot 은 1개이고, *Discovery* slot 은 default 1개 (운영 옵션 `target.dual_track.discovery_wip` 로 제한 확장 가능) 다. 두 slot 은 서로 다른 milestone 만 점유한다. Discovery N+1 의 manifest 에는 Delivery N 의 live telemetry 가 read-only 로 inject 된다.

4. **Caller-only operational write** — 상태 전이와 영속 workflow 변경은 Caller 만 수행한다. trunk merge, slice/session/merge state 전이, ledger append, lease 획득·해제, Issue 생성·종료, 알림 등 모든 operational side-effect 는 Caller 의 단독 책임이다.

5. **Required human contribution for `feature` slices** — 사람 승인은 `human` AgentProfile 의 contribution envelope 으로 표현된다. Slice class 가 `feature` 인 모든 slice 는 outer loop 의 Discovery / Specification 단계에서 `human` contribution 을 final artifact 응축 조건에 포함해야 한다. `internal` slice 는 `target.internal_escalation_rules` 의 escalation rule 1개라도 hit 시 자동으로 `feature` 게이트로 승격된다. 사람 결정의 권위는 절대적이며, agent quorum 이 사람 승인을 대체할 수 없다. Caller 프로세스는 사람 contribution 을 기다리는 동안 다른 slice / session 처리를 계속한다.

6. **Deterministic verification authority by Caller** — 빌드·테스트·린트·타입체크·정적 분석·metric 측정·interface diff 는 Caller 가 실행하고, 결과의 권위는 agent 의 verdict 보다 우위다. DialogueSession 의 종료 판정에서 `required_evidence` (verification_green / metric_threshold / interface_diff_clean / coverage_threshold 등) 는 agent finalization rule 과 분리되며, contract 가 정의하는 `composite_rule` 에 따라 결합된다.

7. **Knowledge accumulation** — 스펙, 결정, 거부된 대안, Context Summary, slice telemetry, RefactorBacklog 의 architectural debt 지표, turn_log 압축본은 누적되어 다음 milestone 의 1급 입력이 된다. Discovery 는 추정이 아닌 직전·진행 중 Delivery 의 현실에 기반해야 한다.

8. **AgentProfile abstraction** — 본 문서와 contract 는 AgentProfile id 만 사용한다. 모델명·엔진·런타임은 target config 의 책임이며, 모델 교체는 contract amendment 없이 가능해야 한다.

9. **Self-fetch + Context Manifest + revision pin** — Caller 는 호출 전에 manifest 와 revision pin 을 고정한다. Agent 는 manifest 밖의 객체를 read/write 하지 않는다. 본 invariant 는 session 안의 turn 호출에도 동일하게 적용된다 — turn manifest 는 직전 turn_log_snapshot 을 entry 로 포함할 수 있으나, 그 외 외부 객체는 Caller 가 명시한 manifest 밖이면 fetch 금지다. 위반 시 산출은 invalid 로 분류된다.

### Supplementary Guarantees

**Finite retry (delegated)** — 자동 재시도는 유한하다. 재시도 한도, no-progress / regression / scope-violation 정책, ESCALATED 진입의 구체 규칙은 본 헌법이 직접 정의하지 않고 [`reliability-and-gate-contract.md#RGC-FAILURE`](docs/contracts/reliability-and-gate-contract.md#RGC-FAILURE) 가 정의한다. 본 헌법은 *유한성* 만 보장한다 (위 9 invariant 와 별개의 supplementary guarantee).

---

## Workflow Shape

진행은 **3-loop nested model** 을 따른다.

```text
Outer  (milestone) — Discovery slot 과 Delivery slot 의 dual-track
  └ Middle (slice) — user-observable thin end-to-end (feature) 또는 behavior-preserving change (internal)
       └ Inner (TDD build) — forge 의 solo dialogue session, red/green/refactor turn
```

Outer loop 의 phase 어휘는 다음 4개로 격하된다.

```text
Discovery → Specification → Planning → Validation
```

이전 모형의 `Implementation` / `CodeReview` / `Integration` 어휘는 outer loop 에서 폐기되며, middle loop 의 slice review 와 inner loop 의 TDD build, 그리고 SliceMerge lifecycle 의 책임으로 흡수된다.

각 loop step 은 DialogueSession 으로 진행된다 — turn-based agent 협의, 참가자 (`lead`/`reviewer`/`observer` role) 와 종료 조건 (`finalization_rule` × `required_evidence` × `composite_rule`) 으로 정의된다. session 의 종료 판정 권위는 Caller 에 있다. session 의 final artifact 응축은 (state, final_verdict) tuple 에 따라 분기된다 — 같은 `CONVERGED` state 도 `approve` / `request_changes` / `tests_green` / `spec_accept` 등 verdict 에 따라 다음 dispatch 가 달라진다.

Slice 는 milestone 단위로 DAG 를 이루며, 의존 관계는 `blocks` (순서 강제) / `coordinates_with` (병렬 허용, first-merger-wins) 로 표현된다. Slice 별 trunk merge 는 SliceMerge 객체의 lifecycle (`SM_DRAFT → SM_READY_FOR_REVIEW → SM_APPROVED → SM_MERGED`) 로 관리된다. 역방향 이동은 명시적 회수로만 허용된다 — Recover 는 진행 동사가 아니라 회복 동사이며, stale, fail, lease 만료, 사람의 회수 요청, 미도착 contribution 의 timeout 을 처리한다.

세부 상태와 전이는 [State and Operation Contract](docs/contracts/state-and-operation-contract.md) 가, lease 계층과 회수 정책은 [Reliability and Gate Contract](docs/contracts/reliability-and-gate-contract.md) 가, 어휘 glossary 와 legacy phase model → loop-based 환산표는 [Contract README](docs/contracts/README.md) 가 정의한다.

---

## Deprecated Vocabulary (legacy phase model → loop-based)

본 헌법은 다음 어휘를 폐기한다. 신규 코드·문서·dispatcher 는 폐기 어휘를 사용하지 않는다 (historical reader / fixture / migration tooling 은 예외).

| 폐기 | 대체 |
|---|---|
| `Task` | `Slice` (책임 확장: 코드 → 가치) |
| `PhaseRun` | `DialogueSession` (turn 추가, lifecycle 5-state) |
| Phase 단위 lock-step (7-phase) | 3-loop nested. phase 어휘는 outer loop step 4개로만 잔존 |
| `Code CP` / `Integration CP` | `SliceMerge` (lifecycle 7-state 흡수) |
| `IMPLEMENTATION_IN_PROGRESS` / `INTEGRATION_*` milestone state | `M_DELIVERY_BUILDING` / `M_DELIVERY_VALIDATING` |
| 평행 quorum submission as primary review | DialogueSession primary; quorum 은 `finalization_rule` enum 의 한 종류 (`min_approvals` 등) 로 잔존 |
| Single-milestone serialization | Dual-slot serialization (Discovery + Delivery) |
| `agent_role` | `agent_profile_id` (rename, 의미 동일) |
| `operation` (legacy ledger) | `action_kind` (rename + 의미 확장) |

상세 환산표 (state label / envelope field / config key / contribution_kind enum / contract anchor) 는 [Contract README](docs/contracts/README.md) 의 `CONTRACT-MIGRATION-NOTES` 가 단일 권위다.

---

## Contract Reference Rules

Contract 문서는 stable section ID를 사용한다. 다른 문서에서 세부 규칙을 참조할 때는 다음 형식을 쓴다.

```text
<path>#<section-id>
```

예:

- `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`
- `docs/contracts/agent-and-context-contract.md#AGC-SESSION-INPUT`
- `docs/contracts/state-and-operation-contract.md#SOC-SLICE-LIFECYCLE`
- `docs/contracts/state-and-operation-contract.md#SOC-MILESTONE-DUAL-SLOT`
- `docs/contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS`
- `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER`
- `docs/contracts/knowledge-contract.md#KAC-REFACTOR-BACKLOG`
- `docs/contracts/knowledge-contract.md#KAC-TURN-LOG-COMPACTION`
- `docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES`
- `docs/contracts/target-config-contract.md#TCC-ENFORCEMENT`

Reference 와 권위 순서는 [Contract README](docs/contracts/README.md) 가 정의한다.

---

## Adaptation

본 문서는 의도적으로 추상이다. 다음은 본 문서에 들어가지 않는다.

- 영속 저장소·이슈 트래커·알림 채널·버전 관리 시스템의 제품명
- 상태 표지의 구체 이름·색·인코딩
- 디렉토리 구조 / CLI 호출 / 프롬프트 / 데몬 폴링 주기
- Lease TTL / 임계 시간 / 재시도 한도 / `target.dual_track.discovery_wip` / `target.tdd_strict` / `target.dual_track.priority` 같은 운영 슬롯 수치
- Slice class escalation rule 의 구체 매개변수 (security path, perf threshold 등)
- `target.invariant_enforcement` 의 stage_graded list

도구는 자유롭게 교체할 수 있다. 단 본 모델의 9 invariant 는 새 도구 위에서도 동일하게 보장되어야 한다.

---

## Amendment

- 본 문서의 변경은 사람의 명시적 승인을 필요로 한다.
- 변경은 변경 제안 + 사람의 승인 시그널 + Caller 의 병합 + 새 commit 으로만 발생한다.
- 구현 또는 contract 문서가 본 문서와 충돌하면 본 문서가 우선하며, 하위 문서를 정정해야 한다.
- 본 모델 위반이 발견되면 즉시 작업을 중단하고 사람에게 보고한다. 위반을 우회·은폐하지 않는다.
