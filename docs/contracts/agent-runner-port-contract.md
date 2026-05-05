# Agent Runner Port Contract

본 문서는 Caller 가 Agent 를 호출하기 위해 사용하는 *포트* 의 시그니처와 호출 의미를 정의한다. 본 contract 는 *어떤 정보가 오가는가* 보다 *어떻게 오가는가* 에 집중한다. 호출의 *내용* 은 `docs/contracts/agent-and-context-contract.md` 가 정의한다.

권한 경계는 `llm-team.md` 가 우선한다. target 단위로 어느 adapter 가 어느 AgentProfile 에 매핑되는가는 `docs/contracts/target-config-contract.md#TCC-AGENT-PROFILES` 가 정의한다.

<a id="ARC-SCOPE"></a>
## ARC-SCOPE: Scope

이 문서의 authoritative scope 는 다음이다.

- agent runner 포트의 시그니처 (turn 단위 호출, session 컨텍스트 포함)
- 호출의 결정성과 멱등성 (3-scope: per-turn / per-session-outcome / per-merge)
- 실패 분류와 retry 정책의 통합 지점
- adapter 교체 시 invariant
- AGC vs ARC 책임 분리 (semantic vs transport)

본 문서는 특정 LLM 제공자나 CLI 를 명시하지 않는다.

### AGC vs ARC 책임 분리

본 contract 는 *transport-level* 만 다룬다. envelope 의 semantic (필드 의미, 권한 경계, contribution_kind 별 산출) 은 AGC 가 단일 권위.

| 영역 | 권위 |
|---|---|
| envelope 필드 의미 / enum / 산출 매트릭스 | AGC |
| envelope encoding / 전송 / stdin / exit_status | ARC |
| 멱등성 식 합성 항 (의미) | AGC + SOC |
| 멱등성 식 적용 (transport-level dedup) | ARC |

<a id="ARC-PORT-SIGNATURE"></a>
## ARC-PORT-SIGNATURE: Port Signature

agent runner 는 다음 입력을 받아 다음 출력을 반환하는 단일 호출 함수다. 한 호출은 한 SessionTurn 이다.

### 입력

| 항목 | 의미 |
|---|---|
| `agent_profile_id` | 호출 대상 AgentProfile id (`atlas`, `forge`, `sentinel`, `scout`, `human` 중 하나) |
| `session_id` | 본 호출이 속한 DialogueSession 식별자 |
| `turn_index` | session-local turn 인덱스. (session_id, turn_index) 가 globally unique |
| `parent_loop` | `outer` / `middle` / `inner` 중 하나. envelope 메타로 pass-through |
| `purpose` | session purpose. envelope 메타로 pass-through |
| `agent_role_in_session` | `lead` / `reviewer` / `observer` 중 하나 |
| `session_context_ref` | 직전 turn_log_snapshot + 직전 verification_result 의 합성 참조 — Caller 가 manifest 와 함께 영속화한 file/IO 위치. adapter 는 본 ref 를 자체적으로 fetch 하지 않으며, 본 ref 가 가리키는 본문이 prompt stdin 에 합성되어 전달됨 |
| `manifest_id` | 사용할 Context Manifest 의 식별자 |
| `prompt_ref` | `(loop, phase|purpose, contribution_kind, agent_profile)` 에 대응하는 prompt 의 식별자 |
| `agent_cwd` | Agent 가 작업 공간으로 사용할 격리된 위치의 식별자 (필요한 contribution 에 한함, 예: inner tdd_build) |
| `timeout` | 호출 전체 시간 한도 |
| `idempotency_key` | 같은 입력에 대한 재호출 식별자. 합성 식은 `#ARC-IDEMPOTENCY` 의 per-turn scope |

legacy `phase_run_id`, `agent_role`, `operation` 입력은 폐기되었다.

### 출력

| 항목 | 의미 |
|---|---|
| `exit_status` | 호출의 종료 분류 |
| `envelope_ref` | Agent 가 산출한 envelope 의 위치 |
| `diagnostics_ref` | 표준 오류·진단 출력의 위치 |
| `consumed_at` | 호출 종료 시각 |

`envelope_ref` 가 가리키는 본문의 형식과 필수 필드 (특히 `session_id`, `turn_index`, `parent_loop`, `agent_profile_id`, `contribution_kind`) 는 `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT` 가 정의한다. 본 contract 는 envelope 의 *콘텐츠* 를 정의하지 않는다.

`prompt_ref` 는 prompt 본문에 대한 참조다. caller 는 prompt 본문을 생성하여 참조 가능한 위치에 둔 뒤 그 식별자를 입력으로 전달한다. adapter 는 `prompt_ref` 와 `session_context_ref` 의 본문을 합성한 뒤 stdin 으로 받는다 (`#ARC-CALL-SEMANTICS`).

`exit_status`, `envelope_ref`, `diagnostics_ref`, `consumed_at` 4개 출력은 *호출 단위로 항상 함께* 생성된다. 호출이 비정상 종료한 경우에도 `exit_status` 는 `#ARC-EXIT-CLASSES` 의 enum 중 하나로 분류되며, `diagnostics_ref` 는 adapter 의 stderr 를 보존한다.

<a id="ARC-CALL-SEMANTICS"></a>
## ARC-CALL-SEMANTICS: Call Semantics

- 한 호출은 단일 stateless 호출이며 단일 SessionTurn 을 생산한다. 호출 사이에 adapter 가 상태를 누적하면 invariant 위반이다.
- session 안 multi-turn 의 합성은 Caller 가 `session_context_ref` 의 본문을 통해 한다. adapter 는 session 자체의 state 를 보유하지 않는다.
- adapter 는 입력의 의미를 임의로 확장하지 않는다. 예를 들어 `agent_cwd` 외부의 파일을 Agent 에게 노출시키지 않는다.
- adapter 는 출력에 *Caller 가 요청하지 않은 부작용* 을 첨부하지 않는다. envelope 과 diagnostics 외의 영속 저장소 write 는 금지된다.
- 호출 시간 한도 (`timeout`) 도달 시 adapter 는 호출을 중단하고 `timeout` 분류로 종료한다. 부분 envelope 은 출력하지 않거나, 부분임을 명시적으로 표시한다.
- prompt 본문 + `session_context_ref` 본문은 stdin 으로 adapter 에 전달된다. argv 경유 전달은 ARG_MAX 한계로 인해 금지된다.
- adapter 는 `next_action_request` 필드를 envelope 안에 그대로 보존하여 Caller 에 반환한다. routing 결정은 Caller 가 한다 (`docs/contracts/agent-and-context-contract.md#AGC-NEXT-ACTION-REQUEST`).

<a id="ARC-EXIT-CLASSES"></a>
## ARC-EXIT-CLASSES: Exit Classification

`exit_status` 는 다음 중 하나로 분류된다.

| 값 | 의미 |
|---|---|
| `ok` | adapter 가 정상 종료. envelope 본문은 별도로 검증 필요 |
| `timeout` | 호출 시간 한도 초과 |
| `transport_error` | adapter 외부 통신 또는 인프라 실패 |
| `adapter_unavailable` | adapter 자체가 사용 불가(설치되지 않음, 인증 만료 등) |
| `malformed_output` | envelope 본문이 파싱조차 불가능 |

`ok` 후의 envelope 검증(필수 필드, 권한 경계, revision pin 재검증) 은 `#AGC-OUTPUT`, `#AGC-OUTPUT-RUNTIME-ENRICH`, `#AGC-INVALID` 가 정의한다. `ok` 가 곧 성공을 의미하지는 않는다.

`#RGC-FAILURE` 의 STALE/FAIL/ESCALATED 분류는 `exit_status` 와 envelope 검증 결과를 종합해 도출된다.

분류는 두 단계로 이루어진다. 1) adapter 는 자신이 알 수 있는 종료 사유 (빈 prompt, 미발견 binary, 매칭 fixture 부재 등) 를 결정적인 raw 종료 코드로 표현한다. 2) port 경계의 helper (`lr_classify_exit`) 가 raw 코드를 enum 으로 매핑한다. 매핑되지 않는 코드는 `transport_error` 로 흡수된다 (`#ARC-FAILURE-MODES`).

<a id="ARC-IDEMPOTENCY"></a>
## ARC-IDEMPOTENCY: Idempotency — 3 Scope

같은 입력에 대한 호출 반복은 다음 3 scope 로 분리된다 (`docs/contracts/state-and-operation-contract.md#SOC-IDEMPOTENCY`).

### Per-Turn (transport-level dedup)

agent runner 호출 1회의 멱등성. tuple:

```text
(agent_profile_id, session_id, turn_index, manifest_id, idempotency_key)
```

- 선행 호출이 `ok` 로 완료되었으면 adapter 를 다시 호출하지 않고 선행 envelope 을 사용한다.
- 선행 호출이 비-`ok` 이거나 부분 종료한 경우 새 호출을 시도할 수 있으며, 새 호출의 ledger 기록은 별개의 transition 으로 간주된다.
- (session_id, turn_index) tuple 의 atomic CAS (turn_index 의 CAS — `#RGC-LEASE-KINDS`) 가 동일 turn 의 동시 호출을 차단.

### Per-Session-Outcome (session 종료 응축)

DialogueSession 의 final artifact 응축의 멱등성. tuple:

```text
(session_id, final_verdict, finalization_decision, workspace_revision_pin_at_convergence)
```

같은 tuple 로 두 번 응축이 시도되면 같은 session_outcome 이 산출되어야 한다 — `application/dialogue_coordinator.sh` 가 책임지는 영역. adapter 는 이 scope 를 보지 않는다.

### Per-Merge (SliceMerge trunk merge)

SliceMerge 의 trunk merge 의 멱등성. tuple:

```text
(slice_merge_id, pre_merge_workspace_revision, trunk_base_revision_at_merge_attempt)
```

같은 tuple 로 두 번 merge 시도되면 같은 trunk SHA 가 산출되어야 한다 — Caller 의 trunk merge step 이 책임지는 영역. adapter 는 이 scope 를 보지 않는다.

### 적용 책임

- per-turn: adapter 가 호출 직전에 ledger lookup. 선행 `ok` 발견 시 adapter 호출 skip.
- per-session-outcome: dialogue_coordinator 가 session_outcome 영속화 직전에 ledger lookup.
- per-merge: trunk merge 직전에 ledger lookup.

adapter 자체는 idempotency 보장을 하지 않는다. 3-scope idempotency 는 ledger 와 Caller 가 종합한다.

<a id="ARC-ADAPTER-SUBSTITUTION"></a>
## ARC-ADAPTER-SUBSTITUTION: Adapter Substitution

같은 `agent_profile_id` 에 대해 두 개 이상의 adapter 가 후보가 될 수 있다. 어떤 adapter 가 사용될지는 `docs/contracts/target-config-contract.md#TCC-AGENT-PROFILES` 가 결정한다.

adapter 교체 시 다음 invariant 는 깨지지 않아야 한다.

- 동일 envelope 형식과 필드 의미 (`#AGC-OUTPUT`)
- 동일 입력 (manifest + session_context_ref + prompt) 에 대한 *결과의 분포* 가 비교 가능. 즉, 같은 입력으로 호출했을 때 한 adapter 는 정상 종료하고 다른 adapter 는 항상 `malformed_output` 이라면 그 adapter 는 본 contract 를 만족하지 못한다.
- 동일 timeout 입력에 대해 timeout 동작이 동일

이 invariant 는 *콘텐츠 품질의 동일성* 을 의미하지 않는다. 응답 품질의 차이는 운영 결정이며, 모델 평가의 영역이다. 본 contract 는 *포트 수준의 호환성* 만 보증한다.

<a id="ARC-FAILURE-MODES"></a>
## ARC-FAILURE-MODES: Failure Mode Surface

adapter 는 자신이 회복 불가능하다고 판단한 경우에도 `exit_status` 로 분류 가능한 형태로 종료해야 한다. 분류 불가능한 종료 (예: 프로세스 강제 종료) 는 호출자가 timeout 과 transport_error 두 분류 중 하나로 흡수한다.

adapter 는 자기 진단을 위한 *부가* 정보를 `diagnostics_ref` 로 노출할 수 있으며, 이 정보는 운영 분석에 사용된다. envelope 본문은 `diagnostics_ref` 에 의존하지 않는다.
