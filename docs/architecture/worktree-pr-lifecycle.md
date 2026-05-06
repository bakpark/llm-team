# Worktree-PR Lifecycle

## 1. Scope, Authority, Target Reader

본 문서는 LLM-team 모델에서 *작업 에이전트의 격리된 워크트리*, *영속 산출물*, *PR (SliceMerge 의 외부 mirror) 의 lifecycle* 이 어떻게 한 흐름으로 엮이는지를 한 장에 그린 **workflow diagram entry point** 다. 본 문서는 통합 다이어그램이며, 정합 진술의 권위는 보유하지 않는다.

권위 순서:

1. [`llm-team.md`](../../llm-team.md) — Concept / Constitution.
2. [`docs/contracts/`](../contracts/) — contract set.
3. 본 문서 및 다른 architecture 문서.

본 문서가 contract 와 충돌하면 contract 가 우선한다.

### Target Reader

- Caller / scheduler 구현자 (`application/dialogue_coordinator.sh`, `application/dual_track_scheduler.sh`, `application/slice_merge.sh` 등).
- Agent runner adapter 작성자 (`agent-runner-adapters.md` 의 매핑 구현).
- Contract reviewer (B0 amendment 후 정합성 점검자).

본 문서는 inner / middle / outer 3-loop 모델을 알고 있는 독자를 가정한다. 모델 자체의 소개는 [`pipeline-end-to-end.md`](pipeline-end-to-end.md) 가 담당한다.

---

## 2. Object Cardinality

### Slice ↔ branch ↔ workspace ↔ SliceMerge ↔ PR

| 내부 객체 | 외부 / 파일 시스템 surface | 카디널리티 |
|---|---|---|
| Slice | 1 GitHub Issue | 1 : 1 (`external-tracking-mapping.md` §1) |
| Slice | slice-local branch | 1 Slice : N branches (시간순 — 새 SliceMerge 마다 새 branch) |
| Slice | workspace 디렉토리 (`workdir/workspaces/<slice_id>/`) | 1 : 1 디렉토리 (단 SliceMerge 인스턴스 마다 내부 구조 재생성 가능 — §8) |
| Slice | **SliceMerge 인스턴스 (시간순)** | **1 : N (active 는 1)** ([`SOC-SLICE-MERGE`](../contracts/state-and-operation-contract.md#SOC-SLICE-MERGE) cardinality 단락) |
| SliceMerge | GitHub PR | 1 : 1 (`external-tracking-mapping.md` §4) |
| middle review DialogueSession | PR review thread | 1 review session : 1 PR review thread (PR 와 동일 surface 공유) |

> **active SliceMerge** — 어느 시점에 SliceMerge 의 state 가 `SM_DRAFT` / `SM_READY_FOR_REVIEW` / `SM_APPROVED` / `SM_STALE` / `SM_REQUEST_CHANGES` 중 하나인 인스턴스. terminal (`SM_MERGED` / `SM_CLOSED`) 인 인스턴스는 audit chain 으로만 후속과 연결된다.

후속 SliceMerge 의 middle review session 은 advisory `prior_review_context` 를 동봉할 수 있다 ([`AGC-SESSION-INPUT`](../contracts/agent-and-context-contract.md#AGC-SESSION-INPUT) §`prior_review_context`).

### Audit Chain (terminal SliceMerge → 후속)

```text
SliceMerge_n (SM_CLOSED)
   audit_chain ↘
                SliceMerge_{n+1} (SM_DRAFT 또는 그 이후)
```

Audit chain 의 정의는 [`SOC-SLICE-LIFECYCLE`](../contracts/state-and-operation-contract.md#SOC-SLICE-LIFECYCLE) Audit Chain 절.

> **See also**: [`state-machine.md` SliceMerge State Mapping](state-machine.md), [`external-tracking-mapping.md` §4](external-tracking-mapping.md).

---

## 3. Workspace Applicability Matrix

### 단일 판정 기준

> *Agent 가 patch artifact 를 산출하는가?*

이 질문에 `yes` 인 turn 만 mutable workspace (slice-local worktree) 를 받는다. 그 외에는 read-only checkout 또는 marker 디렉토리만 받는다. 본 절의 매트릭스는 [`AGC-WORKSPACE`](../contracts/agent-and-context-contract.md#AGC-WORKSPACE) 의 architectural mapping 이다.

### 매트릭스

| Loop · Phase / Purpose | Agent profile / role | Patch 산출? | Workspace |
|---|---|---|---|
| inner tdd_build | forge `lead_draft` | ✅ | mutable slice-local worktree |
| middle review | sentinel `lead` (review_verdict) | ❌ | SliceMerge 기반 read-only checkout |
| middle review | atlas / forge `reviewer` (review_verdict) | ❌ | SliceMerge 기반 read-only checkout |
| outer Discovery | atlas `lead_draft` (spec_proposal) | ❌ | marker 디렉토리만 |
| outer Specification | atlas `lead_draft` (spec_proposal) | ❌ | marker 디렉토리만 |
| outer Planning | atlas `lead_draft` (slice_decomposition) | ❌ | marker 디렉토리만 |
| outer Validation | sentinel `lead_draft` (milestone_package) | ❌ | marker 디렉토리만 |
| (any) human_approval | human | ❌ | n/a (사람 입력) |
| (any) proposal | atlas / scout | ❌ | marker 디렉토리만 |

### Edge case 분류 예시

| 상황 | 분류 |
|---|---|
| atlas 가 ADR proposal turn 에서 새 ADR 마크다운을 생성 | spec 산출이며 patch 아님 → marker only |
| forge inner red turn 에서 실패하는 acceptance test 추가 | patch 산출 → mutable worktree |
| sentinel middle review turn 에서 `request_changes` verdict + 인라인 finding | review_verdict 산출, patch 아님 → read-only checkout |
| forge 가 middle review reviewer 로 참여 (verdict 만) | patch 아님 → read-only checkout |
| scout RefactorBacklog scan turn | scan_result 산출, patch 아님 → marker only |

> **See also**: [`agent-runner-adapters.md` agent_cwd](agent-runner-adapters.md), [`pipeline-end-to-end.md` Manifest + Workspace + Prompt](pipeline-end-to-end.md), [`AGC-WORKSPACE`](../contracts/agent-and-context-contract.md#AGC-WORKSPACE).

---

## 4. End-to-End Sequence (Swimlane)

본 절은 한 Slice 가 SLICE_READY 에서 출발해 SLICE_VALIDATED 또는 SLICE_BLOCKED 로 종착하기까지의 흐름을 4 lane (Caller / Agent / Persistent Store / GitHub) 으로 분해한다.

### 4.1 Happy path (approve)

```text
Caller                       Agent (forge / sentinel)         Persistent Store              GitHub
  │                                  │                              │                          │
  ├─ Slice SLICE_READY → SLICE_BUILDING (pre-action)                │                          │
  │   ├─ create SliceMerge (SM_DRAFT) ──────────────────────────────► SliceMerge object         │
  │   └─ open draft PR ─────────────────────────────────────────────────────────────────────────► draft PR (state=draft)
  │                                  │                              │                          │
  ├─ open inner DialogueSession      │                              │                          │
  │   for-each turn:                 │                              │                          │
  │     prepare manifest ────────────► manifest entries             │                          │
  │     invoke runner ──────────────► forge red/green/refactor      │                          │
  │                       envelope ◄─┤ patch + verdict              │                          │
  │     validate, enrich ────────────────────────────────────────────► SessionTurn envelope     │
  │     post-validate commit (slice-local branch) ──────────────────► workspace_commit (SHA)    │
  │     push to draft PR ──────────────────────────────────────────────────────────────────────► draft PR HEAD updated
  │     verify (build/test/lint) ────────────────────────────────────► verification_run_id      │
  │                                  │                              │                          │
  ├─ inner CONVERGED (final_verdict=tests_green)                    │                          │
  │   ├─ SliceMerge SM_DRAFT → SM_READY_FOR_REVIEW ──────────────────► state mark               │
  │   ├─ Slice SLICE_BUILDING → SLICE_REVIEWING                    │                          │
  │   └─ PR ready ───────────────────────────────────────────────────────────────────────────────► PR (state=ready)
  │                                  │                              │                          │
  ├─ open middle review DialogueSession                             │                          │
  │   read-only checkout ──────────► sentinel / atlas / forge       │                          │
  │                       envelope ◄─┤ review_verdict (approve)     │                          │
  │     mirror verdict ──────────────────────────────────────────────────────────────────────────► PR review (approve)
  │                                  │                              │                          │
  ├─ middle CONVERGED (approve)      │                              │                          │
  │   ├─ SliceMerge SM_APPROVED ─────────────────────────────────────► state mark               │
  │   ├─ Slice SLICE_REVIEWING → SLICE_INTEGRATING                 │                          │
  │   ├─ trunk rebase + verification 재실행                         │                          │
  │   ├─ SliceMerge SM_MERGED ───────────────────────────────────────► merge_revision           │
  │   ├─ Slice SLICE_VALIDATED                                     │                          │
  │   └─ PR merged ──────────────────────────────────────────────────────────────────────────────► PR (state=merged)
  │                                  │                              │                          │
  └─ workspace GC (SliceMerge terminal)                             │                          │
```

### 4.2 Branch — middle request_changes

```text
... middle CONVERGED (final_verdict=request_changes)
   ├─ SliceMerge SM_REQUEST_CHANGES → SM_CLOSED (single-step DISPATCH-MATRIX)
   ├─ Slice SLICE_REVIEWING → SLICE_BUILDING
   ├─ workspace GC (SM_CLOSED 진입 시)
   ├─ PR closed ─────────────────────────────────────────────────────────────────────────────────► PR (state=closed)
   └─ start new inner DialogueSession (advisory prior_review_context 동봉)
       └─ go back to §4.1 from the pre-action ↑ (새 SliceMerge 인스턴스, 새 worktree)
```

### 4.3 Branch — inner TIMEOUT / ABANDONED

```text
... inner session TIMEOUT 또는 ABANDONED (no_progress / regression / scope_violation)
   ├─ SliceMerge SM_DRAFT → SM_CLOSED ([SOC-SLICE-MERGE Flow step 8](../contracts/state-and-operation-contract.md#SOC-SLICE-MERGE))
   ├─ Slice SLICE_BLOCKED
   ├─ workspace GC (SM_CLOSED 진입 시)
   └─ PR closed ─────────────────────────────────────────────────────────────────────────────────► PR (state=closed)

(이후 사람 결정으로 Slice 가 SLICE_READY 로 재진입 시 §4.1 의 pre-action 부터 새 SliceMerge 인스턴스 생성. audit chain 으로 직전 SM_CLOSED 와 연결.)
```

> **See also**: [`SOC-SLICE-LIFECYCLE`](../contracts/state-and-operation-contract.md#SOC-SLICE-LIFECYCLE), [`SOC-SLICE-MERGE`](../contracts/state-and-operation-contract.md#SOC-SLICE-MERGE), [`SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX), [`github-side-effect-timeline.md` §2](github-side-effect-timeline.md).

---

## 5. GitHub Signal Direction

> 본 절의 정합 권위는 [`external-tracking-mapping.md` §6](external-tracking-mapping.md) 다.

### 5.1 Outbound (내부 → GitHub)

| 내부 사건 | GitHub 표현 |
|---|---|
| Slice SLICE_BUILDING 진입 (Caller pre-action) | draft PR open |
| inner turn workspace_commit | draft PR HEAD push |
| SliceMerge SM_DRAFT → SM_READY_FOR_REVIEW | PR ready (draft 해제) + label 갱신 |
| middle review SessionTurn 의 `review_verdict=approve` | PR native review (approve) |
| middle review SessionTurn 의 `review_verdict=request_changes` | PR native review (request_changes) 또는 PR comment |
| SliceMerge SM_APPROVED / SM_MERGED / SM_CLOSED / SM_REQUEST_CHANGES / SM_STALE | PR label 갱신 + body marker 갱신 (`state-machine.md` SliceMerge State Mapping) |

### 5.2 Inbound (GitHub → 내부)

| GitHub 이벤트 | node_id prefix | 신호로 인정? |
|---|---|---|
| Issue comment (REST `/issues/{n}/comments`) — strict line-prefix command | `IC_` | ✅ 단일 채널 ([`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS), [`RGC-HUMAN-CONTRIBUTION`](../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION)) |
| PR native review (approve / request_changes / comment via PR review UI) | `PRR_` | ❌ 신호 아님 — drift_observer conflict observation 만 |
| PR inline review comment | `PRRC_` | ❌ 신호 아님 |
| PR / Issue / Milestone lifecycle event (close, reopen, label edit, milestone state edit, draft toggle 등) | — | ❌ 신호 아님 — drift_observer 가 `external_refs[].sync_status=conflict` 로 기록 |

PR native review 가 SliceMerge state 를 직접 전이시키지 않는다. middle review session 의 `review_verdict` 가 §5.1 outbound 로 PR 에 mirror 될 뿐이다.

### 5.3 Human contribution 권위 범위

| 단계 | `human_approval` 의무 | 근거 |
|---|---|---|
| outer Discovery (feature slice) | 필수 | invariant 5, [`agents/profiles/human.md`](agents/profiles/human.md) |
| outer Specification (feature slice) | 필수 | 동상 |
| middle review (internal slice + escalation rule hit 시 feature gate 자동 승격) | 필수 | invariant 5 + `target.internal_escalation_rules` |
| outer Discovery (cross_milestone_amendment) | 필수 | 동상 |
| 그 외 | 선택 (proposal / 기타) | — |

사람 결정의 권위는 절대다. agent quorum 이 사람 승인을 대체할 수 없다 (invariant 5). 단 본 권위는 위 표의 **단계** 에서만 게이트로 작동한다 — 모든 turn 에 사람 승인이 필요하다는 의미는 아니다.

> **See also**: [`external-tracking-mapping.md` §4, §6](external-tracking-mapping.md), [`state-machine.md` SliceMerge State Mapping](state-machine.md), [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS), [`RGC-HUMAN-CONTRIBUTION`](../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION).

---

## 6. Branch / Worktree Topology

### 6.1 Branch 구조

- **Trunk**: 단일 trunk. Delivery N 의 모든 SliceMerge 가 SM_MERGED 시 trunk HEAD 전진 ([`SOC-DUAL-MILESTONE-BRANCH`](../contracts/state-and-operation-contract.md#SOC-DUAL-MILESTONE-BRANCH)).
- **Slice-local branch**: SliceMerge 인스턴스 1 개 당 1 개. 일시적이며 SliceMerge terminal 시 정리 대상.
- **Base SHA**: SliceMerge 의 `pre_merge_workspace_revision` 이 가리키는 trunk SHA. SM_DRAFT 동안 mutable, SM_READY_FOR_REVIEW 진입 시 freeze.

### 6.2 Worktree 구조

- 위치: `workdir/workspaces/<slice_id>/` ([`persistence-layout.md` §1](persistence-layout.md)).
- mutable workspace 가 부여되는 turn 은 §3 매트릭스 1 행만 (inner forge `lead_draft`).
- 동일 Slice 의 후속 SliceMerge 인스턴스 (request_changes / inner abandon 후 재진입) 는 *새 worktree* 로 시작 (§8).

### 6.3 `coordinates_with` 충돌

병렬 slice 가 `coordinates_with` 로 묶인 경우 first-merger-wins. 늦게 merge 시도하는 slice 의 SliceMerge 는 SM_STALE 로 진입하며 rebase 또는 verification 재실행을 거친다 ([`state-machine.md`](state-machine.md) SliceMerge State Mapping, [`SOC-DUAL-MILESTONE-BRANCH`](../contracts/state-and-operation-contract.md#SOC-DUAL-MILESTONE-BRANCH)).

> **See also**: [`SOC-DUAL-MILESTONE-BRANCH`](../contracts/state-and-operation-contract.md#SOC-DUAL-MILESTONE-BRANCH), [`persistence-layout.md` §1](persistence-layout.md).

---

## 7. Lifecycle vs Lease

본 절은 §4 의 흐름을 4-lease 계층 ([`RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS)) 과 매핑한다.

| Lease | 점유 시점 | 점유 단위 | 회수 |
|---|---|---|---|
| Slot lock | milestone Discovery / Delivery slot 점유 | 짧은 transaction | 즉시 |
| Slice lease (= workspace lease) | Slice 가 SLICE_BUILDING 진입 시부터 SliceMerge terminal 까지 | long-running | TTL 만료 → STALE |
| Session lease | DialogueSession turn append 직렬화 | session 활성 | session 종료 시 |
| Turn lease | 개별 agent 호출 lock (CAS 권장) | 단일 turn | turn 완료 시 |

### Workspace 보존·GC

[`persistence-layout.md` §7](persistence-layout.md) 인용:

> `workspaces/` — inner session 종료 시 즉시 정리. 단 `SM_DRAFT` / `SM_READY_FOR_REVIEW` 동안은 보존. SliceMerge terminal 이후 GC.

본 문서의 §8 결정표가 이 정책을 사건별로 분해한다.

> **See also**: [`RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS), [`persistence-layout.md` §7](persistence-layout.md), [`lease-and-recovery.md`](lease-and-recovery.md).

---

## 8. Failure & Recovery — 결정표

| 사건 | SliceMerge 전이 | workspace 처리 | 새 worktree 여부 |
|---|---|---|---|
| lease STALE (turn 단위, lease 만료) | 변동 없음 | 보존 (SM_DRAFT/SM_READY_FOR_REVIEW 동안) | 동일 worktree 재진입 |
| turn FAIL (한도 미초과 — 같은 session 안 재시도) | 변동 없음 | 보존 | 동일 worktree |
| inner TIMEOUT / ABANDONED (한도 초과) | **SM_DRAFT → SM_CLOSED + draft PR close** | SM_CLOSED 진입 시 GC | SLICE_READY 재진입 시 새 worktree + 새 SM_DRAFT (audit chain) |
| middle CONVERGED `request_changes` | `SM_REQUEST_CHANGES → SM_CLOSED` (single-step — DISPATCH-MATRIX 의 middle review request_changes row; SM_REQUEST_CHANGES 는 transient, workspace 는 SM_CLOSED 진입 직전까지 보존) | SM_CLOSED 진입 시 GC | 새 worktree + 새 SM_DRAFT |
| trunk drift → SM_STALE | non-terminal | 보존 | 동일 worktree, rebase 또는 재verify |
| middle review TIMEOUT | non-terminal (SLICE_BLOCKED — Caller 결정) | 보존 | Caller 결정 시까지 동결 |
| ESCALATED (재시도 한도 초과 또는 사람 escalate) | 변동 없음 | 보존 | 사람 결정 시까지 동결 |

각 결정의 권위 anchor:

- inner TIMEOUT / ABANDONED → [`SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) inner tdd_build TIMEOUT / ABANDONED row, [`SOC-SLICE-MERGE`](../contracts/state-and-operation-contract.md#SOC-SLICE-MERGE) Flow step 8.
- middle request_changes single-step → [`SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) middle review CONVERGED `request_changes` row.
- workspace GC 정책 → [`persistence-layout.md` §7](persistence-layout.md).
- Lease 회수 → [`RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS), [`reliability-and-gate-contract.md#RGC-FAILURE`](../contracts/reliability-and-gate-contract.md#RGC-FAILURE).

> **See also**: [`SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX), [`lease-and-recovery.md`](lease-and-recovery.md).

---

## 9. Open Questions (Out of Scope)

본 문서는 다음 구현 디테일을 결정하지 않는다. 어댑터 / 운영 정책 영역.

- worktree 격리 메커니즘: `git worktree add` vs 별도 clone vs container sandbox.
- worktree GC 의 구체 명령 (`git worktree remove --force` vs rsync rm 등).
- draft PR push 의 batch 정책 (turn 마다 push vs N turn 마다 squash push).
- Slice-local branch 의 naming convention.
- Hook (pre-commit, post-receive 등) 활용 여부.
- 동일 Slice 의 후속 SliceMerge 가 직전 worktree 디렉토리를 재사용 (path reuse) 할지, 별도 sub-디렉토리에서 시작할지.

위 항목은 별도 adapter 문서 또는 target config 가 정의한다 ([`target-config-contract.md`](../contracts/target-config-contract.md), [`agent-runner-adapters.md`](agent-runner-adapters.md), [`adapter-inventory.md`](adapter-inventory.md)).

---

## 10. See Also

| 문서 / Anchor | 용도 |
|---|---|
| [`llm-team.md`](../../llm-team.md) Architecture §3 | Caller 정의 — "에이전트를 호출하고 모든 operational write 를 수행" |
| [`llm-team.md`](../../llm-team.md) invariant 5, 9 | feature slice 사람 게이트, manifest revision pin |
| [`AGC-WORKSPACE`](../contracts/agent-and-context-contract.md#AGC-WORKSPACE) | mutable workspace = inner forge `lead_draft` 한정 |
| [`AGC-SESSION-INPUT`](../contracts/agent-and-context-contract.md#AGC-SESSION-INPUT) | `prior_review_context` advisory slot |
| [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT) | contribution_kind ↔ output_kind 매트릭스 (review_verdict / patch / spec_proposal / ...) |
| [`SOC-SLICE-LIFECYCLE`](../contracts/state-and-operation-contract.md#SOC-SLICE-LIFECYCLE) | Slice 9-state |
| [`SOC-SLICE-MERGE`](../contracts/state-and-operation-contract.md#SOC-SLICE-MERGE) | SliceMerge 7-state, schema, Flow, cardinality, field availability |
| [`SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) | (state, final_verdict) → 다음 dispatch 분기 |
| [`SOC-OPERATIONS`](../contracts/state-and-operation-contract.md#SOC-OPERATIONS) | Middle Slice Build pre-action |
| [`SOC-DUAL-MILESTONE-BRANCH`](../contracts/state-and-operation-contract.md#SOC-DUAL-MILESTONE-BRANCH) | trunk / branch 정책 |
| [`RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS) | 4-lease 계층 |
| [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS), [`RGC-HUMAN-CONTRIBUTION`](../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION) | inbound human signal, contribution 변환 |
| [`ARC-PORT-SIGNATURE`](../contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE) | `agent_cwd` 필드 |
| [`external-tracking-mapping.md`](external-tracking-mapping.md) §4, §6 | SliceMerge ↔ PR 매핑, inbound 정책 |
| [`persistence-layout.md`](persistence-layout.md) §1, §7 | workdir 디렉토리, GC |
| [`state-machine.md`](state-machine.md) | SliceMerge state ↔ GitHub label/marker encoding |
| [`github-side-effect-timeline.md`](github-side-effect-timeline.md) §2 | 세션 단위 GitHub side-effect 시퀀스 |
| [`pipeline-end-to-end.md`](pipeline-end-to-end.md) | 4 cycle (scheduler / coordinator / worker / verification) |
| [`agent-runner-adapters.md`](agent-runner-adapters.md) | adapter 매핑 |
| [`agents/profiles/human.md`](agents/profiles/human.md) | `human_approval` contribution 변환 |
