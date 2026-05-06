# Pipeline End-to-End

본 문서는 Caller 가 운영하는 cycle 들을 contract 의 anchor 에 매핑한다. 본 문서는 contract 를 override 하지 않는다. 권위는 다음 순으로 우선한다.

1. [`llm-team.md`](../../llm-team.md)
2. [`docs/contracts/state-and-operation-contract.md`](../contracts/state-and-operation-contract.md) — 특히 [`#SOC-LOOPS`](../contracts/state-and-operation-contract.md#SOC-LOOPS), [`#SOC-OPERATIONS`](../contracts/state-and-operation-contract.md#SOC-OPERATIONS), [`#SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX)
3. [`docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT) / [`#AGC-SESSION-INPUT`](../contracts/agent-and-context-contract.md#AGC-SESSION-INPUT) / [`#AGC-OUTPUT-RUNTIME-ENRICH`](../contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH)
4. [`docs/contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS) / [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) / [`#RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY)
5. [`docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES`](../contracts/target-config-contract.md#TCC-LOOP-POLICIES)

## Cycle 개요

Caller 는 다음 4 cycle 을 가진다.

1. **Dual-track scheduler cycle** — `application/dual_track_scheduler.sh` 가 milestone 의 dual-slot (Discovery + Delivery) promotion 과 intake_queue / delivery_promotion_queue dispatch 를 담당. slot_lock 의 short transaction 만 보유.
2. **Dialogue coordinator cycle** — `application/dialogue_coordinator.sh` 가 DialogueSession 의 turn coordination, finalization 평가, session_outcome 응축, dispatch 를 담당. session_lease 보유.
3. **Turn worker cycle** — AgentProfile 별 daemon 이 ready turn 을 pickup 하여 LLM 호출, envelope 검증, SessionTurn 영속화까지 끌고 가는 6 단계. session_lease 와 turn_lease (또는 turn_index CAS) 를 사용.
4. **Verification cycle** — turn 직후 또는 SliceMerge 단계에서 결정적 검증 (VerificationRun + MetricRun) 을 실행하고 required_evidence 평가의 입력을 영속화.

```text
                    ┌─────────────────────────────┐
                    │ Dual-track scheduler        │
                    │  intake/promotion (slot_lock)│
                    └──────┬──────────────────────┘
                           │
                ┌──────────▼──────────────┐
                │ Dialogue coordinator    │
                │ session lifecycle +     │
                │ finalization evaluation │
                └──┬─────────────────┬────┘
                   │ dispatch turn   │ dispatch session_outcome
                   ▼                 ▼
        ┌──────────────────┐  ┌────────────────────┐
        │ Turn worker      │  │ Caller dispatch    │
        │ (per AgentProfile)│ │ (slice/merge state)│
        └──────┬───────────┘  └─────┬──────────────┘
               │ verification        │ trunk merge
               ▼                     ▼
        ┌──────────────┐       ┌──────────────┐
        │ Verification │       │ Trunk        │
        │ + Metric     │       │ (SliceMerge) │
        └──────────────┘       └──────────────┘
```

각 cycle 은 contract 의 책임을 하나씩 *적용* 만 한다. cycle 사이에서는 envelope · session_log · ledger · 4-lease 가 인터페이스다.

## Dual-Track Scheduler Cycle

### A. Queue Pickup

`dual_track_scheduler` 는 다음 두 큐 를 polling 한다 ([`#RGC-DUAL-GATE-QUEUE`](../contracts/reliability-and-gate-contract.md#RGC-DUAL-GATE-QUEUE)).

| Queue | head 후보 | dispatch 조건 |
|---|---|---|
| `intake_queue` | `M_INTAKE_QUEUED` milestone | Discovery slot 이 비어 있음 + slot_lock 획득 |
| `delivery_promotion_queue` | `M_SPEC_APPROVED` milestone | Delivery slot 이 비어 있음 + promotion guard 통과 + slot_lock 획득 |

### B. Slot Lock + Promotion

[`#RGC-SLOT-LOCK`](../contracts/reliability-and-gate-contract.md#RGC-SLOT-LOCK) 의 atomic 4 단계를 따른다 — slot_lock 보유 중에는 LLM 호출 / verification / 사람 입력 대기 금지.

### C. Ledger + Release

slot_lock 해제 + ledger 한 줄 (`object_kind=milestone`, `loop_kind=outer`, `slot_kind=discovery|delivery`, `action_kind=slot_promotion`).

## Dialogue Coordinator Cycle

### A. Session Pickup

dialogue_coordinator 는 다음을 ready 로 본다.

| Loop · Phase / Purpose | Ready 조건 |
|---|---|
| outer Discovery / Specification | milestone state ∈ {`M_DISCOVERY_DRAFT`, `M_DISCOVERY_AWAITING_HUMAN`, `M_SPECIFICATION_DRAFT`, `M_SPECIFICATION_AWAITING_HUMAN`} 이고 진행 session 이 없거나 직전 session 이 종료됨 |
| outer Planning | milestone `M_DELIVERY_PLANNING` |
| outer Validation | milestone `M_DELIVERY_VALIDATING` |
| middle review | slice `SLICE_REVIEWING` + SliceMerge `SM_READY_FOR_REVIEW` |
| inner tdd_build | slice `SLICE_BUILDING` 진입 직후 또는 `SLICE_BUILDING` + 직전 turn 의 verification 결과 도착 |

### B. Session Lease + Turn Coordination

session_lease 를 atomic claim. session 이 없으면 새 SESSION_OPEN 영속화. 직전 turn 종료 시점이면 다음 turn 의 routing 결정 (`AGC-NEXT-ACTION-REQUEST` 의 `caller_routing_decision`):

- `accepted` → `next_action_request.addressed_to` 를 다음 turn 의 호출 대상으로 enqueue
- `overridden` → coordinator 가 다른 participant 결정
- `dropped` → finalization 평가로 진입

### C. Finalization 평가

[`#SOC-SESSION-TERMINATION`](../contracts/state-and-operation-contract.md#SOC-SESSION-TERMINATION) 의 (finalization_rule × required_evidence × composite_rule) 평가.

- 충족 → SESSION_OPEN → CONVERGED + final_verdict 결정. session_outcome contribution 응축.
- 미충족 → 다음 turn 호출 enqueue 또는 max_turns 도달 시 TIMEOUT.

### D. Dispatch + Ledger + Lease Release

CONVERGED 후 [`#SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) 의 (state, final_verdict) tuple 분기로 caller_dispatch 호출. ledger row append (`action_kind=session_finalize`, `final_verdict` 필드 채움).

## Turn Worker Cycle (6 단계)

```text
┌─────────────┐   ┌─────────────┐   ┌──────────────────┐
│ 1. Pickup   │──▶│ 2. Lease    │──▶│ 3. Manifest +    │
│ (ready turn)│   │ (turn_index │   │    Workspace +   │
│             │   │  CAS)       │   │    Prompt        │
└─────────────┘   └─────────────┘   └──────────────────┘
                                            │
                                            ▼
┌─────────────┐   ┌────────────────┐   ┌──────────────────┐
│ 6. Cleanup  │◀──│ 5. SessionTurn │◀──│ 4. Invoke +      │
│  + Ledger   │   │ persist        │   │    Validate +    │
│             │   │                │   │    Pin recheck   │
└─────────────┘   └────────────────┘   └──────────────────┘
```

### 1. Pickup

AgentProfile 별 worker 는 `dialogue_coordinator` 가 enqueue 한 다음 turn 후보 중 본 profile 이 책임지는 항목 1개를 pickup. 정렬은 oldest-ready-first ([`#RGC-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-FAIRNESS)).

### 2. Lease

session_lease 가 이미 dialogue_coordinator 에 의해 보유된 상태이므로 worker 는 turn_index CAS 만 수행 (separate turn_lease 객체 두지 않음 — [`#RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS)).

### 3. Manifest + Workspace + Prompt

[`#AGC-SESSION-INPUT`](../contracts/agent-and-context-contract.md#AGC-SESSION-INPUT) 의 합성 규약을 따라 input 을 만든다 — manifest + prior_turn_log_snapshot + prior_verification_result + workspace_revision_pin + role prompt. inner loop 한정으로 격리 작업 공간 ([`#AGC-WORKSPACE`](../contracts/agent-and-context-contract.md#AGC-WORKSPACE)) 준비.

| Loop · Purpose | 작업 공간 |
|---|---|
| outer 모든 phase | 읽기 전용 marker 디렉토리 |
| middle review | SliceMerge 기반 read-only checkout |
| inner tdd_build | slice-local worktree (forge 격리) |

mutable / read-only 분리, edge case 분류 예시, SliceMerge 인스턴스 (시간순 1:N) 와 worktree 의 결합은 [`worktree-pr-lifecycle.md`](worktree-pr-lifecycle.md) §3 참조.

### 4. Invoke + Validate + Pin Recheck

agent runner 어댑터 호출 ([`#ARC-PORT-SIGNATURE`](../contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE)). 응답 후:

1. **Enrichment** ([`#AGC-OUTPUT-RUNTIME-ENRICH`](../contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH)) — runtime metadata + idempotency_key 후주입.
2. **Envelope validation** ([`#AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT), [`#AGC-INVALID`](../contracts/agent-and-context-contract.md#AGC-INVALID)) — 필수 필드, (parent_loop, contribution_kind, output_kind) 매트릭스, scope enforcement (inner), TDD orthodoxy (옵션).
3. **Pin recheck** — manifest required entry 의 revision pin 재검증.

### 5. SessionTurn Persist

SessionTurn 영속화 — envelope_ref + caller_routing_decision (다음 cycle 에서 coordinator 가 결정 — [`#AGC-NEXT-ACTION-REQUEST`](../contracts/agent-and-context-contract.md#AGC-NEXT-ACTION-REQUEST) 의 `decision` ∈ {accepted, overridden, delayed, dropped} + 필수 `decision_reason`) + workspace_commit (inner 한정 — turn worker 가 envelope 검증 통과 후 patch 를 슬라이스-로컬 브랜치에 commit; [`#SOC-SLICE-LIFECYCLE`](../contracts/state-and-operation-contract.md#SOC-SLICE-LIFECYCLE) 의 inner build session 절차 step 4) + verification_result_ref (별도 verification cycle 의 결과 식별자만, 본문은 [`persistence-layout.md`](persistence-layout.md) §1 의 `verifications/` 영역). 같은 SessionTurn 의 envelope 은 immutable.

`output_kind=failure` 면 turn 만 invalid 처리하고 ledger `result=invalid` 또는 `error`. session 자체는 유지 — coordinator 가 다음 cycle 에서 재시도 또는 ABANDONED 결정.

### 6. Cleanup + Ledger

작업 공간 정리 (inner). ledger row append (`action_kind=session_progress`, `loop_kind` / `phase` / `slice_id` / `slice_kind` / `session_id` / `turn_index` / `agent_profile_id` / `contribution_kind` / lease_kind=`turn_lease` 또는 null if CAS).

## Verification Cycle

inner tdd_build turn 직후 또는 SliceMerge `SM_APPROVED` 직후 실행. [`#RGC-VERIFICATION`](../contracts/reliability-and-gate-contract.md#RGC-VERIFICATION) 의 VerificationRun + MetricRun 산출. loop 별 동기성은 [`RGC-VERIFICATION`](../contracts/reliability-and-gate-contract.md#RGC-VERIFICATION) 의 실행 시점 매트릭스가 정의 — inner = 동기 (turn worker post-commit 직후, 결과가 영속화되기 전 다음 turn enqueue 금지), middle / outer = 비동기 (session_outcome 또는 SliceMerge 전이 시점).

| 트리거 | 입력 | 결과 | 동기성 |
|---|---|---|---|
| inner turn 직후 | turn 의 workspace_commit | failed_tests[] + verification_run_id → SessionTurn.verification_result | 동기 |
| middle review 의 evidence 수집 | SliceMerge.pre_merge_workspace_revision | required_evidence 평가 입력 | 비동기 |
| trunk rebase 후 | merge_revision | SM_APPROVED → SM_MERGED 의 게이트 | 비동기 |
| outer Validation pre-action | Delivery 의 trunk HEAD | cross-slice acceptance + AC-ID 별 결과 | 비동기 |

VerificationRun 본문의 영속 위치는 [`persistence-layout.md`](persistence-layout.md) §1 의 `verifications/` 영역이며, SessionTurn 은 식별자(`verification_run_id`) 만 보유한다.

## 정합성 점검 포인트

본 문서는 다음 invariant 의 *매핑* 만 보여준다. 위반 여부는 contract 가 판정한다.

- Inv #1 stateless per call, contextual within session: turn worker 단계 4 의 invoke 는 stateless 단일 호출. session 컨텍스트는 단계 3 의 `session_context_ref` 합성으로만 전달.
- Inv #2 direct invocation forbidden, mediated addressing allowed: turn envelope 의 `next_action_request` 는 dialogue_coordinator 가 routing 결정.
- Inv #3 dual-slot milestone serialization: dual_track_scheduler 가 slot_lock 보호.
- Inv #4 caller-only operational write: dispatch 와 trunk merge 는 caller_dispatch.
- Inv #5 required human contribution for feature slices: feature slice 의 outer Discovery / Specification 에서 human_approval contribution 누락 시 finalization 차단.
- Inv #6 deterministic verification authority: required_evidence 권위가 agent verdict 보다 우위.
- Inv #7 knowledge accumulation: outer Validation PASS 시 Context Summary 영속화 + RefactorBacklog 의 architectural debt 누적.
- Inv #8 AgentProfile abstraction: turn worker 의 agent_profile_id lookup 은 `agent_profiles.<id>.runner` 만 본다 (모델명 미등장).
- Inv #9 self-fetch + Context Manifest + revision pin: 단계 3 의 manifest 와 단계 4 의 pin recheck. turn manifest 도 동일 invariant 적용.
- Finite retry: dialogue_coordinator C 단계의 retry 한도 + ESCALATED 분기 ([`#RGC-FAILURE`](../contracts/reliability-and-gate-contract.md#RGC-FAILURE)).
