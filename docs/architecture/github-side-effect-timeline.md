# GitHub Side-Effect Timeline

본 문서는 GitHub adapter(`adapters/issue_tracker/github.sh`) 가 발생시키는 side-effect 의 시간순 흐름을 기록한다. contract 본문은 [`docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`](../contracts/state-and-operation-contract.md#SOC-OPERATIONS) / [`#SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) 가 정의하며, 본 문서는 그 매핑일 뿐이다.

GitHub 외 adapter(향후 GitLab/Forgejo 등) 가 추가되면 본 문서는 해당 adapter 영역으로 분리한다.

## 1. 하나의 Operation 에서 발생하는 side-effect 시퀀스

각 단계는 (caller 함수, port 진입, 외부 API) 3-tuple 을 가진다. 모든 단계는 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 `lease_token` (lease_kind ∈ {`slot_lock`, `slice_lease`, `session_lease`, `turn_lease`}) 을 함께 기록한다.

dual_track_scheduler / dialogue_coordinator / turn worker / caller_dispatch 는 서로 다른 cycle 에서 lease 의 다른 종을 보유한다 ([`#RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS)). 본 timeline 은 turn worker 와 caller_dispatch 가 함께 만드는 단일 turn → session_outcome dispatch 의 GitHub 측면이다.

```text
Turn worker cycle
   │
   ▼
[1] lease (turn_index CAS within session_lease)   lib/lease.sh           (local FS, no GitHub)
   │
   ▼
[2] context_manifest_create() + session_input     lib/context.sh         GraphQL (issue/PR/session_log snapshot)
   │
   ▼
[3] LLM invoke                                    adapters/llm_runner    (no GitHub side-effect)
   │
   ▼
[4] envelope validate + pin re-check              lib/output.sh          GraphQL (head SHA / updatedAt 재조회)
   │
   ▼
[5] SessionTurn persist + verification (inner)    lib/session.sh         (local FS, no GitHub)
   │
   ▼ (dialogue_coordinator next cycle)
[6] finalization 평가 + session_outcome 응축      application/dialogue_coordinator.sh
   │
   ▼
[7] caller_dispatch (state, final_verdict)        application/caller_dispatch.sh    REST + GraphQL  (아래 §2)
   │
   ▼
[8] ledger append + lease_release                 lib/ledger.sh          (local FS, no GitHub)
```

## 2. Caller dispatch 단계의 GitHub write 분기

각 dispatch 의 *콘텐츠* 책임은 contract 가, *write 순서* 는 본 문서가 담당한다.

| Loop · Step CONVERGED 시 | caller_dispatch 의 GitHub write 순서 | TOCTOU 가능성 |
|---|---|---|
| outer Discovery | `it_milestone_create()` 또는 `it_milestone_update()` → `it_milestone_set_state()` (`M_DISCOVERY_*` 전이) | milestone description 의 동시 편집(거의 없음) |
| outer Specification | `it_milestone_update()` → `it_milestone_set_state()` (`M_SPECIFICATION_*` → `M_SPEC_APPROVED`) | 위와 동일 |
| outer Planning | `it_issue_create()` × N (Slice 영속화) → `it_issue_link_to_milestone()` × N → `it_issue_set_blocked_by()` × N (slice DAG `blocks`/`coordinates_with`) → `it_milestone_set_state()` (`M_DELIVERY_PLANNING` → `M_DELIVERY_BUILDING`) | Issue 생성과 link 사이에 외부 사용자가 milestone 을 close 할 가능성 |
| inner tdd_build session 종료 (CONVERGED) | (worktree 작업은 §3) → SliceMerge `SM_DRAFT` → `SM_READY_FOR_REVIEW` 의 marker write | slice worktree 의 외부 push, label 충돌 |
| middle review | SliceMerge marker write (`SM_READY_FOR_REVIEW` ↔ `SM_REWORK_REQUESTED` ↔ `SM_APPROVED`) → label 갱신 → comment | slice worktree HEAD 가 검증 시점 이후 push 로 변경됨 (pin re-check 가 흡수) |
| middle merge (`SM_APPROVED` → `SM_MERGED`) | trunk merge/rebase → `it_issue_set_state()` (slice 종결) | trunk 의 동시 변경 (rebase 시 재검증) |
| outer Validation | `it_milestone_set_state()` (`M_DELIVERY_VALIDATING` → `M_DONE`) → close note 또는 release 발행 | 검증 도중 slice 회귀 |

**TOCTOU 흡수 정책**: 모든 write 직전에 [`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 의 pin 을 재조회하고, 변경이 감지되면 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) `stale` 로 결과를 종결한 뒤 dispatch 를 건너뛴다. 부분 진행된 write 는 [`#RGC-FAILURE`](../contracts/reliability-and-gate-contract.md#RGC-FAILURE) 의 partial-fail rollback 정책에 따라 처리한다.

## 3. 워크스페이스 side-effect (inner tdd_build)

inner tdd_build 의 forge turn 은 slice-local worktree 단계에서 다음을 수행한다.

| 단계 | 호출 함수 | 영속 부작용 |
|---|---|---|
| 격리 worktree 생성 | `lib/worktree.sh` | 로컬 FS only |
| patch 적용 | `application/agent_workspace.sh` ws_apply_patch | 로컬 FS only |
| `git push` | `lib/worktree.sh` | 원격 ref 갱신 |
| SliceMerge state marker 갱신 | `application/slice_merge.sh` | Issue/PR body REST PATCH |

worktree → push 사이에 [`#RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS) 의 turn_lease (또는 turn_index CAS) 가 만료되면 push 결과는 ledger 에 기록되지만 이후 단계는 stale 로 종결된다.

## 4. 사용 가이드

- 운영 사고 발생 시 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 timestamp 와 본 문서의 단계 번호를 함께 보면 어느 단계에서 멈췄는지가 식별된다.
- 새 operation 또는 새 어댑터를 추가할 때는 본 문서의 §2 표에 행을 한 줄 추가하고 contract 의 [`#SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) anchor 를 함께 갱신한다.
