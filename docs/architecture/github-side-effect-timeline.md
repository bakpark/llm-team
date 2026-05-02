# GitHub Side-Effect Timeline

본 문서는 GitHub adapter(`adapters/issue_tracker/github.sh`) 가 발생시키는 side-effect 의 시간순 흐름을 기록한다. contract 본문은 [`docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`](../contracts/state-and-operation-contract.md#SOC-OPERATIONS) / [`#SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) 가 정의하며, 본 문서는 그 매핑일 뿐이다.

GitHub 외 adapter(향후 GitLab/Forgejo 등) 가 추가되면 본 문서는 해당 adapter 영역으로 분리한다.

## 1. 하나의 Operation 에서 발생하는 side-effect 시퀀스

각 단계는 (caller 함수, port 진입, 외부 API) 3-tuple 을 가진다. 모든 단계는 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 `lease_token` 을 함께 기록한다.

```text
Caller cycle
   │
   ▼
[1] lease_claim()                      lib/lease.sh           (local FS, no GitHub)
   │
   ▼
[2] context_manifest_create()          lib/context.sh         GraphQL (issue/PR snapshot)
   │
   ▼
[3] LLM invoke                         adapters/llm_runner    (no GitHub side-effect)
   │
   ▼
[4] envelope validate + pin re-check   lib/output.sh          GraphQL (head SHA / updatedAt 재조회)
   │
   ▼
[5] operation-specific writes (아래 §2)                       REST + GraphQL
   │
   ▼
[6] ledger append + lease_release      lib/ledger.sh          (local FS, no GitHub)
```

## 2. Operation 별 [5] 단계 분기

각 operation 의 *콘텐츠* 책임은 contract 가, *write 순서* 는 본 문서가 담당한다.

| Operation | 단계 [5] 의 GitHub write 순서 | TOCTOU 가능성 |
|---|---|---|
| Compose-PO | `it_milestone_create()` 또는 `it_milestone_update()` → `it_milestone_set_state()` | milestone description 의 동시 편집(거의 없음) |
| Compose-PM | `it_milestone_update()` → `it_milestone_set_state()` | 위와 동일 |
| Decompose | `it_issue_create()` × N → `it_issue_link_to_milestone()` × N → `it_issue_set_blocked_by()` × N → `it_milestone_set_state()` | issue 생성과 link 사이에 외부 사용자가 milestone 을 close 할 가능성 |
| Implement | (worktree 작업은 §3) → PR 생성/갱신 → `it_issue_set_state()` task → CP marker write | PR 본문/head SHA 의 외부 push, label 충돌 |
| Review | CP marker write → label 갱신 → comment | PR head SHA 가 검증 시점 이후 push 로 변경됨(pin re-check 가 흡수) |
| Refactor | milestone description 갱신 → `it_milestone_set_state()` → 필요 시 cleanup PR | refactor 도중 외부 task 추가 |
| Validate | `it_milestone_set_state()` → close note 또는 release 발행 | 검증 도중 task 회귀 |

**TOCTOU 흡수 정책**: 모든 write 직전에 [`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 의 pin 을 재조회하고, 변경이 감지되면 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) `stale` 로 결과를 종결한 뒤 dispatch 를 건너뛴다. 부분 진행된 write 는 [`#RGC-FAILURE`](../contracts/reliability-and-gate-contract.md#RGC-FAILURE) 의 partial-fail rollback 정책에 따라 처리한다.

## 3. 워크스페이스 side-effect (Coder/Reviewer)

Coder/Reviewer 는 worktree 단계에서 다음을 수행한다.

| 단계 | 호출 함수 | 영속 부작용 |
|---|---|---|
| 격리 worktree 생성 | `lib/worktree.sh` | 로컬 FS only |
| patch 적용 | `application/agent_workspace.sh` ws_apply_patch | 로컬 FS only |
| `git push` | `lib/worktree.sh` | 원격 ref 갱신 |
| PR 본문/state marker 갱신 | `_github_replace_cp_state_marker()` | PR body REST PATCH |

worktree → push 사이에 [`docs/contracts/reliability-and-gate-contract.md#RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE) 의 lease 가 만료되면 push 결과는 ledger 에 기록되지만 이후 단계는 stale 로 종결된다.

## 4. 사용 가이드

- 운영 사고 발생 시 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 timestamp 와 본 문서의 단계 번호를 함께 보면 어느 단계에서 멈췄는지가 식별된다.
- 새 operation 또는 새 어댑터를 추가할 때는 본 문서의 §2 표에 행을 한 줄 추가하고 contract 의 [`#SOC-DISPATCH-MATRIX`](../contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX) anchor 를 함께 갱신한다.
