# Target Configuration Contract

본 문서는 Caller 가 다루는 *target* 의 설정 스키마를 정의한다. target 은 영속 저장소의 한 작업 영역에 대응하는 식별 단위이며, Caller 의 큐·lease·onboarding·AgentProfile 레지스트리·phase policy 가 모두 target 단위로 분기된다.

권한 경계는 `llm-team.md`가 우선한다. AgentProfile / Phase / Contribution 어휘 정의는 `docs/contracts/agent-and-context-contract.md` 와 `docs/contracts/README.md#CONTRACT-GLOSSARY` 가 우선하며, 상태/operation/lease 메커닉은 `docs/contracts/state-and-operation-contract.md`, `docs/contracts/reliability-and-gate-contract.md` 가 정의한다.

<a id="TCC-SCOPE"></a>
## TCC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- target 식별과 영속 저장소 바인딩
- target 단위 lease TTL 정책 (AgentProfile 별 + Phase 별 timeout)
- target 단위 onboarding 게이트 설정
- **AgentProfile 레지스트리**: id 별 모델 / runner / capabilities 매핑 (모델명은 본 contract 단일 권위)
- **Phase policy**: phase 별 lead / reviewers / required_reviewers / quorum / timeout
- 설정값 우선순위

본 문서는 설정의 *구체 파일 형식* 을 강제하지 않는다. 형식(YAML, TOML, JSON 등)과 파일 경로는 운영 환경별 구현이 결정한다.

<a id="TCC-IDENTITY"></a>
## TCC-IDENTITY: Target Identity

target은 다음 식별자를 가진다.

| 필드 | 의미 |
|---|---|
| `target_id` | 시스템 내에서 유일한 target 식별자. 라벨 prefix, 큐 분기, ledger 필터의 기준 |
| `persistent_store_ref` | target이 바인딩되는 영속 저장소의 추상 참조(repository, project 등). 어댑터 형식은 운영 환경이 결정 |
| `label_prefix` | 영속 저장소가 라벨을 지원할 때 같은 저장소를 공유하는 다른 target과의 격리를 위한 prefix |

`target_id`가 다르면 같은 영속 저장소를 공유하더라도 큐·lease·라벨이 분리된다.

<a id="TCC-LEASE-CONFIG"></a>
## TCC-LEASE-CONFIG: Lease Configuration

target 은 lease TTL 을 다음 키로 표현한다.

| 키 | 의미 |
|---|---|
| `lease.ttl_default` | 명시되지 않은 모든 AgentProfile 이 사용할 기본 TTL |
| `lease.ttl_by_agent_profile` | AgentProfile id 별 명시적 TTL 매핑. 누락된 profile 은 `ttl_default` 를 사용. `human` profile 은 외부 신호 대기형이므로 일반적으로 `ttl_default` 보다 큰 값을 둔다 |
| `lease.ttl_by_phase` (optional) | phase 별 PhaseRun 단위 timeout. `application/phase_coordinator.sh` 가 사용. 누락 시 `ttl_default` × policy 로 결정 |

값의 단위는 *시간* 이며 구체 단위(초/밀리초)는 운영 환경 구현이 결정한다. `0` 또는 음수는 invalid 이며, 본 contract 는 무한 TTL 을 허용하지 않는다.

legacy `lease.ttl_by_role` 키는 본 contract 에서 폐기되었다. 환산은 `docs/contracts/README.md#CONTRACT-MIGRATION-NOTES` 참조.

`lease.ttl_default`, `lease.ttl_by_agent_profile`, `lease.ttl_by_phase` 의 조합에 대한 해석 규칙과 환경 변수 우선순위는 `docs/contracts/reliability-and-gate-contract.md#RGC-PHASE-LEASE` 의 "Lease TTL 정책" 절이 정의한다.

<a id="TCC-ONBOARDING"></a>
## TCC-ONBOARDING: Onboarding Gate

target은 운영 진입 전 점검을 받는다. 본 절은 점검의 *설정 형태* 만 정의하고, 점검 항목 자체는 architecture 영역이 결정한다.

| 키 | 의미 |
|---|---|
| `onboarding.preset` | target이 따르는 점검 묶음의 식별자. 같은 preset을 공유하는 target들은 동일한 점검 집합을 통과해야 한다 |
| `onboarding.skip_flags` | 환경적으로 비활성화하는 점검 항목의 식별자 집합. 명시적으로 합의된 항목만 허용 |

`onboarding.skip_flags`는 사람의 governance 결정 결과를 설정으로 흘려넣는 통로다. 운영 의도가 명확하지 않은 비활성화는 invariant 위반으로 본다.


<a id="TCC-AGENT-PROFILES"></a>
## TCC-AGENT-PROFILES: Agent Profile Registry

target 은 AgentProfile id 별로 모델 / runner / capabilities 를 매핑한다. 본 절은 AgentProfile 추상의 *구체 바인딩* 을 다루는 단일 권위다 — 다른 contract 는 AgentProfile id 만 사용하고 모델명·엔진을 등장시키지 않는다.

| 키 | 의미 |
|---|---|
| `agent_profiles.<id>.runner` | AgentProfile 의 호출 어댑터 식별자. `<id>` 는 `atlas`, `forge`, `sentinel`, `scout`, `human` 중 하나 |
| `agent_profiles.<id>.model` | AgentProfile 이 사용할 모델 식별자 (예: `claude-opus-4-7`, `codex-qwen-3-6`). `human` profile 의 경우 비어 있거나 `human` 으로 표기 |
| `agent_profiles.<id>.capabilities` (optional) | profile 이 추가로 가진 능력의 식별자 집합 (예: `web-search`, `code-execution`) |

`agent_profiles.<id>.runner` 가 `human` profile 일 때는 사람 신호 입력 어댑터(예: `github_human_signal`) 가 매핑된다. 사람 결정의 권위는 절대적이며, 어댑터는 사람의 approve/reject 신호를 contribution envelope 으로 변환할 뿐 결정 자체에 개입하지 않는다.

adapter 의 시그니처와 호출 의미는 `docs/contracts/agent-runner-port-contract.md` 가 정의한다. 본 contract 는 *어떤 AgentProfile 이 어떤 adapter / 모델에 매핑되는가* 만 다루며, adapter 자체의 인터페이스는 정의하지 않는다.

legacy `agent_runner.by_role` 키는 본 contract 에서 폐기되었다. 환산은 `docs/contracts/README.md#CONTRACT-MIGRATION-NOTES` 참조.

<a id="TCC-PHASE-POLICIES"></a>
## TCC-PHASE-POLICIES: Phase Policies

target 은 각 phase 의 lead / reviewers / required_reviewers / quorum / timeout 을 정의한다. `application/phase_coordinator.sh` 가 본 정책을 읽어 quorum 평가와 final artifact 압축을 수행한다.

| 키 | 의미 |
|---|---|
| `phase_policies.<phase>.lead` | phase 의 lead AgentProfile id |
| `phase_policies.<phase>.reviewers[]` | phase 에서 review_verdict / evidence / summary contribution 을 받을 reviewer profile 목록. 빈 리스트 허용 |
| `phase_policies.<phase>.required_reviewers[]` | quorum 에 반드시 포함되어야 하는 profile id 목록. 예: `[human]` |
| `phase_policies.<phase>.quorum.rule` | enum: `lead_only`, `min_approvals`, `all_reviewers`, `any_request_changes_blocks` |
| `phase_policies.<phase>.quorum.threshold` | `rule=min_approvals` 일 때 필요한 approve 카운트 (정수) |
| `phase_policies.<phase>.quorum.request_changes_blocks` | boolean. `true` 면 contribution 중 1건이라도 `request-changes` 가 있으면 phase 종착이 차단됨 |
| `phase_policies.<phase>.timeout` | PhaseRun 1회의 시간 한도. `lease.ttl_by_phase` 로 fallback 가능 |
| `phase_policies.<phase>.fetch_scope_overrides` (optional) | contribution_kind 별 기본 fetch_scope 를 phase 별로 override. 키는 `contribution_kind`, 값은 `metadata`/`body`/`tree`/`body+comments`. `docs/contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST` 의 contribution_kind default 보다 우선 |
| `phase_policies.<phase>.max_attempts` (optional) | 같은 PhaseRun 안에서 lead contribution 의 누적 재시도 한도. 초과 시 PhaseRun 을 ESCALATED 로 전이 (`docs/contracts/reliability-and-gate-contract.md#RGC-FAILURE`) |

`<phase>` 는 `Discovery`, `Specification`, `Planning`, `Implementation`, `CodeReview`, `Integration`, `Validation` 중 하나다 (`docs/contracts/agent-and-context-contract.md#AGC-PHASES`).

### required_reviewers ⊆ 의미 규칙

`required_reviewers[]` 항목 중 `human` 은 `reviewers[]` 에 포함되지 않는다. `human` AgentProfile 은 일반 worker daemon slot 을 점유하지 않으며 (`docs/contracts/reliability-and-gate-contract.md#RGC-PHASE-LEASE`), 외부 신호 변환 path 로만 contribution 을 만들기 때문이다. 다른 모든 `required_reviewers[]` 항목은 `reviewers[]` 의 부분집합이어야 한다 — 검증 위치는 본 contract 의 schema validator 다.

`required_reviewers[]` 가 빈 배열이면 *명시적으로 사람 또는 특정 reviewer 가 필수가 아님* 으로 해석한다 (`#TCC-PRECEDENCE`). 누락(키 자체가 없음) 과는 다르다 — 누락 시 시스템 default 가 적용된다.

### Phase default

target operator 가 `phase_policies.<phase>` 키를 명시하지 않으면 다음 시스템 기본값이 적용된다. 본 default 는 `#TCC-PRECEDENCE` 의 시스템 기본값 layer 에 속하며, target 단위 또는 worker 환경에서 override 가능하다.

```text
phase_policies.Discovery:
  lead: atlas
  reviewers: [sentinel]
  required_reviewers: [human]
  quorum:
    rule: min_approvals
    threshold: 1                    # sentinel 1 approve 면 충족 (human 은 별도 required)
    request_changes_blocks: true

phase_policies.Specification:
  lead: atlas
  reviewers: [forge, sentinel]
  required_reviewers: [human]
  quorum:
    rule: min_approvals
    threshold: 2
    request_changes_blocks: true

phase_policies.Planning:
  lead: atlas
  reviewers: [forge, sentinel]
  required_reviewers: []
  quorum:
    rule: min_approvals
    threshold: 2
    request_changes_blocks: true

phase_policies.Implementation:
  lead: forge
  reviewers: []
  required_reviewers: []
  quorum:
    rule: lead_only                 # patch 자체가 다음 phase 의 입력 (`SOC-OPERATIONS#Implementation`)
    request_changes_blocks: false

phase_policies.CodeReview:
  lead: sentinel
  reviewers: [atlas, forge]
  required_reviewers: []
  quorum:
    rule: any_request_changes_blocks  # lead 의 verdict + reviewer 의 request-changes 1건이 차단
    request_changes_blocks: true

phase_policies.Integration:
  lead: sentinel
  reviewers: [scout, atlas]
  required_reviewers: []
  quorum:
    rule: lead_only                 # 결정적 검증 + sentinel verdict 가 phase 종착의 1차 결정자
    request_changes_blocks: true

phase_policies.Validation:
  lead: sentinel
  reviewers: [scout, atlas]
  required_reviewers: []
  quorum:
    rule: lead_only
    request_changes_blocks: true
```

Default `quorum.rule` 의 의미:

- `lead_only`: lead contribution 1건 submit 시 즉시 quorum_reached. reviewer contribution 은 evidence 또는 보조 정보로만 ledger 에 기록된다.
- `min_approvals`: lead 1건 + reviewer 의 `verdict.result=approve` 가 `threshold` 값 이상 도착 시 quorum_reached. `required_reviewers[]` 의 contribution 은 별도로 모두 도착해야 한다.
- `all_reviewers`: `reviewers[]` 의 모든 profile 이 approve 했을 때 quorum_reached.
- `any_request_changes_blocks`: `request_changes_blocks=true` 와 동의어. 1건이라도 request-changes 면 phase 종착 차단. (별도 enum 으로 둔 이유는 reviewer 의 verdict 가 모두 도착하지 않았더라도 즉시 차단 분기로 가도록 dispatching helper 가 구분하기 위함이다.)

`required_reviewers[]` 가 비어 있지 않으면 quorum.rule 과 무관하게 해당 profile 의 contribution 이 모두 도착하기 전까지 quorum_reached 가 되지 않는다. `human` 의 `verdict.result=reject` 는 항상 phase 종착을 차단하며, agent quorum 이 이를 압도하지 않는다 (`docs/contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION`).

<a id="TCC-PRECEDENCE"></a>
## TCC-PRECEDENCE: Configuration Precedence

같은 키에 대해 여러 출처가 값을 제공할 때 우선순위는 다음과 같다.

1. worker 별 환경에서 명시적으로 지정된 값
2. target 단위 설정(`TCC-LEASE-CONFIG`, `TCC-ONBOARDING`, `TCC-AGENT-PROFILES`, `TCC-PHASE-POLICIES` 등)
3. 시스템 기본값

상위 출처가 명시적으로 빈 값을 설정하면 *제거* 가 아닌 *명시적 빈 설정* 으로 본다. 이는 `TCC-ONBOARDING.skip_flags` 와 `phase_policies.<phase>.required_reviewers` 같이 명시성이 invariant 인 키에 특히 중요하다 — `required_reviewers: []` 는 "사람 승인 불필요" 라는 명시적 결정으로 해석된다.

<a id="TCC-CHANGE-RULES"></a>
## TCC-CHANGE-RULES: Change Rules

target 설정의 변경은 운영 결정이며 다음을 따른다.

- target 식별자(`target_id`, `persistent_store_ref`, `label_prefix`) 는 변경 시 영속 저장소 재할당과 ledger 분리가 필요하다. 동일 target_id 의 의미를 도중에 다른 저장소로 옮기는 것은 invariant 위반이다.
- `lease`, `onboarding`, `agent_profiles`, `phase_policies` 키는 다음 cycle 시작 시점부터 적용된다. 진행 중인 lease 와 PhaseRun 은 이전 설정으로 끝까지 처리된다.
- `agent_profiles.<id>.model` 변경은 contract amendment 가 아닌 운영 결정이다 (모델명은 본 contract 단일 권위 — `llm-team.md` 의 AgentProfile abstraction invariant). 단 모델 교체는 별도 governance 검토 대상이며, 변경 자체는 ledger 에 기록되어야 한다.
- 변경 자체는 `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER`에 기록되어야 한다.
