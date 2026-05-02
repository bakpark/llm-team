# Agent Runner Port Contract

본 문서는 Caller가 Agent를 호출하기 위해 사용하는 *포트* 의 시그니처와 호출 의미를 정의한다. 본 contract는 *어떤 정보가 오가는가* 보다 *어떻게 오가는가* 에 집중한다. 호출의 *내용* 은 `docs/contracts/agent-and-context-contract.md`가 정의한다.

권한 경계는 `llm-team.md`가 우선한다. target 단위로 어느 adapter가 어느 역할에 매핑되는가는 `docs/contracts/target-config-contract.md#TCC-AGENT-RUNNER-MAP`가 정의한다.

<a id="ARC-SCOPE"></a>
## ARC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- agent runner 포트의 시그니처
- 호출의 결정성과 멱등성
- 실패 분류와 retry 정책의 통합 지점
- adapter 교체 시 invariant

본 문서는 특정 LLM 제공자나 CLI를 명시하지 않는다. 그것은 architecture 영역이 결정한다.

<a id="ARC-PORT-SIGNATURE"></a>
## ARC-PORT-SIGNATURE: Port Signature

agent runner는 다음 입력을 받아 다음 출력을 반환하는 단일 호출 함수다.

### 입력

| 항목 | 의미 |
|---|---|
| `role` | 호출 대상 Agent의 역할 |
| `operation` | 수행할 operation |
| `manifest_id` | 사용할 Context Manifest의 식별자 |
| `prompt_ref` | 역할·operation에 대응하는 prompt의 식별자 |
| `agent_cwd` | Agent가 작업 공간으로 사용할 격리된 위치의 식별자(필요한 역할에 한함) |
| `timeout` | 호출 전체 시간 한도 |
| `idempotency_key` | 같은 입력에 대한 재호출 식별자 |

### 출력

| 항목 | 의미 |
|---|---|
| `exit_status` | 호출의 종료 분류 |
| `envelope_ref` | Agent가 산출한 envelope의 위치 |
| `diagnostics_ref` | 표준 오류·진단 출력의 위치 |
| `consumed_at` | 호출 종료 시각 |

`envelope_ref`가 가리키는 본문의 형식과 필수 필드는 `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`가 정의한다. 본 contract는 envelope의 *콘텐츠* 를 정의하지 않는다.

<a id="ARC-CALL-SEMANTICS"></a>
## ARC-CALL-SEMANTICS: Call Semantics

- 한 호출은 단일 stateless 호출이다. 호출 사이에 adapter가 상태를 누적하면 invariant 위반이다.
- adapter는 입력의 의미를 임의로 확장하지 않는다. 예를 들어 `agent_cwd` 외부의 파일을 Agent에게 노출시키지 않는다.
- adapter는 출력에 *Caller가 요청하지 않은 부작용* 을 첨부하지 않는다. envelope과 diagnostics 외의 영속 저장소 write는 금지된다.
- 호출 시간 한도(`timeout`) 도달 시 adapter는 호출을 중단하고 `timeout` 분류로 종료한다. 부분 envelope은 출력하지 않거나, 부분임을 명시적으로 표시한다.

<a id="ARC-EXIT-CLASSES"></a>
## ARC-EXIT-CLASSES: Exit Classification

`exit_status`는 다음 중 하나로 분류된다.

| 값 | 의미 |
|---|---|
| `ok` | adapter가 정상 종료. envelope 본문은 별도로 검증 필요 |
| `timeout` | 호출 시간 한도 초과 |
| `transport_error` | adapter 외부 통신 또는 인프라 실패 |
| `adapter_unavailable` | adapter 자체가 사용 불가(설치되지 않음, 인증 만료 등) |
| `malformed_output` | envelope 본문이 파싱조차 불가능 |

`ok` 후의 envelope 검증(필수 필드, 권한 경계, revision pin 재검증)은 `#AGC-OUTPUT`, `#AGC-OUTPUT-RUNTIME-ENRICH`, `#AGC-INVALID`가 정의한다. `ok`가 곧 성공을 의미하지는 않는다.

`#RGC-FAILURE`의 STALE/FAIL/ESCALATED 분류는 `exit_status`와 envelope 검증 결과를 종합해 도출된다.

<a id="ARC-IDEMPOTENCY"></a>
## ARC-IDEMPOTENCY: Idempotency

같은 `(role, operation, manifest_id, idempotency_key)` 튜플로 호출이 반복된 경우 Caller는 ledger에서 선행 호출 기록을 확인한다.

- 선행 호출이 `ok`로 완료되었으면 adapter를 다시 호출하지 않고 선행 envelope을 사용한다.
- 선행 호출이 비-`ok`이거나 부분 종료한 경우 새 호출을 시도할 수 있으며, 새 호출의 ledger 기록은 별개의 transition으로 간주된다.

adapter 자체는 idempotency 보장을 하지 않는다. idempotency는 ledger와 Caller가 종합한다.

<a id="ARC-ADAPTER-SUBSTITUTION"></a>
## ARC-ADAPTER-SUBSTITUTION: Adapter Substitution

같은 `role`에 대해 두 개 이상의 adapter가 후보가 될 수 있다. 어떤 adapter가 사용될지는 `docs/contracts/target-config-contract.md#TCC-AGENT-RUNNER-MAP`가 결정한다.

adapter 교체 시 다음 invariant는 깨지지 않아야 한다.

- 동일 envelope 형식과 필드 의미(`#AGC-OUTPUT`)
- 동일 입력에 대한 *결과의 분포* 가 비교 가능. 즉, 같은 manifest로 호출했을 때 한 adapter는 정상 종료하고 다른 adapter는 항상 `malformed_output`이라면 그 adapter는 본 contract를 만족하지 못한다.
- 동일 timeout 입력에 대해 timeout 동작이 동일

이 invariant는 *콘텐츠 품질의 동일성* 을 의미하지 않는다. 응답 품질의 차이는 운영 결정이며, 모델 평가의 영역이다. 본 contract는 *포트 수준의 호환성* 만 보증한다.

<a id="ARC-FAILURE-MODES"></a>
## ARC-FAILURE-MODES: Failure Mode Surface

adapter는 자신이 회복 불가능하다고 판단한 경우에도 `exit_status`로 분류 가능한 형태로 종료해야 한다. 분류 불가능한 종료(예: 프로세스 강제 종료)는 호출자가 timeout과 transport_error 두 분류 중 하나로 흡수한다.

adapter는 자기 진단을 위한 *부가* 정보를 `diagnostics_ref`로 노출할 수 있으며, 이 정보는 운영 분석에 사용된다. envelope 본문은 `diagnostics_ref`에 의존하지 않는다.
