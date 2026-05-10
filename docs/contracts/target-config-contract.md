# Target Configuration Contract

본 문서는 Caller 가 다루는 *target* 의 설정 스키마를 정의한다. target 은 영속 저장소의 한 작업 영역에 대응하는 식별 단위이며, Caller 의 큐·lease·onboarding·AgentProfile 레지스트리·loop policy·dual-track 정책·refactor metric·invariant enforcement 등급이 모두 target 단위로 분기된다.

권한 경계는 `llm-team.md` 가 우선한다. AgentProfile / Loop / Slice / DialogueSession 어휘 정의는 `docs/contracts/agent-and-context-contract.md` 와 `docs/contracts/README.md#CONTRACT-GLOSSARY` 가 우선하며, 상태/operation/lease 메커닉은 `docs/contracts/state-and-operation-contract.md`, `docs/contracts/reliability-and-gate-contract.md` 가 정의한다.

<a id="TCC-SCOPE"></a>
## TCC-SCOPE: Scope

이 문서의 authoritative scope 는 다음이다.

- target 식별과 영속 저장소 바인딩
- target 단위 lease TTL 정책 (4-lease kind 별 + AgentProfile 별 + Phase 별)
- target 단위 onboarding 게이트 설정
- AgentProfile 레지스트리: id 별 모델 / runner / capabilities 매핑 (모델명은 본 contract 단일 권위)
- Loop policy: outer/middle/inner loop 의 phase 또는 purpose 별 lead / participants / required_participants / session_termination / timeout / concurrent_sessions / turn_ordering / conflict
- Slice class escalation rule (`internal_escalation_rules`)
- Dual-track 정책 (`target.dual_track.{discovery_wip, priority, telemetry_refresh_interval, scheduled_capacity}`)
- Context budget (`target.context_budget.<loop>.<step>.tokens`)
- Refactor metric 정책 (scan interval, metric thresholds)
- Invariant enforcement 등급 (always_hard / stage_graded)
- Governance surface — 사람 입력 채널, GitHub Team authority, control / contract change Issue 번호 (`TCC-GOVERNANCE`)
- 설정값 우선순위

본 문서는 설정의 *구체 파일 형식* 을 강제하지 않는다. 형식(YAML, TOML, JSON 등)과 파일 경로는 운영 환경별 구현이 결정한다.

<a id="TCC-IDENTITY"></a>
## TCC-IDENTITY: Target Identity

target 은 다음 식별자를 가진다.

| 필드 | 의미 |
|---|---|
| `target_id` | 시스템 내에서 유일한 target 식별자. 라벨 prefix, 큐 분기, ledger 필터의 기준 |
| `persistent_store_ref` | target 이 바인딩되는 영속 저장소의 추상 참조 |
| `label_prefix` | 영속 저장소가 라벨을 지원할 때 같은 저장소를 공유하는 다른 target 과의 격리를 위한 prefix |

`target_id` 가 다르면 같은 영속 저장소를 공유하더라도 큐·lease·라벨이 분리된다.

<a id="TCC-LEASE-CONFIG"></a>
## TCC-LEASE-CONFIG: Lease Configuration

target 은 lease TTL 을 다음 키로 표현한다. 4 lease kind 의 분기를 지원한다 (`docs/contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS`).

| 키 | 의미 |
|---|---|
| `lease.ttl_default` | 명시되지 않은 모든 lease 가 사용할 기본 TTL |
| `lease.ttl_by_lease_kind.<kind>` | lease_kind 별 명시적 TTL. `kind` ∈ {`slot_lock`, `slice_lease`, `session_lease`, `turn_lease`}. slot_lock 은 short transaction 이므로 매우 짧음 |
| `lease.ttl_by_agent_profile.<id>` | AgentProfile id 별 turn_lease TTL. 누락된 profile 은 `ttl_default`. `human` profile 은 외부 신호 대기형이므로 일반적으로 매우 큰 값 (또는 별도 timeout 정책) |
| `lease.ttl_by_phase.<phase>` (optional) | outer-loop phase 별 session_lease 또는 slice_lease TTL fallback |

값의 단위는 *시간* 이며 구체 단위(초/밀리초)는 운영 환경 구현이 결정한다. `0` 또는 음수는 invalid 이며, 본 contract 는 무한 TTL 을 허용하지 않는다.

legacy `lease.ttl_by_role` 키는 본 contract 에서 폐기되었다. `lease.ttl_by_agent_profile` 로 환산. 환산은 `docs/contracts/README.md#CONTRACT-MIGRATION-NOTES` 참조.

`lease.ttl_*` 키의 조합 해석 규칙은 `docs/contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS` 의 "Lease TTL 정책" 절이 정의한다.

<a id="TCC-ONBOARDING"></a>
## TCC-ONBOARDING: Onboarding Gate

target 은 운영 진입 전 점검을 받는다. 본 절은 점검의 *설정 형태* 만 정의하고, 점검 항목 자체는 architecture 영역이 결정한다.

| 키 | 의미 |
|---|---|
| `onboarding.preset` | target 이 따르는 점검 묶음의 식별자. 같은 preset 을 공유하는 target 들은 동일한 점검 집합을 통과해야 한다 |
| `onboarding.skip_flags` | 환경적으로 비활성화하는 점검 항목의 식별자 집합. 명시적으로 합의된 항목만 허용 |
| `onboarding.required_lib[]` | 군집 시작 시 필수로 검증되는 lib 목록 (예: `lease.sh`, `dialogue_coordinator.sh`, `dual_track_scheduler.sh`). atomic startup (`#RGC-DAEMON-STARTUP`) 의 진입 게이트 |

`onboarding.skip_flags` 는 사람의 governance 결정 결과를 설정으로 흘려넣는 통로다.

<a id="TCC-AGENT-PROFILES"></a>
## TCC-AGENT-PROFILES: Agent Profile Registry

target 은 AgentProfile id 별로 모델 / runner / capabilities 를 매핑한다. 본 절은 AgentProfile 추상의 *구체 바인딩* 을 다루는 단일 권위다.

| 키 | 의미 |
|---|---|
| `agent_profiles.<id>.runner` | AgentProfile 의 호출 어댑터 식별자. `<id>` ∈ {`atlas`, `forge`, `sentinel`, `scout`, `human`} |
| `agent_profiles.<id>.model` | AgentProfile 이 사용할 모델 식별자 (예: `claude-opus-4-7`, `codex-qwen-3-6`). `human` profile 의 경우 비어 있거나 `human` 으로 표기 |
| `agent_profiles.<id>.capabilities` (optional) | profile 이 추가로 가진 능력의 식별자 집합 (예: `web-search`, `code-execution`) |

`agent_profiles.<id>.runner` 가 `human` profile 일 때는 사람 신호 입력 어댑터(예: `github_human_signal`)가 매핑된다.

adapter 의 시그니처와 호출 의미는 `docs/contracts/agent-runner-port-contract.md` 가 정의한다. 본 contract 는 *어떤 AgentProfile 이 어떤 adapter / 모델에 매핑되는가* 만 다룬다.

legacy `agent_runner.by_role` 키는 폐기되었다.

<a id="TCC-GOVERNANCE"></a>
## TCC-GOVERNANCE: Governance Surface & Human Authority

`target.governance.*` 는 사람·GitHub 경계의 단일 권위 설정이다.

| 키 | 필수 | default | 의미 |
|---|---|---|---|
| `target.governance.human_team` | yes | — | GitHub Team 슬러그 (예: `myorg/approvers`). comment command 의 author authority 검증 단일 권위. v1 은 단일 team. |
| `target.governance.control_issue_number` | yes | — | system signal (`pause` / `resume` / `stop`) 입력 surface — repo-level Issue 번호 (1 repo당 1개). |
| `target.governance.contract_change_issue_number` | yes | — | `{contract, change_proposal}` 집합 surface — verb 가 target_kind 결정 (예: `amendment-approve` → `change_proposal`). |
| `target.governance.signal_command_prefix` | no | `/` | comment command verb prefix. slash-command 충돌 회피용 운영 override. |
| `target.governance.human_team_cache_ttl_seconds` | no | `300` | drain 의 GitHub Teams API 응답 캐시 TTL. RGC-LEASE-KINDS 의 lease TTL 과 별개. |
| `target.governance.human_team_provider` | no | `"fs-mirror"` | `TeamMembershipPort` 어댑터 선택. `"fs-mirror"` (default) 는 `external_mirror/teams/<team>.json` allowlist (self-hosting / 테스트 용). `"github"` 는 `gh api /orgs/{org}/teams/{slug}/memberships/{user}` 로 라우팅 (auth 는 `GH_TOKEN` / `gh auth login` 으로 외부에서 — Inv #4). |
| `target.governance.unauthorized_author_alert` | no | `false` | 비-멤버이지만 repo collaborator 인 author 의 1차 시도 시 비공개 운영 알림 (RGC-NOTIFICATION). 공개 surface 에는 노출하지 않음. |

`human_team` 캐시 미스 + GitHub Teams API 실패 시 drain 은 fail-closed (envelope 큐 진입 보류, backoff 재시도). 한도 초과 시 RGC-NOTIFICATION 운영 알림.

`control_issue_number` 와 `contract_change_issue_number` 가 각각 1개 Issue 만 가리키는 이유는 외부 surface 단일 권위 보장이다. 다중 Issue 라우팅은 미도입. 두 키는 서로 달라야 한다 (같은 Issue 번호 시 라우팅 모호 → schema reject).

**Block 자체의 optionality**: contract 정의상 `human_team` / `control_issue_number` / `contract_change_issue_number` 는 필수다. 다만 본 spec 의 runtime consumer (`human_signal_drain` / `signal_dispatch` / `drift_observer`) 가 미구현 상태이므로, Zod schema 는 v1 한정으로 `target.governance` block 자체를 optional 로 둔다 — block 부재 시 component 들은 no-op 으로 동작한다. 후속 plan 에서 component 를 도입하면 block 을 required 로 승격한다.

<a id="TCC-LOOP-POLICIES"></a>
## TCC-LOOP-POLICIES: Loop Policies

target 은 각 loop step (outer phase 또는 middle/inner purpose) 의 lead / participants / session_termination 정책을 정의한다. `application/dialogue_coordinator.sh` 가 본 정책을 읽어 session 의 turn coordination 과 finalization 평가를 수행한다.

`loop_policies` 는 phase_policies 의 후신이다. legacy `phase_policies.<phase>` 키는 본 contract 에서 폐기되었다 (`docs/contracts/README.md#CONTRACT-MIGRATION-NOTES`).

### 키 스키마

```text
loop_policies.<loop>.<step>.{
  lead                       # AgentProfile id
  participants[]             # [{agent_profile, role: lead|reviewer|observer}]
  required_participants[]    # quorum 에 반드시 포함되어야 하는 profile id (예: [human])
  session_termination: {
    finalization_rule        # lead_only | unanimous_approve | quorum_then_lead
                             # | any_request_changes_blocks | timeout_only
    finalization_threshold   # finalization_rule=quorum_then_lead 또는 min_approvals 일 때 필요한 approve 카운트
    required_evidence[]      # [{kind: verification_green|metric_threshold|interface_diff_clean|coverage_threshold, params}]
    composite_rule           # finalization_AND_evidence | evidence_only | finalization_only
  }
  timeout                    # session 1회의 wall-clock 한도
  max_turns                  # session 1회의 max turn 수 (inner 한정 default 적용)
  concurrent_sessions        # WIP limit per profile (default = 1, fail-serial — RGC-FAIRNESS Concurrent Sessions Hard Default)
  fetch_scope_overrides      # contribution_kind 별 default fetch_scope override
  max_attempts_per_turn      # inner loop 한정 — 같은 turn 안에서 invalid 재시도 한도
  no_progress_streak         # inner 한정 — newly_green=0 누적 한도
  regression_streak          # inner 한정 — regression 누적 한도
  turn_ordering: {
    max_consecutive_per_profile  # AGC-TURN-ORDERING fairness cap. 동일 agent_profile_id 가 같은 session 안에서 연속 점유할 수 있는 turn 수의 상한 (default = 2)
  }
  conflict: {
    max_redispatch              # AGC-CONFLICT-RESOLUTION 의 1차 re-dispatch 한도. 초과 시 사람 governance signal 요구 (default = 1)
  }
}
```

`<loop>` ∈ {`outer`, `middle`, `inner`}. `<step>` 은 loop 별 다음 enum.

| Loop | Step enum |
|---|---|
| outer | `Discovery` / `Specification` / `Planning` / `Validation` |
| middle | `review` / `merge` |
| inner | `tdd_build` |

### Default

target operator 가 `loop_policies.<loop>.<step>` 을 명시하지 않으면 다음 시스템 기본값이 적용된다.

```text
loop_policies.outer.Discovery:
  lead: atlas
  participants: [{atlas, lead}, {sentinel, reviewer}, {human, reviewer}]
  required_participants: [human]
  session_termination:
    finalization_rule: quorum_then_lead
    finalization_threshold: 1   # sentinel 1 approve + human required
    composite_rule: finalization_only
  timeout: (운영 결정)

loop_policies.outer.Specification:
  lead: atlas
  participants: [{atlas, lead}, {forge, reviewer}, {sentinel, reviewer}, {human, reviewer}]
  required_participants: [human]
  session_termination:
    finalization_rule: quorum_then_lead
    finalization_threshold: 2
    composite_rule: finalization_only

loop_policies.outer.Planning:
  lead: atlas
  participants: [{atlas, lead}, {forge, reviewer}, {sentinel, reviewer}]
  required_participants: []
  session_termination:
    finalization_rule: unanimous_approve
    composite_rule: finalization_only

loop_policies.outer.Validation:
  lead: sentinel
  participants: [{sentinel, lead}, {scout, observer}, {atlas, observer}]
  required_participants: []
  session_termination:
    finalization_rule: lead_only
    required_evidence:
      - {kind: verification_green, params: {acceptance_tests: all, deterministic_checks: all}}
    composite_rule: evidence_only

loop_policies.middle.review:                # feature slice default
  lead: sentinel
  participants: [{sentinel, lead}, {forge, reviewer}]
  required_participants: []                  # internal escalation rule hit 시 [human] 추가
  session_termination:
    finalization_rule: any_request_changes_blocks
    required_evidence:
      - {kind: verification_green, params: {acceptance_tests: slice_local}}
    composite_rule: finalization_AND_evidence

loop_policies.middle.review.internal_overrides:  # internal slice 한정 override
  participants: [{sentinel, lead}, {forge, reviewer}, {atlas, reviewer}]
  session_termination:
    finalization_rule: quorum_then_lead
    finalization_threshold: 2
    required_evidence:
      - {kind: verification_green, params: {acceptance_tests: existing_only}}
      - {kind: metric_threshold, params: {ref: declared_metric_threshold}}
      - {kind: interface_diff_clean, params: {protected_apis: target_default}}
    composite_rule: finalization_AND_evidence

loop_policies.middle.merge:
  required_evidence:
    - {kind: verification_green, params: {acceptance_tests: full, deterministic_checks: full}}
  composite_rule: evidence_only
  max_revalidation_attempts: 3

loop_policies.inner.tdd_build:
  lead: forge
  participants: [{forge, lead}]
  required_participants: []
  session_termination:
    finalization_rule: lead_only
    required_evidence:
      - {kind: verification_green, params: {acceptance_tests: slice_local, deterministic_checks: slice_local}}
    composite_rule: evidence_only
  max_turns: 20                              # 보수적 default. dogfood 후 조정
  no_progress_streak: 3
  regression_streak: 1
  max_attempts_per_turn: 3
```

### 의미 규칙

- `required_participants[]` 항목 중 `human` 은 일반 `participants[]` 의 reviewer slot 에 등장하나, worker daemon slot 을 점유하지 않으며 `RGC-SIGNALS` 의 envelope 변환 path 로만 contribution 을 만든다.
- `participants[].role=observer` 는 contribution 을 producer 하지 않고 next_action_request 또는 evidence 생성에만 참여 가능. 종료 평가에 영향을 주지 않음.
- `required_evidence[]` 가 비어 있으면 finalization rule 만 평가 (composite=finalization_only).
- `finalization_rule=lead_only` + `composite=evidence_only` 의 조합은 lead 의 1 turn 출력으로 즉시 finalization 평가 + evidence 가 단독 결정자 (TDD inner build).

<a id="TCC-SLICE-CLASS-RULES"></a>
## TCC-SLICE-CLASS-RULES: Slice Class Escalation Rules

`internal` slice 가 자동으로 `feature` 게이트로 승격되는 조건을 정의한다 (`docs/contracts/state-and-operation-contract.md#SOC-SLICE-CLASS`).

### 키 스키마

```text
target.internal_escalation_rules: {
  interface_break: { enabled: bool, protected_apis: [path|glob] }
  schema_or_migration_change: { enabled: bool, paths: [path|glob] }
  security_sensitive_path: { enabled: bool, paths: [path|glob] }
  perf_critical_path: { enabled: bool, paths: [path|glob], regression_threshold }
  existing_test_coverage_below_threshold: { enabled: bool, threshold }
  metric_runner_unavailable: { enabled: bool }
}
```

### Default 6 Rules

target operator 가 명시하지 않으면 다음 6 rule 이 모두 활성화된다.

| Rule | Default 의미 |
|---|---|
| `interface_break: true` | public API signature 변경. `protected_apis` 의 default 는 target operator 가 정의 |
| `schema_or_migration_change: true` | DB schema, migration 파일, public schema 정의 변경 |
| `security_sensitive_path: true` | auth, crypto, secret handling 관련 path 변경 |
| `perf_critical_path: true` | 성능 임계 모듈 변경. perf_threshold 미통과 시 escalate |
| `existing_test_coverage_below_threshold` | slice 의 declared_scope 안 기존 test coverage 가 threshold 미달이면 escalate |
| `metric_runner_unavailable` | declared_metric_threshold 가 있는 internal slice 인데 MetricRun runner 가 사용 불가하면 escalate |

### 평가 시점

- Caller 가 internal slice 를 SLICE_BUILDING 으로 전이하기 직전 (Planning 의 plan_accept 직후).
- 위 6 rule 중 1개라도 hit 하면 slice 를 *feature 게이트로 승격* — `loop_policies.middle.review.internal_overrides` 가 자동 적용 + `human` participant 가 추가됨.

평가 결과는 ledger 의 `result_detail=slice_class_promotion` 으로 기록.

<a id="TCC-DUAL-TRACK"></a>
## TCC-DUAL-TRACK: Dual-Track Policy

dual-slot serialization (`docs/contracts/state-and-operation-contract.md#SOC-MILESTONE-DUAL-SLOT`) 의 운영 매개변수를 정의한다.

### 키 스키마

```text
target.dual_track: {
  enabled: bool                    # default: true. false 면 single-slot fallback (Stage 4 abort line)
  discovery_wip: int               # default: 1. Discovery slot 개수
  delivery_wip: int                # default: 1. Delivery slot 개수 (확장 옵션 — Stage 4 이후)
  priority: enum                   # delivery_first (default) | balanced | discovery_first
  telemetry_refresh_interval       # default: 30분 또는 Delivery slot 의 slice 상태 변경 시점
  scheduled_capacity               # RefactorBacklog SCHEDULED 슬롯 capacity (옵션)
  fairness_oscillation_threshold   # cross-slot fairness 위반 telemetry 임계 (Stage 4 까지 warn)
}
```

### 정책 의미

| 키 | 의미 |
|---|---|
| `enabled: false` | single-slot fallback. Discovery + Delivery 동시 진행 차단. Stage 4 abort line 의 토글 |
| `priority: delivery_first` | Discovery N+1 보다 Delivery N 의 worker slot 을 우선 |
| `priority: balanced` | 두 slot 의 worker slot 을 라운드로빈 |
| `priority: discovery_first` | Delivery N 의 진행보다 Discovery N+1 의 진행을 우선 (드물게 사용) |

<a id="TCC-CONTEXT-BUDGET"></a>
## TCC-CONTEXT-BUDGET: Context Budget

`AGC-CONTEXT-BUDGET` 의 hard cap 을 (loop, step) 별로 정의한다. Caller (`lib/context.sh`) 가 manifest assemble 시 해당 cap 을 읽어 token 예산을 결정하고, 초과 시 `AGC-CONTEXT-BUDGET` 의 truncation 우선순위를 적용한다.

### 키 스키마

```text
target.context_budget."<loop>.<step>".{
  token_hard_cap   # MUST. int (positive). 1-shot 호출의 총 token hard cap
                   # (provider 한도 보다 낮게 설정). 초과 시 AGC-CONTEXT-BUDGET
                   # truncation 우선순위 적용 후에도 남으면 AGC-INVALID
                   # `context_budget_truncation` 으로 LLM 호출 차단.
  soft_warn_pct    # optional. float ∈ [0, 1]. 향후 telemetry/warn 임계 (현재 reserved).
}
```

키는 `<loop>.<step>` 한 토큰의 flat string 이다 (예: `"outer.Discovery"`, `"inner.tdd_build"`). `<loop>` ∈ {`outer`, `middle`, `inner`}, `<step>` 은 `TCC-LOOP-POLICIES` 의 step enum 과 동일하며 구현은 `LoopStep` Zod enum 으로 폐쇄된다 (`outer.{Discovery,Specification,Planning,Validation}` / `middle.{review,merge}` / `inner.tdd_build`).

### Default

target operator 가 `target.context_budget."<loop>.<step>"` 을 명시하지 않으면 다음 시스템 기본값이 적용된다 (architecture default; provider 한도 보다 낮게 설정).

```text
target.context_budget."outer.Discovery".token_hard_cap:    256000
target.context_budget."outer.Specification".token_hard_cap: 256000
target.context_budget."outer.Planning".token_hard_cap:     256000
target.context_budget."outer.Validation".token_hard_cap:   256000
target.context_budget."middle.review".token_hard_cap:      192000
target.context_budget."middle.merge".token_hard_cap:       128000
target.context_budget."inner.tdd_build".token_hard_cap:    128000
```

provider 한도 변경에 따른 cap 조정은 `TCC-CHANGE-RULES` 의 다음 cycle 적용 정책을 따른다.

<a id="TCC-REFACTOR-METRICS"></a>
## TCC-REFACTOR-METRICS: Refactor Metrics Policy

RefactorBacklog 의 자동 scan 과 internal slice 의 metric_threshold 정책을 정의한다.

### 키 스키마

```text
target.refactor_metrics: {
  scan_interval                    # scout 의 정기 scan 주기
  metrics: {                       # 사용 가능한 metric 정의
    <name>: {
      kind: code_complexity | churn | test_coverage | perf_regression | static_check | ...
      runner_ref                   # MetricRun adapter 식별자
      default_threshold            # internal slice 가 명시하지 않으면 사용
      comparator: lte | gte | eq | range
    }
  }
  alert_threshold: {               # scan 결과가 이 임계를 넘으면 RefactorProposal 자동 생성
    <name>: { value, comparator }
  }
}
```

### Default

target operator 가 명시하지 않으면 metric 자동 scan 비활성화. internal slice 가 `declared_metric_threshold` 를 명시하면 `metric_runner_unavailable` escalation rule 이 hit 되어 자동으로 feature 게이트로 승격됨.

<a id="TCC-ENFORCEMENT"></a>
## TCC-ENFORCEMENT: Invariant Enforcement Levels

본 절은 invariant 위반의 enforcement 등급을 정의한다 — Stage 2~4 의 점진적 hard-fail transition 을 지원하기 위함이다 .

### 키 스키마

```text
target.invariant_enforcement: {
  always_hard[]: [<invariant_name>]          # 항상 block. Stage 와 무관
  stage_graded: {
    <invariant_name>: warn | block           # Stage 별 모드
  }
}
```

### Default

```text
target.invariant_enforcement.always_hard:
  - caller_only_operational_write
  - direct_invocation_forbidden
  - manifest_external_read_write
  - lease_acquisition_order
  - stateless_per_call

target.invariant_enforcement.stage_graded:
  dual_slot_fairness: warn                   # Stage 4 까지 warn, Stage 5 block
  telemetry_enrichment_missing: warn
  turn_log_compaction_delay: warn
  refactor_metric_missing: warn
  required_evidence_unmet: warn              # Stage 3b 부터 block
  actor_team_membership_unreachable: block   # Inv #5 — phase 9a 추가 (TCC-GOVERNANCE 행)
  scope_violation: warn                      # AGC-WORKSPACE 행에서 stage_graded 로 참조 (Stage 3b block)
  fairness_violation: warn                   # RGC-FAIRNESS 행에서 stage_graded 로 참조 (detector 미구현)
```

### 의미

- `always_hard` 의 invariant 는 어느 Stage 에서도 block. 위반 시 즉시 invalid + ledger `result=invalid`.
- `stage_graded.<name>=warn` 의 invariant 는 ledger 에 warning row 가 기록되나 transition 은 진행. (Stage 3b dogfood 의 DoD: warning row 0건)
- `stage_graded.<name>=block` 으로 변경하면 hard-fail. 변경 자체는 ledger 에 기록되어야 한다.

### Stage 5 의 의미

Stage 5 진입 시 `target.invariant_enforcement` 의 stage_graded 모든 항목을 `block` 으로 전환. legacy writer 코드 경로 (legacy phase/Task/PhaseRun helper) 가 신규 row 를 만들지 못한다.

### Call-site 매트릭스 (phase 9c)

각 invariant 가 실제로 어떤 평가자에서 적용되며, 그 평가자가 `application/invariant-enforcement.ts` 의 `resolveEnforcementLevel(...)` 을 통과하는지 (즉 operator override 가 효력을 갖는지) 의 추적은 `docs/contracts/README.md#TCC-ENFORCEMENT-AUDIT` 매트릭스에 정리된다. 현재 wired 된 stage_graded 항목은 `actor_team_membership_unreachable` 뿐이며, 나머지는 Stage 5 default block 동작에만 의존한다 (operator downgrade 미지원). 후속 cycle 이 invariant 단위로 평가자에 lookup 을 wire 한다.

<a id="TCC-PRECEDENCE"></a>
## TCC-PRECEDENCE: Configuration Precedence

같은 키에 대해 여러 출처가 값을 제공할 때 우선순위는 다음과 같다.

1. worker 별 환경에서 명시적으로 지정된 값
2. target 단위 설정 (`TCC-LEASE-CONFIG`, `TCC-ONBOARDING`, `TCC-AGENT-PROFILES`, `TCC-LOOP-POLICIES`, `TCC-SLICE-CLASS-RULES`, `TCC-DUAL-TRACK`, `TCC-CONTEXT-BUDGET`, `TCC-REFACTOR-METRICS`, `TCC-ENFORCEMENT`, `TCC-GOVERNANCE` 등)
3. 시스템 기본값

상위 출처가 명시적으로 빈 값을 설정하면 *제거* 가 아닌 *명시적 빈 설정* 으로 본다. `required_participants: []` 는 "사람 또는 특정 participant 가 필수가 아님" 이라는 명시적 결정으로 해석된다.

<a id="TCC-CHANGE-RULES"></a>
## TCC-CHANGE-RULES: Change Rules

target 설정의 변경은 운영 결정이며 다음을 따른다.

- target 식별자 (`target_id`, `persistent_store_ref`, `label_prefix`) 는 변경 시 영속 저장소 재할당과 ledger 분리가 필요하다.
- `lease`, `onboarding`, `agent_profiles`, `loop_policies`, `internal_escalation_rules`, `dual_track`, `context_budget`, `refactor_metrics`, `governance` 키는 다음 cycle 시작 시점부터 적용된다. 진행 중인 lease 와 DialogueSession 은 이전 설정으로 끝까지 처리된다. `governance.human_team` / `governance.control_issue_number` / `governance.contract_change_issue_number` 변경은 외부 surface 재바인딩을 요구하므로 caller 가 새 cycle 시작 전에 awaiting block / Tracker Issue 의 정합을 검증한다.
- `agent_profiles.<id>.model` 변경은 contract amendment 가 아닌 운영 결정이다 (`llm-team.md` AgentProfile abstraction). 단 모델 교체는 별도 governance 검토 대상이며, 변경 자체는 ledger 에 기록되어야 한다.
- `target.invariant_enforcement.stage_graded.<name>=block` 으로의 전환은 운영자 결정이며 ledger 에 기록 + 영향 받는 invariant 의 누적 violation 을 사전 점검한다 (Stage 5 hard-fail transition 의 진입 조건).
- 변경 자체는 `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER` 에 기록되어야 한다.
