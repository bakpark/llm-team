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
| `object_kind` | milestone, task, change_proposal, spec_doc, verification_log, code_tree 등 |
| `object_id` | 영속 저장소의 객체 식별자 |
| `fetch_scope` | Agent가 읽을 수 있는 범위. 본 문서의 fetch scope enum 중 하나. `tree` 는 cwd mount 의미 |
| `revision_pin` | revision/hash/HEAD/updated_at 등 가장 강한 버전 식별자. `code_tree` 진입 시 branch HEAD commit SHA |
| `required` | true면 fetch 실패 시 Agent는 실패 산출을 반환해야 한다 |
| `purpose` | 이 객체를 읽는 이유 |

Agent는 Context Manifest에 없는 객체를 self-fetch하지 않는다. 필요한 컨텍스트가 누락되었으면 임의로 확장하지 않고 `NEED_CONTEXT` 실패 산출을 반환한다.

Caller는 Agent 산출을 영속화하기 직전에 모든 required entry의 revision pin을 재검증한다. 변경이 감지되면 산출을 stale로 판정한다.

### Fetch Scope Enum

`fetch_scope`는 Agent가 entry에서 읽을 수 있는 정보의 깊이를 한정한다. 다음 값 중 하나여야 한다.

| 값 | 허용 범위 |
|---|---|
| `metadata` | 식별자, 상태, 라벨, 마커 등 본문을 제외한 메타데이터 |
| `body` | metadata + 객체 본문 |
| `tree` | 트리 전체 read-only 시야 (cwd 비치). entry 본문은 비어 있으며, Agent는 코드베이스에서 자력 탐색. `revision_pin`은 branch HEAD commit SHA를 의미 |
| `body+comments` | body + 객체에 누적된 코멘트/이력 |

좁은 scope에 충분한 정보가 있는데도 더 넓은 scope을 사용하면 manifest 크기가 불필요하게 커지고, 후속 호출의 입력 결정성이 떨어진다.

### Role별 기본 Scope

호출 prompt 가 별도로 명시하지 않으면 Caller는 다음 기본값을 사용한다.

| 역할 | 기본 scope |
|---|---|
| PO | `body` |
| PM | `body` |
| Planner | `body` |
| Coder | `body` |
| Reviewer | `body+comments` |
| Integrator | `body+comments` |
| QA | `body+comments` |

Reviewer/Integrator/QA가 `body+comments`를 기본으로 갖는 이유는 결정적 검증 결과와 사람의 추가 코멘트가 판단의 1급 입력이기 때문이다.

### 절단(Truncation) 책임

본 contract는 entry당 절대적인 길이 한도를 정의하지 않는다. Caller는 `fetch_scope`에 의해 정해진 의미적 범위 안에서, 어댑터별 한도(컨텍스트 윈도우, 인용 비용)에 맞춰 *수렴적* 절단을 적용할 수 있다.

절단이 적용된 경우 entry는 그 사실을 보존해야 한다. Agent는 절단 표시를 본 채 임의로 외부 self-fetch를 시도하지 않는다.

<a id="AGC-OUTPUT"></a>
## AGC-OUTPUT: Output Contract

모든 Agent output은 공통 envelope를 가져야 한다. 아래 표의 `필수` 값은 Caller enrichment 이후의 canonical envelope 기준이다. Agent 가 직접 산출해야 하는 필수 subset 은 `#AGC-OUTPUT-RUNTIME-ENRICH` 가 분리한다.

| 필드 | 필수 | 의미 |
|---|---|---|
| `output_kind` | yes | `spec_proposal`, `task_plan`, `patch`, `verdict`, `milestone_package`, `failure` 중 하나. enum 값 자체는 본 표가 권위이며 role 별 허용 값은 `#AGC-ROLE-OUTPUTS` 의 매트릭스가 정의한다 |
| `agent_role` | yes | PO, PM, Planner, Coder, Reviewer, Integrator, QA. 각 role은 단일 정합 `output_kind`(또는 `failure`)만 산출하므로, role↔kind 매핑이 enum 검증을 흡수한다 |
| `operation` | yes | Compose-PO, Compose-PM, Decompose, Implement, Review, Refactor, Validate. role↔operation 매핑은 1:1이며 검증은 expected_operation 비교로 흡수된다(역시 enum 자체 검사를 별도로 두지 않는다) |
| `object_id` | yes | 주 처리 대상 객체의 식별자(milestone, task, change_proposal 중 하나). `target` 은 `TCC-IDENTITY` 의 작업 영역 식별자이며 본 envelope 필드와 다른 개념이다 |
| `manifest_id` | yes | 입력 Context Manifest 식별자 |
| `input_revision_pins` | yes | 산출에 사용한 revision pin 집합 |
| `idempotency_key` | caller-enriched yes | Caller 가 enrichment 단계에서 합성하는 envelope idempotency key. 합성 식은 `SOC-OPERATIONS` 가 operation 별로 정의한다 |
| `summary` | yes | 사람이 읽을 수 있는 요약 |
| `artifacts` | conditional | patch, markdown, task specs, CP message 등 산출물 |
| `verdict` | conditional | approve, request-changes, PASS, FAIL 등 |
| `failure` | conditional | 실패 종류와 근거 |
| `runtime_metadata` | conditional | Caller 가 enrichment 단계에서 후주입하는 키-값 영역. 채우는 키는 `#AGC-OUTPUT-RUNTIME-ENRICH` 의 매트릭스가 정의한다. Agent 는 본 영역을 산출하지 않는다 |

Agent output은 operational side effect를 포함하지 않는다. `merge`, `close_issue`, `set_label`, `notify`, `lease_expire` 같은 실행 지시는 허용되지 않는다. 필요하면 `recommended_outcome`으로 판단만 표현한다.

<a id="AGC-OUTPUT-RUNTIME-ENRICH"></a>
## AGC-OUTPUT-RUNTIME-ENRICH: Runtime Metadata Enrichment

본 절은 Agent envelope 의 *콘텐츠 필드(Agent 가 산출)* 와 *runtime metadata 필드(Caller 가 영속 저장소 작업 후 후주입)* 의 권한 경계를 정정한다. `llm-team.md` Inv#3 (caller-only operational write) 의 직접 결과로, Agent 는 영속 저장소가 발급하거나 Caller 의 operational write 시점에 비로소 결정되는 식별자를 알 수 없으며 알아서도 안 된다.

### 분리 원칙 (MUST)

- Agent 는 AGC-OUTPUT 이 정의한 Agent-authored envelope 필드와 *콘텐츠* 성격의 artifact 만 산출한다. 콘텐츠는 manifest 와 prompt 만 보고 결정 가능한 정보를 의미한다. `idempotency_key` 와 `runtime_metadata` 는 Agent-authored subset 에 포함되지 않는다.
- runtime metadata 는 영속 저장소 작업의 *결과* 로만 결정된다. Agent 가 산출하지 않으며, Caller 가 envelope 의 별도 영역에 후주입한다.
- runtime metadata 누락은 envelope invalid 사유가 아니다. enrichment 자체가 실패하면 결과는 RGC-LEDGER 의 실패 분류에 따라 기록한다.

### Producer / Enricher 매트릭스

| 역할 | Agent 산출(콘텐츠) | Caller 후주입(runtime metadata) |
|---|---|---|
| PO | spec / research 본문, 요약 | Spec CP 식별자 |
| PM | 시나리오, 수용 기준, AC-ID | Spec CP 식별자 |
| Planner | task 본문(slug, 의존, AC 매핑), 통합 브랜치 명세 | task 객체 식별자, 통합 브랜치 HEAD |
| Coder | patch, CP message | Code CP 식별자, source revision pin, review 대상 식별자 |
| Reviewer | verdict, 근거 | review 대상 식별자, source revision pin(stale 비교 기준), Code CP 식별자 |
| Integrator | verdict, Integration CP message(있을 때) | Integration CP 식별자(있을 때), 통합 브랜치 HEAD |
| QA | verdict, 마일스톤 본문, Context Summary, AC 결과, 책임 task 식별 | Milestone CP 식별자, release 식별자(있을 때) |

콘텐츠 필드의 구체 이름과 verdict enum 은 SOC-OPERATIONS 와 AGC-ROLE-OUTPUTS 가 정의한다. runtime metadata 의 구체 형태(번호 / 경로 / SHA 등)는 영속 저장소 어댑터가 결정한다. 본 매트릭스는 *역할별 책임 분리* 만 표현한다.

### Caller Enrichment 규칙

- Caller 는 envelope 파싱 직후 AGC-INVALID 검증 *이전* 에 enrichment 를 수행한다. enrichment 이전의 preflight parser 는 JSON 파싱, role/operation/manifest 정합성, side-effect 금지처럼 Agent-authored subset 만 검증한다.
- Enrichment 결과는 envelope 의 `runtime_metadata` 영역(AGC-OUTPUT 의 conditional 필드)에 키-값으로 누적된다. Agent 가 산출한 envelope 의 다른 필드를 덮어쓰지 않는다. 같은 키가 양쪽에 존재하면 invalid 로 판정한다.
- Enrichment 의 입력은 manifest 와 영속 저장소에 즉시 질의 가능한 lookup 으로 제한된다. 새로운 Agent 호출이나 사람의 결정에 의존하지 않는다.
- Enrichment 이후 envelope 은 불변으로 취급한다. side-effect 와 ledger 기록 단계에서 재변형하지 않는다.

### envelope.idempotency_key 의 producer

`AGC-OUTPUT` envelope 의 `idempotency_key` 는 Agent 가 산출하지 않는다. `SOC-OPERATIONS` 의 operation 별 idempotency_key 식은 일부 항이 runtime metadata(예: 영속 저장소가 발급한 식별자, 통합 단위 HEAD)에 의존하므로 Agent 의 manifest 만으로는 합성할 수 없다.

Caller 는 enrichment 단계에서 SOC-OPERATIONS 의 식에 따라 envelope idempotency key 를 합성하여 `idempotency_key` 의 표준 위치에 기입한다. Agent 가 어떤 형태로든 이 필드를 산출했다면 Caller 는 이를 pre-enrichment invalid 로 판정하고 자체 합성 결과로 덮어쓰지 않는다.

### 위반 처리

- Agent 가 runtime metadata 필드 또는 envelope idempotency key 를 산출한 경우 Caller 는 invalid 로 판정한다. Caller 는 Agent-authored 값을 자체 lookup 결과로 덮어쓰지 않는다.
- Caller enrichment 자체가 실패한 경우 envelope 은 미완성으로 간주하고 side-effect 를 수행하지 않는다. 결과는 RGC-LEDGER 의 실패 분류에 따라 기록한 뒤 lease 를 해제한다.

<a id="AGC-ROLE-OUTPUTS"></a>
## AGC-ROLE-OUTPUTS: Role-Specific Outputs

- PO output은 마일스톤 본문과 도메인 리서치 스펙 변경 제안을 포함한다.
- PM output은 시나리오, 수용 기준, AC-ID를 포함한다.
- Planner output은 Task 본문, Task slug, AC-ID mapping, dependency graph, 통합 브랜치 명세를 포함한다.
- Coder output은 격리 작업 공간 diff와 변경 제안 메시지를 포함한다.
- Reviewer output은 결정적 검증 로그 해석, approve/request-changes verdict, 근거를 포함한다.
- Integrator output은 통합 변경 제안 또는 no-op 근거, self-test verdict를 포함한다.
- QA output은 마일스톤 변경 제안, AC별 PASS/FAIL, 책임 Task 식별, Context Summary를 포함한다.

### Role × Output Kind × Verdict

본 매트릭스는 `AGC-OUTPUT` 의 `output_kind` enum 검증 위치다. `failure` 는 모든 role 에서 허용되며, 이 경우 `failure` 필드가 필수이고 Caller 는 operational side effect 없이 `#AGC-INVALID` / `#RGC-FAILURE` 정책으로 분류한다.

| Operation | Role | 정합 `output_kind` | verdict / artifact 제약 |
|---|---|---|---|
| Compose-PO | PO | `spec_proposal` | `verdict` 없음. 마일스톤 본문과 도메인 리서치 스펙 CP 본문을 artifact 로 산출 |
| Compose-PM | PM | `spec_proposal` | `verdict` 없음. 시나리오와 AC-ID 목록을 artifact 로 산출 |
| Decompose | Planner | `task_plan` | `verdict` 없음. task 본문, dependency graph, 통합 브랜치 명세를 artifact 로 산출 |
| Implement | Coder | `patch` | `verdict` 없음. 격리 작업 공간 diff 또는 CP message 를 artifact 로 산출 |
| Review | Reviewer | `verdict` | `verdict.result` 는 `approve` 또는 `request-changes` |
| Refactor | Integrator | `milestone_package` | `verdict.result` 는 `PASS`, `FAIL`, `STALE` 중 하나. no-op 은 `PASS` 와 CP message 부재로 표현하고 `summary` 에 근거를 둔다 |
| Validate | QA | `milestone_package` | `verdict.result` 는 `PASS`, `FAIL`, `STALE` 중 하나. `PASS` 는 Context Summary 를 포함해야 한다 |

<a id="AGC-WORKSPACE"></a>
## AGC-WORKSPACE: Workspace Rules

Agent는 영속 저장소에 직접 쓰지 않는다. 단, Caller가 할당한 격리 작업 공간 내부 파일은 임시 산출 매개체로 수정할 수 있다.

작업 공간 변경은 Caller가 diff를 수집해 Change Proposal로 영속화한 시점에만 workflow에 진입한다. 작업 공간 생성, 정리, 폐기는 Caller 책임이다.

<a id="AGC-ISSUE-BODY"></a>
## AGC-ISSUE-BODY: Persisted Object Body Rendering

Caller가 Agent artifact를 영속 저장소의 객체 본문(예: 마일스톤 본문, Task 본문)에 기록할 때 본문은 두 계층으로 분리된다.

### 두 계층 구조

| 계층 | 대상 독자 | 내용 |
|---|---|---|
| 사람 계층 | 사람 검토자 | Agent가 산출한 자연어 본문(요약, 시나리오, 결정 근거 등) |
| 기계 계층 | Caller | 상태 마커, 식별자, idempotency key 등 Caller가 후속 cycle에서 다시 읽을 메타데이터 |

기계 계층은 사람 본문의 가독성을 해치지 않도록 *접힌(collapsible) 영역* 또는 그에 상응하는 분리된 영역에 위치한다. 사람 계층은 마커 토큰이나 기계 메타데이터를 직접 포함하지 않는다.

### 작성 규칙

- Caller는 사람 계층을 항상 본문 상단에, 기계 계층을 그 뒤에 배치한다. 객체 외부 도구(브라우저, CLI 미리보기)에서 본문이 잘리는 경우 사람이 우선 보이도록 한다.
- 기계 계층은 Caller가 후속 cycle에서 안정적으로 파싱할 수 있는 단일 영역에 모은다. 두 계층의 토큰이 섞이면 invalid 본문으로 간주한다.
- 사람의 수동 편집은 사람 계층에 한정된다. 기계 계층은 Caller만 갱신한다. 사람이 기계 계층을 편집한 경우 Caller는 그 본문을 stale로 판정하고 사람의 governance signal을 요구한다.

### Agent 책임의 한계

Agent는 본문의 *사람 계층 콘텐츠* 만 산출한다. 기계 계층의 상태 마커나 식별자는 Agent가 산출하지 않으며, 이는 `#AGC-OUTPUT-RUNTIME-ENRICH`의 직접 결과다.

<a id="AGC-INVALID"></a>
## AGC-INVALID: Invalid Output Handling

Caller는 다음 output을 invalid로 판정해야 한다.

- manifest 밖 객체를 참조한 산출
- 필수 envelope 필드가 없는 산출
- revision pin 집합이 누락된 산출
- operational side effect를 직접 수행하려는 산출
- 비밀 또는 자격증명을 포함한 산출
- 할당 범위 밖 파일 변경을 포함한 산출
- Agent 가 산출한 키와 Caller enrichment 의 키가 충돌한 envelope (`#AGC-OUTPUT-RUNTIME-ENRICH`)
- 두 본문 계층 토큰이 섞인 객체 본문 (`#AGC-ISSUE-BODY`)

Invalid output은 FAIL로 처리되며, retry 한도 정책은 `docs/contracts/reliability-and-gate-contract.md#RGC-FAILURE`를 따른다.
