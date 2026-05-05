# State and Operation Contract

본 문서는 LLM Team workflow 의 객체 상태와 loop 별 operation 전이를 정의한다. 권한 경계는 `llm-team.md`, Agent output envelope / AgentProfile / Contribution 정의는 `docs/contracts/agent-and-context-contract.md` 가 우선한다.

<a id="SOC-SCOPE"></a>
## SOC-SCOPE: Scope

이 문서의 authoritative scope 는 다음이다.

- Workflow 객체 (Milestone, Slice, DialogueSession, SessionTurn, SliceMerge, VerificationRun, MetricRun) 의 상태와 전이
- 3-loop nested model 의 loop 정의와 nesting 규약
- Slice dependency 모델 (`blocks` / `coordinates_with`) 과 join condition
- DialogueSession lifecycle (5-state) + termination rule (finalization × required_evidence × composite_rule)
- SliceMerge lifecycle (7-state) + trunk merge 정책
- Milestone dual-slot serialization (Discovery + Delivery) + state machine
- Cross-milestone read-only reference rules
- Idempotency 3-scope (per-turn / per-session-outcome / per-merge)

Lease 4 종, 회수, retry, 사람 contribution 변환 path, ledger schema 는 `docs/contracts/reliability-and-gate-contract.md` 가 정의한다. session 종료 판정 정책 (finalization rule × required_evidence) 의 운영 매개변수는 `docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES` 가 정의한다. RefactorBacklog / RefactorProposal 객체와 turn_log compaction 은 `docs/contracts/knowledge-contract.md` 가 정의한다.

### 어휘 주석

본 contract 는 "trunk", "merge", "rebase" 같은 VCS 어휘를 *작업 단위* 와 *전이의 종착* 을 가리키는 추상 개념으로 사용한다. 어휘는 git 에서 빌렸으나 의미는 어댑터 중립이다. 다른 VCS(예: 패치 큐 기반, mercurial 등)로 매핑할 때는 동등 개념(통합 base, 통합 적용)으로 치환한다. 어휘 자체가 git 을 강제하지 않는다.

<a id="SOC-LOOPS"></a>
## SOC-LOOPS: 3-Loop Nested Model

workflow 는 다음 3 loop 를 nested 로 진행한다.

```text
OUTER  (milestone, dual-slot)
  Discovery slot ↔ Delivery slot 의 dual-track. Discovery N+1 manifest 에 Delivery N 의 live telemetry 자동 inject.
  └ MIDDLE  (slice)
      slice = user-observable thin end-to-end (feature) 또는 behavior-preserving change (internal). milestone 단위 DAG.
      └ INNER  (TDD build)
          forge solo session, red/green/refactor turn. convergence: verification_green.
```

각 loop step 은 DialogueSession (`#SOC-SESSION-LIFECYCLE`) 으로 진행되며, session 의 종료는 `#SOC-SESSION-TERMINATION` 의 (state, final_verdict) tuple 평가로 결정된다.

폐기된 어휘:

- `Phase` 단위 lock-step (7 phase) → outer loop step 4개 (`Discovery / Specification / Planning / Validation`) + middle/inner loop. Implementation / CodeReview / Integration 어휘는 outer phase 에서 폐기.
- `Task` → `Slice`
- `PhaseRun` → `DialogueSession`
- `Code CP` / `Integration CP` → `SliceMerge`

<a id="SOC-OBJECTS"></a>
## SOC-OBJECTS: Workflow Objects

| 객체 | 의미 |
|---|---|
| Milestone | 사람의 제품 목표가 outer loop (Discovery / Specification / Planning / Validation) 4 phase 를 거쳐 완료되는 단위. dual-slot serialization (`#SOC-MILESTONE-DUAL-SLOT`) |
| Slice | user-observable thin end-to-end (feature class) 또는 behavior-preserving code change (internal class). Planning phase 가 산출하며 정확히 1 milestone 에 속한다. middle / inner loop 의 작업 단위 (`#SOC-SLICE-LIFECYCLE`) |
| DialogueSession | turn-based agent deliberation. parent_loop ∈ {outer, middle, inner}. 여러 SessionTurn 을 가지며 termination rule 에 의해 final artifact 응축 (`#SOC-SESSION-LIFECYCLE`) |
| SessionTurn | session 의 1 turn. agent_profile + envelope + next_action_request + caller_routing_decision (`docs/contracts/agent-and-context-contract.md#AGC-NEXT-ACTION-REQUEST`) |
| SliceMerge | slice 의 trunk merge 후보 객체. 7-state lifecycle (Code CP + Integration CP 의 후신, `#SOC-SLICE-MERGE`) |
| VerificationRun | Caller 가 실행한 결정적 검증 1회 (build, test, lint, type, static analysis 등) |
| MetricRun | Caller 가 측정한 quality metric 1회 (code complexity, churn, performance metric 등). refactor evidence 의 인프라 |
| Spec CP | Discovery / Specification 의 outer loop session 산출물 — milestone 본문 또는 scenario spec 의 변경 제안. trunk 코드 병합 대상이 아니라 spec/doc 객체 영속화 단위 |
| Milestone CP | outer Validation phase 산출물 — milestone-level summary 의 영속화 단위. trunk 코드 병합 대상 아님 |
| RefactorProposal / RefactorBacklog | KAC 소유 (`docs/contracts/knowledge-contract.md#KAC-REFACTOR-BACKLOG`). 본 contract 는 internal slice promotion path 만 다룸 (`#SOC-SLICE-CLASS`) |
| System (non-workflow) | workflow 객체가 아닌 시스템 차원 entity. 전역 control state(`docs/contracts/reliability-and-gate-contract.md#RGC-PAUSE`) 와 Caller 군집 시작(`#RGC-DAEMON-STARTUP`) 의 ledger/signal 대상으로만 사용된다. workflow 전이는 가지지 않는다 |

폐기된 객체:

- `Task` (→ `Slice`, 책임 확장: 코드 → 가치)
- `PhaseRun` (→ `DialogueSession`, turn-based 추가)
- `Code CP` / `Integration CP` (→ `SliceMerge`, lifecycle 7-state 흡수)
- 독립 lifecycle 객체로서의 `Contribution` (→ DialogueSession 안의 SessionTurn 산출물 + session_outcome). envelope 내 1급 필드로서의 contribution 은 `docs/contracts/agent-and-context-contract.md#AGC-CONTRIBUTION` 가 정의 — 객체 lifecycle 만 폐기되고 envelope payload 표현은 보존된다

`Spec CP` 와 `Milestone CP` 는 보존된다 (`Appendix A`) — outer loop 산출물로서 trunk 코드 병합 대상이 아니므로 SliceMerge lifecycle 과 의미가 다르다.

### External References (추상 슬롯)

Milestone / Slice / SliceMerge 는 외부 추적 시스템과의 mirror 관계를 표현하기 위해 다음 추상 슬롯을 가질 수 있다.

```text
external_refs[]: [{
  provider: <opaque-id>          # 외부 시스템 식별자. enum 은 본 contract 가 고정하지 않음
  kind: <tracker | review_surface | milestone | unknown>  # extensible
  id: <opaque>                   # 외부 시스템에서의 식별자
  url?: <opaque>                 # 외부 시스템에서의 영속 링크
}]
```

invariant:

- `provider` 값의 enum 은 본 contract 가 고정하지 않는다. 구체 매핑(예: 어떤 외부 시스템이 어떤 provider 식별자를 갖는가, 어떤 객체가 어떤 kind 를 가질 수 있는가) 은 architecture 한정이다.
- `kind` enum 은 미정 값을 `unknown` 으로 표기한다 — 향후 신규 kind 는 architecture 가 추가하더라도 본 contract 의 invariant 를 깨지 않는다.
- 동기화 방향: 내부 객체 = authoritative, `external_refs[]` 항목 = mirror. 외부 mirror 의 변경은 사람 governance signal (RGC-HUMAN-CONTRIBUTION) 또는 Caller 의 sync 작업으로만 내부 상태에 반영된다.
- 동기화 메타 (`sync_status`, `last_synced_internal_revision`, `last_seen_external_revision` 등) 는 본 contract 가 정의하지 않으며 architecture 매핑 문서가 정의한다.

<a id="SOC-MILESTONE-DUAL-SLOT"></a>
## SOC-MILESTONE-DUAL-SLOT: Milestone Dual-Slot

milestone 은 **Discovery slot 1 + Delivery slot 1** (default; `target.discovery_wip` 로 N 까지 확장 옵션) 으로 직렬화된다. 두 slot 은 서로 다른 milestone 에만 점유한다.

### Milestone State Machine

```text
Pre-intake:
  M_INTAKE_QUEUED              # seed 가 queue 에 들어온 상태. 아직 slot 점유 전

Discovery stage:
  M_DISCOVERY_DRAFT            # Discovery slot 점유 시작
  M_DISCOVERY_AWAITING_HUMAN
  M_SPECIFICATION_DRAFT
  M_SPECIFICATION_AWAITING_HUMAN
  M_SPEC_APPROVED              # Discovery 종료 (terminal of Discovery slot)

Delivery stage:
  M_DELIVERY_PLANNING          # Delivery slot 점유 시작. Planning ensemble session 진행
  M_DELIVERY_BUILDING          # slice 들의 inner/middle loop 진행
  M_DELIVERY_VALIDATING        # cross-slice acceptance + Context Summary
  M_DONE | M_ESCALATED         # terminal
```

### Slot 점유 / 해제 / Promotion

- Discovery slot 점유: M_INTAKE_QUEUED → M_DISCOVERY_DRAFT 시점 (slot lock 으로 보호 — `#RGC-SLOT-LOCK`).
- Discovery slot 해제: M_SPEC_APPROVED 도달 시점.
- Delivery slot 점유: M_SPEC_APPROVED → M_DELIVERY_PLANNING 시점. Promotion guard (`#RGC-PROMOTION-GUARD`) 에 의해 직전 Delivery N 의 finalization 전에는 차단됨.
- Delivery slot 해제: M_DONE 또는 M_ESCALATED 도달 시점.

### Dual-track Knowledge Inject

Discovery N+1 의 manifest 에 자동 inject (KAC-SLICE-TELEMETRY):

- 직전 Delivery milestone N-1 의 Context Summary
- 진행 중 Delivery milestone N 의 slice telemetry (진행 slice 수, 성공 acceptance 결과, BLOCKED 사유)
- N 의 inner session_log 요약 (자주 발생한 edge case, refactor 패턴)
- N 의 evidence/metric run 결과
- RefactorBacklog 의 architectural debt indicator

Discovery N+1 은 Delivery N 의 영속 객체를 **read-only** 만 참조 — `read_base_revision_pin` 필수 (`#SOC-CROSS-MILESTONE-REFERENCE`).

<a id="SOC-SLICE-LIFECYCLE"></a>
## SOC-SLICE-LIFECYCLE: Slice Lifecycle (7-state)

```text
SLICE_PENDING        (dependency 미해소 — `blocks` edge 가 SLICE_VALIDATED 안 됨)
   → SLICE_READY     (build 시작 가능)
   → SLICE_BUILDING  (inner loop session 진행)
   → SLICE_REVIEWING (middle review session + SliceMerge SM_READY_FOR_REVIEW)
   → SLICE_INTEGRATING (SM_APPROVED → trunk rebase + verification)
   → SLICE_VALIDATED (SM_MERGED, terminal-ish)
   |  SLICE_BLOCKED  (escalate, governance signal 필요)
```

### Slice Schema

```text
Slice {
  slice_id
  milestone_id
  slice_kind                 # feature | internal
  value_statement            # one sentence (feature) 또는 refactor_summary (internal)
  ac_ids[]                   # feature 한정
  acceptance_tests[]         # path + name + AC-ID mapping (feature). pending marker 정책 §SOC-OPERATIONS-OUTER-SPECIFICATION
  declared_scope             # 변경 허용 file/path
  declared_metric_threshold  # internal 한정 (선택)
  interface_break            # boolean default false
  dependencies[]             # {slice_id, edge_type: blocks | coordinates_with}
  trunk_base_revision
  dod_revision_pin           # DoD 가 변경되면 새 pin
  state                      # 7-state
  current_session_id         # 진행 중 session
  spawning_proposal_id       # internal 일 때 RefactorProposal 역참조
  abandoned_reason           # SLICE_BLOCKED 또는 abandon 시
  external_refs[]            # 외부 추적 시스템 mirror (선택, 추상 슬롯 — §SOC-OBJECTS)
}
```

### Inner Build Session 절차

`SLICE_BUILDING` 의 inner DialogueSession 은 forge 의 solo session 이며 다음 turn-by-turn 을 따른다.

1. Caller 가 input 구성 (manifest + turn_log + 직전 verification_result + role prompt — `AGC-SESSION-INPUT`).
2. forge 호출 (stateless, but input 에 turn_log).
3. forge → turn envelope: workspace patch + `tdd_phase: red_green | refactor` + `target_tests[]`.
4. envelope 검증 통과 후 turn worker 가 patch 를 슬라이스-로컬 브랜치에 적용하고 commit 을 생성하여 `workspace_commit` SHA 를 SessionTurn 에 기록한다 (post-validate step). 검증 실패 시 commit 을 생성하지 않으며 그 turn 은 `#AGC-INVALID` 로 분류된다.
5. Caller verification 실행 (acceptance + deterministic).
6. turn_log append + progress_metric 계산.
7. Convergence:
   - 모든 acceptance_test green + deterministic pass → CONVERGED → SLICE_REVIEWING.
   - max_turns 도달 → TIMEOUT → SLICE_BLOCKED.
   - 3 turn 동안 newly_green=0 → no_progress → escalate.
   - regression (직전 green 깨짐) 한도 초과 → escalate.
   - refactor turn 인데 test 빨강 → 그 turn rollback (commit revert).

### TDD Orthodoxy (option `target.tdd_strict`)

- `tdd_phase: red_green` turn — 직전 verification 에 failed[] 비어 있지 않아야. 이 turn 후 newly_green ≥ 1 기대.
- `tdd_phase: refactor` turn — 직전 모두 green 이어야 시작. 이 turn 후 regression 0 강제.

위반 → 그 turn invalid. retry 한도는 `loop_policies.inner.tdd_build.max_attempts_per_turn`.

<a id="SOC-SLICE-DEPENDENCIES"></a>
## SOC-SLICE-DEPENDENCIES: Slice Dependency Model

Planning phase 가 slice DAG 와 의존 그래프를 산출한다.

### Edge Types

| Edge | 의미 | 정책 |
|---|---|---|
| `blocks` | 순서 강제 | dependency slice 가 `SLICE_VALIDATED` 전까지 본 slice 는 `SLICE_PENDING`. Join condition (`SLICE_PENDING → SLICE_READY`) 의 1차 조건 |
| `coordinates_with` | 병렬 허용 | 두 slice 가 동시에 `SLICE_BUILDING` 가능. trunk merge 시 first-merger-wins, 후속은 rebase. SliceMerge 단계의 `SM_STALE` 감지로 처리 |

### Join Condition

`SLICE_PENDING → SLICE_READY` 전이 조건:

- 모든 `blocks` dependency 가 `SLICE_VALIDATED`.
- `coordinates_with` dependency 의 상태는 join 에 영향을 주지 않는다 (병렬 허용).

### Dynamic Edge Discovery

inner loop 중 새 의존 발견 시 forge 가 turn envelope 의 `next_action_request.proposal_artifact_ref` 또는 `proposal` contribution 에 `discovered_dependency` 를 첨부.

| 본 slice 상태 | 처리 |
|---|---|
| `SLICE_BUILDING` 이전 (`SLICE_PENDING` / `SLICE_READY`) | Caller 가 자동으로 dependency 추가 (DAG 갱신) |
| `SLICE_BUILDING` 이후 | governance signal `acceptance_test_amendment` 또는 `cross_milestone_amendment` 필요. 자동 추가 차단 |

### Cycle Detection

Planning ensemble session 의 lead artifact validation 시 cycle 검사. cycle 발견 시 lead contribution FAIL 로 처리되어 session 이 `request_changes` 또는 `failure` 로 전이.

<a id="SOC-SLICE-CLASS"></a>
## SOC-SLICE-CLASS: Slice Class & Internal Promotion

### Class

| Class | 의미 | DoD |
|---|---|---|
| `feature` | user-observable behavior | acceptance_tests + Discovery/Specification 의 사람 게이트 |
| `internal` | behavior preservation (refactor, code health) | 기존 test green + scope/interface invariant + (선택) metric_threshold. 사람 게이트 면제 (단 escalation rule 미발동 시) |

### Internal Escalation

`target.internal_escalation_rules` (`docs/contracts/target-config-contract.md#TCC-SLICE-CLASS-RULES`) 의 1개라도 hit 시 자동 `feature` 게이트로 승격 (사람 review 필수). default 6 rule:

- `interface_break: true` (public API signature 변경)
- `schema_or_migration_change: true`
- `security_sensitive_path: true`
- `perf_critical_path: true`
- `existing_test_coverage_below_threshold`
- `metric_runner_unavailable`

### RefactorBacklog → Internal Slice Promotion

scout 정기 scan + forge / sentinel ad-hoc proposal → `RefactorProposal` 영속화 (KAC-REFACTOR-BACKLOG). Planning ensemble session 시점에 atlas curate → CURATED → internal slice promotion (Caller operation):

```text
proposal.status=CURATED:
  slice = create_internal_slice(
    value_statement: proposal.suggested_refactor,
    declared_scope: proposal.code_location,
    declared_metric_threshold: proposal.metric_target,
    spawning_proposal_id: proposal.proposal_id)
  proposal.status = SCHEDULED
slice → SLICE_VALIDATED:
  proposal.status = DONE
slice → SLICE_BLOCKED/abandon:
  proposal.status = SUPERSEDED | DROPPED
```

<a id="SOC-SESSION-LIFECYCLE"></a>
## SOC-SESSION-LIFECYCLE: DialogueSession Lifecycle (5-state)

```text
SESSION_OPEN
   → CONVERGED            (finalization rule 통과 + required_evidence 충족)
   |  TIMEOUT             (max_turns 또는 wall-clock 초과)
   |  ABANDONED           (no_progress / regression 한도 / scope_violation 한도 초과)
   |  AWAITING_REVALIDATION  (trunk 변경으로 verification 재실행 필요)
```

### DialogueSession Schema

```text
DialogueSession {
  session_id
  parent_object_kind: slice | milestone
  parent_object_id
  parent_loop: outer | middle | inner
  purpose                  # design / build / review / tdd_build / planning_decompose / validation
  participants[]: [{agent_profile, role: lead|reviewer|observer}]
  session_termination: {finalization_rule, required_evidence[], composite_rule}  # §SOC-SESSION-TERMINATION
  workspace_revision_pin   # session 시작 시 base
  current_turn_index
  state                    # SESSION_OPEN | CONVERGED | TIMEOUT | ABANDONED | AWAITING_REVALIDATION
  final_verdict            # CONVERGED 일 때만 채워짐. (state, final_verdict) tuple 이 dispatch 분기
  max_turns
  turn_log_ref             # session_log artifact 포인터 (KAC-SESSION-LOG-STORAGE)
  spawned_contribution_id  # 응축된 1개 session_outcome contribution
  finalization_decision    # 종료 시 어느 rule 이 결정자였는지 (audit) — finalization_rule | required_evidence | composite
  lease                    # session-level lease (RGC-LEASE-KINDS)
}

SessionTurn {
  session_id, turn_index   # session-local. (session_id, turn_index) globally unique
  agent_profile_id
  input_manifest_id
  input_turn_log_snapshot_ref
  output_envelope_ref
  next_action_request      # agent 의 *제안*
  caller_routing_decision  # accepted | overridden | dropped
  workspace_commit         # inner loop 한정
  verification_result      # required_evidence 평가 입력
  recorded_at
}
```

### State Transition

| 현재 state | 트리거 | 다음 state |
|---|---|---|
| SESSION_OPEN | finalization rule + required_evidence 동시 충족 | CONVERGED + final_verdict 기록 |
| SESSION_OPEN | max_turns 도달 또는 wall-clock 초과 | TIMEOUT |
| SESSION_OPEN | no_progress 한도 / regression 한도 / scope_violation 한도 초과 | ABANDONED + abandoned_reason 기록 |
| SESSION_OPEN | session 안 turn 들 사이에 trunk 가 변동 (cross-slot stale 감지 — `#RGC-CROSS-SLOT-STALE`) | AWAITING_REVALIDATION |
| AWAITING_REVALIDATION | Caller 가 verification 재실행 후 pass | SESSION_OPEN 으로 복귀 (이어서 진행) |
| AWAITING_REVALIDATION | verification 재실행 fail (한도 내 재시도 후 실패) | TIMEOUT |

### Dispatch 책임

위 state transition 의 트리거 감지와 dispatch (parent 객체의 state 전이, SliceMerge 생성, 다음 turn enqueue 등) 는 dialogue coordinator (Caller 의 session 진행 daemon) 가 단독으로 수행한다. inner CONVERGED 직후 SLICE_BUILDING → SLICE_REVIEWING 으로의 전이도 본 dispatch 의 일부로 *동기적으로* 일어나며, agent 또는 turn worker 가 직접 수행하지 않는다.

같은 slice 의 inner session 과 middle session 이 동시에 SESSION_OPEN 인 상태는 invalid 다 — slice_lease (`docs/contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS`) 가 슬라이스 단위로 보호한다. inner CONVERGED → SLICE_REVIEWING 전이의 동기 dispatch 가 이 invariant 를 보존한다.

<a id="SOC-SESSION-TERMINATION"></a>
## SOC-SESSION-TERMINATION: Session Termination Rule

session 종료 조건은 *의사결정 수렴* (finalization_rule) 과 *결정적 증거* (required_evidence) 를 분리한다.

```text
session_termination {
  finalization_rule:
    lead_only | unanimous_approve | quorum_then_lead
    | any_request_changes_blocks | timeout_only
  required_evidence[]:
    verification_green: { acceptance_tests[], deterministic_checks[] }
    metric_threshold: { metric_name, comparator, value }
    interface_diff_clean: { protected_apis[] }
    coverage_threshold: { ... }
  composite_rule:
    finalization_AND_evidence | evidence_only | finalization_only
}
```

### Finalization Rule Enum

| Rule | 의미 |
|---|---|
| `lead_only` | lead 의 1 turn 출력으로 즉시 finalization 평가. 예: TDD inner build (forge solo) |
| `unanimous_approve` | 모든 reviewer participant 의 approve. Planning ensemble 의 default |
| `quorum_then_lead` | reviewer 의 quorum (`min_approvals` threshold) + lead 의 final say. Discovery / Specification 의 default (with `human` required) |
| `any_request_changes_blocks` | 1건이라도 request_changes 면 차단. middle review 의 default |
| `timeout_only` | wall-clock 만 평가. observation-only session 에 사용 |

### Required Evidence Enum

| Kind | 의미 | producer |
|---|---|---|
| `verification_green` | acceptance_tests + deterministic_checks 모두 pass | VerificationRun |
| `metric_threshold` | code metric 이 target threshold 충족 (예: complexity ≤ X) | MetricRun |
| `interface_diff_clean` | protected_apis 의 signature 무변경 | VerificationRun (interface diff) |
| `coverage_threshold` | test coverage ≥ X | VerificationRun |

### Composite Rule

| Rule | 의미 |
|---|---|
| `finalization_AND_evidence` | 둘 다 충족해야 CONVERGED |
| `evidence_only` | required_evidence 만 평가 (finalization_rule 무시) — TDD inner build 의 default |
| `finalization_only` | finalization_rule 만 평가 (required_evidence 무시) — Spec design 의 default |

### Session 사용 예

| 사용처 | finalization_rule | required_evidence | composite_rule |
|---|---|---|---|
| inner TDD build | lead_only | verification_green | evidence_only |
| outer Discovery (사람 + agent) | quorum_then_lead (with `human` required) | (없음) | finalization_only |
| outer Specification | quorum_then_lead (with `human` required) | (없음) | finalization_only |
| outer Planning | unanimous_approve | (없음) | finalization_only |
| outer Validation | lead_only | verification_green | evidence_only |
| middle review (feature slice) | any_request_changes_blocks | verification_green | finalization_AND_evidence |
| middle review (internal slice) | quorum_then_lead | verification_green + metric_threshold + interface_diff_clean | finalization_AND_evidence |

### final_verdict Enum

session 의 (state, final_verdict) tuple 이 다음 dispatch 분기를 결정한다 (`#SOC-DISPATCH-MATRIX`).

| final_verdict | 사용처 |
|---|---|
| `approve` | middle review CONVERGED |
| `request_changes` | middle review CONVERGED (재build 필요) |
| `tests_green` | inner tdd_build CONVERGED |
| `spec_accept` | outer Discovery / Specification CONVERGED |
| `spec_reject` | outer Discovery / Specification CONVERGED (사람 reject) |
| `plan_accept` | outer Planning CONVERGED |
| `validation_pass` | outer Validation CONVERGED PASS |
| `validation_fail` | outer Validation CONVERGED FAIL |
| `validation_stale` | outer Validation CONVERGED STALE |
| `no_progress` | inner ABANDONED 의 abandoned_reason |
| `regression` | inner ABANDONED 의 abandoned_reason |
| `scope_violation` | inner ABANDONED 의 abandoned_reason |

<a id="SOC-SLICE-MERGE"></a>
## SOC-SLICE-MERGE: SliceMerge Lifecycle (7-state)

### SliceMerge Schema

```text
SliceMerge {
  slice_merge_id
  slice_id
  pre_merge_workspace_revision   # rebase 기준
  merge_revision                 # trunk SHA after merge (terminal 직전 채워짐)
  inner_session_id
  review_session_id
  verification_run_id
  state                          # SM_DRAFT | SM_READY_FOR_REVIEW | SM_APPROVED | SM_MERGED
                                 # | SM_REQUEST_CHANGES | SM_CLOSED | SM_STALE
  merged_at
  merged_by_caller_id
  lease_token
  external_refs[]                # 외부 추적 시스템 mirror (선택, 추상 슬롯 — §SOC-OBJECTS)
}
```

### Lifecycle

```text
SM_DRAFT                    (inner session 진행 중)
   → SM_READY_FOR_REVIEW    (inner CONVERGED → middle 입력)
   → SM_APPROVED            (middle finalization 통과)
   → SM_MERGED              (Caller trunk merge 완료, terminal)
   |  SM_REQUEST_CHANGES    (middle request_changes → SLICE_BUILDING 회수)
   |  SM_CLOSED             (abandon/escalate, terminal)
   |  SM_STALE              (trunk 변경 → rebase 또는 verification 재실행 fail)
```

### SliceMerge Flow (Slice 와 정합)

1. Inner session CONVERGED (final_verdict=tests_green) → SliceMerge SM_DRAFT 생성, SM_READY_FOR_REVIEW 로 전이. Slice SLICE_BUILDING → SLICE_REVIEWING.
2. Middle review session 시작 — 입력은 SliceMerge + inner session_log.
3. Middle CONVERGED (final_verdict=approve) → SM_APPROVED → Slice SLICE_REVIEWING → SLICE_INTEGRATING → Caller trunk rebase + verification 재실행.
4. Clean → SM_MERGED → Slice SLICE_VALIDATED.
5. Conflict / verification fail → SM_STALE → Slice SLICE_REVIEWING 유지 (재호출 대기). 한도 내 자동 verification 재실행 → pass 시 SM_READY_FOR_REVIEW 복귀, fail 시 한도 초과 시 Slice SLICE_BLOCKED.
6. Middle CONVERGED (final_verdict=request_changes) → SM_REQUEST_CHANGES → SM_CLOSED. Slice SLICE_REVIEWING → SLICE_BUILDING 회수, 새 inner build session 시작.

### Audit Chain

`SliceMerge → review_session_id → SessionTurn[] → inner_session_id → SessionTurn[] → slice_id → ac_ids → acceptance_tests` — Code CP / Integration CP 폐기 후에도 audit trace 보존.

<a id="SOC-DUAL-MILESTONE-BRANCH"></a>
## SOC-DUAL-MILESTONE-BRANCH: Dual-Milestone Branch Policy

Delivery slot 1 + Discovery slot 1 의 dual-track 에서 trunk 와 milestone-level branch 의 관계는 다음을 따른다.

- **Trunk**: 단일 trunk 만 존재. Delivery N 의 모든 SliceMerge 가 SM_MERGED 시 trunk HEAD 를 전진시킨다.
- **Milestone-level branch**: SliceMerge 의 base 는 trunk 의 어느 시점 SHA 이며, slice 별 branch 는 일시적이다. milestone N 종료 (M_DONE) 와 동시에 milestone-level branch 는 정리된다.
- **Discovery N+1 의 working artifact**: spec/doc 객체이며 trunk 코드 병합 대상이 아니다. Spec CP 는 별도 spec-doc store 에 영속화되거나 trunk 의 doc 디렉토리에 SliceMerge 가 아닌 outer-loop session_outcome 의 후주입으로 commit 될 수 있다 (운영 결정).
- **Cross-slot conflict**: Delivery N 의 SliceMerge 와 Discovery N+1 의 doc commit 이 동일 path 에 충돌하는 경우 first-merger-wins. 후속은 SM_STALE 또는 spec session 의 AWAITING_REVALIDATION.

병렬 slice 의 trunk merge 에 대한 정책은 `#SOC-MERGE-POLICY` 를 따른다.

<a id="SOC-CROSS-MILESTONE-REFERENCE"></a>
## SOC-CROSS-MILESTONE-REFERENCE: Cross-Milestone Reference Rules

Discovery N+1 은 Delivery N 의 영속 객체를 **read-only** 만 참조한다.

| 규칙 | 의미 |
|---|---|
| `read_base_revision_pin` 필수 | Discovery N+1 manifest 가 Delivery N 의 객체를 inject 할 때 반드시 revision pin 첨부 |
| 변경 감지 → AWAITING_REVALIDATION | N 의 객체가 변경되면 N+1 의 영향 받은 session 이 자동 AWAITING_REVALIDATION 으로 전이. Caller 가 revision pin 비교로 감지 |
| Default scope expansion | N+1 이 "N 에도 X 필요" 발견 시 default 동작은 X 를 N+1 scope 흡수. explicit 변경은 `cross_milestone_amendment` proposal → governance signal |
| Promotion guard | Delivery N finalization (M_DONE) 전 N+1 의 `M_SPEC_APPROVED → M_DELIVERY_PLANNING` 금지 (`#RGC-PROMOTION-GUARD`) |

### Resource Sharing

- AgentProfile worker slot 은 milestone-agnostic. atlas 1 worker 가 N+1 Discovery + N Planning 을 번갈아 servicing.
- `target.dual_track.priority` ∈ {`delivery_first`, `balanced`, `discovery_first`} (TCC-DUAL-TRACK).
- WIP limit per profile: `loop_policies.<loop>.<phase|purpose>.concurrent_sessions`.

<a id="SOC-INTAKE"></a>
## SOC-INTAKE: Milestone Intake

milestone 은 외부 입력으로부터 `M_INTAKE_QUEUED` 로 처음 만들어진다. 입력 종류는 다음 둘이다.

| 입력 | 출처 | 진입 결과 |
|---|---|---|
| 사람이 남긴 milestone seed | governance/input write (예: 사람이 영속 저장소에 남긴 아이디어 객체) | Caller 가 새 milestone 을 `M_INTAKE_QUEUED` 로 영속화 |
| 후속 milestone trigger | 직전 milestone 의 Context Summary 또는 KAC-DECISION-LOG 의 후속 항목 | Caller 가 새 milestone 을 `M_INTAKE_QUEUED` 로 영속화 |

intake 는 Agent 호출이 아니다. Caller 단독 operational write 이며 다음을 따른다.

- intake 는 *영속 저장소가 발급한 milestone 식별자* 가 결정된 시점에 ledger 한 줄을 남긴다. ledger 의 `from_state` 는 비어 있고 `to_state` 는 `M_INTAKE_QUEUED` 다.
- intake 의 idempotency_key 는 `(intake_source_kind, intake_source_id)` 다. 동일 source 가 두 milestone 을 만들면 invariant 위반이다.
- intake 입력의 정합성 검증은 `docs/contracts/reliability-and-gate-contract.md#RGC-SIGNALS` 의 envelope 검증을 따른다.

`M_INTAKE_QUEUED → M_DISCOVERY_DRAFT` 전이는 Discovery slot 이 비어 있을 때 dual-gate queue (`#RGC-DUAL-GATE-QUEUE`) 가 dispatch 한다 — slot lock 보호 (`#RGC-SLOT-LOCK`).

<a id="SOC-OPERATIONS"></a>
## SOC-OPERATIONS: Operations

각 loop step 의 operation 은 다음 구조를 갖는다.

- **Loop / Phase / Purpose**: outer / middle / inner 의 loop 위치
- **Lead profile** + **Reviewer profiles** + **Required participants** — `loop_policies.<loop>.<phase|purpose>` (`docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES`)
- **Allowed `contribution_kind` 셋** — `#AGC-CONTRIBUTION-OUTPUTS` 매트릭스의 해당 행
- **Default termination** — `loop_policies.<loop>.<phase|purpose>.session_termination`
- **Caller action on session CONVERGED** — `application/dialogue_coordinator.sh` 가 (state, final_verdict) tuple 평가 후 dispatch
- **Idempotency key** — Caller enrichment 가 합성 (`#SOC-IDEMPOTENCY`)
- **Failure modes** — invalid / stale / 한도초과 케이스

### Intake

- Agent: 없음 (Caller only)
- Input state: 외부 seed
- Caller action: milestone 생성 + `M_INTAKE_QUEUED` 영속화
- Idempotency key: `intake_source_kind + intake_source_id`

### Outer Discovery

- Lead profile: `atlas`
- Reviewer profiles: `sentinel`
- Required participants: `human` (feature 게이트)
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `human_approval`, `proposal`
- Input state: `M_DISCOVERY_DRAFT`
- Lead artifact: milestone 본문 + ADR + spec_proposal
- Default termination: `quorum_then_lead` + `finalization_only` (composite_rule)
- Caller action on CONVERGED (final_verdict=spec_accept): Spec CP 영속화, milestone `M_DISCOVERY_DRAFT → M_SPECIFICATION_DRAFT`
- Caller action on CONVERGED (final_verdict=spec_reject): Spec CP 닫음, milestone `M_DISCOVERY_DRAFT` 유지 또는 `M_DISCOVERY_AWAITING_HUMAN` 진입
- Idempotency key (session_outcome): `milestone_id + outer + Discovery + session_id + input_revision_pins`
- Failure: required `human` 누락 (timeout 시 ESCALATED), envelope invalid

### Outer Specification

- Lead profile: `atlas`
- Reviewer profiles: `forge`, `sentinel`
- Required participants: `human`
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `human_approval`, `proposal` (acceptance_test_amendment)
- Input state: `M_SPECIFICATION_DRAFT`
- Lead artifact: scenarios + AC-IDs + AC-ID 별 acceptance test 코드
- Default termination: `quorum_then_lead` + `finalization_only`
- Pending marker 정책: 신규 commit 된 acceptance test 는 framework 별 pending marker 적용 (`@pytest.mark.pending`, `xit(...)`, `t.Skip("pending slice X")` 등). 일반 trunk verification 은 marker 가 붙은 test 를 수집은 하되 실행은 skip — trunk green 유지. slice 의 inner build 시작 시 그 slice 의 acceptance_tests[] marker 만 제거. SLICE_VALIDATED 도달 → marker 영구 제거. SLICE_BLOCKED → marker 유지 (governance signal `purge_acceptance_tests` 로 명시 제거).
- Acceptance test escape path: inner build 중 acceptance test 의 *behavioral intent* 가 잘못이 명백해지면 forge 가 turn envelope 에 `acceptance_test_amendment_proposal` 첨부. proposal 은 새 Specification dialogue session 트리거 (sentinel + atlas + human required). approve 시 새 acceptance test 코드 commit + 영향 받은 slice 의 `dod_revision_pin` 갱신. test name/path 변경은 별도 `acceptance_test_rename` governance signal.
- Caller action on CONVERGED (spec_accept): Spec CP merge, milestone `M_SPECIFICATION_DRAFT → M_SPEC_APPROVED`. Discovery slot 해제.

### Outer Planning

- Lead profile: `atlas`
- Reviewer profiles: `forge`, `sentinel`
- Required participants: 없음 (사람 게이트는 Discovery / Specification 에서 흡수)
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `proposal` (refactor_proposal — RefactorBacklog curation)
- Input state: `M_DELIVERY_PLANNING`
- Lead artifact: slice DAG + 의존 그래프 + dod_revision_pin
- Default termination: `unanimous_approve` + `finalization_only`
- Caller action on CONVERGED (plan_accept): slice DAG 영속화, dependency 없는 slice 를 `SLICE_READY` 로 전이. RefactorProposal 의 CURATED → SCHEDULED + internal slice promotion (`#SOC-SLICE-CLASS`). milestone `M_DELIVERY_PLANNING → M_DELIVERY_BUILDING`.
- Failure: dependency cycle, slice DAG invalid, scope conflict.

### Middle Slice Build (Inner Loop의 wrapper로서)

slice 의 inner build session (`#SOC-SLICE-LIFECYCLE`) 자체는 inner loop session 이지만, slice state 전이의 lifecycle 은 middle loop 의 책임이다.

### Middle Slice Review

- Lead profile: `sentinel`
- Reviewer profiles: `forge` (default), `atlas` (architectural slice 한정)
- Required participants: 없음 (단 `feature` slice 에서 internal escalation rule hit 시 `human` 추가)
- Allowed contribution_kinds: `review_verdict`, `proposal`
- Input: SliceMerge + inner session_log
- Default termination (feature slice): `any_request_changes_blocks` + `verification_green` (composite=AND)
- Default termination (internal slice): `quorum_then_lead` + `verification_green + metric_threshold + interface_diff_clean` (composite=AND)
- Caller action on CONVERGED (approve): SliceMerge `SM_READY_FOR_REVIEW → SM_APPROVED`, Slice `SLICE_REVIEWING → SLICE_INTEGRATING`. trunk rebase + verification 재실행.
- Caller action on CONVERGED (request_changes): SliceMerge `SM_REQUEST_CHANGES → SM_CLOSED`, Slice `SLICE_REVIEWING → SLICE_BUILDING`. 새 inner build session 시작.

### Outer Validation

- Lead profile: `sentinel`
- Reviewer profiles: `scout` (evidence), `atlas` (summary)
- Required participants: 없음 (사람 승인은 phase 외부 release governance)
- Allowed contribution_kinds: `lead_draft`, `review_verdict`, `proposal`
- Input state: `M_DELIVERY_VALIDATING`
- Caller pre-action: trunk 결정적 검증 실행 (cross-slice acceptance test 포함, AC-ID 별 결과 수집)
- Lead artifact: validation_pass / validation_fail / validation_stale verdict, milestone 본문, Context Summary, AC 별 결과, FAIL 시 책임 slice 식별
- Default termination: `lead_only` + `verification_green` (composite=evidence_only)
- Caller action on CONVERGED (validation_pass): Milestone CP 영속화 + merge, Context Summary 영속화 (KAC-CONTEXT-SUMMARY), 자식 Issue 종료, milestone `M_DELIVERY_VALIDATING → M_DONE`. Delivery slot 해제.
- Caller action on CONVERGED (validation_fail): Milestone CP 닫음, 책임 slice 만 `SLICE_READY` 회수, 나머지 SLICE_VALIDATED 유지, milestone `M_DELIVERY_VALIDATING → M_DELIVERY_BUILDING`.
- Caller action on CONVERGED (validation_stale): Milestone CP `SM_STALE`-equivalent (Spec CP store 의 stale), milestone 회수.

### Recover

Recover 의 진입 트리거와 객체 수준 결과 분류는 `#SOC-RECOVERY-OPERATION` 이 정의한다. 회수 메커니즘 (lease 만료 검출, sweeper, 회수 시각 결정) 은 `docs/contracts/reliability-and-gate-contract.md#RGC-RECOVERY` 가 정의한다.

<a id="SOC-RECOVERY-OPERATION"></a>
## SOC-RECOVERY-OPERATION: Recover Operation

Recover 는 다른 operation 과 달리 Agent 를 호출하지 않는다. Caller (또는 Caller 가 위임한 sweeper) 가 비정상 상태의 객체를 수습하기 위해 직접 수행하는 operational write 다.

### 진입 트리거

| Trigger | 설명 |
|---|---|
| stale | lease 만료, timeout, revision pin 불일치 |
| lease-expiry | lease 의 `expires_at` 도과 |
| human-revoke | 사람이 회수 요청 시그널을 남김 |
| partial-fail-rollback | multi-step operational write 의 부분 적용을 원복 |
| session-stale | DialogueSession 의 lease 만료 또는 base revision 변동 — slice 는 살아 있고 session 만 ABANDONED 또는 AWAITING_REVALIDATION |
| session-timeout | `loop_policies.<loop>.<phase>.timeout` 안에 도착하지 않은 session — slice 또는 milestone 을 직전 `*_READY` 로 회수 |
| inner-no-progress | inner loop 의 newly_green=0 한도 초과 또는 regression 한도 초과 — slice SLICE_BUILDING → SLICE_BLOCKED |
| slice-merge-stale | trunk 변경으로 SliceMerge SM_APPROVED 의 verification 재실행 fail — SM_STALE 로 전이 |
| coordinator-failure | dialogue_coordinator 또는 slot scheduler 가 실행 도중 중단되어 평가가 미완 — session/slot lock 을 sweep 후 다음 cycle 에서 재평가 |

### 객체 전이

```text
SLICE_BUILDING → SLICE_READY (rebuild 가능 시) | SLICE_BLOCKED
SLICE_REVIEWING → SLICE_BUILDING (request_changes 회수)
SLICE_INTEGRATING → SLICE_REVIEWING (verification fail) | SLICE_BLOCKED
SESSION_OPEN → ABANDONED | TIMEOUT | AWAITING_REVALIDATION
SM_DRAFT/SM_READY_FOR_REVIEW/SM_APPROVED → SM_STALE | SM_CLOSED
M_DELIVERY_BUILDING → M_DELIVERY_PLANNING (재계획 필요 시)
M_*_AWAITING_HUMAN → M_*_DRAFT (timeout 또는 명시 회수)
M_* → M_ESCALATED
```

### Trigger × Ledger Result

| Trigger | 일반 result | 회수 자체 실패 시 |
|---|---|---|
| stale | `recovered` | `escalated` |
| lease-expiry | `recovered` | `escalated` |
| human-revoke | `recovered` | `escalated` |
| partial-fail-rollback | `rolled_back` | `escalated` |
| session-stale | `recovered` | `escalated` |
| session-timeout | `recovered` | `escalated` |
| inner-no-progress | `recovered` (SLICE_BLOCKED 진입) | `escalated` |
| slice-merge-stale | `recovered` (SM_STALE 진입) | `escalated` |
| coordinator-failure | `recovered` (재평가 후 `applied`) | `escalated` |

### Idempotency

같은 Recover trigger 가 같은 객체에 대해 반복 발화될 수 있다. Caller 는 Recover ledger idempotency key 를 `object_id + trigger + observed_revision_pin` 으로 산출하여 중복 회수를 ledger 의 `duplicate` 로 흡수한다. session-단위 회수의 경우 `object_id` 는 `(session_id, current_turn_index)` 이고, slice-merge 단위는 `slice_merge_id`. 이 키는 Agent output envelope 의 idempotency key 와 이름은 같지만 entity scope 가 다르므로 prose 에서는 항상 Recover ledger idempotency key 로 한정해 부른다.

<a id="SOC-DISPATCH-MATRIX"></a>
## SOC-DISPATCH-MATRIX: Dispatch Matrix

본 절은 `#SOC-OPERATIONS` 의 모든 분기를 *loop · phase/purpose × session state × final_verdict × 종착* 으로 응축한 표다. 각 operation 절의 본문이 정본이며, 본 표는 단일 진입점으로의 인덱스 역할을 한다.

session 종착 transition 은 `application/dialogue_coordinator.sh` 가 (state, final_verdict) tuple 평가 시점에만 dispatch 한다.

| Loop · Phase / Purpose | session state | final_verdict | 종착 |
|---|---|---|---|
| Intake | (없음) | (Caller only) | milestone `M_INTAKE_QUEUED` |
| Slot promotion (intake → discovery) | (Caller only) | — | milestone `M_DISCOVERY_DRAFT` (Discovery slot 점유) |
| outer Discovery | CONVERGED | `spec_accept` | milestone `M_SPECIFICATION_DRAFT`, Spec CP merged |
| outer Discovery | CONVERGED | `spec_reject` | milestone `M_DISCOVERY_DRAFT` 유지 또는 `M_DISCOVERY_AWAITING_HUMAN`, Spec CP closed |
| outer Discovery | TIMEOUT | (n/a) | milestone `M_DISCOVERY_DRAFT` 회수 또는 ESCALATED |
| outer Specification | CONVERGED | `spec_accept` | milestone `M_SPEC_APPROVED`, Discovery slot 해제 |
| outer Specification | CONVERGED | `spec_reject` | milestone `M_SPECIFICATION_DRAFT` 유지 |
| Slot promotion (spec_approved → delivery) | (Caller only) | — | milestone `M_DELIVERY_PLANNING` (Delivery slot 점유, promotion guard 통과 시) |
| outer Planning | CONVERGED | `plan_accept` | milestone `M_DELIVERY_BUILDING`, slices 영속화, READY slice → SLICE_READY |
| outer Planning | CONVERGED | `request_changes` | milestone `M_DELIVERY_PLANNING` 유지, lead 재호출 |
| inner tdd_build | CONVERGED | `tests_green` | slice `SLICE_BUILDING → SLICE_REVIEWING`, SliceMerge `SM_DRAFT → SM_READY_FOR_REVIEW` |
| inner tdd_build | TIMEOUT | (n/a) | slice `SLICE_BLOCKED` |
| inner tdd_build | ABANDONED | `no_progress`/`regression`/`scope_violation` | slice `SLICE_BLOCKED` |
| middle review | CONVERGED | `approve` | slice `SLICE_REVIEWING → SLICE_INTEGRATING`, SliceMerge `SM_APPROVED`. trunk rebase + verification 후 `SM_MERGED` + slice `SLICE_VALIDATED` |
| middle review | CONVERGED | `request_changes` | slice `SLICE_REVIEWING → SLICE_BUILDING`, SliceMerge `SM_REQUEST_CHANGES → SM_CLOSED`, 새 inner session 시작 |
| middle review | AWAITING_REVALIDATION | (n/a) | slice `SLICE_REVIEWING` 유지, SliceMerge `SM_STALE`. Caller verification 재실행 — pass 시 `SM_READY_FOR_REVIEW` 복귀, fail 한도 초과 시 SLICE_BLOCKED |
| middle review | TIMEOUT | (n/a) | slice `SLICE_BLOCKED` |
| outer Validation | CONVERGED | `validation_pass` | milestone `M_DONE`, Milestone CP merged, Context Summary 영속화, Delivery slot 해제 |
| outer Validation | CONVERGED | `validation_fail` | milestone `M_DELIVERY_BUILDING` 회수, 책임 slice 만 `SLICE_READY` |
| outer Validation | CONVERGED | `validation_stale` | milestone `M_DELIVERY_VALIDATING` 회수 |
| Recover | (다양) | (Caller only) | trigger 별 — `#SOC-RECOVERY-OPERATION` |
| (any) | (any) | `failure` | 상태 변경 없음. 해당 session 의 turn 만 invalid 처리 |

ledger result 매핑(`applied`, `stale`, `recovered`, `rolled_back`, `escalated` 등) 은 `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER` 가 정의한다.

### Operation × Ledger Result 매트릭스

| 분기 | Ledger result |
|---|---|
| 정상 종착 (위 표의 transition) | `applied` |
| lease claim 경쟁 패배 | `claim_failed` |
| 같은 idempotency_key 의 선행 ledger 발견 | `duplicate` |
| 전이 조건 미충족 (예: dependency 미해소, ready 객체 부재) | `noop` |
| envelope 검증 실패 (`#AGC-INVALID`) | `invalid` |
| revision pin 또는 lease_token 불일치 | `stale` |
| 인프라/어댑터 오류 (`#ARC-EXIT-CLASSES`) | `error` |
| Recover 의 stale/lease-expiry/human-revoke 회수 | `recovered` |
| Recover 의 partial-fail-rollback 또는 multi-step 부분 적용 원복 | `rolled_back` |
| 재시도 한도 초과 또는 회수 자체 실패 | `escalated` |

같은 normal cycle 에서 두 result 가 동시에 후보가 되면 우선순위는 다음과 같다: `claim_failed` > `duplicate` > `noop` > `stale` > `invalid` > `error` > 정상 분기 (`applied`). 우선순위는 *최초로 만족한 조건* 으로 cycle 을 즉시 종료시키는 의미다.

`recovered`, `rolled_back`, `escalated` 는 위 normal cycle 우선순위 비교 대상이 아니다. 이 셋은 Recover 또는 failure handling 이 별도 ledger 행으로 기록하는 terminal result 다.

<a id="SOC-MERGE-POLICY"></a>
## SOC-MERGE-POLICY: SliceMerge Trunk Merge Policy

SliceMerge 의 base 는 trunk 의 어느 시점 SHA 다. 병렬 slice (`coordinates_with` 의존) 때문에 base 가 현재 trunk HEAD 보다 낡을 수 있다.

Caller 는 middle review 의 final_verdict=approve 통과 후 다음 순서로 처리한다.

1. SliceMerge.pre_merge_workspace_revision 이 현재 trunk HEAD 와 같으면 trunk merge 를 시도한다.
2. base 가 낡았지만 deterministic merge/rebase 가 clean 이면 Caller 가 SliceMerge 를 갱신하고 결정적 검증을 다시 실행한다 (verification 재실행).
3. conflict 가 있거나 결정적 검증이 실패하면 SliceMerge `SM_STALE` 로 전이하고 slice 를 `SLICE_REVIEWING` 유지 (재호출 대기). 자동 verification 재실행 한도 초과 시 `SLICE_BLOCKED`.

Agent 는 병합 충돌을 직접 해결하지 않는다. 충돌 해결이 필요한 경우 Caller 는 새 inner build session 을 만든다 (slice `SLICE_REVIEWING → SLICE_BUILDING`).

`coordinates_with` slice 의 first-merger-wins 보장은 trunk merge 시점의 atomic 단계에서 lock 보호된다. 후속 slice 는 SM_STALE → 재verification → SM_READY_FOR_REVIEW 사이클을 거친다.

<a id="SOC-IDEMPOTENCY"></a>
## SOC-IDEMPOTENCY: Idempotency Rules — 3 Scope

멱등성 키는 입력 revision 을 기준으로 한다. LLM 산출 본문 hash 는 output identity 로 사용하고, primary idempotency key 로 사용하지 않는다.

본 contract 는 다음 3 scope 의 idempotency 를 분리한다 — 이전 모형의 `phase_run_id` 단일 scope 가 폐기되고, session/turn/merge 차원의 분리가 필요하기 때문이다 (`docs/contracts/agent-runner-port-contract.md#ARC-IDEMPOTENCY`).

### Per-Turn Scope (agent runner 호출 단위)

agent runner 호출 1회의 멱등성. 같은 input 으로 두 번 호출되면 같은 envelope 가 산출되어야 한다.

`per_turn_idempotency_key = session_id + turn_index + agent_profile_id + manifest_id + input_revision_pins`

### Per-Session-Outcome Scope (session 종료 응축 단위)

DialogueSession 의 final artifact 응축의 멱등성. 같은 session_id + 같은 final_verdict tuple 로 두 번 응축이 시도되면 같은 session_outcome 이 산출되어야 한다.

`per_session_outcome_idempotency_key = session_id + final_verdict + finalization_decision + workspace_revision_pin_at_convergence`

### Per-Merge Scope (SliceMerge trunk merge 단위)

SliceMerge 의 trunk merge 의 멱등성. 같은 SliceMerge.id + 같은 pre_merge_workspace_revision 으로 두 번 merge 시도되면 같은 trunk SHA 가 산출되어야 한다.

`per_merge_idempotency_key = slice_merge_id + pre_merge_workspace_revision + trunk_base_revision_at_merge_attempt`

### 합성 책임

3-scope idempotency_key 의 합성은 모두 Caller enrichment 가 수행한다 (`docs/contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH`). Agent 는 산출하지 않는다.

중복 산출이 감지되면 Caller 는 새 객체를 만들지 않고 기존 객체를 재사용하거나 상태를 수렴시킨다. ledger 는 `duplicate` 로 기록한다.
