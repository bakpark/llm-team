# Loop-Based Workflow Design

**Status**: Draft (brainstorming output)
**Date**: 2026-05-05
**Branch context**: builds on `feat/phase-agent-profile-pivot`
**Scope**: Constitution amendment + 6 contracts rewrite + 6-stage rollout
**Authors**: brainstorming session output (Claude); reviewed by qwen3.6 + gpt5.5

---

## 0. Executive Summary

현재 `llm-team.md` + 6 contracts 는 **GitFlow + waterfall phases + parallel quorum review** 의 공식화다. 7 phase 가 linear 하게 lock-step 으로 진행되며, agent 는 stateless 1-call, agent 간 통신은 영속 큐로만, milestone 은 1개씩 직렬 진행.

본 design 은 그 모형을 **3-loop nested iterative model + dialogue-based agent collaboration + dual-slot milestone serialization** 으로 전환한다. 검증된 software methodologies (TDD, vertical slicing, trunk-based, continuous review, dual-track Discovery/Delivery, refactoring as first-class, ADR) 을 1급 시민으로 흡수.

**핵심 전환 3가지**:

1. **Phase → Loop**: 7 linear phase → 3 nested loop (outer milestone / middle slice / inner TDD).
2. **Quorum 평행 제출 → Dialogue session**: turn-based agent deliberation, Caller-mediated. agent statelessness 는 input 에 turn_log 를 포함하는 트릭으로 보존.
3. **Monolith milestone → Vertical slice 집합**: milestone = N slices 의 DAG, 각 slice 가 thin end-to-end + per-slice trunk merge.

**파급 효과 요약**:

- 헌법 invariant 11개 → 9개 (변경 3 + 보존 6, 그 외 항목은 Workflow Shape 절 또는 contract 로 격하).
- 6 contract 모두 rewrite (변경 강도: AGC 큼, SOC 매우 큼, RGC 매우 큼, KAC 큼, TCC 중~큼, ARC 중).
- 신규 contract 0 개. CONTRACT-MIGRATION-NOTES 가 phase→loop 환산표로 재활약.
- Cutover 6 stage (Stage 0~5), 각 stage abort line 정의.

---

## 1. Motivation

### 1-1. 현재 모형의 본질적 한계

| 한계 | 발현 |
|---|---|
| Phase 가 무거움 | 작은 변경에도 사람 게이트 2회 (Discovery + Specification) |
| Quorum 평행 제출 | reviewer A 와 B 의 의견 충돌 시 dialogue 없이 coordinator 의 binary 결정에 의존 |
| Milestone 직렬 | 다음 milestone Discovery 가 *추정* 으로 출발, 현재 milestone 의 실제 구현 학습이 입력 안 됨 |
| Implementation phase 의 단일 호출 | forge 가 verification 결과를 *그 다음 phase* 에서야 봄 — 즉시 자가 교정 불가 |
| Big-batch CodeReview | reviewer 부담 ↑, conflict 폭발, "95% 완료의 lying problem" |
| Refactor 가 high-ceremony | 기술부채 누적, 내부 청결성 저하 |

### 1-2. 적용할 방법론

| 방법론 | 적용 위치 |
|---|---|
| **TDD (Beck)** — red/green/refactor inner loop | Inner loop, slice 안의 forge build session |
| **Vertical slicing (Patton, Cohn)** | Slice 가 1급 객체. milestone = slice DAG |
| **Trunk-based (Fowler)** | per-slice trunk merge. 별도 long-lived feature branch 없음 |
| **Pair / Ensemble (Williams, Zuill)** | DialogueSession 의 Pair / Ensemble 형태 |
| **Continuous review** | middle loop 의 turn-based dialogue |
| **Dual-track Discovery/Delivery (Cagan/Patton)** | dual-slot milestone serialization |
| **Refactoring as continuous (Fowler)** | `internal` slice class + RefactorBacklog |
| **Definition of Done (Sutherland)** | slice DoD = 자동 게이트 (test + metric + interface + scope) |
| **ADR (Nygard)** | Discovery/Specification artifact 형식 강화 |

### 1-3. 보존되는 가치

- Caller-only operational write (권한 격리)
- Required human contribution (사람 결정의 절대 권위 — feature slice 한정)
- Knowledge accumulation (누적 spec / decision / context summary)
- AgentProfile abstraction (모델 교체 자유)
- Deterministic verification by Caller
- Self-fetch + Context Manifest + revision pin

---

## 2. Architecture: 3-Loop Nested Model

```
┌──────────────────────────────────────────────────────────────┐
│  OUTER LOOP — Milestone (Discovery + Delivery dual-track)    │
│   Discovery slot ↔ Delivery slot. live telemetry inject.     │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  MIDDLE LOOP — Slice                                 │   │
│   │   spec stub → tests → code → review → trunk merge   │   │
│   │   class: feature | internal                          │   │
│   │                                                      │   │
│   │   ┌─────────────────────────────────────────────┐   │   │
│   │   │  INNER LOOP — TDD build                     │   │   │
│   │   │   forge solo session, red/green/refactor    │   │   │
│   │   │   convergence: verification_green           │   │   │
│   │   └─────────────────────────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 2-1. Outer Loop — Milestone with Dual Slot

`Discovery slot 1 + Delivery slot 1` (default; `target.dual_track.discovery_wip` 로 N 까지 확장 옵션). 두 slot 은 서로 다른 milestone 에만 점유. Discovery N+1 의 manifest 에 Delivery N 의 live telemetry 가 자동 inject (Discovery 가 *현실* 에 기반).

Milestone state machine (2-stage):

```
Discovery stage:
  M_DISCOVERY_DRAFT
  M_DISCOVERY_AWAITING_HUMAN
  M_SPECIFICATION_DRAFT
  M_SPECIFICATION_AWAITING_HUMAN
  M_SPEC_APPROVED         (terminal of Discovery)

Delivery stage:
  M_DELIVERY_PLANNING     (slice 분해 dialogue session)
  M_DELIVERY_BUILDING     (slices 의 inner/middle loop 진행)
  M_DELIVERY_VALIDATING   (cross-slice acceptance + Context Summary)
  M_DONE | M_ESCALATED

Pre-intake:
  M_INTAKE_QUEUED
```

Outer loop 의 *phase* 어휘는 `Discovery / Specification / Planning / Validation` 4개로 격하. `Implementation / CodeReview / Integration` 은 middle/inner loop 의 책임으로 흡수되어 outer phase 어휘에서 폐기.

### 2-2. Middle Loop — Slice

Slice = user-observable thin end-to-end (`feature` class) 또는 behavior-preserving code change (`internal` class). 자체 DoD + per-slice trunk merge eligibility.

Slice lifecycle (7-state):

```
SLICE_PENDING        (dependency 미해소)
SLICE_READY          (build 시작 가능)
SLICE_BUILDING       (inner loop session 진행)
SLICE_REVIEWING      (middle review session + SliceMerge SM_READY_FOR_REVIEW)
SLICE_INTEGRATING    (SM_APPROVED → trunk rebase + verification)
SLICE_VALIDATED      (SM_MERGED, terminal-ish)
SLICE_BLOCKED        (escalate, governance 필요)
```

### 2-3. Inner Loop — TDD Build

forge 의 solo dialogue session. red/green/refactor turn 들이 verification feedback 을 input 으로 받아 자가 교정. Convergence rule: `verification_green` (deterministic verification 결과가 종료 권한).

---

## 3. Object Model

### 3-1. 신규 1급 객체 (SOC-OBJECTS 추가)

workflow lifecycle / lease / state transition 직접 보유 객체. RefactorBacklog/RefactorProposal 은 *지식* 객체이므로 KAC 소유 (다음 §3-2).

| 객체 | 책임 |
|---|---|
| **Milestone** | 2-stage (Discovery/Delivery), dual-slot 점유 |
| **Slice** | user value 또는 internal change 의 thin end-to-end. class 차원. dependency DAG |
| **DialogueSession** | turn-based agent deliberation. parent_loop ∈ {outer, middle, inner} |
| **SessionTurn** | session 의 1 turn. agent_profile + envelope + next_action_request + caller_routing_decision |
| **SliceMerge** | slice 의 trunk merge candidate (Code CP + Integration CP 의 후신). 7-state lifecycle |
| **VerificationRun** | 결정적 검증 1회 |
| **MetricRun** | quality metric 측정 1회 (refactor evidence 인프라) |

### 3-2. KAC 1급 객체

| 객체 | 책임 |
|---|---|
| **RefactorBacklog** | proposal 큐. lifecycle: PROPOSED / CURATED / SCHEDULED / DONE / DROPPED / SUPERSEDED |
| **RefactorProposal** | backlog 의 1 entry. forge / sentinel / scout 가 산출 |

### 3-3. 폐기되는 객체

| 폐기 | 후신 |
|---|---|
| Task | Slice |
| PhaseRun | DialogueSession |
| Code CP | SliceMerge (lifecycle 흡수) |
| Integration CP | SliceMerge (동일) |
| Spec CP, Milestone CP | 보존 (변경 없음) |

### 3-4. Slice Schema

```text
Slice {
  slice_id
  milestone_id
  slice_kind               # feature | internal
  value_statement          # one sentence (feature) 또는 refactor_summary (internal)
  ac_ids[]                 # feature 한정
  acceptance_tests[]       # path + name + AC-ID mapping (feature)
  declared_scope           # 변경 허용 file/path
  declared_metric_threshold # internal 한정 (선택)
  interface_break          # boolean default false
  dependencies[]           # {slice_id, edge_type: blocks | coordinates_with}
                           # 정책:
                           #   blocks: 순서 강제. dependency slice 가 SLICE_VALIDATED 전까지 본 slice 는 SLICE_PENDING.
                           #   coordinates_with: 병렬 허용. trunk merge 시 first-merger-wins, 후속은 rebase.
                           # Join condition (SLICE_PENDING → SLICE_READY):
                           #   모든 blocks dependency 가 SLICE_VALIDATED.
                           # Dynamic edge (discovered_dependency):
                           #   inner loop 중 새 의존 발견 시 forge 가 turn envelope 에 proposal 첨부.
                           #   본 slice 가 SLICE_BUILDING 이전이면 자동 추가, SLICE_BUILDING 이후이면 governance signal 필요.
                           # Cycle detection: Planning ensemble session 의 lead artifact validation 시 자동.
  trunk_base_revision
  dod_revision_pin         # DoD 가 변경되면 새 pin
  state                    # 7-state
  current_session_id
  spawning_proposal_id     # internal 일 때 RefactorProposal 역참조
  abandoned_reason
}
```

### 3-5. DialogueSession Schema

```text
DialogueSession {
  session_id
  parent_object_kind: slice | milestone
  parent_object_id
  parent_loop: outer | middle | inner
  purpose                  # design / build / review / tdd_build / planning_decompose / validation
  participants[]: [{agent_profile, role: lead|reviewer|observer}]
  session_termination: {finalization_rule, required_evidence[], composite_rule}
  workspace_revision_pin   # session 시작 시 base
  current_turn_index
  state                    # SESSION_OPEN | CONVERGED | TIMEOUT | ABANDONED | AWAITING_REVALIDATION
  final_verdict            # CONVERGED 일 때만 채워짐: approve | request_changes | tests_green | spec_accept | spec_reject | etc.
                           # state 와 verdict 분리 — 같은 CONVERGED 도 verdict 에 따라 dispatch 분기
  max_turns
  turn_log_ref             # session_log artifact 포인터
  spawned_contribution_id  # 응축된 1개 contribution
  finalization_decision    # 종료 시 어느 rule 이 결정자였는지 (audit) — finalization_rule | required_evidence | composite
  lease                    # session-level lease
}

SessionTurn {
  session_id, turn_index   # session-local turn_index, (session_id, turn_index) globally unique
  agent_profile_id
  input_manifest_id
  input_turn_log_snapshot_ref
  output_envelope_ref
  next_action_request      # agent 의 *제안* (routing 권한은 Caller)
  caller_routing_decision  # accepted | overridden | dropped
  workspace_commit         # inner loop 한정
  verification_result      # required_evidence 평가 입력
  recorded_at
}
```

### 3-6. SliceMerge Schema + Lifecycle

```text
SliceMerge {
  slice_merge_id
  slice_id
  pre_merge_workspace_revision   # rebase 기준
  merge_revision                 # trunk SHA after merge (terminal 직전 채워짐)
  inner_session_id
  review_session_id
  verification_run_id
  state                          # SM_DRAFT | SM_READY_FOR_REVIEW | SM_APPROVED | SM_MERGED | SM_REQUEST_CHANGES | SM_CLOSED | SM_STALE
  merged_at
  merged_by_caller_id
  lease_token
}
```

Lifecycle:

```
SM_DRAFT
   → SM_READY_FOR_REVIEW    (inner CONVERGED → middle 입력)
   → SM_APPROVED            (middle finalization 통과)
   → SM_MERGED              (Caller trunk merge 완료, terminal)
   |  SM_REQUEST_CHANGES    (middle request_changes → SLICE_BUILDING 회수)
   |  SM_CLOSED             (abandon/escalate, terminal)
   |  SM_STALE              (trunk 변경 → rebase 또는 verification 재실행 fail)
```

### 3-7. Audit Chain

`SliceMerge → review_session_id → SessionTurn[] → inner_session_id → SessionTurn[] → slice_id → ac_ids → acceptance_tests` — Code CP / Integration CP 폐기 후에도 audit trace 보존.

---

## 4. Lease Hierarchy + Acquisition Order

4 lease 종류 + 명시적 계층:

```
┌──────────────────────────────────────────────────────┐
│ Slot Lock        (milestone-level Discovery/Delivery)
│   - SHORT TRANSACTION ONLY (entry/exit/promotion)
│   - long agent call 중 보유 금지
│   ┌────────────────────────────────────────────────┐
│   │ Slice Lease  (slice workspace 점유)
│   │   - long-running OK
│   │   ┌────────────────────────────────────────┐
│   │   │ Session Lease  (turn append 직렬화)
│   │   │   - per session, long-running OK
│   │   │   ┌──────────────────────────────────┐
│   │   │   │ Turn Lease  (개별 agent 호출 lock)
│   │   │   │   - turn_index CAS 로 대체 권장
│   │   │   └──────────────────────────────────┘
│   │   └────────────────────────────────────────┘
│   └──────────────────────────────────────────────┘
└──────────────────────────────────────────────────────┘
```

**Acquisition order rules**:

1. Caller 는 **outer-to-inner** 순서로만 lease 획득. 역순 시도는 invariant 위반.
2. **Slot lock 은 transactional only**: promotion / intake-bind / slot-release 같은 짧은 critical section 에서만. 그 안에서 LLM 호출 또는 verification 금지.
3. **Turn lease 는 turn_index CAS 권장**: separate lease 객체 두지 않고 session 의 `current_turn_index` 에 대한 atomic CAS.
4. **Cross-lease conflict**: 동일 slice 의 inner / middle loop session 은 별도 session_id → 별도 session lease. workspace 점유는 slice lease 가 보호하므로 두 session 동시 commit 안 됨.
5. **Cycle wait detection**: lease 만료 외에도 sweeper 가 cycle 감지. lower-priority forceful release + escalate.

---

## 5. Convergence: Finalization + Required Evidence

session 종료 조건은 *의사결정 수렴* 과 *결정적 증거* 를 분리.

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

3 사용 예:

| 사용처 | finalization_rule | required_evidence | composite_rule |
|---|---|---|---|
| TDD inner build | lead_only | verification_green | evidence_only |
| Spec design (사람 + agent) | quorum_then_lead (with `human` required) | (없음) | finalization_only |
| internal slice review | quorum_then_lead | verification_green + metric_threshold + interface_diff_clean | finalization_AND_evidence |

`required_evidence` 는 인프라 1급 (VerificationRun + MetricRun). 폐기된 `evidence` contribution_kind 의 책임을 흡수.

---

## 6. Inner Loop — TDD

### 6-1. Inner Build Session

forge 의 solo dialogue session. participants 1, finalization=lead_only, evidence=verification_green.

매 turn:

1. Caller 가 input 구성 (manifest + turn_log + 직전 verification_result + role prompt).
2. forge 호출 (stateless, but input 에 turn_log).
3. forge → turn envelope: workspace patch + `tdd_phase: red_green | refactor` + `target_tests[]`.
4. Caller patch 적용 → slice-local branch commit (workspace_commit SHA 기록).
5. Caller verification 실행 (acceptance + deterministic).
6. turn_log append + progress_metric 계산.
7. Convergence:
   - 모든 acceptance_test green + deterministic pass → CONVERGED → SLICE_REVIEWING.
   - max_turns 도달 → TIMEOUT → SLICE_BLOCKED.
   - 3 turn 동안 newly_green=0 → no_progress → escalate.
   - regression (직전 green 깨짐) 한도 초과 → escalate.
   - refactor turn 인데 test 빨강 → 그 turn rollback (commit revert).

### 6-2. TDD Orthodoxy Enforcement (option `target.tdd_strict`)

- `tdd_phase: red_green` turn — 직전 verification 에 failed[] 비어 있지 않아야. 이 turn 후 newly_green ≥ 1 기대.
- `tdd_phase: refactor` turn — 직전 모두 green 이어야 시작. 이 turn 후 regression 0 강제.

### 6-3. Scope Enforcement

- acceptance_tests 변경 금지 (slice contract).
- declared_scope 밖 파일 변경 금지.
- dependency lockfile 변경 금지 (별도 chore).

위반 → 그 turn invalid, 같은 session 안에서 재시도 (한도).

---

## 7. Middle Loop — Slice Review

### 7-1. Middle Review Session

forge + sentinel pair (default; +atlas if architectural). Convergence: `any_request_changes_blocks` finalization + (internal class 면) `verification_green + metric_threshold + interface_diff_clean` evidence.

session 종료 → SliceMerge state 전이 + Slice state 전이는 다음 표를 따른다.

termination outcome 은 `(state, final_verdict)` 의 tuple 로 표현된다. state 만으로는 dispatch 분기를 결정하지 못한다 (특히 CONVERGED 는 approve/request_changes 두 분기 가능).

| Session purpose | state | final_verdict | Slice 전이 |
|---|---|---|---|
| inner_build | CONVERGED | tests_green | SLICE_BUILDING → SLICE_REVIEWING + SliceMerge SM_DRAFT → SM_READY_FOR_REVIEW |
| inner_build | TIMEOUT | (n/a) | SLICE_BUILDING → SLICE_BLOCKED |
| inner_build | ABANDONED | no_progress \| regression \| scope_violation | SLICE_BUILDING → SLICE_BLOCKED |
| middle_review | CONVERGED | approve | SLICE_REVIEWING → SLICE_INTEGRATING + SliceMerge SM_READY_FOR_REVIEW → SM_APPROVED |
| middle_review | CONVERGED | request_changes | SLICE_REVIEWING → SLICE_BUILDING + SliceMerge SM_REQUEST_CHANGES → SM_CLOSED, 새 inner_build_session 시작 |
| middle_review | TIMEOUT | (n/a) | SLICE_REVIEWING → SLICE_BLOCKED |
| middle_review | AWAITING_REVALIDATION | (n/a) | SLICE_REVIEWING 유지, SliceMerge SM_STALE. Caller 가 trunk 변경 감지 후 자동 verification 재실행 → pass 시 SM_READY_FOR_REVIEW 복귀, fail 시 TIMEOUT 한도 내 재시도, 한도 초과 시 SLICE_BLOCKED + governance escalate |

Turn_index scope 는 session-local. (session_id, turn_index) 가 globally unique tuple.

### 7-2. SliceMerge Flow

1. Inner session CONVERGED → SliceMerge SM_DRAFT 생성, SliceMerge SM_READY_FOR_REVIEW.
2. Middle review session 시작 — 입력은 SliceMerge + inner session_log.
3. Approve → SM_APPROVED → Caller trunk rebase + verification 재실행.
4. Clean → SM_MERGED, Slice SLICE_VALIDATED.
5. Conflict / verification fail → SM_STALE, Slice SLICE_REVIEWING 유지, 재호출 대기.
6. Request_changes → SM_REQUEST_CHANGES → SM_CLOSED, 새 inner build session 시작.

---

## 8. Outer Loop — Discovery / Specification / Planning / Validation

### 8-1. Phase as Outer-Loop Step

Outer loop 의 4 phase 는 quorum-기반 ensemble session 으로 진행. 각 phase 의 session 은 outer DialogueSession.

| Phase | Session 형태 | 산출 |
|---|---|---|
| Discovery | atlas + sentinel pair, `lead_final_say`, `human` required | milestone 본문 + ADR + spec_proposal |
| Specification | atlas + forge + sentinel ensemble, `quorum_then_lead`, `human` required | scenarios + AC-IDs + acceptance test 코드 (TDD-ready) |
| Planning | atlas + forge + sentinel ensemble, `unanimous_approve` | slice DAG + dependency + RefactorBacklog curation |
| Validation | sentinel solo + scout evidence, `lead_only` | cross-slice acceptance + Context Summary + Milestone CP |

### 8-2. TDD Integration in Specification

Specification lead artifact 에 **AC-ID 별 acceptance test 코드** 포함 (단순 자연어 텍스트 ✕). Caller 가 quorum 통과 직후 acceptance test 를 target test 디렉토리에 commit (Spec CP 일부).

**Pending marker 정책 — trunk 빨강 방지**:

- 신규 commit 된 acceptance test 는 framework 별 *pending / disabled marker* 로 표시 (`@pytest.mark.pending`, `xit(...)`, `t.Skip("pending slice X")` 등). target 의 framework 별 마커는 `target.test_runner.pending_marker` (TCC) 가 정의.
- 일반 trunk verification (unit/integration/lint) 은 pending marker 가 붙은 test 를 *수집은 하되 실행은 skip* — trunk green 유지.
- 해당 slice 의 inner build session 시작 시 Caller 가 그 slice 의 acceptance_tests[] 의 marker 만 제거. session converge 시 marker 제거 commit 이 SliceMerge 에 포함.
- slice 가 SLICE_VALIDATED 도달 → marker 영구 제거 + acceptance test 가 정식 trunk verification 의 일원.
- slice 가 SLICE_BLOCKED / abandoned → marker 유지 (test 는 trunk 에 남되 inactive). governance signal `purge_acceptance_tests` 로 명시적 제거 가능.

**Acceptance test escape path** (Specification 시점의 가정 오류 발견 시):

- inner build 중 acceptance test 의 *behavioral intent* 가 잘못이 명백해지면 (구현 불가능 또는 spec 모순), forge 의 turn envelope 에 `acceptance_test_amendment_proposal` 첨부.
- proposal 은 새 Specification dialogue session 트리거 (sentinel + atlas + human required). approve 시 새 acceptance test 코드 commit + 영향 받은 slice 의 dod_revision_pin 갱신.
- proposal 은 governance signal 이 아니라 *세션 산출물* — 사람 review 는 session 의 finalization 에 포함.
- test name / path 변경은 별도 governance signal (`acceptance_test_rename`) 거침. assertion logic 변경은 위 amendment proposal path.

→ AC-ID → test name → result 자동 mapping. Validation FAIL 의 책임 slice 식별 자동화. trunk 빨강 위험 차단.

### 8-3. Dual-Track Knowledge Flow

Discovery slot 의 milestone N+1 의 manifest 에 자동 inject:

- 직전 Delivery milestone N-1 의 Context Summary
- 진행 중 Delivery milestone N 의 *slice telemetry* (진행 slice 수, 성공 acceptance 결과, BLOCKED 사유)
- 진행 중 N 의 *inner session_log 요약* (자주 발생한 edge case, refactor 패턴)
- N 의 *evidence/metric run* 결과
- RefactorBacklog 의 architectural debt indicator

→ Discovery 가 추정 ✕, 현실 ○.

### 8-4. Cross-Milestone Reference Rules

- Discovery N+1 은 Delivery N 의 영속 객체를 **read-only** 만 참조. `read_base_revision_pin` 필수.
- N 의 객체 변경 감지 시 N+1 의 영향 받은 session 을 `AWAITING_REVALIDATION` 으로 전이.
- N+1 이 "N 에도 X 필요" 발견 시 default: X 를 N+1 scope 흡수. explicit: `cross_milestone_amendment` governance signal.
- Promotion guard: Delivery N finalization 전 N+1 의 `M_SPEC_APPROVED → M_DELIVERY_PLANNING` 금지.

### 8-5. Resource Sharing

- AgentProfile worker slot 은 milestone-agnostic. atlas 1 worker 가 N+1 Discovery + N Planning 번갈아 servicing.
- `target.dual_track.priority`: `delivery_first | balanced | discovery_first`.
- WIP limit per profile: `loop_policies.<phase>.concurrent_sessions`.

---

## 9. Class-Aware Governance

### 9-1. Slice Class

- `feature`: user-observable behavior. Discovery/Specification 사람 게이트 거침. acceptance test 필수.
- `internal`: behavior preservation. 사람 게이트 면제 (단 escalation rule 미발동 시). DoD = 기존 test green + scope/interface invariant + (선택) metric.

### 9-2. Internal Escalation Rules

`target.internal_escalation_rules` (TCC-SLICE-CLASS-RULES) 가 운영 정책으로 정의. default 6:

- `interface_break: true` (public API signature 변경)
- `schema_or_migration_change: true`
- `security_sensitive_path: true`
- `perf_critical_path: true`
- `existing_test_coverage_below_threshold`
- `metric_runner_unavailable`

1개라도 hit → 자동 feature 게이트 승격 (사람 review).

### 9-3. RefactorBacklog 운영

scout 정기 scan + forge / sentinel ad-hoc proposal → `RefactorProposal` 영속화. Planning ensemble session 시점에 atlas curate → CURATED → `internal` slice promotion (SOC operation):

```
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

---

## 10. Constitution Amendment

### 10-1. Core Invariants (9개)

1. **Stateless per call, contextual within session** (변경) — 호출 단위 무상태. session 안 multi-turn 은 Caller 가 turn_log 를 input 에 합쳐 합성. agent 자체는 호출 사이 메모리 미보유.
2. **Direct invocation forbidden, mediated addressing allowed** (변경) — agent ↔ agent 직접 호출 금지. session 안 addressing 은 agent 의 *제안* 이며 routing 권한 Caller.
3. **Dual-slot milestone serialization** (변경) — Delivery slot 1 + Discovery slot 1 (default). 두 slot 은 서로 다른 milestone 만 점유.
4. **Caller-only operational write** (보존).
5. **Required human contribution for `feature` slices** (보존, scope 명확화).
6. **Deterministic verification authority by Caller** (확장 — verification 결과의 권위는 agent verdict 보다 우위).
7. **Knowledge accumulation** (보존).
8. **AgentProfile abstraction** (보존).
9. **Self-fetch + Context Manifest + revision pin** (보존) — Caller 는 호출 전에 manifest 와 revision pin 을 고정한다. agent 는 manifest 밖 객체를 read/write 하지 않는다. 위반 시 invalid 산출. 본 invariant 는 session 안의 turn 호출에도 적용 (turn manifest 는 직전 turn_log_snapshot 을 entry 로 포함하지만, 그 외 외부 객체는 Caller 가 명시한 manifest 밖이면 fetch 금지).

**Finite retry**: 자동 재시도는 유한하다. 재시도 한도 / 정책 / ESCALATED 진입의 구체 규칙은 헌법이 직접 정의하지 않고 `reliability-and-gate-contract.md#RGC-FAILURE` 가 정의한다. 본 헌법은 *유한* 만 보장하고 운영 정책은 contract 위임.

### 10-2. Workflow Shape (절 본문, invariant 아님)

- 3-loop nested model.
- Outer loop 의 phase 어휘: Discovery / Specification / Planning / Validation 4개로 격하.
- Implementation / CodeReview / Integration 어휘는 outer phase 에서 폐기, middle/inner loop 책임으로 흡수.

### 10-3. Authority Boundaries 갱신

| 주체 | 추가/변경 |
|---|---|
| Agent | DialogueSession 안에서 `next_action_request.addressed_to` 로 mediated addressing. 직접 호출 금지 유지 |
| Caller | DialogueSession turn coordinator 책임. session 종료 결정의 권위 (convergence rule + evidence rule 에 따라) |

### 10-4. 폐기 어휘

| 폐기 | 대체 |
|---|---|
| Task | Slice |
| PhaseRun | DialogueSession |
| Phase 단위 lock-step | 3-loop nested. phase 어휘는 outer loop step 으로만 잔존 |
| Code CP / Integration CP | SliceMerge (lifecycle 흡수) |
| `IMPLEMENTATION_IN_PROGRESS` / `INTEGRATION_*` milestone state | `M_DELIVERY_BUILDING` / `M_DELIVERY_VALIDATING` |
| 평행 quorum submission as primary review | DialogueSession primary, quorum 은 finalization_rule 의 한 종류로 잔존 |
| Single-milestone serialization | Dual-slot serialization |

---

## 11. Contract Impact

| Contract | 변경 강도 | 핵심 변경 |
|---|---|---|
| `agent-and-context-contract.md` | 큼 | Phase enum 4개로 격하, contribution_kind enum 정정 (lead_draft/review_verdict/human_approval/session_outcome/proposal), envelope 신규 필드 (session_id/turn_index/slice_id/slice_kind/tdd_phase), `agent_role`→`agent_profile_id` rename, AGC-SESSION-INPUT / AGC-NEXT-ACTION-REQUEST 신설 |
| `state-and-operation-contract.md` | 매우 큼 | Task/PhaseRun/CP 폐기, Slice/DialogueSession/SessionTurn/SliceMerge 신설 (RefactorProposal 은 KAC 소유 — 본 contract 는 internal slice promotion path 만), dual-slot milestone state, slice 7-state lifecycle, session 5-state lifecycle, SliceMerge 7-state lifecycle, slice dependency model (blocks/coordinates_with) + policy, session-termination spec, dual-milestone branch policy, cross-milestone reference rules |
| `reliability-and-gate-contract.md` | 매우 큼 | 4-lease 계층 + acquisition order, slot lock, slice/session/turn lease, cross-slot stale, promotion guard, cross-slot fairness, dual-gate queue, ledger 필드 갱신 (slice_id/session_id/turn_index/slot_kind/dod_revision/slice_kind/agent_profile_id/action_kind/loop_kind 추가, legacy 필드 신규 row 금지) |
| `knowledge-contract.md` | 큼 | RefactorBacklog 1급, turn_log compaction + storage 분리 anchor, slice telemetry inject path, decision_kind enum 확장 (refactor/spike_finding/architectural_debt/cross_milestone_amendment), audit_hash 정책 |
| `target-config-contract.md` | 중~큼 | TCC-LOOP-POLICIES (phase_policies 후신), TCC-SLICE-CLASS-RULES (escalation 6-rule), TCC-DUAL-TRACK, TCC-REFACTOR-METRICS, TCC-ENFORCEMENT (invariant_enforcement always_hard / stage_graded list) |
| `agent-runner-port-contract.md` | 중 | session_id/turn_index/session_context_ref 필수, idempotency 3 scope 분리 (per-turn / per-session-outcome / per-merge), AGC vs ARC 책임 분리 (semantic vs transport) |
| `README.md` | 큼 | glossary 전면 갱신, CONTRACT-MIGRATION-NOTES 재활약 (phase→loop / role→profile / Task→Slice / PhaseRun→Session / CP→SliceMerge), CONTRACT-CONFORMANCE 에 anchor metadata 4 field 확장 (status / implementation_surface / enforcement / active_since) |

신규 contract 0개.

---

## 12. Cutover Plan — 6 Stages

### Stage 0: Legacy Freeze & Drain (operational)

- Inventory: non-terminal Milestone/Task/PhaseRun/CP 수집.
- Intake freeze (`stop scope=intake`).
- Daemon stop/drain.
- Per-object disposition (사람 결정): `complete-as-legacy` | `abandon` | `archive-only`.
- Cutover timestamp ledger 영속화.

**DoD**: in-flight 0개, `cutover_at` row 존재.
**Abort**: reversible. drain 중 amendment 취소 시 freeze 해제로 정상 운영 복귀.

### Stage 1: Documents (single amendment PR, internal commits A~F)

| Commit | 내용 |
|---|---|
| A | `llm-team.md` amendment (8 invariant + Workflow Shape 재작성) |
| B | 6 contract rewrite (atomic, anchor 상호 참조 때문에 분리 불가) — RGC-LEASE-KINDS 본문에 lease hierarchy spec 포함 |
| C | architecture docs rewrite — *기존* doc set (pipeline-end-to-end, state-machine, daemons, application-modules, agent profiles, lease-and-recovery, agent-runner-adapters) 만. 신규 supplementary doc (slice-machine.md, dialogue-machine.md) 은 Stage 3b dogfood 산출물 |
| D | `docs/history/legacy-phase-model/` 로 legacy doc raw move + history README |
| E | CONTRACT-MIGRATION-NOTES 환산표 + glossary |
| F | CONTRACT-CONFORMANCE matrix metadata 확장 (4 field) |

**DoD**: PR + amendment_approve signal merge.
**Abort**: D commit revert (raw move 되돌림). Stage 0 결과 유지.

### Stage 2: Implementation Foundation

영속 layer + lease + ledger. workflow 실행 0%.

| Anchor | 1차 구현 |
|---|---|
| SOC-OBJECTS 신규 5종 (workflow) | `lib/slice.sh`, `lib/session.sh`, `lib/slice_merge.sh` |
| KAC-REFACTOR-BACKLOG 객체 | `lib/refactor_backlog.sh` (KAC 소유) |
| RGC-LEASE-KINDS | `lib/lease.sh` rewrite (4 lease + acquisition order CI) |
| RGC-LEDGER | `lib/ledger.sh` rewrite (append-compatible: legacy row immutable, new row new schema, parser union read) |
| dialogue_coordinator.sh skeleton | turn 진행 + convergence/evidence 평가 + turn_log size limit + tail-truncation |
| dual_track_scheduler.sh skeleton | slot lock + intake queue (promote 만) |
| ARC-PORT-SIGNATURE 갱신 | adapter 시그니처 |

**DoD**: 단위 테스트 통과. acquisition order 위반 자동 reject 검증. turn_log truncation 검증.
**Abort**: 신규 module 추가 + 기존 minimal touch 로 작성. Stage 1 으로 revert.

### Stage 3a: Fake Runner MVP

deterministic e2e 검증. 실제 LLM 0회.

**검증**: fake runner 가 stub envelope sequence 로 1 slice end-to-end (inner_build → middle_review → SliceMerge → trunk merge). audit chain trace 가능. acquisition order 위반 fail.

**DoD**: CI reproducible.
**Abort**: fake runner revert.

### Stage 3b: Real Runner Dogfood

≥2 slice + dependency. 본 amendment 의 architecture doc rewrite 를 milestone 으로:

- slice A (feature): `docs/architecture/slice-machine.md` 작성. acceptance = anchor cross-reference green.
- slice B (feature, blocks: A): `docs/architecture/dialogue-machine.md` 작성. acceptance = nesting diagram + slice-machine.md 참조 일관성.
- slice C (internal): `docs/architecture/state-machine.md` state 표 갱신. 기존 reference 무파괴.

**DoD**: 3 slice trunk 까지 통과. audit chain trace. **warning ledger row 0건**.
**Abort**: dogfood milestone abandon. Stage 3a 보존.

### Stage 4: Dual-Track + Advanced

- SOC-MILESTONE-DUAL-SLOT + RGC-SLOT-LOCK
- RGC-CROSS-SLOT-FAIRNESS + RGC-DUAL-GATE-QUEUE
- RGC-CROSS-SLOT-STALE + SOC-CROSS-MILESTONE-REFERENCE
- SOC-SLICE-CLASS + TCC-SLICE-CLASS-RULES (escalation 6-rule)
- KAC-REFACTOR-BACKLOG + scout 정기 scan
- KAC-SLICE-TELEMETRY (live inject)
- KAC-TURN-LOG-COMPACTION + KAC-SESSION-LOG-STORAGE
- TCC-LOOP-POLICIES + TCC-DUAL-TRACK + TCC-REFACTOR-METRICS

**DoD**: dual-slot 시연 (M1 Delivery + M2 Discovery 동시). internal slice 1개 자동 게이트 통과. refactor proposal 1개 lifecycle 완주.
**Abort**: `target.dual_track.enabled=false` 토글로 single-slot fallback.

### Stage 5: Hard-fail Transition

- 모든 invariant `block` 모드.
- Old writer 코드 경로 (legacy phase/Task/PhaseRun helper) 삭제.
- Legacy label 생성 분기 제거.
- Dashboard/parser 의 legacy schema 분기 정리 (과거 read 보존).

**DoD**: TCC `invariant_enforcement: block` (모든 target). **new writer / dispatcher 코드 한정 legacy 어휘 grep 0건** (historical reader / fixture / migration map / `docs/history/` archive 는 예외 — 과거 ledger row 읽기 + migration tooling 용). fully green hard-fail mode.
**Abort**: Stage 4 모드 (warn for advanced) 로 복귀. writer 삭제는 별도 commit.

### 12-1. Always-Hard vs Stage-Graded Invariants

| 카테고리 | invariant | Stage 2~4 정책 |
|---|---|---|
| Always-hard (권한 경계) | Caller-only operational write | hard-fail |
| | Direct invocation forbidden | hard-fail |
| | Manifest 외 read/write | hard-fail |
| | Lease acquisition order | hard-fail |
| | Stateless per call | hard-fail |
| Stage-graded | dual-slot fairness | warn (Stage 4 까지) |
| | telemetry enrichment 누락 | warn |
| | turn_log compaction 지연 | warn |
| | refactor metric 미수집 | warn |
| | required_evidence 충족 누락 | warn → block (Stage 3b 부터) |

`TCC-ENFORCEMENT.target.invariant_enforcement` 가 invariant-별 list (`always_hard[]` + `stage_graded.<name>: warn|block`).

### 12-2. PR 전략

| Stage | PR 수 | 비고 |
|---|---|---|
| 0 | 0 (operational) 또는 inventory script 1 PR | |
| 1 | **1 atomic amendment PR** (commit A~F) | atomicity 필수 |
| 2 | 4-6 PR (lease/ledger/objects/coordinator 분리) | review 단위 |
| 3a | 1-2 PR (fake runner + e2e test) | |
| 3b | dogfood milestone 안 slice 들 자체 PR | meta-loop |
| 4 | feature flag 별 1 PR | 4 PR 정도 |
| 5 | 2-3 PR (enforcement flip + writer removal + cleanup) | |

총 ~15 PR. Stage 1 단일 PR 로 atomicity 확보.

### 12-3. Legacy Archive Policy

`docs/history/legacy-phase-model/` 영구 보존 (`deprecated_historical_reference`). 신규 코드/doc 의 history 의존 금지 (lint rule). 시간 한도 ✕, gate 는 Stage 5 DoD.

---

## 13. Open Questions / Future Work

| 항목 | 메모 |
|---|---|
| Discovery WIP > 1 | default 1, 운영 익숙 후 확장 옵션. cross-milestone interaction 복잡도 ↑ |
| TDD orthodoxy 강제 | `target.tdd_strict` default 미정. dogfood 후 결정 |
| Manual override path | inner loop 실패 시 사람 직접 patch 작성 path (`human` AgentProfile 의 `manual_patch`). exception 으로만 둘지 1급으로 둘지 |
| Heavy track (Spike + Retrospective) | 본 design 에서 보류. 필요성 발생 시 후속 amendment |
| Cross-target governance | single-target 가정. 복수 target 운영 확장은 후속 |
| LLM cost 절감 | dialogue session 의 token 누적이 가장 큰 비용. condensation 정책의 효과 측정 필요 |
| Slice 의 canonical DoD ref | 현재 schema 는 `dod_revision_pin` 만. *어느 artifact 가 DoD 항목 정본인가* (acceptance_tests array? 별도 dod_ref doc?) 는 Stage 1 contract rewrite 시 결정 |
| Dependency lockfile 변경의 feature slice 승인 path | 현재 inner loop scope 에서 lockfile 변경 금지 (별도 chore-style internal slice). 하지만 새 dependency 가 필요한 *feature* slice 의 경우 별도 internal slice 를 dependency 로 두는지, 혹은 feature slice 가 dependency 변경을 포함할 수 있는 escape 정의 필요 — Stage 1 contract rewrite 의제 |

---

## 14. Risks Summary

| Risk | Mitigation |
|---|---|
| Stage 1 amendment 가 너무 큼 → review 부담 | atomic 1 PR + 내부 commit 분리 + PR description 의 anchor index |
| 4-lease deadlock | acquisition order CI + sweeper cycle detection + slot lock short transaction |
| Stage 3a→3b 전환 시 real runner 가 fake 와 다른 행동 | fake runner 의 envelope schema 가 real runner 의 superset. real adapter 는 fake 통과 envelope 을 그대로 산출 가능해야 함 |
| dogfood milestone 실패 | abandon + Stage 3a 까지 보존. 실패 자체가 design gap 의 신호 |
| dual-slot fairness oscillation | promotion guard 먼저 enforce, fairness 는 telemetry 누적 후 enable |
| Inner loop max_turns / token 폭주 | turn_log compaction + max_turns 보수적 default + dogfood 측정 후 조정 |
| Refactor backlog overflow | scout 의 scan 빈도 조정 + Planning curation 의 priority cap |
| Audit chain 단절 | Code CP 폐기 후 SliceMerge 의 audit_chain field 가 review_session/inner_session/turn_logs 모두 trace 가능 |

---

## Appendix A: Migration Mapping (legacy → new)

| Legacy | New | 비고 |
|---|---|---|
| `Task` | `Slice` | 책임 확장 (코드 → 가치) |
| `PhaseRun` | `DialogueSession` | turn 추가 |
| `Phase` (7개) | outer loop step (4개) + middle/inner loop | Implementation/CodeReview/Integration 흡수 |
| `agent_role` | `agent_profile_id` | rename, 의미 동일 |
| `operation` | `action_kind` | rename + 의미 확장 |
| `Code CP` / `Integration CP` | `SliceMerge` | 단일 객체 lifecycle |
| `Spec CP` | `Spec CP` | 보존 — outer loop 산출물로 trunk merge 대상 아님. spec/doc 객체로의 병합이며 SliceMerge 의 trunk 코드 병합과 의미가 다름 |
| `Milestone CP` | `Milestone CP` | 보존 — 동일 이유. milestone-level summary 의 영속화 단위 |
| `TASK_*` state | `SLICE_*` state | 7-state |
| `IMPLEMENTATION_IN_PROGRESS` etc | `M_DELIVERY_BUILDING` | dual-slot |
| `phase_policies.<phase>` | `loop_policies.<loop>.<phase>` | TCC anchor |
| `lease.ttl_by_agent_profile` (현재) | `lease.ttl_by_lease_kind` + `lease.ttl_by_agent_profile` | 4 lease 종류 분기 (slot/slice/session/turn) |
| `quorum.rule` (X6) | `session_termination.{finalization_rule, required_evidence, composite_rule}` | 분리 |
| `evidence` contribution_kind | RequiredEvidence + VerificationRun + MetricRun | re-home |
| `rework_patch` contribution_kind | `lead_draft` 의 후속 instance + parent_review_verdict_id field | enum 축소 |
| `summary` contribution_kind | Validation lead_draft 의 artifact | enum 축소 |

---

## Appendix B: Anchor Index (신규 / 변경 / 폐기)

신규 anchor (★, 27개):

- **SOC (10)**: SOC-LOOPS, SOC-SLICE-LIFECYCLE, SOC-SLICE-DEPENDENCIES, SOC-SLICE-CLASS, SOC-SESSION-LIFECYCLE, SOC-SESSION-TERMINATION, SOC-SLICE-MERGE, SOC-MILESTONE-DUAL-SLOT, SOC-DUAL-MILESTONE-BRANCH, SOC-CROSS-MILESTONE-REFERENCE.
- **RGC (6)**: RGC-LEASE-KINDS, RGC-SLOT-LOCK, RGC-CROSS-SLOT-STALE, RGC-PROMOTION-GUARD, RGC-CROSS-SLOT-FAIRNESS, RGC-DUAL-GATE-QUEUE.
- **KAC (4)**: KAC-SESSION-LOG-STORAGE, KAC-TURN-LOG-COMPACTION, KAC-REFACTOR-BACKLOG, KAC-SLICE-TELEMETRY.
- **TCC (5)**: TCC-LOOP-POLICIES, TCC-SLICE-CLASS-RULES, TCC-DUAL-TRACK, TCC-REFACTOR-METRICS, TCC-ENFORCEMENT.
- **AGC (2)**: AGC-SESSION-INPUT, AGC-NEXT-ACTION-REQUEST.

변경 anchor (↻, ~20개): AGC-PHASES (4 phase), AGC-CONTRIBUTION (enum 정정), AGC-CALL-BOUNDARY, AGC-CONTEXT-MANIFEST, AGC-OUTPUT, AGC-OUTPUT-RUNTIME-ENRICH, AGC-CONTRIBUTION-OUTPUTS, AGC-WORKSPACE, AGC-INVALID, SOC-OBJECTS, SOC-INTAKE, SOC-OPERATIONS, SOC-DISPATCH-MATRIX, SOC-RECOVERY-OPERATION, SOC-MERGE-POLICY, SOC-IDEMPOTENCY, RGC-SIGNALS, RGC-RECOVERY, RGC-FAILURE, RGC-VERIFICATION, RGC-HUMAN-CONTRIBUTION, RGC-LEDGER, RGC-FAIRNESS, RGC-DAEMON-STARTUP, KAC-ACCUMULATION, KAC-MANIFEST-FROM-KNOWLEDGE, KAC-DECISION-LOG, KAC-CONTEXT-SUMMARY, KAC-TRACEABILITY, KAC-EQUIVALENCE, TCC-SCOPE, TCC-LEASE-CONFIG, TCC-ONBOARDING, TCC-CHANGE-RULES, ARC-SCOPE, ARC-PORT-SIGNATURE, ARC-CALL-SEMANTICS, ARC-IDEMPOTENCY, ARC-ADAPTER-SUBSTITUTION.

폐기 anchor (✕, 1개): SOC-PHASE-RUN.

보존 anchor (=, 변경 없음): AGC-SCOPE, AGC-AGENT-PROFILES, AGC-ISSUE-BODY, SOC-SCOPE, RGC-SCOPE, RGC-WRITES, RGC-PAUSE, RGC-NOTIFICATION, KAC-SCOPE, KAC-MANIFEST, KAC-CONFLICTS, TCC-IDENTITY, TCC-PRECEDENCE, ARC-EXIT-CLASSES, ARC-FAILURE-MODES, CONTRACT-AUTHORITY, CONTRACT-STRUCTURE, CONTRACT-REFERENCE, CONTRACT-CHANGE, CONTRACT-STATUS.

---

## Appendix C: Reviewers' P0/P1 Items Resolution

Two external review rounds (qwen3.6, gpt5.5) raised the following P0/P1 items; all resolved in this design:

| Item | Resolution |
|---|---|
| agent_role / operation 폐기 위험 | rename to agent_profile_id / action_kind, ledger 보존 |
| 4-lease deadlock | acquisition order spec (Section 4) + slot lock short transaction |
| SliceMerge "이미 merge" 명칭 모호 | 7-state lifecycle (Section 3-6) + audit chain. glossary 에 "trunk merge 후보 객체, SM_MERGED 만 실제 병합 완료" 명시 |
| SOC-SLICE-LIFECYCLE 11-state 과도 | 7-state 합리화 (Section 2-2) |
| Slice ↔ Session nesting 모호 | 1:N relationship + termination → state transition 표 (Section 7-1) |
| Internal escalation 6-rule contract 하드코딩 | TCC-SLICE-CLASS-RULES 격하 (Section 9-2) |
| Convergence rule hybrid concern | finalization + evidence 분리 (Section 5) |
| Dual-slot connectivity (lease/gate/fairness/branch) | RGC anchors 신설 (Section 11 RGC 행 매우 큼) |
| Slice dependency model | edge type (blocks/coordinates_with) + cycle detection (Section 3-4) |
| Stage 0 legacy drain | 6-stage 의 Stage 0 신설 (Section 12) |
| Lease hierarchy → Stage 1 spec | RGC-LEASE-KINDS 본문이 Stage 1 commit B 에 포함 |
| Soft-fail 너무 거침 | always-hard vs stage-graded 분리 (Section 12-1) |
| Sample slice 너무 toy | dogfood milestone 으로 ≥2 slice + dependency (Stage 3b) |
| PR 전략 미결 | Stage 1 atomic 1 PR + 나머지 분산 (Section 12-2) |
| Append-compatible ledger | Stage 2 의 ledger.sh rewrite invariant (Section 12 Stage 2) |
| Anchor enforcement metadata | CONTRACT-CONFORMANCE 4-field 확장 (Stage 1 commit F, Section 11) |
| Turn_log size limit | dialogue_coordinator.sh 의 Stage 2 책임 (Section 12 Stage 2) |
| Legacy archive 삭제 시점 | 영구 보존, 시간 한도 폐기 (Section 12-3) |
| RefactorBacklog ↔ Slice promotion | SOC-SLICE-LIFECYCLE 본문 명시 (Section 9-3) |
| Per-stage abort line | 각 Stage 별 Abort 항목 (Section 12) |

추가로 spec self-review 후 third review round (qwen3.6 + gpt5.5) 의 P1 항목들도 모두 inline 해소:

| Item | Resolution |
|---|---|
| SliceMerge 6-state vs 7-state 불일치 | 7-state 로 통일 (3 spots: §3-1, §11, Appendix C) |
| DialogueSession.state CONVERGED 가 approve/request_changes 동시 표현 | schema 에 `final_verdict` 필드 분리 (§3-5), 전이 표를 (state, final_verdict) tuple 로 재작성 (§7-1) |
| Specification acceptance test commit 으로 trunk 빨강 위험 | Pending marker 정책 신설 (§8-2): per-framework marker, slice 활성화 시점 marker 제거, slice abandon 시 marker 유지 |
| Acceptance test escape path 부재 | §8-2 에 amendment proposal session path 추가 (sentinel + atlas + human required) |
| SOC-SLICE-DEPENDENCIES 가 edge type 만 정의, policy 없음 | Slice schema 에 join condition / dynamic edge / cycle detection / coordinates_with 정책 inline (§3-4) |
| Context Manifest + revision pin invariant 누락 | Section 10-1 에 9번째 invariant 로 복원 + Finite retry 의 RGC 위임 명시 |
| RefactorBacklog 가 SOC vs KAC 사이 흔들림 | §3-1 에 SOC 객체에서 제외 명시 + Stage 2 implementation 에서 lib/refactor_backlog.sh 를 KAC 행으로 이동 |
| Stage 5 legacy 어휘 grep 0건 vs historical reader 보존 충돌 | "new writer / dispatcher 한정" 으로 좁힘. historical reader / fixture / migration map / docs/history archive 예외 |
| AWAITING_REVALIDATION exit path 모호 | §7-1 표에 자동 verification 재실행 + 한도 초과 시 SLICE_BLOCKED escalate 명시 |
| Spec CP / Milestone CP 보존 이유 부재 | Appendix A 에 "outer loop 산출물, trunk merge 대상 아님" 명시 |
| 보존 anchor 목록 부재 | Appendix B 에 보존 anchor 20개 list 추가 |
| Slice canonical DoD ref 부재 | Open Questions §13 에 추가 (Stage 1 contract rewrite 의제) |
| Dependency lockfile 변경 의 feature slice 승인 path | Open Questions §13 에 추가 |
