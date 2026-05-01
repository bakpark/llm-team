# Agent and Context Contract

본 문서는 Agent 역할, Context Manifest, revision pin, Agent output 형식을 정의한다. 최상위 원칙은 `llm-team.md`가 우선한다.

<a id="AGC-SCOPE"></a>
## AGC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- Agent 역할별 입력과 산출
- Caller → Agent 호출 경계
- Context Manifest와 revision pin
- Agent output envelope
- self-fetch, workspace write, secret handling

상태 전이와 operation별 Caller action은 `docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`가 정의한다. lease, retry, human gate는 `docs/contracts/reliability-and-gate-contract.md`가 정의한다.

<a id="AGC-ROLES"></a>
## AGC-ROLES: Agent Roles

| 역할 | 입력 | 산출 |
|---|---|---|
| PO | 사람 트리거 / 후속 마일스톤 트리거 + 누적 스펙 manifest | 마일스톤 본문 변경 제안 + 누적 도메인 리서치 변경 제안 |
| PM | 게이트 통과한 마일스톤 본문 + 누적 스펙 | 시나리오 스펙 변경 제안(시나리오 + 수용 기준) |
| Planner | 게이트 통과한 마일스톤 + 시나리오 스펙 | Task Issue 본문 N개 + 통합 브랜치 명세 + 의존 그래프 |
| Coder | Task Issue 1개 + 격리 작업 공간 식별자 + 통합 브랜치 base revision pin | 격리 작업 공간 내 코드 patch + 코드 변경 제안 메시지 |
| Reviewer | 코드 변경 제안 1개 + 결정적 검증 로그 | approve / request-changes 결정문 + 근거 |
| Integrator | 모든 자식 Task가 통합된 통합 브랜치 + 결정적 검증 로그 | 통합 변경 제안(필요 시) + self-test PASS/FAIL 결정문 |
| QA | Refactor PASS된 통합 브랜치 + 시나리오 스펙 + 결정적 검증 로그 | 마일스톤 변경 제안 + Context Summary + 종합 수용 기준 PASS/FAIL 결정문 |

한 Agent 호출은 한 역할과 한 operation에만 대응한다. 한 호출이 두 역할의 책임을 겸하지 않는다.

<a id="AGC-CALL-BOUNDARY"></a>
## AGC-CALL-BOUNDARY: Caller-Agent Boundary

Caller가 Agent에 제공하는 것은 다음으로 제한된다.

- operation 이름
- 대상 객체 식별자
- 산출 위치 식별자
- Context Manifest
- 읽기 도구 권한
- 필요한 경우 격리 작업 공간 식별자

Caller는 긴 컨텍스트 본문을 직접 주입하지 않는다. Agent는 Context Manifest를 통해 self-fetch하여 컨텍스트를 재구성한다.

Agent가 Caller에 반환하는 것은 콘텐츠다. Agent는 operational transition을 실행하지 않고, 상태 변경을 요구하는 명령도 내리지 않는다. 필요한 경우 `recommended_outcome` 또는 `verdict`로 판단만 반환한다.

<a id="AGC-CONTEXT-MANIFEST"></a>
## AGC-CONTEXT-MANIFEST: Context Manifest

Context Manifest는 Caller가 Agent 호출 전에 생성하는 읽기 대상 목록이다.

필수 필드:

| 필드 | 의미 |
|---|---|
| `manifest_id` | 호출 단위 manifest 식별자 |
| `operation` | 호출할 operation |
| `target` | 주 처리 대상 객체 |
| `entries` | self-fetch 가능한 객체 목록 |
| `created_at` | manifest 생성 시각 |

각 `entries` 항목은 다음 필드를 갖는다.

| 필드 | 의미 |
|---|---|
| `object_kind` | milestone, task, change_proposal, spec_doc, verification_log 등 |
| `object_id` | 영속 저장소의 객체 식별자 |
| `fetch_scope` | Agent가 읽을 수 있는 범위 |
| `revision_pin` | revision/hash/HEAD/updated_at 등 가장 강한 버전 식별자 |
| `required` | true면 fetch 실패 시 Agent는 실패 산출을 반환해야 한다 |
| `purpose` | 이 객체를 읽는 이유 |

Agent는 Context Manifest에 없는 객체를 self-fetch하지 않는다. 필요한 컨텍스트가 누락되었으면 임의로 확장하지 않고 `NEED_CONTEXT` 실패 산출을 반환한다.

Caller는 Agent 산출을 영속화하기 직전에 모든 required entry의 revision pin을 재검증한다. 변경이 감지되면 산출을 stale로 판정한다.

<a id="AGC-OUTPUT"></a>
## AGC-OUTPUT: Output Contract

모든 Agent output은 공통 envelope를 가져야 한다.

| 필드 | 필수 | 의미 |
|---|---|---|
| `output_kind` | yes | `spec_proposal`, `task_plan`, `patch`, `verdict`, `milestone_package`, `failure` 등 |
| `agent_role` | yes | PO, PM, Planner, Coder, Reviewer, Integrator, QA |
| `operation` | yes | Compose-PO, Compose-PM, Decompose, Implement, Review, Refactor, Validate |
| `target_id` | yes | 주 처리 대상 객체 |
| `manifest_id` | yes | 입력 Context Manifest 식별자 |
| `input_revision_pins` | yes | 산출에 사용한 revision pin 집합 |
| `idempotency_key` | yes | Caller가 중복 산출을 식별하는 키 |
| `summary` | yes | 사람이 읽을 수 있는 요약 |
| `artifacts` | conditional | patch, markdown, task specs, CP message 등 산출물 |
| `verdict` | conditional | approve, request-changes, PASS, FAIL 등 |
| `failure` | conditional | 실패 종류와 근거 |

Agent output은 operational side effect를 포함하지 않는다. `merge`, `close_issue`, `set_label`, `notify`, `lease_expire` 같은 실행 지시는 허용되지 않는다. 필요하면 `recommended_outcome`으로 판단만 표현한다.

<a id="AGC-ROLE-OUTPUTS"></a>
## AGC-ROLE-OUTPUTS: Role-Specific Outputs

- PO output은 마일스톤 본문과 도메인 리서치 스펙 변경 제안을 포함한다.
- PM output은 시나리오, 수용 기준, AC-ID를 포함한다.
- Planner output은 Task 본문, Task slug, AC-ID mapping, dependency graph, 통합 브랜치 명세를 포함한다.
- Coder output은 격리 작업 공간 diff와 변경 제안 메시지를 포함한다.
- Reviewer output은 결정적 검증 로그 해석, approve/request-changes verdict, 근거를 포함한다.
- Integrator output은 통합 변경 제안 또는 no-op 근거, self-test verdict를 포함한다.
- QA output은 마일스톤 변경 제안, AC별 PASS/FAIL, 책임 Task 식별, Context Summary를 포함한다.

<a id="AGC-WORKSPACE"></a>
## AGC-WORKSPACE: Workspace Rules

Agent는 영속 저장소에 직접 쓰지 않는다. 단, Caller가 할당한 격리 작업 공간 내부 파일은 임시 산출 매개체로 수정할 수 있다.

작업 공간 변경은 Caller가 diff를 수집해 Change Proposal로 영속화한 시점에만 workflow에 진입한다. 작업 공간 생성, 정리, 폐기는 Caller 책임이다.

<a id="AGC-INVALID"></a>
## AGC-INVALID: Invalid Output Handling

Caller는 다음 output을 invalid로 판정해야 한다.

- manifest 밖 객체를 참조한 산출
- 필수 envelope 필드가 없는 산출
- revision pin 집합이 누락된 산출
- operational side effect를 직접 수행하려는 산출
- 비밀 또는 자격증명을 포함한 산출
- 할당 범위 밖 파일 변경을 포함한 산출

Invalid output은 FAIL로 처리되며, retry 한도 정책은 `docs/contracts/reliability-and-gate-contract.md#RGC-FAILURE`를 따른다.
