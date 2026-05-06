# External Tracking System Mapping

본 문서는 [`SOC-OBJECTS`](../contracts/state-and-operation-contract.md#SOC-OBJECTS) 가 정의한 추상 슬롯 `external_refs[]` 의 *현재 구현체 매핑* 이다.

contract 본문은 `external_refs[].provider` 의 enum 을 고정하지 않는다. 본 문서는 `provider="github"` 1종에 대한 매핑을 정의한다. 향후 GitLab / Forgejo / 자체 tracker 가 추가되면 별도 §provider 절을 추가한다.

write 의 *시간 순서* 와 TOCTOU 정책은 [`github-side-effect-timeline.md`](github-side-effect-timeline.md) 가 정의하며, 본 문서는 *어떤 객체가 어떤 외부 surface 로 mirror 되는가* 만 다룬다.

## 1. provider="github" 객체 매핑

| 내부 객체 | 외부 surface | `external_refs[].kind` | 카디널리티 |
|---|---|---|---|
| Milestone | GitHub Milestone | `milestone` | 1 milestone : 1 GitHub Milestone (dual-slot 은 label 로 구분 — §2) |
| Slice (`SOC-SLICE-LIFECYCLE`) | GitHub Issue | `tracker` | 1 Slice : 1 Issue |
| SliceMerge (`SOC-SLICE-MERGE`) | GitHub Pull Request | `review_surface` | 1 SliceMerge : 1 PR |
| middle review DialogueSession | PR review thread (review + comments) | `review_surface` | 1 middle review session : 1 PR review thread (PR 와 동일 surface 공유) |
| outer Discovery / Specification DialogueSession | (없음) | — | spec 산출은 milestone 본문에 직접 누적; session 자체는 GitHub mirror 를 갖지 않는다 |
| outer Validation DialogueSession | (없음) | — | validation 결과는 milestone 본문/close note 또는 release 에 누적 |
| inner tdd_build DialogueSession | (없음) | — | session_log 는 KAC 가 영속화. PR 본문은 SliceMerge 의 mirror 가 담당 |
| MilestoneTracker | GitHub Issue (label `kind/milestone-tracker` + body machine block) | `milestone_tracker` | 1 milestone : 1 Tracker Issue. outer Discovery / Specification / Validation 의 사람 승인 surface (Issue body `awaiting:` block 갱신 + comment command 입력). 보조용 — Milestone CP / Spec CP 본문은 GitHub Milestone description 에 누적되는 기존 정책 유지. spec: `docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md` §4.2 |
| Control | GitHub Issue (1 repo당 1개) | `control` | system signal (`pause`/`resume`/`stop`) 단일 입력 surface. `target.governance.control_issue_number` 로 식별. terminal state 없음 (close 안 함) |
| ContractChange | GitHub Issue (1 repo당 1개) | `contract_change` | `{contract, change_proposal}` 집합 surface — verb 가 target_kind 결정. `target.governance.contract_change_issue_number` 로 식별. terminal state 없음 |

`Milestone CP` / `Spec CP` 는 GitHub mirror 의 별도 객체가 아니라 GitHub Milestone 본문의 콘텐츠 누적 단위다 ([`AGC-ISSUE-BODY`](../contracts/agent-and-context-contract.md#AGC-ISSUE-BODY) 의 두 계층 구조).

## 2. Milestone Dual-Slot 매핑

[`SOC-MILESTONE-DUAL-SLOT`](../contracts/state-and-operation-contract.md#SOC-MILESTONE-DUAL-SLOT) 의 Discovery slot 과 Delivery slot 은 다음 정책으로 GitHub Milestone 1 개에 통합한다.

- 두 slot 은 단일 GitHub Milestone 으로 표현된다 (1:1).
- slot 구분은 label 로 한다.
  - `slot/discovery`: milestone 이 Discovery stage 점유 중 (`M_DISCOVERY_*` / `M_SPECIFICATION_*` / `M_SPEC_APPROVED` 직전).
  - `slot/delivery`: milestone 이 Delivery stage 점유 중 (`M_DELIVERY_*`).
  - 두 label 동시 부착은 invalid (전환 도중에는 atomically 한 label 만 유지).
- milestone state 는 별도 label `state/<value>` 로 mirror (예: `state/M_DELIVERY_BUILDING`). 본문(description) 의 machine block 도 같은 값을 가진다.

대안 — Discovery slot 1개 + Delivery slot 1개의 2 GitHub Milestone 분리 — 는 cross-milestone amendment 와 dual-track knowledge inject 의 manifest 합성을 복잡하게 만들어 채택하지 않는다.

## 3. Slice ↔ Issue State 매핑

| Slice state | GitHub Issue state | label |
|---|---|---|
| `SLICE_PENDING` | open | `slice-state/pending`, `dep/<blocker_slice_id>` × N |
| `SLICE_READY` | open | `slice-state/ready` |
| `SLICE_BUILDING` | open | `slice-state/building` |
| `SLICE_REVIEWING` | open | `slice-state/reviewing`, `pr/<slice_merge_pr_number>` |
| `SLICE_INTEGRATING` | open | `slice-state/integrating` |
| `SLICE_VALIDATED` | closed (completed) | `slice-state/validated` |
| `SLICE_BLOCKED` | open | `slice-state/blocked`, `escalation-required` |

Issue body 의 machine block 은 [`AGC-ISSUE-BODY`](../contracts/agent-and-context-contract.md#AGC-ISSUE-BODY) 의 두 계층 구조에 따라 다음 마커를 포함한다 (단일 `<details>` 영역에 모음).

- `slice-state/<value>`
- `slice-merge-state/<value>` (SliceMerge 가 생성된 이후)
- `lease/<kind>/<token>` (현재 보유 lease)
- `dod-revision-pin/<sha>`

## 4. SliceMerge ↔ PR State 매핑

| SliceMerge state | GitHub PR state | label |
|---|---|---|
| `SM_DRAFT` | draft PR | `sm-state/draft` |
| `SM_READY_FOR_REVIEW` | ready PR (open) | `sm-state/ready-for-review` |
| `SM_APPROVED` | open + approved review | `sm-state/approved` |
| `SM_MERGED` | merged | `sm-state/merged` (closed PR) |
| `SM_REQUEST_CHANGES` | open + change-requested review | `sm-state/request-changes` |
| `SM_CLOSED` | closed (not merged) | `sm-state/closed` |
| `SM_STALE` | open | `sm-state/stale` |

middle review session 의 SessionTurn 별 review_verdict 는 PR review (approve / request_changes) 또는 PR comment 로 push 된다. `next_action_request` 의 `addressed_to` 는 GitHub 의 review request 로는 mirror 하지 않는다 (mediated addressing — Caller 가 단독 routing).

> SliceMerge 인스턴스 (시간순 1:N) 와 PR open / close timing 의 통합 sequence 는 [`worktree-pr-lifecycle.md`](worktree-pr-lifecycle.md) §4. signal direction (outbound mirror vs inbound `IC_` 단일 채널) 의 정리는 같은 문서 §5.

## 5. 동기화 메타 스키마

`external_refs[]` entry 가 mirror 의 stale 검출과 회복을 가능하게 하려면 다음 메타가 필요하다.

```text
external_refs[].sync_meta {
  sync_status: <opaque-id>          # 추상 슬롯 — 본 문서의 enum 권위는 §5.1
  last_synced_internal_revision     # mirror 갱신 시점의 내부 객체 audit_hash 또는 revision_pin
  last_seen_external_revision       # mirror 갱신 시점의 외부 객체 etag / updated_at
  last_synced_at                    # ISO-8601(UTC)
  last_sync_attempt_at              # 실패 포함, 가장 최근 시도 시각
  last_sync_error                   # 실패 시 분류 (선택)
}
```

### 5.1 `sync_status` enum

| 값 | 의미 |
|---|---|
| `synced` | 마지막 sync 시점에 내부 ↔ 외부 revision 일치 |
| `dirty` | 내부 변경이 발생했고 mirror push 가 필요 |
| `conflict` | 외부 변경이 감지되어 사람의 결정이 필요 (인바운드 변경은 §6 의 signal 변환만 허용) |
| `orphan` | 외부 surface 가 사라짐 (Issue 삭제 등). 내부 객체는 보존되며 사람 escalation 필요 |

`sync_status=conflict` 는 RGC-CROSS-SLOT-STALE 과 다르다 — cross-slot stale 은 내부 객체 간 stale 이고, conflict 는 외부 mirror 와 내부 사이의 불일치다.

## 6. 동기화 방향과 inbound 정책

- **방향**: 내부 객체 = authoritative. `external_refs[]` 는 mirror.
- **outbound (내부 → 외부)**: SOC operation 이 dispatch 한 caller_dispatch 에서만 일어난다. write 시퀀스는 [`github-side-effect-timeline.md`](github-side-effect-timeline.md) 가 단일 권위.
- **inbound (외부 → 내부)**: 외부 surface 의 변경은 *내부 state 를 직접 변경하지 않는다*.
  - GitHub Issue comment (REST `/issues/{n}/comments`, GraphQL node_id prefix `IC_`) 의 strict line-prefix command 만이 [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS) envelope 로 변환되어 사람 governance signal 의 입력으로 인정된다. PR inline review comment (`PRRC_`) / PR review native (`PRR_`) / lifecycle 이벤트 (close/reopen/label/milestone state edit/draft toggle 등) 는 신호로 승격되지 않는다.
  - 비-신호 lifecycle 이벤트는 `drift_observer` 가 대응 `external_refs[].sync_status` 를 `conflict` 로 전이하고 ledger 에 `action_kind=external_observation` row 를 기록한다. 회복은 §7 의 `conflict` 회복 정책 (사람 governance signal) 으로 일원화한다 — 자동 reopen / state mutate 없음.
  - signal envelope 변환과 dispatch 는 [`사람·GitHub 경계 spec`](../superpowers/specs/2026-05-06-human-github-boundary-contract-design.md) 의 `human_signal_drain` / `signal_dispatch` 컴포넌트가 수행한다. envelope 검증을 통과한 `approve` / `reject` 는 [`RGC-HUMAN-CONTRIBUTION`](../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION) 의 contribution 으로 enveloping 되어 dialogue_coordinator 가 평가한다.

> outbound (review_verdict → PR review/comment, SliceMerge state → label/marker) 와 inbound (IC_ 단일 채널) 의 통합 정리는 [`worktree-pr-lifecycle.md`](worktree-pr-lifecycle.md) §5.

## 7. 회복 정책

| sync_status | 회복 절차 |
|---|---|
| `synced` | 무동작 |
| `dirty` | 다음 caller_dispatch 가 mirror push 를 시도. 실패 시 RGC-FAILURE 의 partial-fail rollback. 한도 초과 시 `conflict` 또는 `orphan` 으로 격하 |
| `conflict` | 사람 governance signal 요구. signal 도착까지 mirror push 보류 |
| `orphan` | 즉시 사람 escalation. 내부 객체는 보존되며 새 mirror 를 만들지 결정해야 함 |

## 8. 사용 가이드

- 신규 외부 시스템 (예: GitLab) 추가 시 본 문서에 §provider="gitlab" 절을 추가하고 매핑표를 작성한다. contract 본문은 변경하지 않는다.
- 새 객체 (예: 신규 contribution kind) 가 외부 mirror 를 가질 가능성이 있으면 본 §1 표에 행을 추가하기 전에 [`SOC-OBJECTS`](../contracts/state-and-operation-contract.md#SOC-OBJECTS) 의 추상 슬롯이 충분한지 검토한다.
- 본 문서의 매핑 변경은 [`github-side-effect-timeline.md`](github-side-effect-timeline.md) 의 write 순서와 정합해야 한다. 두 문서가 어긋나면 timeline 이 우선한다 (timeline = side-effect 의 단일 권위).
