# Application Modules

본 문서는 `application/` 하위 12 개 use-case 모듈의 진입점·책임·의존을 표로 정리한다. contract 를 정의하지 않으며, 권위는 다음 순으로 우선한다.

1. [`llm-team.md`](../../llm-team.md)
2. [`docs/contracts/`](../contracts/)
3. 본 architecture 문서

각 모듈은 *하나의 use case* 만 담는다. port adapter 호출(`it_*`, `ws_*`, `ps_*`, `lr_*`)을 통해서만 외부 시스템(`gh`, `git`, LLM, 파일시스템)과 통신한다. application 파일은 `gh`/`git`/`curl`/LLM CLI 를 직접 호출하지 않는다.

## 모듈 매트릭스

| 모듈 | 책임 (한 줄) | 진입 함수(주요) | 의존 port | 호출처 | 테스트 |
|---|---|---|---|---|---|
| `ready_object.sh` | `(phase, contribution_kind, agent_profile)` 별 oldest-ready unit 1개 선점(읽기 전용) | `ready_object_pick` | `it_*` | `scheduler/runner.sh` contribution cycle 단계 1 | `test-ready-object.sh` |
| `recovery.sh` | 만료 lease 스윕 + 객체 회수 (`SOC-Recover`). contribution-stale / contribution-timeout / coordinator-failure trigger 포함 | `recovery_scan` | `it_*`, lease | runner.sh 매 cycle 시작 | `test-recovery.sh` |
| `human_signal.sh` | `RGC-SIGNALS` envelope drain → `human` profile 의 `human_approval` contribution envelope 으로 변환 후 영속 큐 enqueue | `human_signal_drain` | `it_*`, ledger | runner.sh 진입부 | `test-human-signal.sh` |
| `feature_request.sh` | `feature-request` issue → `DISCOVERY_DRAFT` milestone 승격 | `feature_request_promote` | `it_*` | runner.sh 진입부 | `test-feature-request.sh` |
| `agent_io.sh` | LLM 호출 + envelope 추출/검증(`AGC-INVALID`, `(phase, contribution_kind)` 매트릭스 일치 포함) + pin recheck | `agent_prompt_assemble`, `agent_output_parse`, `agent_output_validate_extended`, `revision_pin_revalidate` | `lr_*`, ledger, `ws_*`(code_tree pin 재검증) | runner.sh contribution cycle 단계 4 | `test-agent-io.sh` |
| `agent_workspace.sh` | 격리 worktree 생성/정리(`AGC-WORKSPACE`). lead_draft / rework_patch contribution 한정 | `agent_workspace_for` | `ws_*` | runner.sh contribution cycle 단계 3, 6 | `test-agent-workspace.sh` |
| `phase_coordinator.sh` (신규) | PhaseRun 의 `CONTRIB_SUBMITTED` 들을 모아 quorum 평가 → final artifact 압축 → `caller_dispatch` 호출. `phase_policies.<phase>` 소비 | `phase_coordinator_evaluate`, `phase_coordinator_dispatch` | `it_*`, ledger, `caller_dispatch` | phase coordinator daemon cycle | `test-phase-coordinator.sh` (신규) |
| `caller_dispatch.sh` | phase × contribution_kind × output_kind/verdict 분기별 side-effect 실행 (`SOC-OPERATIONS`, `SOC-DISPATCH-MATRIX`) | `caller_apply_output` | 전 port | phase_coordinator quorum_reached 시점 | `test-caller-dispatch*.sh` |
| `verification_runner.sh` | CodeReview / Integration / Validation phase 의 pre-action deterministic verification (`RGC-VERIFICATION`) | `verification_run_for`, `verification_attach_to_manifest` | `ws_*`, `ps_*` | contribution cycle pre-action / coordinator pre-dispatch | `test-verification-runner.sh` |
| `release.sh` | Validation phase 의 PASS quorum_reached 시 release tag/notes 발행 | `release_publish_from_milestone` | `it_*`, `ps_*` | dispatch Validation PASS 분기 | `test-release.sh` |
| `knowledge.sh` | decision-log / context-summary 누적(`KAC`). Validation phase 의 lead_draft 또는 summary contribution 가 입력 | `knowledge_record_decision`, `knowledge_snapshot_context_summary` | `it_*` | dispatch Validation PASS 분기 | `test-knowledge.sh` |
| `ledger_summary.sh` | ledger 통계 / 최근 결과 추출 (운영 도구) | `ledger_pipeline_summary`, `ledger_caller_window`, `ledger_recent` | ledger | CLI 보조 | `test-ledger-summary.sh` |
| `workspace_prune.sh` | 종료된 task worktree 정리 | `workspace_prune_unit`, `workspace_prune_units` | `ws_*` | 주기적/수동 | `test-workspace-prune.sh` |

`onboarding/` 서브디렉토리는 별도 use case set 으로 운영 진입 게이트를 담당한다(테스트 `test-onboarding-verify.sh`).

## 의존 흐름

### Contribution worker daemon cycle

```text
runner.sh --agent-profile <id>
   ├─ recovery_scan ─────────────┐
   ├─ human_signal_drain ────────┤
   ├─ feature_request_promote ───┤   (입수/회수/시그널 처리; human_signal 은 contribution envelope 으로 변환)
   ├─ ready_object_pick ─────────┘   (자기 profile 이 책임지는 contribution_kind 만)
   ├─ lease_claim (lib/lease.sh, lease_kind=contribution)
   ├─ agent_workspace_for (lead_draft / rework_patch 한정)
   ├─ agent_prompt_assemble + lr_invoke
   ├─ agent_output_parse + agent_output_validate_extended + revision_pin_revalidate
   ├─ contribution_submit (CONTRIB_SUBMITTED 영속화)
   ├─ transition_ledger_write
   └─ workspace_prune_unit + lease_release
```

### Phase coordinator daemon cycle

```text
runner.sh --phase-coordinator
   ├─ recovery_scan (coordinator-failure trigger)
   ├─ phase_run_pick (*_AWAITING_QUORUM | *_AWAITING_HUMAN)
   ├─ lease_claim (lib/lease.sh, lease_kind=phase_coordinator)
   ├─ phase_coordinator_evaluate
   │     ├─ load phase_policies.<phase>
   │     ├─ collect CONTRIB_SUBMITTED in PhaseRun
   │     └─ classify: quorum_reached | awaiting_more_contributions | blocked_by_request_changes
   ├─ phase_coordinator_dispatch (quorum_reached 한정)
   │     ├─ verification_run_for (CodeReview / Integration / Validation 의 dispatch pre-action)
   │     ├─ caller_apply_output (SOC-DISPATCH-MATRIX 의 phase 종착 row)
   │     ├─ release_publish_from_milestone (Validation PASS)
   │     └─ knowledge_record_decision / knowledge_snapshot_context_summary (Validation PASS)
   ├─ transition_ledger_write (quorum_decision 필드 포함)
   └─ lease_release
```

## 모듈 변경 규칙

- application 모듈은 *하나의 use case* 만 담는다. 동일 cycle 의 다른 단계로 책임이 번지면 분리한다.
- application → port → adapter 방향만 허용. 역방향 의존은 금지.
- 새 모듈 추가 시: (a) 진입 함수 한 개, (b) 동일 이름의 테스트 파일, (c) 본 표 갱신.
- ledger 기록은 use case 마다 한 줄. 다단 use case 는 단계마다 별도 result 로 기록한다.
