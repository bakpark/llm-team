# Application Modules

본 문서는 `application/` 하위 use-case 모듈의 진입점·책임·의존을 표로 정리한다. contract 를 정의하지 않으며, 권위는 다음 순으로 우선한다.

1. [`llm-team.md`](../../llm-team.md)
2. [`docs/contracts/`](../contracts/)
3. 본 architecture 문서

각 모듈은 *하나의 use case* 만 담는다. port adapter 호출(`it_*`, `ws_*`, `ps_*`, `lr_*`) 을 통해서만 외부 시스템과 통신한다. application 파일은 `gh`/`git`/`curl`/LLM CLI 를 직접 호출하지 않는다.

## 모듈 매트릭스

| 모듈 | 책임 (한 줄) | 진입 함수(주요) | 의존 port | 호출처 | 테스트 |
|---|---|---|---|---|---|
| `ready_object.sh` | turn pickup — `(parent_loop, phase|purpose, agent_profile, target)` 별 oldest-ready turn 1개 선점(읽기 전용) | `ready_object_pick` | `it_*` | turn worker cycle 단계 1 | `test-ready-object.sh` |
| `recovery.sh` | 4-lease kind 만료 스윕 + 객체 회수. session-stale / inner-no-progress / slice-merge-stale / coordinator-failure trigger 포함 | `recovery_scan` | `it_*`, lease | runner.sh 매 cycle 시작 | `test-recovery.sh` |
| `human_signal.sh` | `RGC-SIGNALS` envelope drain → `human` profile 의 `human_approval` contribution envelope 으로 변환 후 영속 큐 enqueue. cross_milestone_amendment 등 신규 signal 처리 | `human_signal_drain` | `it_*`, ledger | runner.sh 진입부 | `test-human-signal.sh` |
| `feature_request.sh` | `feature-request` issue → `M_INTAKE_QUEUED` milestone 승격 (intake_queue enqueue) | `feature_request_promote` | `it_*` | runner.sh 진입부 | `test-feature-request.sh` |
| `agent_io.sh` | LLM 호출 + envelope 추출/검증 (`AGC-INVALID`, (parent_loop, contribution_kind, output_kind) 매트릭스, scope enforcement, TDD orthodoxy strict 옵션) + pin recheck | `agent_prompt_assemble`, `agent_output_parse`, `agent_output_validate_extended`, `revision_pin_revalidate` | `lr_*`, ledger, `ws_*` | turn worker cycle 단계 4 | `test-agent-io.sh` |
| `agent_workspace.sh` | inner loop 의 forge 격리 worktree 생성/정리 (`AGC-WORKSPACE`). slice-local branch + workspace_commit 영속화 | `agent_workspace_for` | `ws_*` | turn worker cycle 단계 3, 6 (inner 한정) | `test-agent-workspace.sh` |
| `dialogue_coordinator.sh` (신규) | DialogueSession lifecycle 관리: turn coordination + finalization 평가 (finalization_rule × required_evidence × composite_rule) + session_outcome 응축 + dispatch | `dialogue_session_pick`, `dialogue_evaluate_termination`, `dialogue_dispatch_outcome` | `it_*`, ledger, `caller_dispatch`, `verification_runner` | dialogue_coordinator daemon cycle | `test-dialogue-coordinator.sh` (신규) |
| `dual_track_scheduler.sh` (신규) | milestone dual-slot promotion: intake_queue / delivery_promotion_queue dispatch + slot_lock short transaction + promotion guard | `dual_track_promote` | `it_*`, ledger | dual_track_scheduler daemon cycle | `test-dual-track-scheduler.sh` (신규) |
| `caller_dispatch.sh` | (state, final_verdict) tuple 분기별 side-effect 실행 (`SOC-DISPATCH-MATRIX`) — slice / SliceMerge / milestone / Spec CP / Milestone CP 전이 | `caller_apply_outcome` | 전 port | dialogue_coordinator dispatch 시점 | `test-caller-dispatch*.sh` |
| `verification_runner.sh` | inner turn 직후 / SliceMerge 의 SM_APPROVED / outer Validation pre-action 의 deterministic verification (`RGC-VERIFICATION`) + MetricRun | `verification_run_for`, `metric_run_for`, `verification_attach_to_manifest` | `ws_*`, `ps_*` | turn worker (inner 직후) / dialogue_coordinator (middle merge / outer Validation) | `test-verification-runner.sh` |
| `slice_merge.sh` (신규) | SliceMerge lifecycle (SM_DRAFT/READY/APPROVED/MERGED/REQUEST_CHANGES/CLOSED/STALE) + trunk rebase + first-merger-wins 보호 | `slice_merge_promote`, `slice_merge_rebase`, `slice_merge_finalize` | `ws_*`, lease, ledger | dialogue_coordinator (middle review CONVERGED 이후) | `test-slice-merge.sh` (신규) |
| `release.sh` | outer Validation 의 validation_pass dispatch 시 release tag/notes 발행 | `release_publish_from_milestone` | `it_*`, `ps_*` | dispatch validation_pass 분기 | `test-release.sh` |
| `knowledge.sh` | decision-log / context-summary / RefactorBacklog / SliceTelemetry 누적 (`KAC`). outer Validation 의 PASS 또는 RefactorProposal 도착 시 입력 | `knowledge_record_decision`, `knowledge_snapshot_context_summary`, `knowledge_refactor_backlog_append`, `knowledge_slice_telemetry_emit`, `knowledge_turn_log_compact` | `it_*` | dispatch validation_pass + 정기 telemetry refresh + turn worker 의 turn_log compaction trigger | `test-knowledge.sh` |
| `refactor_backlog.sh` (신규, KAC 소유) | RefactorProposal/RefactorBacklog 영속화 + lifecycle (PROPOSED/CURATED/SCHEDULED/DONE/DROPPED/SUPERSEDED) | `refactor_proposal_append`, `refactor_proposal_curate`, `refactor_proposal_promote_to_slice` | `it_*`, ledger | scout 정기 scan + dispatch outer Planning 의 plan_accept | `test-refactor-backlog.sh` (신규) |
| `ledger_summary.sh` | ledger 통계 / 최근 결과 추출 (운영 도구). union read 로 legacy + new schema 동시 처리 | `ledger_pipeline_summary`, `ledger_caller_window`, `ledger_recent` | ledger | CLI 보조 | `test-ledger-summary.sh` |
| `workspace_prune.sh` | 종료된 slice worktree + 만료된 session_log 정리 | `workspace_prune_unit`, `workspace_prune_units` | `ws_*` | 주기적/수동 | `test-workspace-prune.sh` |

`onboarding/` 서브디렉토리는 별도 use case set 으로 운영 진입 게이트를 담당한다. acquisition order CI 와 같은 daemon startup 진입 검증을 포함.

## 의존 흐름

### Turn worker daemon cycle

```text
runner.sh --agent-profile <id>
   ├─ recovery_scan ─────────────┐
   ├─ human_signal_drain ────────┤
   ├─ feature_request_promote ───┤   (입수/회수/시그널; human_signal 은 contribution envelope 으로 변환)
   ├─ ready_object_pick ─────────┘   (자기 profile 이 책임지는 (parent_loop, phase|purpose) 만)
   ├─ turn_index CAS (또는 turn_lease 발급)
   ├─ agent_workspace_for (inner 한정)
   ├─ agent_prompt_assemble + lr_invoke (session_context_ref 합성 포함)
   ├─ agent_output_parse + agent_output_validate_extended + revision_pin_revalidate
   ├─ session_turn_persist (envelope + workspace_commit 저장)
   ├─ verification_run_for (inner 한정 — 직후 결정적 검증)
   ├─ knowledge_turn_log_compact (조건 충족 시)
   ├─ transition_ledger_write (action_kind=session_progress)
   └─ workspace_prune_unit + lease_release
```

### Dialogue coordinator daemon cycle

```text
runner.sh --dialogue-coordinator
   ├─ recovery_scan (session-stale / coordinator-failure / session-timeout / slice-merge-stale)
   ├─ dialogue_session_pick (states: SESSION_OPEN, AWAITING_REVALIDATION 재검증 후)
   ├─ lease_claim (lease_kind=session_lease)
   ├─ dialogue_evaluate_termination
   │     ├─ load loop_policies.<loop>.<phase|purpose>
   │     ├─ collect SessionTurn[] + verification_result + metric_result
   │     └─ classify: converged/timeout/abandoned/awaiting_revalidation/awaiting_more_turns
   ├─ branch:
   │   ├─ converged → dialogue_dispatch_outcome
   │   │     ├─ caller_apply_outcome (SOC-DISPATCH-MATRIX (state, final_verdict) 분기)
   │   │     ├─ slice_merge_promote (middle review 의 approve)
   │   │     ├─ release_publish_from_milestone (outer Validation pass)
   │   │     └─ knowledge_record_decision / knowledge_snapshot_context_summary (Validation pass)
   │   ├─ awaiting_more_turns → enqueue next turn (caller_routing_decision 결정)
   │   └─ timeout/abandoned → escalate (slice → SLICE_BLOCKED 또는 milestone → ESCALATED)
   ├─ transition_ledger_write (action_kind=session_finalize 또는 session_progress)
   └─ lease_release
```

### Dual-track scheduler daemon cycle

```text
runner.sh --dual-track-scheduler
   ├─ recovery_scan (slot_lock stale)
   ├─ inspect intake_queue head
   ├─ inspect delivery_promotion_queue head
   ├─ for each candidate:
   │   ├─ check slot 빔 + promotion_guard
   │   ├─ lease_claim (lease_kind=slot_lock, short transaction)
   │   ├─ atomic 4 단계 (validate → persist state → ledger → release)
   │   └─ lease_release
   └─ knowledge_slice_telemetry_emit (Discovery N+1 manifest 갱신)
```

## 모듈 변경 규칙

- application 모듈은 *하나의 use case* 만 담는다. 동일 cycle 의 다른 단계로 책임이 번지면 분리한다.
- application → port → adapter 방향만 허용. 역방향 의존은 금지.
- 새 모듈 추가 시: (a) 진입 함수 한 개, (b) 동일 이름의 테스트 파일, (c) 본 표 갱신.
- ledger 기록은 use case 마다 한 줄. 다단 use case 는 단계마다 별도 result 로 기록한다.
- 4-lease kind 의 acquisition order 는 lib/lease.sh 가 강제. application 모듈은 outer-to-inner 순서 위반 시 하드 fail (Stage 2 의 always_hard invariant).
