# 사람·GitHub 경계 contract — 단일 comment-command protocol

- **Date**: 2026-05-06
- **Status**: Draft
- **Scope bundle**: 전체 외부 경계 결정 묶음의 첫 번째 spec. 본 spec 은 사람·GitHub 표면 결정만 다루고, "Phase 간 Issue body 정보 전이"(항목 1·4) 는 후속 별도 spec 에서 다룬다.

## 1. Goal

3-loop nested model 의 외부 경계 — 사람과 GitHub 표면 — 에서 다음 4개 미결정을 단일 protocol 로 닫는다.

| 항목 | 결정 |
|---|---|
| A. Human approval channel | comment command (strict line-prefix), 단일 채널 |
| B. RGC-SIGNALS 11종 입력 protocol | 동일 comment command + surface routing, lifecycle 은 drift detector |
| C. Profile → model 매핑 | 기존 TCC `agent_profiles.<id>.model` 전역 매핑 그대로. per-step override 비도입 |
| D. SliceMerge 재진입 시 review 입력 | 새 review session manifest 에 advisory `prior_review_context` 동봉 |

## 2. Non-Goals

- Per-step model override (별도 후속 spec)
- Review continuity 의 강한 carry-over (advisory 이상 강화 안 함)
- GitHub Discussions / 외부 form / CLI 등 대체 채널 도입
- Phase 간 Issue body / Spec CP 갱신 책임 (다음 spec)
- Webhook 인프라 자체 (poll vs webhook 선택은 운영 결정)
- legacy `phase_policies.*` 호환 (이미 폐기됨, 본 spec 의 결정과 무관)

## 3. Background

### 3.1 현재 결정된 것 (출처)

- `human` AgentProfile 의 변환 path: signal envelope → `application/human_signal.sh` drain → `human_approval` contribution (`docs/architecture/agents/profiles/human.md`)
- RGC-SIGNALS 11종 카탈로그: `approve`, `reject`, `request_rework`, `request_recover`, `pause`, `resume`, `amendment_approve`, `cross_milestone_amendment`, `acceptance_test_rename`, `purge_acceptance_tests`, `stop` (`docs/contracts/reliability-and-gate-contract.md#RGC-SIGNALS`)
- TCC-AGENT-PROFILES: `agent_profiles.<id>.{runner, model, capabilities}` 단일 권위 (`docs/contracts/target-config-contract.md#TCC-AGENT-PROFILES`)
- TCC-LOOP-POLICIES: `loop_policies.<loop>.<step>.{lead, participants, required_participants, session_termination, ...}` (`docs/contracts/target-config-contract.md#TCC-LOOP-POLICIES`)
- SliceMerge 단계의 `SM_REQUEST_CHANGES → SM_CLOSED` (terminal) → 새 SliceMerge 가 새 review session 으로 시작 (`docs/contracts/state-and-operation-contract.md` SliceMerge Flow §6)
- Milestone CP / Spec CP 는 GitHub Milestone description 의 콘텐츠 누적 단위 (`docs/architecture/external-tracking-mapping.md §1`)
- inbound 정책: 외부 surface 변경은 내부 state 직접 변경 금지, signal 변환만 (`docs/architecture/external-tracking-mapping.md §6`)

### 3.2 본 spec 이 닫는 빈 자리

- `human.md` 가 "GitHub label, comment, 또는 별도 form" 셋 중 하나로 열어둔 채널 선택
- GitHub Milestone 에 native comment thread 가 없는데 outer Discovery / Specification 에서 사람 승인을 어디서 받을지
- 11종 signal 의 입력 surface 와 `signal_id` 산출 규칙
- 사람이 GitHub 에서 Issue 를 manual close / label 수정 시의 처리
- comment author 의 권위 검증 메커니즘
- request_changes 후 새 SliceMerge 의 review 가 이전 review 의 finding 을 어떻게 다룰지

## 4. Decisions

### 4.1 Human approval channel (A)

- **채널**: GitHub Issue 코멘트 (PR 의 Conversation 탭 코멘트 포함) 단일. label / external form 채택 안 함.
  - **GitHub comment 종류 한정**: Issue comment (REST `/issues/{n}/comments`, node_id prefix `IC_`) 만 signal source. PR inline review comment (`PRRC_`) 와 PR review native (`PRR_`, "Approve" 버튼) 는 signal 로 인정하지 않으며 drift_observer 가 lifecycle 로 관찰 (§4.5).
- **Grammar**: 코멘트 첫 줄이 정확히 `<prefix><verb>(\s+<verb-args>)?(\s+<rationale-tail>)?` 패턴. `<prefix>` 는 `target.governance.signal_command_prefix` (default `/`).
- **Verb-args** (verb 별 고정 위치 인자):
  - `at-rename <old> <new>` — 두 토큰 (whitespace-split). 그 뒤 토큰부터 rationale tail
  - 그 외 verb — verb-args 없음. 첫 줄의 verb 뒤 모든 텍스트는 rationale tail
  - **알려진 한계**: whitespace 가 포함된 acceptance test 이름은 단일 토큰으로 표현 불가. v1 은 운영 컨벤션(공백 없는 ID 사용)에 의존하고, 후속 spec 에서 quoting (`"<old>" "<new>"`) 도입 여부 결정.
- **Rationale**: 첫 줄 rationale tail + 다음 줄 이하 본문 전체. 둘 다 비어 있으면 `rationale = ""`.
- **첫 줄 패턴 미일치**: drain 무시 (no-op), ledger 기록 없음. signal 로 인정되지 않음.
- **outer phase surface**: GitHub Milestone 자체에는 comment thread 가 없으므로 **Milestone Tracker Issue** 1개를 milestone 당 별도 생성하여 outer Discovery / Specification 의 human approval 을 받는다 (§4.2 참조).
- **Pin binding (`awaiting` block)**: 모든 signal-receiving surface 의 Issue body 에는 Caller 가 유지하는 machine block `awaiting:` 가 존재한다. Caller 는 대상 객체가 새로 사람 승인을 기다리게 될 때마다 (예: M_DISCOVERY_AWAITING_HUMAN 진입) 이 block 을 갱신한다.

  ```yaml
  awaiting:
    target_kind: milestone | slice | slice_merge | dialogue_session | change_proposal | system | contract | null
    target_id: <string|null>
    target_revision_pin: <string|null>
    related_object_id: <string|null>
    related_object_revision_pin: <string|null>
    session_id: <string|null>
    turn_index: <int|null>
    posted_at: <iso8601>
    expected_verbs: [<verb>, ...]
  ```

  drain 은 코멘트 처리 시 같은 surface 의 `awaiting` block 을 읽어 envelope 의 pin / session 슬롯을 채운다. signal_dispatch 가 RGC-SIGNALS 의 `target_revision_pin` 검증을 수행하므로 사람이 다른 revision 을 보고 작성한 코멘트는 자동으로 `result=stale` 로 reject 된다.

### 4.2 새 GitHub surface 와 routing (B)

| Surface | 생성 시점 | 종료 시점 | target_kind |
|---|---|---|---|
| Slice PR | inner CONVERGED → SliceMerge SM_DRAFT 진입 (기존) | SM_MERGED 또는 SM_CLOSED | `slice_merge` (코멘트 시 review session 추론) |
| Slice Issue | outer Planning 단계 (기존) | SLICE_VALIDATED → close | `slice` |
| **Milestone Tracker Issue** (신규) | outer Discovery 진입 시점 with milestone | M_DONE 또는 milestone 폐기 | `milestone` (Spec CP 도 동일 surface) |
| **Control Issue** (신규, repo 1개) | repo 부트스트랩 1회 | terminal 없음 (pinned 권장) | `system` |
| **Contract Change Issue** (신규, repo 1개) | repo 부트스트랩 1회 | terminal 없음 | `{contract, change_proposal}` 집합 — verb 가 결정 |

**Surface 식별 방법**:

| Surface | 식별자 |
|---|---|
| Slice PR | `external_refs[]` 의 `pr_number` ↔ `slice_merge.id` lookup |
| Slice Issue | `external_refs[]` 의 `issue_number` ↔ `slice.id` lookup. body machine block 의 `kind: slice` |
| Milestone Tracker Issue | label `kind/milestone-tracker` + body machine block `kind: milestone_tracker, milestone_id: <id>`. Caller 가 생성 시 두 mark 동시 부여 |
| Control Issue | TCC `target.governance.control_issue_number` 와 일치 |
| Contract Change Issue | TCC `target.governance.contract_change_issue_number` 와 일치 |

**Routing 규칙**: drain 이 `(comment.surface_kind, comment.surface_id, verb)` → `(target_kind, target_id)` 변환표로 라우팅 — surface 가 target_kind 의 *허용 집합* 만 좁히고, verb 가 그 안에서 결정한다. 대부분의 surface 는 단일 target_kind 만 허용 (Contract Change Issue 만 verb-discriminated). invalid 조합 (예: Slice PR 에 `/pause`, Contract Change Issue 에 `/approve`) 은 `result=invalid, result_detail=incompatible_target_kind` ledger row + 동일 surface 에 echo 코멘트 (Caller `it_comment_create`).

전체 surface × verb 호환 매트릭스는 부록 §13 에 명시.

**Verb ↔ signal_type 매핑**:

| Verb | signal_type |
|---|---|
| `approve` | `approve` |
| `reject` | `reject` |
| `recover` | `request_recover` |
| `rework` | `request_rework` |
| `pause` | `pause` |
| `resume` | `resume` |
| `stop` | `stop` |
| `amendment-approve` | `amendment_approve` |
| `amend-cross` | `cross_milestone_amendment` |
| `at-rename <old> <new>` | `acceptance_test_rename` |
| `at-purge` | `purge_acceptance_tests` |

### 4.3 Idempotency (A)

- `signal_id = comment.node_id` (GitHub GraphQL node_id, REST `id` 와 1:1. comment 종류별 prefix 로 type 구분 — `IC_` 만 signal 자격, 그 외는 drain 에서 reject)
- **Lock-at-drain**: 최초 drain 시점에 envelope 영구 고정. 이후 코멘트 수정·삭제는 무시 (no-op, no ledger row)
- **Pre-drain edit 거부**: 코멘트가 drain 전에 수정된 흔적 (`comment.created_at != comment.updated_at`) 이 있으면 `result=invalid, result_detail=parse_error_pre_drain_edit` 로 reject. lock-at-drain 결정의 폐쇄성을 폴링/웹훅 race 에서도 보존.
- 결정 변경 의사는 **새 코멘트** 로 표현해야 한다. 운영 안내문은 각 Tracker Issue 본문 상단에 고정 (Caller 가 Issue 생성 시 자동 삽입)
- 같은 `signal_id` 의 envelope 이 영속 큐에 이미 enqueued 면 추가 enqueue 는 `result=duplicate` (dedup)
- **모든 reject reason** 표준 enum: `parse_error_unknown_verb`, `parse_error_pre_drain_edit`, `unauthorized_author`, `incompatible_target_kind`, `stale_revision_pin`, `awaiting_block_missing` (§7 참조)

### 4.4 Authority (A)

- 권위 검증: `comment.author.login` ∈ GitHub Team membership (`target.governance.human_team`)
- **단일 team 만 (v1)**: `human_team` 은 단일 슬러그. 다중 team 지원은 미도입 (필요 시 후속 spec)
- **Cache TTL**: GitHub Teams API 응답 캐시는 `target.governance.human_team_cache_ttl_seconds` 키로 설정 (default 300). RGC-LEASE-KINDS 의 lease TTL 과는 별개의 캐시 정책. 명시적 키 도입.
- **Fail-closed**: 캐시 만료 + GitHub Teams API 실패 시 drain 은 envelope 를 buffering (큐에 enqueue 하지 않음) 하고 backoff 재시도 (`max_retries=5`, exponential). 한도 초과 시 운영 알림 (notification) + 코멘트는 미처리 상태로 유지. 멤버십 불확실 상태에서 처리 진행 안 함.
- 비-멤버 코멘트: drain 처리 + `result=invalid, result_detail=unauthorized_author` ledger row. 동일 surface 에 echo 코멘트는 **작성하지 않음** (사칭 시도 노출 방지).
- **선택적 운영 알림**: `target.governance.unauthorized_author_alert: true` (default false) 시, 비-멤버이지만 repo collaborator 인 author 의 1차 시도에 대해 비공개 운영 알림 채널 (예: Slack, RGC-NOTIFICATION) 송신. 합법 운영자 misconfiguration 회복용. 공개 surface 에는 노출하지 않음.
- **추가 검증**: signal envelope 의 `target_revision_pin` 과 `related_object_revision_pin` 은 기존 RGC-SIGNALS 검증 그대로 적용. mismatch 시 `result=stale, result_detail=stale_revision_pin`. envelope 의 `awaiting` block 자체가 비어 있는 경우 (Caller 가 awaiting 상태가 아닌 surface 에 사람이 코멘트) `result=invalid, result_detail=awaiting_block_missing`

### 4.5 Drift detector (B)

- GitHub lifecycle 이벤트 (Issue close/reopen, label add/remove, milestone state edit, PR draft toggle, PR review native UI 의 approve/request_changes 등) 를 `drift_observer` 가 관찰
- **신호로 승격하지 않음**. 즉 사람이 Issue 를 manual close 해도 internal state 는 변하지 않으며 자동 reopen 도 하지 않는다
- 처리:
  1. `external_refs[]` 의 `sync_status` 를 `conflict` 로 전이 (`docs/architecture/external-tracking-mapping.md §5.1`). 이로써 outbound mirror push 는 사람 governance signal 도착까지 보류된다 (§7 회복 정책 재사용).
  2. ledger row 기록: `action_kind=external_observation, result=noop, result_detail=external_drift_<kind>` (§6.7 의 schema 확장 참조). 본 row 는 transition 이 아닌 외부 이벤트 관찰. `from_state=to_state` 로 동일.
  3. 즉시 echo 코멘트 1회 — drift 가 발생한 surface 에 Caller 가 안내 코멘트 작성:
     ```
     ⚠ External change detected (kind=<drift_kind>) but internal state did not change.
     Internal authoritative state: <state>.
     If you intended to recover/stop, post `/recover` or `/stop` as a new comment.
     ```
     동일 surface 에 같은 drift_kind 의 echo 가 이미 존재하면 dedup (단일 surface 에서 같은 종류 drift 가 반복돼도 echo 1회).
  4. 다음 outer Validation 의 Sentinel session input `findings` 슬롯에 추가
- 사람의 진짜 의도가 회수·중단이면 명시적으로 `/recover` 또는 `/stop` 코멘트 명령을 작성해야 한다. 정상 signal 도착 시 `sync_status` 를 `synced` 로 회복.
- **`external-tracking-mapping.md §6` 의 기존 문구 갱신 필요**: "Issue close → `request_recover` 또는 `cross_milestone_amendment`" 매핑은 폐기. drift detector 로 대체.

### 4.6 Profile → model 매핑 (C)

- 본 spec 은 신규 정의를 추가하지 않는다. 기존 `agent_profiles.<id>.model` 단일 권위로 충분.
- per-step override 가 필요해지면 별도 후속 spec 에서 `loop_policies.<loop>.<step>.model_overrides.<profile_id>` 추가. 본 spec 의 결정 영역 아님.

### 4.7 SliceMerge 재진입 시 review 입력 (D)

- 새 SliceMerge 의 middle review session 입력 manifest 에 advisory slot `prior_review_context` 추가:
  ```yaml
  prior_review_context:
    prior_slice_merge_id: <id>
    final_verdict_summary: <string>
    key_findings:
      - kind: review_finding
        path: <file>
        line: <int|null>
        summary: <string>
  ```
- **Advisory only**: contribution chain 에 영향 없음. reviewer 는 새 코드 기준 독립 판단. prompt 의 "참고 컨텍스트" 로만 동봉.
- AGC-SESSION-INPUT 에 본 슬롯 정의 추가 (선택적, middle review session 에만).
- 동봉 조건: 동일 Slice 의 직전 SliceMerge 가 `SM_CLOSED` 이고, 종료 사유가 `SM_REQUEST_CHANGES → SM_CLOSED` (request_changes) 인 경우만. 그 외 사유 (`abandon`, `escalate`) 또는 직전 SliceMerge 부재 시 슬롯 omit.

## 5. Architecture

### 5.1 Component diagram

```
[GitHub surfaces]                                  [internal]

Slice PR comment ────────┐
Slice Issue comment ─────┤
Milestone Tracker cmt ───┼──► human_signal_drain ─► signal envelope queue ─► signal_dispatch
Control Issue comment ───┤   (poll/webhook)            (영속, dedup by         │
Contract Change cmt ─────┘   • parse strict cmd        signal_id)              ├─► approve/reject
                             • authority (team)                                │      → human_approval
                             • routing (surface →                              │        contribution
                               target_kind)                                    │        (DialogueSession)
                             • envelope build                                  │
                                                                               └─► governance signals
GitHub lifecycle events ─► drift_observer ─► ledger anomaly row                       → state transition
(close/reopen, label,         (no signal           + sentinel.findings                  (recover, pause, ...)
 milestone state edit,         promotion,           input slot
 draft toggle)                 no auto-heal)
```

### 5.2 Components

#### `human_signal_drain` (구체화)

- Input: GitHub Issue comment 이벤트 stream (poll 또는 webhook 어댑터). PR inline / PR review native 는 입력 대상 아님 (drift_observer 로 라우팅).
- 처리 순서:
  1. comment node_id prefix 가 `IC_` 가 아니면 입력 reject (drift_observer 로 위임)
  2. Comment 본문 첫 줄 정규식 매칭. 미일치 → no-op (ledger 기록 없음)
  3. `comment.created_at != comment.updated_at` → `result=invalid, result_detail=parse_error_pre_drain_edit`
  4. `signal_id=comment.node_id` 가 ledger 에 존재 → `result=duplicate` (dedup)
  5. Author authority 검증 (GitHub Team membership 캐시 조회, fail-closed). 실패 → `result=invalid, result_detail=unauthorized_author`
  6. Surface 식별 (§4.2 Surface 식별 표) → `surface_kind`. 그 surface 의 Issue body 에서 `awaiting:` machine block 파싱. 부재·`null` → `result=invalid, result_detail=awaiting_block_missing`
  7. `(surface_kind, verb)` → 부록 §13 매트릭스로 target_kind 결정. invalid 조합 → `result=invalid, result_detail=incompatible_target_kind` + Caller 에게 echo 코멘트 위임
  8. envelope 구성: `signal_id=comment.node_id, signal_type=<verb>, target_kind, target_id=awaiting.target_id, target_revision_pin=awaiting.target_revision_pin, related_object_id, related_object_revision_pin, rationale, actor=<login>, created_at=<comment.created_at>, source=github_comment, external_ref={comment_node_id, html_url}`
  9. 영속 큐 enqueue + ledger `action_kind=signal_apply, result=applied, result_detail=enqueued_<signal_type>` 기록
- Output: 영속 큐의 envelope, ledger rows

#### `signal_dispatch` (Caller 내부)

- Input: 영속 큐에서 envelope drain
- 처리:
  - `signal_type` ∈ {`approve`, `reject`} → 기존 `human.md` §"Contribution 변환 path" 그대로 — `human_approval` envelope 변환 후 DialogueSession 큐 enqueue
  - 그 외 governance signal → 기존 RGC-SIGNALS 의 effect 표 (line 67-74) 에 따라 state transition 직접 호출
  - revision pin mismatch 시 `action_kind=signal_apply, result=stale, result_detail=stale_revision_pin` ledger 기록 + envelope 폐기 + 동일 surface 에 echo 코멘트 (사용자에게 새 코멘트 요청)

#### `drift_observer`

- Input: GitHub lifecycle 이벤트 stream (Issue comment 외 모두 — Issue close/reopen, label add/remove, milestone state edit, PR draft toggle, PR review native, PR inline review comment, comment 삭제 등)
- 처리:
  1. event payload 분류 → `drift_kind`
  2. 대응되는 `external_refs[]` slot 의 `sync_status` 를 `conflict` 로 전이
  3. ledger 기록: `action_kind=external_observation, result=noop, result_detail=external_drift_<drift_kind>`. transition 의미가 없으므로 `from_state=to_state`, `output_hash=null`
  4. 동일 surface 에 같은 drift_kind 의 echo 코멘트가 미존재면 echo 1회 (Caller `it_comment_create`)
  5. 다음 outer Validation Sentinel session input 의 `findings` 슬롯에 추가
- 비집행: 자동 reopen / state mutate 안 함. internal state 는 인사이드 권위 유지.

### 5.3 데이터 흐름 — approve 시나리오

```
0. (전제) outer Discovery session 이 AWAITING_HUMAN 진입.
   Caller 가 Milestone Tracker Issue body 의 awaiting block 갱신:
     awaiting:
       target_kind: milestone
       target_id: M-42
       target_revision_pin: <rev_a>
       related_object_id: spec_cp_M42_v3
       related_object_revision_pin: <rev_b>
       session_id: ses_outer_disc_M42
       turn_index: 5
       posted_at: 2026-05-06T10:00Z
       expected_verbs: [approve, reject, recover]

1. Reviewer (human-team member) Milestone Tracker Issue 에 코멘트:
   "/approve
    spec scenarios cover edge cases noted in §3."

2. webhook/poll → human_signal_drain
   - node_id prefix=IC_ → OK
   - 첫 줄 매칭 → verb=approve
   - created_at == updated_at → OK
   - dedup (signal_id=comment.node_id 신규) → OK
   - author ∈ team (캐시 hit) → OK
   - surface=milestone_tracker_issue → awaiting block 파싱 → target=(milestone, M-42)
   - (milestone_tracker, approve) → milestone (부록 §13)
   - envelope 구성 (pin = awaiting.target_revision_pin, related_object_id=spec_cp_M42_v3, ...)
   - 큐 enqueue + ledger row (action_kind=signal_apply, result=applied,
       result_detail=enqueued_approve)

3. signal_dispatch
   - target_revision_pin 검증 → 일치 (Caller 가 그 사이 awaiting 을 갱신하지 않았음)
   - signal_type=approve → human.md §"Contribution 변환 path"
   - human_approval contribution envelope 생성 (verdict.result=approve)
   - 대상 DialogueSession (ses_outer_disc_M42) 의 다음 turn 으로 enqueue

4. dialogue_coordinator next cycle
   - finalization rule (quorum_then_lead, loop_policies.outer.Discovery) 평가
   - human_approval 도착 + 다른 reviewer quorum 충족 → CONVERGED
   - milestone state 전이 (예: M_DISCOVERY_AWAITING_HUMAN → M_SPECIFICATION_DRAFT)
   - Caller 가 Tracker Issue 의 awaiting block 을 다음 phase 용으로 갱신
```

> **Stale 시나리오**: 사람이 코멘트 작성과 drain 사이에 Caller 가 awaiting 을 갱신하면 (예: timeout 으로 재오픈) `target_revision_pin` 불일치 → `result=stale`, echo 코멘트로 사용자에게 새 코멘트 요청. 사람이 이전 revision 을 보고 작성한 결정이 새 revision 을 압도하지 않음.

### 5.4 데이터 흐름 — drift 시나리오

```
1. 사람이 GitHub UI 에서 Slice Issue #123 manual close

2. webhook/poll → drift_observer
   - lifecycle event: issue.closed
   - internal lookup: Slice S-7 → SLICE_BUILDING (open 이어야 함)
   - drift 검출 → external_refs[Slice S-7].sync_status = conflict
     ledger row: action_kind=external_observation, result=noop,
                 result_detail=external_drift_issue_close
     (target=slice/S-7, github_event_id=...)
   - 동일 surface 에 echo 코멘트 1회 ("Internal state is SLICE_BUILDING. Use /recover ...")
   - 다음 outer Validation Sentinel input.findings 에 추가

3. internal state 변경 없음. GitHub 자동 reopen 없음.
   sync_status=conflict 인 동안 outbound mirror push 보류.

4. 사람이 의도적으로 회수하려면 별도로 Slice Issue 에 "/recover" 코멘트 작성 필요
   → 정규 signal path (4.1~4.5) 진입.
   signal_dispatch 가 회수 transition 집행 후 sync_status 를 synced 로 회복.
```

## 6. Contract / 문서 변경

### 6.1 TCC additions (`docs/contracts/target-config-contract.md`)

```yaml
target.governance:
  human_team: <github_team_slug>                  # 필수. 단일 team. 예: "myorg/approvers"
  control_issue_number: <int>                     # 필수. system signal surface
  contract_change_issue_number: <int>             # 필수. {contract, change_proposal} 집합 surface
  signal_command_prefix: "/"                      # 선택. default "/"
  human_team_cache_ttl_seconds: 300               # 선택. default 300. drain 의 Teams API 캐시 TTL
  unauthorized_author_alert: false                # 선택. default false. 비-멤버 collaborator 1차 시도 시 비공개 운영 알림
```

### 6.2 AGC-SESSION-INPUT 보강 (`docs/contracts/agent-and-context-contract.md`)

middle review session 에 한해 advisory slot 정의:

```yaml
prior_review_context:                      # optional, advisory only
  prior_slice_merge_id: <string>
  final_verdict_summary: <string>
  key_findings:
    - { kind: review_finding, path, line, summary }
```

contribution chain 과 무관. SliceMerge 가 `SM_CLOSED` (request_changes 사유) 직후의 새 SliceMerge review 만 동봉.

### 6.3 RGC-SIGNALS 보강 (`docs/contracts/reliability-and-gate-contract.md#RGC-SIGNALS`)

- envelope 의 `source` 필드 표준값에 `github_comment` 추가
- envelope 의 `external_ref` 표준값에 `{comment_node_id, html_url}` 명시
- `signal_id` 산출 규칙: GitHub comment 출처일 때 `comment.node_id` (REST `id` 의 GraphQL 등가, 영속·전역 유일)
- pin / session 슬롯의 출처 명시: GitHub comment 출처 envelope 은 동일 surface 의 Issue body `awaiting:` machine block 에서 pin / session_id / related_object_id 를 채운다 (§4.1, §4.5 참조)

### 6.4 `human.md` 갱신

- "GitHub label, comment, 또는 별도 form" 문구 → "GitHub comment command (§본 spec)" 단일 명시
- §"Contribution 변환 path" 의 절차 1 ("`application/human_signal.sh` drain") 은 본 spec 의 `human_signal_drain` 으로 매핑. 절차 2~5 는 변경 없음.

### 6.5 `external-tracking-mapping.md` 갱신

- §6 의 "Issue close → `request_recover` 또는 `cross_milestone_amendment` signal" 폐기. 대체 문구: "GitHub lifecycle 이벤트는 신호로 승격되지 않는다. `drift_observer` 가 `external_refs[].sync_status` 를 `conflict` 로 전이하고 ledger 에 `action_kind=external_observation` row 를 기록한다. 회복은 §7 의 conflict 회복 정책 (사람 governance signal) 으로 일원화한다. 사람의 회수·중단 의사는 §본 spec 의 comment command 로 명시해야 한다."
- §1 (provider="github" 객체 매핑 표) 에 신규 row 추가: `MilestoneTracker → GitHub Issue (kind: milestone_tracker)`, `Control → GitHub Issue (kind: control)`, `ContractChange → GitHub Issue (kind: contract_change)`. `external_refs[].kind` enum 에 동일 3종 추가.
- §1 의 표는 Milestone CP / Spec CP 가 GitHub Milestone description 에 누적된다는 기존 진술 유지. 본 spec 은 *승인 표면* 만 Tracker Issue 로 분리.

### 6.6 `github-side-effect-timeline.md` 갱신

- outer Discovery 진입 시 `it_milestone_create()` 와 함께 `it_issue_create(kind=milestone_tracker)` 호출 추가
- M_DONE 도달 시 milestone tracker Issue close 단계 추가
- repo 부트스트랩 단계에 Control Issue / Contract Change Issue 1회 생성 명시

### 6.7 RGC-LEDGER 매핑

본 spec 은 새 ledger row "kind" 를 도입하지 않는다. 기존 RGC-LEDGER 의 `action_kind` + `result` + `result_detail` 슬롯에 매핑한다.

| 사례 | action_kind | result | result_detail |
|---|---|---|---|
| drain 이 envelope 큐에 enqueue 성공 | `signal_apply` (기존) | `applied` | `enqueued_<signal_type>` |
| drain dedup 히트 | `signal_apply` | `duplicate` | `signal_id_duplicate` |
| parse 미일치 (verb 불명) | `signal_apply` | `invalid` | `parse_error_unknown_verb` |
| pre-drain edit 감지 | `signal_apply` | `invalid` | `parse_error_pre_drain_edit` |
| 비-멤버 author | `signal_apply` | `invalid` | `unauthorized_author` |
| awaiting 부재 | `signal_apply` | `invalid` | `awaiting_block_missing` |
| 부적합 target_kind | `signal_apply` | `invalid` | `incompatible_target_kind` |
| revision_pin mismatch | `signal_apply` | `stale` | `stale_revision_pin` |
| signal_dispatch 정상 집행 | `signal_apply` (기존) | `applied` | `dispatched_<signal_type>` |
| drift 관찰 (transition 무관) | **`external_observation` (신규)** | `noop` | `external_drift_<drift_kind>` |

**RGC-LEDGER schema 확장 (additive)**: `action_kind` enum 에 `external_observation` 추가. transition 이 아닌 외부 이벤트 관찰의 ledger 표현. `from_state=to_state` 동일, `output_hash=null`, `manifest_id=null` 가능. legacy reader 와 union read 호환.

**parse 첫 줄 미일치 (일반 토론 코멘트)**: ledger 기록 없음 (drain 이 진입 자체를 안 함). 위 `parse_error_unknown_verb` 와 구별 — 후자는 `<prefix>` 는 일치하나 verb 가 미등록인 경우.

## 7. Error Handling

| 경우 | 처리 | ledger |
|---|---|---|
| Comment 첫 줄 패턴 미일치 (prefix 도 미일치) | drain 무시 | 기록 없음 |
| node_id prefix 가 `IC_` 아님 (PR review native, inline comment 등) | drift_observer 로 위임 | `external_observation/noop/external_drift_<kind>` |
| Verb 알 수 없음 (`/foo`) | drain reject + 동일 surface echo 코멘트 | `signal_apply/invalid/parse_error_unknown_verb` |
| Pre-drain 코멘트 수정 (`created_at != updated_at`) | drain reject + echo 코멘트 ("새 코멘트로 다시 작성") | `signal_apply/invalid/parse_error_pre_drain_edit` |
| Author 비-멤버 | drain reject. 공개 echo 없음. `unauthorized_author_alert=true` 시 비공개 운영 알림 | `signal_apply/invalid/unauthorized_author` |
| awaiting block 부재 (Caller 가 awaiting 상태 아님) | drain reject + echo 코멘트 ("현재 사람 결정 대기 상태가 아님") | `signal_apply/invalid/awaiting_block_missing` |
| Surface ↔ verb 부적합 | drain reject + echo 코멘트 | `signal_apply/invalid/incompatible_target_kind` |
| `target_revision_pin` 또는 `related_object_revision_pin` mismatch | dispatch reject + echo 코멘트 ("revision 변경됨, 새 코멘트로 다시 작성") | `signal_apply/stale/stale_revision_pin` |
| `signal_id` 중복 enqueue 시도 | drain dedup | `signal_apply/duplicate/signal_id_duplicate` |
| 코멘트 사후 수정 / 삭제 | drift_observer 로 위임 (lock-at-drain) | `external_observation/noop/external_drift_comment_<edit\|delete>` |
| GitHub Team API 일시 실패 (캐시 hit) | 캐시값으로 진행 | (정상 처리에 따름) |
| GitHub Team API 일시 실패 (캐시 miss) | drain 보류, backoff 재시도. envelope 큐 entry 안 만듦 | 기록 없음 (재시도 한도 초과 시 RGC-NOTIFICATION 운영 알림) |
| Webhook / poll 어댑터 장애 | 본 spec 영역 아님 (인프라 healthcheck) | — |
| 직전 SliceMerge 없거나 `SM_REQUEST_CHANGES` 사유 아님 | `prior_review_context` 슬롯 omit | — |

## 8. Testing

### 8.1 Unit

- `human_signal_drain` parse:
  - 정상 verb 11종 각각 + rationale 패턴 (없음 / 같은 줄 / 다음 줄 / 멀티라인)
  - 첫 줄 미일치 (일반 토론 코멘트) → no-op
  - prefix override (`signal_command_prefix=":"`) 정상 동작
  - `at-rename a b extra rationale` 토큰 분해 검증
  - `at-rename a` (인자 부족) → `parse_error_unknown_verb` 처리
  - PR inline review comment 입력 (`PRRC_` prefix) → drift_observer 로 라우팅
  - PR review native (`PRR_` prefix) → drift_observer 로 라우팅
- `human_signal_drain` authority:
  - team member → accepted
  - 비-member → `unauthorized_author`. `unauthorized_author_alert=true` 시 비공개 알림 1회
  - 캐시 hit 인 경우 API 호출 없음
  - 캐시 miss + API 일시 실패 → 보류 (재시도 카운터)
  - 캐시 miss + 재시도 한도 초과 → RGC-NOTIFICATION 송신
- `human_signal_drain` pin binding:
  - awaiting block 정상 → envelope pin 채워짐
  - awaiting block 부재 → `awaiting_block_missing`
  - awaiting block 의 expected_verbs 와 verb 불일치 시 처리 정책 (현 spec: 무시, 다른 검사로 흡수)
  - pre-drain edit (`updated_at > created_at`) → `parse_error_pre_drain_edit`
- `human_signal_drain` routing (부록 §13 매트릭스 기반):
  - 5개 surface × 11 verb 매트릭스에서 valid / invalid 분류 회귀
  - Contract Change Issue 의 verb-discriminated 라우팅 (amendment_approve → change_proposal)
  - `incompatible_target_kind` 발생 케이스 + echo 코멘트 검증
- `signal_dispatch` 분기:
  - approve → human_approval contribution 변환
  - 그 외 governance signal → state transition 호출
  - revision_pin mismatch → `stale/stale_revision_pin` + echo
- `drift_observer`:
  - 5종 lifecycle event × internal state 일치/불일치 케이스
  - drift 발생 시 sync_status=conflict 전이 + ledger external_observation row + 동일 surface 에 echo 1회
  - 동일 drift_kind 의 echo dedup
- `prior_review_context` slot 동봉 결정:
  - 직전 SliceMerge `SM_CLOSED` (request_changes 사유) → slot 동봉
  - 직전 SliceMerge `SM_CLOSED` (abandon 사유) → slot omit (negative)
  - 직전 SliceMerge `SM_CLOSED` (escalate 사유) → slot omit (negative)
  - 직전 SliceMerge 부재 → slot omit (negative)
  - SliceMerge 가 SM_STALE → SLICE_BLOCKED 후 회복 → slot omit (negative; request_changes 사유 아님)

### 8.2 Integration (smoke)

- outer Discovery 진입 → Caller 가 Milestone Tracker Issue 자동 생성 + awaiting block 갱신 → 사람 `/approve` → drain → dispatch → human_approval contribution → CONVERGED → milestone state 전이. awaiting block 이 다음 phase 용으로 갱신 (E2E)
- 사람이 awaiting 상태 아닌 Tracker Issue 에 `/approve` 작성 → `awaiting_block_missing` echo
- 사람이 코멘트 작성 후 dispatch 전 Caller 가 awaiting 갱신 → `stale_revision_pin` echo
- middle review request_changes → SM_CLOSED → 새 SliceMerge → 새 review session input 에 `prior_review_context` 동봉 검증
- 사람 manual Issue close → drift_observer + sync_status=conflict + 자동 echo. 추후 outbound mirror push 시도 → `conflict` 로 보류 검증. 사람 `/recover` 코멘트 → 정상 처리 후 `sync_status=synced` 회복
- `signal_id` 중복 enqueue 시도 → 1회만 dispatch (`duplicate`)

### 8.3 Property / fuzz

- comment 본문 fuzz (Unicode, 이모지, 멀티라인, CRLF, BOM 변형) 입력 → drain 이 crash 없이 첫 줄 매칭 결과만 산출
- 동일 envelope 의 N회 redispatch 가 idempotent (state transition 1회만 발생)
- 동시성: 같은 comment 를 동시 webhook + poll 양쪽이 처리 시도 → idempotency_key + signal_id dedup 으로 1회만 진행

## 9. Migration / Rollout

1. TCC schema 추가 (§6.1 의 6개 키) — additive
2. RGC-LEDGER `action_kind` enum 에 `external_observation` 추가 — additive (legacy reader union read 호환)
3. AGC-SESSION-INPUT `prior_review_context` 슬롯 추가 — optional, additive
4. `external_refs[].kind` enum 에 `milestone_tracker`, `control`, `contract_change` 추가 — additive
5. RGC-SIGNALS envelope 의 `source` / `external_ref` 표준값 명시 — additive
6. `external-tracking-mapping.md §6` 의 "Issue close → request_recover" 문구 폐기 + drift detector + sync_status=conflict 문구로 대체 — **breaking** (의미 변경)
7. `human.md` 채널 후보 3종 → 단일 channel 명시 — **breaking** (단일 권위)
8. `github-side-effect-timeline.md` outer Discovery 진입 step 에 Milestone Tracker Issue 생성 + awaiting block 갱신 추가, repo 부트스트랩에 Control Issue / Contract Change Issue 1회 생성 추가 — **breaking** (기존 timeline 보강)
9. 신규 component (`human_signal_drain`, `signal_dispatch`, `drift_observer`) 구현은 후속 implementation plan 에서 분해

**Breaking 의 운영 가정 (위험)**: 본 spec 의 6/7/8 항목은 현재 운영 인스턴스가 없다는 가정 하에 backward-compat window 없이 즉시 전환한다. 만약 운영 인스턴스가 도입된 뒤 본 spec 이 반영되면, 다음을 별도 마이그레이션 spec 으로 다뤄야 한다:
- 기존에 inbound Issue close 로 변환된 envelope 큐 entry 의 처리
- 사람이 익숙해진 "Issue close = recover" 컨벤션의 운영 안내 (Tracker Issue body / repo README)
- 기존 milestone 의 Tracker Issue 일괄 backfill

## 10. Open / 후속 spec 으로 분리

- **Phase 간 Issue body 갱신 책임** (항목 1) + **Outer-loop Spec CP 영속 위치** (항목 4) — 다음 brainstorming 묶음
- Per-step model override (`loop_policies.<loop>.<step>.model_overrides.<profile_id>`)
- Review continuity 의 강한 carry-over (advisory 이상)
- Webhook vs polling 인프라 결정
- 사람에게 보내는 echo 코멘트의 본문 표준 템플릿 (다국어, 안내문 톤)

## 11. Open / Future Considerations

리뷰 단계에서 도출된 후속 결정 사항:

- **Quoting grammar** (`at-rename "<old with space>" "<new>"`) 도입 여부 — v1 은 공백 없는 ID 컨벤션
- **Multi-team approver** (`human_team` list 형식) — 큰 조직 도입 시 후속
- **Awaiting block 의 expected_verbs 와 verb 불일치 정책** — 현재 spec 은 무시 (다른 검사로 흡수). 명시 reject 로 강화할지
- **Drift echo 의 본문 표준 템플릿 다국어화** — 현재 영어 1종

## 12. Decision Log

| ID | 결정 | 대안 | 채택 이유 |
|---|---|---|---|
| A.1 | Comment command 단일 채널 | label / PR review native / external form / 하이브리드 | outer Milestone 에도 적용되려면 PR review native 불가; rationale 보존을 위해 label 부족; 단일 drain 으로 단순화 |
| A.2 | Milestone Tracker Issue (1 per milestone) | Phase-transient Issue / Description block / Discussions | comment thread 가 필요 + 영구 audit + 기존 `it_issue_*` port 재사용 |
| A.3 | Strict line-prefix grammar | trailer-style / quoted args / two-channel | 파서 단순, GitHub Slash Command 컨벤션 |
| A.4 | Lock-at-drain (`signal_id=comment.id`) | last-edit-wins / pre-drain edit allowed | Inv #5 의 권위 절대성과 정합, audit 영구 보존 |
| A.5 | GitHub Team membership | username allowlist / repo role / 하이브리드 | 회사 SSO 정렬 + 회전 운영성 |
| B.1 | 단일 protocol + drift detector | 이중 (코멘트 + lifecycle) / CLI 혼합 | drain·authority·ledger 1세트, 우발적 close 부작용 차단 |
| B.2 | Surface-by-comment-location routing | surface-agnostic + 명시 인자 / 하이브리드 | 사용자 부담 최소, audit 자연스러움 |
| B.3 | Anomaly + Sentinel finding (no auto-heal) | auto-heal / 하이브리드 | internal state authoritative 정합, write 경로 1개 유지 |
| C.1 | 글로벌 매핑만 | per-step override / capability routing | TCC 가 이미 닫혀 있음, YAGNI |
| D.1 | Advisory `prior_review_context` | full reset / hard carry-over | 학습 효과 + 권위 분리 |

## 13. Appendix — Surface × Verb 호환 매트릭스

`✓` = 허용. `→<kind>` = 허용 + 결과 target_kind. `✗` = `incompatible_target_kind`.

`amendment_approve` 와 `cross_milestone_amendment` 는 의미가 다르다:
- `amendment_approve` = change_proposal 자체의 승인 (`target_kind=change_proposal`)
- `cross_milestone_amendment` = milestone N+1 의 발견을 N scope 로 흡수 (`target_kind=milestone`)

| Verb \ Surface | Slice PR | Slice Issue | Milestone Tracker | Control Issue | Contract Change Issue |
|---|---|---|---|---|---|
| `approve` | →slice_merge | ✗ | →milestone | ✗ | ✗ |
| `reject` | →slice_merge | ✗ | →milestone | ✗ | ✗ |
| `recover` | →slice_merge | →slice | →milestone | ✗ | ✗ |
| `rework` | →slice_merge | →slice | ✗ | ✗ | ✗ |
| `pause` | ✗ | ✗ | ✗ | →system | ✗ |
| `resume` | ✗ | ✗ | ✗ | →system | ✗ |
| `stop` | ✗ | ✗ | ✗ | →system | ✗ |
| `amendment-approve` | ✗ | ✗ | ✗ | ✗ | →change_proposal |
| `amend-cross` | ✗ | ✗ | →milestone | ✗ | ✗ |
| `at-rename <old> <new>` | ✗ | →slice | ✗ | ✗ | ✗ |
| `at-purge` | ✗ | →slice | ✗ | ✗ | ✗ |

**Notes**:
- Slice PR 코멘트의 target 은 PR 에 연결된 SliceMerge 의 active review session 이며, `awaiting:` block 의 `target_id`, `related_object_id`, `session_id` 가 정확한 라우팅을 결정한다.
- `recover` 의 target_kind 는 surface 가 결정하나, `awaiting:` block 부재 시 Slice Issue 의 `recover` 도 `awaiting_block_missing` 으로 reject 될 수 있다 (Caller 가 awaiting 상태가 아닐 때).
- 본 매트릭스는 `human_signal_drain` 의 라우팅 단계에서 단일 lookup 표로 구현된다. 변경은 본 spec 갱신을 동반한다.
