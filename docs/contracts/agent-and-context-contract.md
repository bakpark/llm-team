# Agent and Context Contract

본 문서는 AgentProfile, outer-loop Phase, Contribution, Context Manifest, revision pin, Agent output envelope, DialogueSession 입력·next-action 규약을 정의한다. 최상위 원칙은 `llm-team.md` 가 우선한다. 어휘 정의는 `docs/contracts/README.md#CONTRACT-GLOSSARY` 가 단일 권위.

<a id="AGC-SCOPE"></a>
## AGC-SCOPE: Scope

이 문서의 authoritative scope 는 다음이다.

- Outer-loop Phase 정의와 final artifact
- AgentProfile 추상과 책임
- Contribution 분류 (`contribution_kind` enum)
- Caller → Agent 호출 경계 (turn 단위)
- Context Manifest 와 revision pin (turn manifest 포함)
- Agent output envelope (session_id / turn_index / next_action_request 포함)
- DialogueSession 안의 turn 입력 합성 규약
- next-action 제안 (mediated addressing) 의 envelope 표현
- self-fetch, workspace write, secret handling

상태 전이와 loop 별 Caller action, slice/session/merge lifecycle 은 `docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS` 가 정의한다. lease 4 종, retry, 사람 contribution 변환 path 는 `docs/contracts/reliability-and-gate-contract.md` 가 정의한다. AgentProfile id 와 모델명 매핑, loop policy 는 `docs/contracts/target-config-contract.md` 가 정의한다.

<a id="AGC-PHASES"></a>
## AGC-PHASES: Outer-Loop Phases

workflow 의 outer loop 는 milestone 단위로 진행되며 다음 4 phase 를 갖는다. 각 phase 는 DialogueSession (`SOC-SESSION-LIFECYCLE`) 으로 진행되고, lead AgentProfile 한 명과 (선택적) reviewer / observer participants 의 contribution 으로 구성된다.

| Phase | 입력 | Final artifact |
|---|---|---|
| `Discovery` | 사람 트리거 / 직전 milestone Context Summary / 현재 진행 Delivery slot 의 slice telemetry | milestone 본문 변경 제안 + ADR + spec_proposal |
| `Specification` | 통과된 milestone 본문 + 누적 스펙 | scenarios + AC-ID + 각 AC-ID 별 acceptance test 코드 (TDD-ready, pending marker 포함) |
| `Planning` | 통과된 milestone + scenario spec + RefactorBacklog curated 후보 | slice DAG (feature + internal mix) + 의존 그래프 (`blocks`/`coordinates_with`) + dod_revision_pin |
| `Validation` | Delivery 의 모든 SLICE_VALIDATED slice + scenario spec + verification 결과 | milestone CP + Context Summary + cross-slice acceptance verdict |

이전 모형의 `Implementation` / `CodeReview` / `Integration` 은 outer phase 에서 폐기되며, middle loop (slice review) + inner loop (TDD build) + SliceMerge lifecycle (`SOC-SLICE-MERGE`) 로 흡수된다.

phase 안에서 contribution 합산 규칙 (finalization rule × required evidence × composite rule) 은 `docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES` 의 `loop_policies.outer.<phase>` 가 정의한다. session 종료 판정과 final artifact 압축은 Caller (`application/dialogue_coordinator.sh`) 가 `SOC-SESSION-TERMINATION` 에 따라 수행한다.

<a id="AGC-AGENT-PROFILES"></a>
## AGC-AGENT-PROFILES: Agent Profiles

AgentProfile 은 모델·성격·권한 묶음의 추상이다. 본 contract 와 다른 contract 는 AgentProfile id 만 사용한다. 모델명·엔진·런타임은 본 문서 어디에도 등장하지 않으며, `docs/contracts/target-config-contract.md` 의 `agent_profiles.<id>` 가 단일 권위다.

| AgentProfile | 책임 |
|---|---|
| `atlas` | 고수준 설계, 스펙 정리, outer-loop lead. Discovery / Specification / Planning 의 lead, middle loop 의 architectural review. RefactorBacklog curation 의 1순위 |
| `forge` | 구현, 빠른 patch, 작은 단위 task. Inner loop (TDD build) 의 lead. Middle loop review 의 reviewer (rework 가능성). Refactor proposal 의 ad-hoc producer |
| `sentinel` | 엄격한 review, 품질 gate, integration 판단. Middle loop (slice review) 의 lead. Outer Validation 의 lead. Refactor proposal 의 ad-hoc producer |
| `scout` | 코드베이스 탐색, 실패 재현, 로그 / 증거 수집. RequiredEvidence 의 1순위 producer. RefactorBacklog 의 정기 scan producer |
| `human` | 사람 승인. `feature` slice 의 outer loop Discovery / Specification 의 finalization 에 필수 contribution 을 제공한다. internal slice 는 `target.internal_escalation_rules` (TCC-SLICE-CLASS-RULES) 의 1개라도 hit 시 자동 feature 게이트로 승격되어 `human` contribution 이 요구된다. 모델 / 엔진 개념 없음. 사람 결정의 권위는 절대적이며 agent finalization 이 대체할 수 없다 |

<a id="AGC-CONTRIBUTION"></a>
## AGC-CONTRIBUTION: Contribution

Contribution 은 하나의 SessionTurn — 한 `(session_id, turn_index, agent_profile)` 호출 — 이 남기는 산출이다. **persistent store 의 1급 객체** 이며, queue-based handoff 는 contribution 단위로도 적용된다. 한 호출은 단일 SessionTurn 안의 단일 contribution 만 생산한다.

| `contribution_kind` | 의미 | 주 producer (예) |
|---|---|---|
| `lead_draft` | session lead 가 작성한 초안 또는 후속 초안 (직전 review_verdict 의 request_changes 사유 해소 시 `parent_review_verdict_id` 로 역참조). 폐기된 `rework_patch` enum 의 책임을 흡수 | atlas / forge / sentinel (loop · phase 마다 다름) |
| `review_verdict` | reviewer 의 verdict + 근거. verdict enum 은 `approve / request_changes / tests_green / spec_accept / spec_reject` 등 — `SOC-SESSION-TERMINATION` 의 (state, final_verdict) tuple 에서 사용 | sentinel / atlas / forge |
| `human_approval` | 사람 승인 / 거부 + 근거. `feature` slice 의 outer Discovery / Specification 에서 필수 | human |
| `session_outcome` | session 종료 시점의 final artifact 응축본. Caller (`application/dialogue_coordinator.sh`) 가 (state, final_verdict) tuple 평가 후 lead 산출과 evidence 결과를 합성하여 1건만 생성. agent 가 직접 산출하지 않음 — runtime metadata 와 함께 후주입 | (Caller-only) |
| `proposal` | 다음 session 또는 governance signal 후보 제안. 예: `acceptance_test_amendment_proposal` (AC 의 가정 오류 발견), `discovered_dependency` (inner loop 중 새 의존 발견), `refactor_proposal` (RefactorBacklog 의 새 entry 후보), `cross_milestone_amendment` (다른 milestone scope 변경 제안). agent 가 turn envelope 의 `next_action_request` 또는 별도 attached artifact 로 산출 | atlas / forge / sentinel / scout |

폐기된 enum:

- `rework_patch` → `lead_draft` 의 후속 instance. envelope 에 `parent_review_verdict_id` 필드를 추가하여 역참조.
- `evidence` → 영속 객체 RequiredEvidence + VerificationRun + MetricRun (`SOC-SESSION-TERMINATION` 의 `required_evidence` 필드). contribution_kind 가 아닌 인프라 영역으로 re-home.
- `summary` → outer Validation phase 의 `lead_draft` artifact 로 흡수. 별도 contribution_kind 아님.

`contribution_kind` 와 phase / loop 의 허용 조합은 `#AGC-CONTRIBUTION-OUTPUTS` 의 매트릭스가 정의한다. session 종료 판정에서 verdict 의 결합과 required_evidence 의 결합 규칙은 `SOC-SESSION-TERMINATION` 이 정의한다.

<a id="AGC-CALL-BOUNDARY"></a>
## AGC-CALL-BOUNDARY: Caller-Agent Boundary

한 Agent 호출은 한 SessionTurn 이다. Caller 가 Agent 에 제공하는 것은 다음으로 제한된다.

- session 식별자 (`session_id`, `turn_index`, `parent_loop`, `purpose`)
- 호출 대상 객체 식별자 (slice / milestone / SliceMerge — `parent_object_kind` + `parent_object_id`)
- 산출 위치 식별자 (envelope 영속화 위치, workspace path 등)
- Context Manifest (turn 단위)
- 직전 turn_log 스냅샷 참조 (`AGC-SESSION-INPUT` 의 합성 규약)
- 직전 verification_result (있을 때)
- prompt 본문 (역할 + 의도 + 제약)
- 읽기 도구 권한
- 필요한 경우 격리 작업 공간 식별자 (inner loop 한정)

Caller 는 긴 컨텍스트 본문을 직접 주입하지 않는다. Agent 는 Context Manifest 를 통해 self-fetch 하여 컨텍스트를 재구성한다. session 안 multi-turn 의 합성은 Caller 가 직전 turn_log 와 verification_result 를 다음 호출의 input 으로 합쳐서 재구성한다 — agent 자체는 호출 사이 메모리를 보유하지 않는다 (`llm-team.md` Inv #1).

Agent 가 Caller 에 반환하는 것은 콘텐츠와 *제안* 이다. Agent 는 operational transition 을 실행하지 않고, 상태 변경을 요구하는 명령도 내리지 않는다. 다음 turn 후보를 envelope 의 `next_action_request` 로 *제안* 할 수 있으나 routing 권한과 reject/override 권한은 Caller 가 단독 보유한다 (`#AGC-NEXT-ACTION-REQUEST`).

<a id="AGC-SESSION-INPUT"></a>
## AGC-SESSION-INPUT: Session Turn Input Composition

DialogueSession 안의 turn 호출에서 Caller 는 다음 항목을 합성하여 Agent input 을 만든다. 본 합성은 invariant — agent 가 turn_log 또는 verification_result 를 자력 조회하는 것은 manifest 외 read 로 invalid (`#AGC-INVALID`).

### 합성 규칙

| 항목 | 출처 | 필수 / 조건 |
|---|---|---|
| `session_id` | DialogueSession.session_id | 필수 |
| `turn_index` | DialogueSession.current_turn_index | 필수 — session-local. (session_id, turn_index) 가 globally unique |
| `parent_loop` | DialogueSession.parent_loop ∈ {outer, middle, inner} | 필수 |
| `purpose` | DialogueSession.purpose ∈ {design, build, review, tdd_build, planning_decompose, validation} | 필수 |
| `participants` | DialogueSession.participants (이번 turn 의 caller 가 routing 한 1명만 호출) | 필수 |
| `agent_role_in_session` | 이번 turn 에서 호출된 agent 의 role ∈ {lead, reviewer, observer} | 필수 |
| `context_manifest` | turn manifest (직전 turn_log_snapshot 을 entry 로 포함 가능) | 필수 |
| `prior_turn_log_snapshot_ref` | 직전 turn_log 의 압축 스냅샷 참조 (`KAC-TURN-LOG-COMPACTION`) | turn_index ≥ 2 면 필수 |
| `prior_verification_result_ref` | 직전 verification_result (inner loop 또는 evidence 가 직전 turn 에서 발생했을 때) | 조건부. inner loop 에서는 turn_index ≥ 2 일 때 필수 |
| `session_workspace_revision_pin` | DialogueSession.workspace_revision_pin (session 시작 시 base) + 누적 commit 들 | 필수 |
| `accumulated_session_artifacts` | session 안에서 이번 turn 까지의 lead artifact / review_verdict / proposal 등 (manifest entry 로 노출) | 조건부 — purpose 별 |

### 합성 무결성

- `prior_turn_log_snapshot` 은 KAC 의 turn_log compaction 정책에 따라 *수렴적* 으로 압축된다. 압축 결과를 agent 가 자체 확장하지 않는다 — manifest 외 read 로 간주.
- `prior_verification_result` 가 inner loop 한정으로 필수인 이유는 TDD red/green/refactor turn 의 결정이 직전 결과에 의존하기 때문이다 (`SOC-SLICE-LIFECYCLE` 의 inner build session 절차).
- session 시작 시점의 `workspace_revision_pin` 은 lock-in 이며, session 종료까지 변하지 않는다. trunk 가 변하면 session 은 `AWAITING_REVALIDATION` 또는 SliceMerge `SM_STALE` 로 전이 (`SOC-SLICE-MERGE`).

<a id="AGC-PROMPT-SERIALIZATION"></a>
## AGC-PROMPT-SERIALIZATION: Prompt Body Serialization

`#AGC-SESSION-INPUT` 의 합성 결과를 1-shot agent 호출의 prompt 본문(adapter stdin 입력) 으로 변환할 때 본 contract 가 정의하는 invariant 다. 본 anchor 는 *어떤 정보가 어디에* 들어가야 하는지를 고정한다. 구체 직렬화 형식(YAML 키 이름, delimiter 토큰, frontmatter 사용 여부) 은 본 문서가 고정하지 않으며 architecture 문서가 결정한다 (`docs/architecture/prompt-build-pipeline.md`).

### 4-Part Canonical Layout

prompt 본문은 다음 4 section 을 본 순서대로 포함한다. 순서가 다르거나 section 이 누락되면 invalid prompt 로 간주한다 (`#AGC-INVALID`).

| 순서 | Section | 책임 |
|---|---|---|
| 1 | `header` | 식별자 echo 영역. Agent 는 본 영역에서 식별자를 읽고 envelope 의 동명 필드에 정확히 echo back 한다 |
| 2 | `context` | session 합성 본문. `prior_turn_log_snapshot_ref` body, `prior_verification_result_ref` body (있을 때), `accumulated_session_artifacts`, Context Manifest 의 fetch 결과 |
| 3 | `instruction` | 역할·의도·제약. prompts/*.md 의 자연어 본문이 본 영역에 들어간다 |
| 4 | `output_schema` | `#AGC-OUTPUT` envelope 의 JSON schema 또는 그에 상응하는 출력 형식 지시 |

### Header Echo Invariant (필수 7 필드)

`header` section 은 다음 7 필드를 포함해야 하며, Agent 는 envelope 의 동명 필드에 본 값을 *정확히* 동일하게 산출해야 한다. 불일치 시 invalid envelope 로 판정한다 (`#AGC-INVALID`).

| 필드 | 출처 |
|---|---|
| `session_id` | `#AGC-SESSION-INPUT` |
| `turn_index` | `#AGC-SESSION-INPUT` |
| `parent_loop` | `#AGC-SESSION-INPUT` |
| `phase_or_purpose` | `#AGC-SESSION-INPUT.purpose` (outer 한정으로 phase 명) |
| `agent_profile_id` | DialogueSession.participants 중 이번 turn 에서 호출된 profile |
| `agent_role_in_session` | `#AGC-SESSION-INPUT.agent_role_in_session` |
| `manifest_id` | `#AGC-CONTEXT-MANIFEST.manifest_id` |

5튜플 식별자 (`session_id, turn_index, parent_loop, agent_profile_id, contribution_kind`) 는 envelope 의 1급 식별자다 (`#AGC-OUTPUT`). 그 중 4개는 header 의 echo 대상이며, `contribution_kind` 는 Agent 의 출력 결정값이므로 header 에 포함되지 않는다.

### Section 책임 분리

- `header` 와 `output_schema` section 의 토큰이 `instruction` 본문 안에 섞여서는 안 된다. 두 영역의 토큰이 본문에 누출된 경우 (`#AGC-ISSUE-BODY` 와 동일 원리) Caller 는 invalid prompt 로 판정한다.
- Caller 는 `context` section 의 entry 본문을 fetch_scope 에 따라 합성한다. fetch_scope 위반은 `#AGC-CONTEXT-MANIFEST` 의 invariant 로 처리된다.
- 본 invariant 의 위반은 prompt 빌드 단계의 책임 (Caller). adapter 는 prompt 본문을 재구성하거나 4 section 의 의미를 변경하지 않는다 (`docs/contracts/agent-runner-port-contract.md#ARC-ADAPTER-PROMPT-CONTRACT`).

<a id="AGC-NEXT-ACTION-REQUEST"></a>
## AGC-NEXT-ACTION-REQUEST: Mediated Addressing

`llm-team.md` Inv #2 (Direct invocation forbidden, mediated addressing allowed) 의 envelope 표현이다. agent 는 다음 turn 의 후보 (수신자 + 의도) 를 envelope 의 `next_action_request` 필드로 *제안* 한다. Caller 가 이를 routing 결정의 입력으로 사용하나 *권위* 는 갖지 않는다.

### Schema

```text
next_action_request? {
  addressed_to: <agent_profile_id> | "caller"  # caller 는 "다음 turn 없이 종료 검토" 의미
  intent: <free-form purpose>                  # 예: "review draft", "rerun verification with X scope"
  evidence_request[]?: { kind, scope }         # required_evidence 의 추가 항목 제안
  proposal_artifact_ref?: <attached proposal>  # acceptance_test_amendment_proposal 등
}
```

### Caller routing decision

Caller 는 본 제안에 대해 다음 넷 중 하나로 결정하고 SessionTurn 의 `caller_routing_decision` 객체에 기록한다.

`caller_routing_decision` 객체 필수 필드:

| 필드 | 의미 |
|---|---|
| `decision` | `accepted` / `overridden` / `delayed` / `dropped` 중 하나 |
| `decision_reason` | 결정의 근거를 담은 자연어. 공란 금지. enum 외 가지 (`overridden`, `delayed`, `dropped`) 의 사유를 audit 가능하게 한다 |
| `resolved_addressed_to` | 실제로 다음 turn 의 호출 대상이 된 agent_profile_id 또는 `null` (decision ∈ {delayed, dropped}) |

| Decision | 의미 |
|---|---|
| `accepted` | 제안된 addressed_to + intent 로 다음 turn 진행 |
| `overridden` | Caller 가 다른 participant 또는 다른 intent 로 다음 turn 결정 (제안 무시). 사유는 capability 부재 / participants 미일치 / `#AGC-TURN-ORDERING` 우선순위 등 |
| `delayed` | fairness violation 또는 cross-session 우선순위로 다음 turn 진행을 보류. 같은 session 의 후속 평가 시점에 재고려된다 |
| `dropped` | 다음 turn 을 만들지 않고 session finalization 평가로 진입 (예: addressed_to=caller, max_turns 도달, 동일 turn 내 동일 next_action_request 반복) |

결정 매트릭스(예시):

| 조건 | decision |
|---|---|
| participants 미일치 / profile capability 부재 | overridden |
| fairness violation (다른 session 우선) | delayed |
| 동일 turn 내 동일 next_action_request 반복 | dropped |
| max_turns 도달 또는 addressed_to=caller | dropped |
| 정상 | accepted |

routing decision 은 ledger (RGC-LEDGER) 의 별도 행으로 기록되지 않으며 session_log 의 SessionTurn entry 에 영속화된다. 다만 audit 시 추적 가능해야 한다.

### 위반

- agent 가 `next_action_request.addressed_to` 로 *명령* 을 발행 (예: "session 을 종료하라", "verification 을 실행하라") 한 경우 envelope 은 invalid 가 아니다 (제안 자체는 허용). Caller 가 그 routing 권한을 임의로 위임하는 것이 invariant 위반이다.
- `next_action_request` 가 manifest 밖의 객체를 *간접* 참조 (예: 다른 slice 의 SliceMerge 식별자) 한 경우 Caller 는 그 참조를 다음 turn manifest 에 자동 포함시키지 않는다 — 명시적 manifest entry 추가는 Caller 의 결정.

<a id="AGC-TURN-ORDERING"></a>
## AGC-TURN-ORDERING: Turn Ordering Policy

DialogueSession 안에서 다음 turn 의 호출 대상 agent 를 선정하는 invariant 다. 본 contract 는 추상 우선순위만 고정한다 — 정량 정책 (연속 점유 한도 등) 은 `docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES` 의 `turn_ordering` block 이 정의한다.

### 우선순위

| 순위 | 입력 | 조건 |
|---|---|---|
| 1 | 직전 turn 의 `next_action_request.addressed_to` + Caller routing decision (`accepted` 한정) | 해당 profile 이 DialogueSession.participants 에 포함되며 `(parent_loop, purpose, 다음 contribution_kind)` 능력에 부합 |
| 2 | profile capability 자동 라우팅 — `(parent_loop, purpose, 다음 contribution_kind)` 가 요구하는 role 에 적합한 participant | `#AGC-AGENT-PROFILES` 의 (parent_loop, phase\|purpose) 매핑 |
| 3 | fallback — 같은 session 안에서 가장 오래 호출되지 않은 적합 profile | participants ≥ 2 일 때만 적용 |

### Fairness 보장

- 동일 `agent_profile_id` 가 같은 session 안에서 연속 N turn 초과 점유할 수 없다 (N 은 TCC `loop_policies.<loop>.<purpose>.turn_ordering.max_consecutive_per_profile` 가 정의).
- inner loop `tdd_build` 는 forge 단독이 lead 이므로 본 fairness 정책 적용 대상이 아니다 (`#AGC-CONTRIBUTION-OUTPUTS`).
- `caller_routing_decision.decision = delayed` 인 turn 은 fairness 카운터 대상이 아니다.

### 위반 처리

순위 위반 또는 fairness 위반은 `caller_routing_decision.decision_reason` 에 사유를 담아 `delayed` 또는 `overridden` 으로 분류한다. 위반을 무시하고 turn 을 진행하면 invalid SessionTurn 으로 판정한다 (`#AGC-INVALID`).

<a id="AGC-CONFLICT-RESOLUTION"></a>
## AGC-CONFLICT-RESOLUTION: Conflict Resolution

같은 lead artifact 또는 같은 결정 대상에 대해 dialogue 안에서 reviewer 의 의견이 분기 (예: 한 reviewer 가 `approve`, 다른 reviewer 가 `request_changes`) 했을 때의 해결 invariant 다. 본 invariant 는 `llm-team.md` Inv #2 (mediated addressing) 와 양립한다 — 충돌 해결 권한은 Caller 가 단독 보유하며, agent 가 다른 agent 의 결정을 직접 무효화하지 않는다.

### 해결 단계

| 순서 | 단계 | 트리거 | 산출 |
|---|---|---|---|
| 1 | re-dispatch | 동일 review 대상에 대해 의견이 분기된 첫 turn 직후 | Caller 가 다른 reviewer profile (또는 동일 profile 의 새 turn) 을 routing 하여 보강 verdict 를 수집한다. 같은 turn 안에서 routing 하지 않고 다음 turn 의 `caller_routing_decision` 으로 처리한다 |
| 2 | finalization 재평가 | re-dispatch 결과 포함 후 | `SOC-SESSION-LIFECYCLE` 의 finalization rule × required_evidence × composite_rule 을 다시 평가. 정족수와 evidence 를 충족하면 session_outcome 으로 종료 |
| 3 | human escalation | re-dispatch 가 한도 (TCC `loop_policies.<loop>.<purpose>.conflict.max_redispatch`) 를 초과하거나 timeout 경과 시 | session 을 `AWAITING_REVALIDATION` 또는 그에 상응하는 state 로 보류하고 사람 governance signal 을 요구. signal 은 `RGC-HUMAN-CONTRIBUTION` 으로 변환된다 |

### invariant

- agent 가 다른 agent 의 verdict 를 *덮어쓰는* 산출을 내면 invalid 다 (envelope 의 다른 contribution 을 직접 무효화하는 형태). 의견 충돌은 새 review_verdict turn 으로만 표현된다 (`#AGC-INVALID`).
- 본 anchor 는 conflict 해결 *프로세스* invariant 만 고정한다. finalization rule 의 정족수, evidence 종류, timeout 값은 TCC 와 SOC 가 정의한다.

<a id="AGC-CONTEXT-MANIFEST"></a>
## AGC-CONTEXT-MANIFEST: Context Manifest

Context Manifest 는 Caller 가 Agent 호출 전에 생성하는 읽기 대상 목록이다. 본 invariant 는 turn 단위 호출에도 동일하게 적용된다 — turn manifest 는 직전 turn_log_snapshot 을 entry 로 포함할 수 있으나, 그 외 외부 객체는 Caller 가 명시한 manifest 밖이면 fetch 금지다 (`llm-team.md` Inv #9).

필수 필드:

| 필드 | 의미 |
|---|---|
| `manifest_id` | turn 단위 manifest 식별자 |
| `session_id` | 본 manifest 가 속한 DialogueSession |
| `turn_index` | 본 manifest 가 속한 SessionTurn |
| `purpose` | session purpose (`AGC-SESSION-INPUT` 의 enum) |
| `target` | 주 처리 대상 객체 (slice / milestone / SliceMerge) |
| `entries` | self-fetch 가능한 객체 목록 |
| `created_at` | manifest 생성 시각 |

각 `entries` 항목은 다음 필드를 갖는다.

| 필드 | 의미 |
|---|---|
| `object_kind` | milestone, slice, slice_merge, dialogue_session, session_turn, verification_run, metric_run, refactor_proposal, spec_doc, code_tree 등 |
| `object_id` | 영속 저장소의 객체 식별자 |
| `fetch_scope` | Agent 가 읽을 수 있는 범위. 본 문서의 fetch scope enum 중 하나. `tree` 는 cwd mount 의미 |
| `revision_pin` | revision/hash/HEAD/updated_at 등 가장 강한 버전 식별자. `code_tree` 진입 시 branch HEAD commit SHA |
| `required` | true 면 fetch 실패 시 Agent 는 실패 산출을 반환해야 한다 |
| `purpose` | 이 객체를 읽는 이유 |

Agent 는 Context Manifest 에 없는 객체를 self-fetch 하지 않는다. 필요한 컨텍스트가 누락되었으면 임의로 확장하지 않고 `NEED_CONTEXT` 실패 산출을 반환한다.

Caller 는 Agent 산출을 영속화하기 직전에 모든 required entry 의 revision pin 을 재검증한다. 변경이 감지되면 산출을 stale 로 판정한다.

### Fetch Scope Enum

`fetch_scope` 는 Agent 가 entry 에서 읽을 수 있는 정보의 깊이를 한정한다. 다음 값 중 하나여야 한다.

| 값 | 허용 범위 |
|---|---|
| `metadata` | 식별자, 상태, 라벨, 마커 등 본문을 제외한 메타데이터 |
| `body` | metadata + 객체 본문 |
| `tree` | 트리 전체 read-only 시야 (cwd 비치). entry 본문은 비어 있으며, Agent 는 코드베이스에서 자력 탐색. `revision_pin` 은 branch HEAD commit SHA 를 의미 |
| `body+comments` | body + 객체에 누적된 코멘트/이력 |
| `body+turn_log` | body + 같은 session 의 직전 turn_log_snapshot. session 안 turn 호출의 합성에만 사용 |

좁은 scope 에 충분한 정보가 있는데도 더 넓은 scope 을 사용하면 manifest 크기가 불필요하게 커지고, 후속 호출의 입력 결정성이 떨어진다.

### Contribution별 기본 Scope

호출 prompt 가 별도로 명시하지 않으면 Caller 는 `(parent_loop, purpose, contribution_kind)` 기준으로 다음 기본값을 사용한다.

| 조합 | 기본 scope | 비고 |
|---|---|---|
| (outer, design, lead_draft) | `body` | 누적 스펙 + ADR 본문 |
| (outer, validation, lead_draft) | `body+comments` | cross-slice 결과 + evidence 누적 |
| (middle, review, review_verdict) | `body+comments` | session 안 lead artifact + verification 결과 |
| (inner, tdd_build, lead_draft) | `body+turn_log` | 직전 turn 의 patch + verification feedback |
| (any, *, human_approval) | `body` | 사람 검토 시점의 본문이 1차 입력 |
| (any, *, proposal) | `body+turn_log` | session context 가 proposal 의 1차 근거 |

phase / loop 별로 다른 기본값이 필요하면 `loop_policies.<loop>.<phase>.fetch_scope_overrides` (`docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES`) 가 우선한다.

### 절단(Truncation) 책임

본 contract 는 entry 당 절대적인 길이 한도를 정의하지 않는다. Caller 는 `fetch_scope` 에 의해 정해진 의미적 범위 안에서, 어댑터별 한도(컨텍스트 윈도우, 인용 비용)에 맞춰 *수렴적* 절단을 적용할 수 있다. turn_log entry 의 압축 정책은 `KAC-TURN-LOG-COMPACTION` 이 단일 권위.

절단이 적용된 경우 entry 는 그 사실을 보존해야 한다. Agent 는 절단 표시를 본 채 임의로 외부 self-fetch 를 시도하지 않는다.

<a id="AGC-CONTEXT-BUDGET"></a>
## AGC-CONTEXT-BUDGET: Context Window Budget

`#AGC-CONTEXT-MANIFEST` 의 절단 책임을 1-shot agent 호출 전체의 context window budget 관리 invariant 로 확장한다. budget 의 정량 hard cap 은 본 문서가 고정하지 않으며, `docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES` 또는 architecture 문서가 결정한다.

### 책임

- 1-shot 호출의 총 context budget 관리 책임은 Caller 다. Caller 는 `#AGC-PROMPT-SERIALIZATION` 의 4 section 을 합성하기 *전* 에 cap 을 적용한다.
- agent runner adapter 는 budget overflow 를 감지하지 않는다. overflow 가 외부 LLM 단에서 절단을 유발하면 결과는 `docs/contracts/agent-runner-port-contract.md#ARC-EXIT-CLASSES` 의 `malformed_output` 또는 envelope 검증 단계의 invalid output 으로 분류된다.
- Agent 가 budget 부족을 감지한 경우 산출은 `output_kind=failure`, `failure.type=need_context` 로 반환한다 (`#AGC-INVALID` 의 manifest 외 read 금지와 양립).

### 절단 우선순위

cap 초과 시 Caller 는 다음 *낮음→높음* 순서로 entry 를 제거 또는 압축한다 (높을수록 보존 우선).

| 우선순위 | fetch_scope | 비고 |
|---|---|---|
| 낮음 (먼저 제거) | `tree` | 코드베이스 자력 탐색 — 누락 시 Agent 가 manifest 외 read 로 보강할 수 없으므로 실패 산출이 유발될 수 있음 |
| | `body+turn_log` | turn_log 는 `KAC-TURN-LOG-COMPACTION` 의 한도까지 추가 압축 가능 |
| | `body+comments` | comment 영역 우선 절단 |
| | `body` | metadata 만 남기는 형태로 격하 |
| 높음 (나중에 제거) | `metadata` | manifest entry 자체의 무결성을 위해 마지막까지 보존 |

### 위반 처리

- Caller 가 cap 적용 없이 prompt 를 빌드하여 외부 LLM 이 silent 하게 절단한 경우 envelope 은 invalid 로 판정한다 (`#AGC-INVALID`). 결과는 `RGC-FAILURE` 분류로 기록한다.
- 본 invariant 는 운용 최적화 (cache breakpoint, streaming 등) 를 결정하지 않는다 — 그것은 architecture 한정.

<a id="AGC-OUTPUT"></a>
## AGC-OUTPUT: Output Contract

모든 Agent output 은 공통 envelope 를 가져야 한다. 아래 표의 `필수` 값은 Caller enrichment 이후의 canonical envelope 기준이다. Agent 가 직접 산출해야 하는 필수 subset 은 `#AGC-OUTPUT-RUNTIME-ENRICH` 가 분리한다.

| 필드 | 필수 | 의미 |
|---|---|---|
| `session_id` | yes | DialogueSession 식별자 |
| `turn_index` | yes | session-local turn 인덱스. (session_id, turn_index) 가 globally unique |
| `parent_loop` | yes | `outer` / `middle` / `inner` 중 하나 |
| `phase_or_purpose` | yes | parent_loop=outer 일 때 `Discovery` / `Specification` / `Planning` / `Validation` 중 하나, parent_loop=middle 일 때 `review` / `merge` 중 하나, parent_loop=inner 일 때 `tdd_build`. `#AGC-PROMPT-SERIALIZATION` header echo 의 동명 필드와 문자열 동일 |
| `slice_id` | conditional | parent_loop ∈ {middle, inner} 일 때 필수 |
| `slice_kind` | conditional | parent_loop ∈ {middle, inner} 일 때 필수. `feature` / `internal` 중 하나 |
| `tdd_phase` | conditional | parent_loop=inner 일 때 필수. `red_green` / `refactor` 중 하나 |
| `agent_profile_id` | yes | `atlas` / `forge` / `sentinel` / `scout` / `human` 중 하나. legacy `agent_role` 은 폐기 |
| `agent_role_in_session` | yes | 이번 turn 에서의 role. `lead` / `reviewer` / `observer` |
| `contribution_kind` | yes | `lead_draft` / `review_verdict` / `human_approval` / `session_outcome` / `proposal` 중 하나. `#AGC-CONTRIBUTION` 의 enum |
| `parent_review_verdict_id` | conditional | contribution_kind=lead_draft 의 후속 instance (rework) 일 때 직전 review_verdict 식별자. polled `rework_patch` 의 책임 흡수 |
| `output_kind` | yes | `spec_proposal` / `task_plan` / `slice_decomposition` / `patch` / `verdict` / `milestone_package` / `proposal_artifact` / `failure` 중 하나. 허용 조합은 `#AGC-CONTRIBUTION-OUTPUTS` 매트릭스가 정의 |
| `object_id` | yes | 주 처리 대상 객체 (slice / milestone / SliceMerge) 식별자 |
| `manifest_id` | yes | 입력 Context Manifest 식별자 |
| `input_revision_pins` | yes | 산출에 사용한 revision pin 집합 |
| `idempotency_key` | caller-enriched yes | Caller 가 enrichment 단계에서 합성하는 envelope idempotency key. 합성 식은 `SOC-IDEMPOTENCY` 의 3-scope (per-turn / per-session-outcome / per-merge) 가 정의 |
| `summary` | yes | 사람이 읽을 수 있는 요약 |
| `artifacts` | conditional | patch, markdown, slice spec, scenario test, proposal 본문 등 |
| `verdict` | conditional | review_verdict / human_approval / outer Validation lead_draft 의 결정 본문 (`approve` / `request_changes` / `tests_green` / `spec_accept` / `spec_reject` / `PASS` / `FAIL` / `STALE` 등 — `SOC-SESSION-TERMINATION` 의 (state, final_verdict) tuple 매핑) |
| `next_action_request` | conditional | mediated addressing 제안. `#AGC-NEXT-ACTION-REQUEST` |
| `failure` | conditional | 실패 종류와 근거. `output_kind=failure` 일 때 필수 |
| `runtime_metadata` | conditional | Caller 가 enrichment 단계에서 후주입하는 키-값 영역. 채우는 키는 `#AGC-OUTPUT-RUNTIME-ENRICH` 의 매트릭스가 정의. Agent 는 본 영역을 산출하지 않는다 |

`(session_id, turn_index, agent_profile_id, contribution_kind)` 셋은 envelope 의 1급 식별자다. legacy `agent_role` / `operation` / `phase_run_id` 필드는 본 contract 에서 폐기되었으며 envelope 어디에도 등장하지 않는다 (`docs/contracts/README.md#CONTRACT-MIGRATION-NOTES`).

Agent output 은 operational side effect 를 포함하지 않는다. `merge`, `close_issue`, `set_label`, `notify`, `lease_expire` 같은 실행 지시는 허용되지 않는다. 다음 turn 또는 governance signal 후보는 `next_action_request` (제안) 또는 `proposal` contribution_kind (별도 artifact) 로 표현한다.

<a id="AGC-OUTPUT-RUNTIME-ENRICH"></a>
## AGC-OUTPUT-RUNTIME-ENRICH: Runtime Metadata Enrichment

본 절은 Agent envelope 의 *콘텐츠 필드(Agent 가 산출)* 와 *runtime metadata 필드(Caller 가 영속 저장소 작업 후 후주입)* 의 권한 경계를 정정한다. `llm-team.md` Inv #4 (Caller-only operational write) 의 직접 결과로, Agent 는 영속 저장소가 발급하거나 Caller 의 operational write 시점에 비로소 결정되는 식별자를 알 수 없으며 알아서도 안 된다.

### 분리 원칙 (MUST)

- Agent 는 AGC-OUTPUT 이 정의한 Agent-authored envelope 필드와 *콘텐츠* 성격의 artifact 만 산출한다. 콘텐츠는 manifest 와 prompt 만 보고 결정 가능한 정보를 의미한다. `idempotency_key` 와 `runtime_metadata` 는 Agent-authored subset 에 포함되지 않는다.
- runtime metadata 는 영속 저장소 작업의 *결과* 로만 결정된다. Agent 가 산출하지 않으며, Caller 가 envelope 의 별도 영역에 후주입한다.
- runtime metadata 누락은 envelope invalid 사유가 아니다. enrichment 자체가 실패하면 결과는 RGC-LEDGER 의 실패 분류에 따라 기록한다.

### Producer / Enricher 매트릭스

| Loop · Phase / Purpose | `contribution_kind` | Agent 산출(콘텐츠) | Caller 후주입(runtime metadata) |
|---|---|---|---|
| outer Discovery | `lead_draft` | spec / research 본문, ADR, 요약 | Spec CP 식별자 |
| outer Specification | `lead_draft` | scenarios, AC-ID, acceptance test 코드 | Spec CP 식별자, acceptance test 파일 경로 (pending marker 적용 후) |
| outer Planning | `lead_draft` | slice DAG (feature + internal), 의존 그래프, dod_revision_pin | slice 객체 식별자, integration branch base revision pin |
| outer Validation | `lead_draft` | cross-slice acceptance verdict, milestone CP message, Context Summary | Milestone CP 식별자, release 식별자(있을 때) |
| middle review | `review_verdict` | verdict, 근거 | review 대상 식별자 (slice_id / SliceMerge id), source revision pin (stale 비교 기준) |
| inner tdd_build | `lead_draft` | workspace patch, target_tests[], tdd_phase | workspace_commit SHA, verification_run_id (turn 직후 Caller 실행) |
| (any) Caller-only | `session_outcome` | (Agent 산출 없음 — Caller 합성) | session_id, final_verdict, finalization_decision, evidence_run_ids[] |
| (any) | `human_approval` | verdict + 근거 | review 대상 식별자, signal_id |
| (any) | `proposal` | proposal 본문, 근거 | proposal_id (RefactorBacklog 또는 governance queue 에 영속화 시) |

콘텐츠 필드의 구체 이름과 verdict enum 은 SOC-OPERATIONS 와 `#AGC-CONTRIBUTION-OUTPUTS` 가 정의한다. runtime metadata 의 구체 형태(번호 / 경로 / SHA 등)는 영속 저장소 어댑터가 결정한다.

### Caller Enrichment 규칙

- Caller 는 envelope 파싱 직후 AGC-INVALID 검증 *이전* 에 enrichment 를 수행한다. enrichment 이전의 preflight parser 는 JSON 파싱, profile/contribution_kind/manifest/session 정합성, side-effect 금지처럼 Agent-authored subset 만 검증한다.
- Enrichment 결과는 envelope 의 `runtime_metadata` 영역(AGC-OUTPUT 의 conditional 필드)에 키-값으로 누적된다. Agent 가 산출한 envelope 의 다른 필드를 덮어쓰지 않는다. 같은 키가 양쪽에 존재하면 invalid 로 판정한다.
- Enrichment 의 입력은 manifest 와 영속 저장소에 즉시 질의 가능한 lookup 으로 제한된다. 새로운 Agent 호출이나 사람의 결정에 의존하지 않는다.
- Enrichment 이후 envelope 은 불변으로 취급한다. side-effect 와 ledger 기록 단계에서 재변형하지 않는다.

### envelope.idempotency_key 의 producer

`AGC-OUTPUT` envelope 의 `idempotency_key` 는 Agent 가 산출하지 않는다. `SOC-IDEMPOTENCY` 의 3-scope (per-turn / per-session-outcome / per-merge) idempotency_key 식은 일부 항이 runtime metadata(예: 영속 저장소가 발급한 식별자, SliceMerge 의 trunk merge SHA)에 의존하므로 Agent 의 manifest 만으로는 합성할 수 없다. 합성 항에는 `session_id`, `turn_index`, `agent_profile_id`, `contribution_kind` 가 포함되어 같은 session 안의 서로 다른 turn 이 충돌 없이 ledger 에 기록된다.

Caller 는 enrichment 단계에서 SOC-IDEMPOTENCY 의 3-scope 식에 따라 envelope idempotency key 를 합성하여 `idempotency_key` 의 표준 위치에 기입한다. Agent 가 어떤 형태로든 이 필드를 산출했다면 Caller 는 이를 pre-enrichment invalid 로 판정하고 자체 합성 결과로 덮어쓰지 않는다.

### 위반 처리

- Agent 가 runtime metadata 필드 또는 envelope idempotency key 를 산출한 경우 Caller 는 invalid 로 판정한다.
- Caller enrichment 자체가 실패한 경우 envelope 은 미완성으로 간주하고 side-effect 를 수행하지 않는다. 결과는 RGC-LEDGER 의 실패 분류에 따라 기록한 뒤 lease 를 해제한다.

<a id="AGC-LLM-NEUTRALITY"></a>
## AGC-LLM-NEUTRALITY: LLM Provider Neutrality

본 contract 의 envelope, manifest, prompt invariant 는 특정 LLM provider 또는 모델 가족에 의존하지 않는다. provider-native 응답 형태 (stop reason, tool/function calling, content block 분리, role-tagged conversation) 는 adapter (`docs/contracts/agent-runner-port-contract.md`) 가 본 contract 의 envelope 으로 normalize 한다. 본 anchor 는 그 normalize invariant 를 정의한다.

### Normalize 매트릭스

`exit_status` 의 enum 은 `docs/contracts/agent-runner-port-contract.md#ARC-EXIT-CLASSES` 가 정의한다.

| Provider-native 결과 | AGC-OUTPUT 매핑 | adapter `exit_status` |
|---|---|---|
| 정상 종료 + 단일 텍스트 응답 | envelope 본문 — `output_kind` ∈ {spec_proposal, slice_decomposition, patch, verdict, milestone_package, proposal_artifact} | `ok` |
| 정상 종료 + tool/function call | envelope `output_kind=failure`, `failure.type=need_context` 또는 `next_action_request` 로 변환. tool 호출은 manifest 외 read 로 환원되며 직접 실행되지 않는다 | `ok` |
| max_tokens / length 제한으로 응답 절단 | envelope 부분 생성 시 `#AGC-INVALID` 검증에서 invalid 로 판정. envelope 미생성 시 `malformed_output` | `ok` 또는 `malformed_output` |
| provider 측 거절 / safety stop | envelope `output_kind=failure`, `failure.type=invalid_output` | `ok` |
| 호출 시간 한도 초과 | envelope 미생성 또는 부분 생성 | `timeout` |
| 외부 통신 / 인프라 실패 | envelope 미생성 | `transport_error` |
| adapter 자체 사용 불가 | envelope 미생성 | `adapter_unavailable` |

### Role-Splitting

provider 가 system / user / assistant role 분리를 요구하는 경우 adapter 는 `#AGC-PROMPT-SERIALIZATION` 의 4 section 의미와 echo invariant 를 보존한다. 본 contract 는 어떤 role 에 어떤 section 을 배치할지 고정하지 않는다 — 매핑 자체는 architecture (`docs/architecture/prompt-build-pipeline.md`) 가 결정하되, normalize invariant 를 위반하면 adapter 의 invalid output 으로 분류된다 (`docs/contracts/agent-runner-port-contract.md#ARC-ADAPTER-PROMPT-CONTRACT`).

### 본 anchor 가 다루지 않는 것

- provider 별 prompt cache, streaming, thinking block 같은 운용 최적화 — out of scope. architecture 가 결정.
- conversation_id / response_id 같은 provider 측 식별자의 영속화 — `#AGC-OUTPUT-RUNTIME-ENRICH` 의 runtime_metadata 영역에 후주입되는 형태로만 등장한다.

<a id="AGC-CONTRIBUTION-OUTPUTS"></a>
## AGC-CONTRIBUTION-OUTPUTS: Contribution-Specific Outputs

- outer Discovery `lead_draft` 는 milestone 본문, ADR, spec_proposal artifact 를 포함한다.
- outer Specification `lead_draft` 는 scenarios, AC-ID, AC-ID 별 acceptance test 코드 (TDD-ready, pending marker 포함) 를 포함한다.
- outer Planning `lead_draft` 는 slice DAG (slice_id, slice_kind, declared_scope, ac_ids/acceptance_tests, dependencies (`blocks`/`coordinates_with`), dod_revision_pin) 를 포함한다.
- outer Validation `lead_draft` 는 milestone CP, AC 별 PASS/FAIL, 책임 slice 식별, Context Summary 를 포함한다.
- middle review `review_verdict` 는 verdict (`approve` / `request_changes`) + 근거 + 만족된 required_evidence 평가 결과를 포함한다.
- inner tdd_build `lead_draft` 는 workspace patch, target_tests[], tdd_phase (`red_green` / `refactor`) 를 포함한다. inner loop 의 lead 는 forge 단독이며 reviewer participants 는 없다.
- `human_approval` 은 사람 approve/reject 결정 + 근거를 포함하며, summary 한 줄과 verdict 만으로도 valid 하다. `feature` slice 의 outer Discovery / Specification 에서 필수.
- `proposal` 은 acceptance_test_amendment_proposal / discovered_dependency / refactor_proposal / cross_milestone_amendment 등의 본문과 근거를 포함하며, `next_action_request` 의 attached artifact 또는 별도 contribution 으로 산출 가능.

### Loop · Purpose × Contribution Kind × Output Kind × Verdict

본 매트릭스는 `AGC-OUTPUT` 의 `output_kind` enum 검증 위치다. `failure` 는 모든 조합에서 허용되며, 이 경우 `failure` 필드가 필수이고 Caller 는 operational side effect 없이 `#AGC-INVALID` / `#RGC-FAILURE` 정책으로 분류한다.

| Loop · Phase / Purpose | `contribution_kind` | 정합 `output_kind` | verdict / artifact 제약 |
|---|---|---|---|
| outer Discovery | `lead_draft` (atlas) | `spec_proposal` | verdict 없음. milestone 본문 + ADR artifact |
| outer Specification | `lead_draft` (atlas) | `spec_proposal` | verdict 없음. scenarios + AC-ID + acceptance test 코드 artifact |
| outer Planning | `lead_draft` (atlas) | `slice_decomposition` | verdict 없음. slice DAG + 의존 그래프 + dod_revision_pin artifact |
| outer Validation | `lead_draft` (sentinel) | `milestone_package` | `verdict.result` ∈ {`PASS`, `FAIL`, `STALE`}. PASS 는 Context Summary 필수 |
| middle review | `review_verdict` (sentinel lead + atlas/forge reviewer) | `verdict` | `verdict.result` ∈ {`approve`, `request_changes`} |
| inner tdd_build | `lead_draft` (forge) | `patch` | verdict 없음. target_tests[] + tdd_phase 필수 |
| (any) | `human_approval` (human) | `verdict` | `verdict.result` ∈ {`approve`, `reject`}. 사람 결정 권위 절대 |
| (any) | `proposal` | `proposal_artifact` | proposal_kind 필수 (acceptance_test_amendment / discovered_dependency / refactor / cross_milestone_amendment). 본문 + 근거 필수 |
| (any Caller-only) | `session_outcome` | `verdict` 또는 `milestone_package` | (state, final_verdict) tuple 영속화. agent 가 산출하지 않음 |

<a id="AGC-WORKSPACE"></a>
## AGC-WORKSPACE: Workspace Rules

Agent 는 영속 저장소에 직접 쓰지 않는다. 단, Caller 가 할당한 격리 작업 공간 내부 파일은 임시 산출 매개체로 수정할 수 있다. 격리 작업 공간은 inner loop 의 forge `lead_draft` (TDD build) 에 한하여 할당된다.

작업 공간 변경은 Caller 가 매 turn 마다 patch 를 수집해 SessionTurn 의 `workspace_commit` SHA 로 영속화한 시점에만 workflow 에 진입한다. session 종료 (CONVERGED) 시 SliceMerge `SM_DRAFT → SM_READY_FOR_REVIEW` 로 전이되며, trunk merge 는 middle loop review 의 finalization 통과 후 Caller 가 수행한다.

작업 공간 생성, 정리, 폐기는 Caller 책임이다. inner loop 한정으로 forge 는 매 turn workspace 의 *현 commit* 까지의 상태를 manifest 로 받는다.

### Scope Enforcement

inner loop 의 forge 산출은 다음을 위반하면 그 turn 이 invalid 로 분류되어 같은 session 안에서 재시도된다 (한도는 `loop_policies.inner.tdd_build.max_attempts_per_turn`).

- `acceptance_tests` 변경 (slice contract — `SOC-SLICE-LIFECYCLE` 의 inner loop 절차)
- `declared_scope` 밖 파일 변경
- dependency lockfile 변경 (별도 chore-style internal slice 로 분리 — `SOC-SLICE-CLASS`)

<a id="AGC-ISSUE-BODY"></a>
## AGC-ISSUE-BODY: Persisted Object Body Rendering

Caller 가 Agent artifact 를 영속 저장소의 객체 본문(예: milestone 본문, slice 본문, SliceMerge 본문)에 기록할 때 본문은 두 계층으로 분리된다.

### 두 계층 구조

| 계층 | 대상 독자 | 내용 |
|---|---|---|
| 사람 계층 | 사람 검토자 | Agent 가 산출한 자연어 본문(요약, 시나리오, 결정 근거 등) |
| 기계 계층 | Caller | 상태 마커, 식별자, idempotency key 등 Caller 가 후속 cycle 에서 다시 읽을 메타데이터 |

기계 계층은 사람 본문의 가독성을 해치지 않도록 *접힌(collapsible) 영역* 또는 그에 상응하는 분리된 영역에 위치한다. 사람 계층은 마커 토큰이나 기계 메타데이터를 직접 포함하지 않는다.

### 작성 규칙

- Caller 는 사람 계층을 항상 본문 상단에, 기계 계층을 그 뒤에 배치한다. 객체 외부 도구(브라우저, CLI 미리보기)에서 본문이 잘리는 경우 사람이 우선 보이도록 한다.
- 기계 계층은 Caller 가 후속 cycle 에서 안정적으로 파싱할 수 있는 단일 영역에 모은다. 두 계층의 토큰이 섞이면 invalid 본문으로 간주한다.
- 사람의 수동 편집은 사람 계층에 한정된다. 기계 계층은 Caller 만 갱신한다. 사람이 기계 계층을 편집한 경우 Caller 는 그 본문을 stale 로 판정하고 사람의 governance signal 을 요구한다.

### Agent 책임의 한계

Agent 는 본문의 *사람 계층 콘텐츠* 만 산출한다. 기계 계층의 상태 마커나 식별자는 Agent 가 산출하지 않으며, 이는 `#AGC-OUTPUT-RUNTIME-ENRICH` 의 직접 결과다.

<a id="AGC-INVALID"></a>
## AGC-INVALID: Invalid Output Handling

Caller 는 다음 output 을 invalid 로 판정해야 한다.

- manifest 밖 객체를 참조한 산출 (turn manifest 외 read 포함)
- 필수 envelope 필드가 없는 산출 (특히 `session_id`, `turn_index`, `parent_loop`, `agent_profile_id`, `contribution_kind`)
- revision pin 집합이 누락된 산출
- `(parent_loop, phase_or_purpose, slice_kind, agent_profile_id, contribution_kind)` 셋 중 enum 밖 값을 가진 envelope (slice_kind 는 parent_loop ∈ {middle, inner} 한정)
- `(parent_loop, contribution_kind, output_kind)` 가 `#AGC-CONTRIBUTION-OUTPUTS` 매트릭스의 허용 조합 밖인 envelope
- `session_id` 또는 `turn_index` 가 누락되었거나 같은 호출 안에서 두 contribution 을 겸한 envelope
- (session_id, turn_index) tuple 이 같은 session 의 다른 turn 과 충돌한 envelope (Caller 의 `current_turn_index` CAS 로 사전 차단)
- inner loop 의 `lead_draft` 가 acceptance_tests 변경, declared_scope 밖 파일, lockfile 을 포함한 산출 (`#AGC-WORKSPACE`)
- TDD strict 모드에서 `tdd_phase=red_green` turn 에 직전 verification 이 모두 green (failed[] 빈) 이거나 `tdd_phase=refactor` turn 에 직전 verification 에 red 가 있는 산출 (`SOC-SLICE-LIFECYCLE`)
- legacy `agent_role`, `operation`, `phase_run_id` 필드가 envelope 에 등장한 산출 (본 contract 에서 폐기됨)
- operational side effect 를 직접 수행하려는 산출 (next_action_request 가 *명령* 형태이거나 envelope 의 다른 필드가 trunk merge 등 직접 지시를 포함)
- 비밀 또는 자격증명을 포함한 산출
- 할당 범위 밖 파일 변경을 포함한 산출
- Agent 가 산출한 키와 Caller enrichment 의 키가 충돌한 envelope (`#AGC-OUTPUT-RUNTIME-ENRICH`)
- 두 본문 계층 토큰이 섞인 객체 본문 (`#AGC-ISSUE-BODY`)
- prompt 의 4-part canonical layout 순서·section 누락 또는 header echo 7 필드 불일치 (`#AGC-PROMPT-SERIALIZATION`)
- `caller_routing_decision` 의 `decision_reason` 누락 또는 `decision` enum 외 값 (`#AGC-NEXT-ACTION-REQUEST`)
- `#AGC-TURN-ORDERING` 우선순위 / fairness 위반을 무시하고 진행한 SessionTurn
- 다른 contribution 의 verdict 를 직접 무효화하는 산출 (`#AGC-CONFLICT-RESOLUTION`)
- Caller 의 cap 미적용으로 인해 외부 LLM 이 silent 절단한 envelope (`#AGC-CONTEXT-BUDGET`)

Invalid output 은 FAIL 로 처리되며, retry 한도 정책은 `docs/contracts/reliability-and-gate-contract.md#RGC-FAILURE` 를 따른다.
