# Application Modules

본 문서는 `application/` 하위 12 개 use-case 모듈의 진입점·책임·의존을 표로 정리한다. contract 를 정의하지 않으며, 권위는 다음 순으로 우선한다.

1. [`llm-team.md`](../../llm-team.md)
2. [`docs/contracts/`](../contracts/)
3. 본 architecture 문서

각 모듈은 *하나의 use case* 만 담는다. port adapter 호출(`it_*`, `ws_*`, `ps_*`, `lr_*`)을 통해서만 외부 시스템(`gh`, `git`, LLM, 파일시스템)과 통신한다. application 파일은 `gh`/`git`/`curl`/LLM CLI 를 직접 호출하지 않는다.

## 모듈 매트릭스

| 모듈 | 책임 (한 줄) | 진입 함수(주요) | 의존 port | 호출처 | 테스트 |
|---|---|---|---|---|---|
| `ready_object.sh` | 역할별 oldest-ready 객체 1개 선점(읽기 전용) | `ready_object_pick` | `it_*` | `scheduler/runner.sh` 단계 1 | `test-ready-object.sh` |
| `recovery.sh` | 만료 lease 스윕 + 객체 회수 (`SOC-Recover`) | `recovery_scan` | `it_*`, lease | runner.sh 매 cycle 시작 | `test-recovery.sh` |
| `human_signal.sh` | `RGC-SIGNALS` envelope drain + gate 적용 | `human_signal_drain` | `it_*`, ledger | runner.sh 진입부 | `test-human-signal.sh` |
| `feature_request.sh` | `feature-request` issue → PO milestone 승격 | `feature_request_promote` | `it_*` | runner.sh 진입부 | `test-feature-request.sh` |
| `agent_io.sh` | LLM 호출 + envelope 추출/검증(`AGC-INVALID`) + pin recheck | `agent_io_invoke`, `agent_io_validate_envelope` | `lr_*`, ledger | runner.sh 단계 4 | `test-agent-io.sh` |
| `agent_workspace.sh` | 격리 worktree 생성/정리(`AGC-WORKSPACE`) | `agent_workspace_prepare` / `_release` | `ws_*` | runner.sh 단계 3, 6 | `test-agent-workspace.sh` |
| `caller_dispatch.sh` | role × output_kind 분기별 side-effect 실행(`SOC-OPERATIONS`) | `caller_apply_output` | 전 port | runner.sh 단계 5 | `test-caller-dispatch*.sh` |
| `verification_runner.sh` | Reviewer/Integrator/QA pre-action 의 deterministic verification(`RGC-VERIFICATION`) | `verification_run` | `ws_*`, `ps_*` | dispatch pre-action | `test-verification-runner.sh` |
| `release.sh` | QA PASS 시 release tag/notes 발행 | `release_publish` | `it_*`, `ps_*` | dispatch QA PASS 분기 | `test-release.sh` |
| `knowledge.sh` | decision-log / context-summary 누적(`KAC`) | `knowledge_record_decision`, `knowledge_record_summary` | `it_*` | dispatch QA PASS 분기 | `test-knowledge.sh` |
| `ledger_summary.sh` | ledger 통계 / 최근 결과 추출(운영 도구) | `ledger_summary` | ledger | CLI 보조 | `test-ledger-summary.sh` |
| `workspace_prune.sh` | 종료된 task worktree 정리 | `workspace_prune` | `ws_*` | 주기적/수동 | (없음) |

`onboarding/` 서브디렉토리는 별도 use case set 으로 운영 진입 게이트를 담당한다(테스트 `test-onboarding-verify.sh`).

## 의존 흐름

```text
runner.sh (단일 cycle)
   ├─ recovery_scan ─────────────┐
   ├─ human_signal_drain ────────┤
   ├─ feature_request_promote ───┤   (입수/회수/시그널 처리; ledger only)
   ├─ ready_object_pick ─────────┘
   ├─ lease_claim (lib/lease.sh, port 외)
   ├─ agent_workspace_prepare
   ├─ agent_io_invoke
   ├─ agent_io_validate_envelope
   ├─ caller_apply_output ──────┬─ verification_run (Reviewer/Integrator/QA pre-action)
   │                            ├─ release_publish (QA PASS)
   │                            └─ knowledge_record_* (QA PASS)
   ├─ ledger_write
   └─ agent_workspace_release + lease_release
```

## 모듈 변경 규칙

- application 모듈은 *하나의 use case* 만 담는다. 동일 cycle 의 다른 단계로 책임이 번지면 분리한다.
- application → port → adapter 방향만 허용. 역방향 의존은 금지.
- 새 모듈 추가 시: (a) 진입 함수 한 개, (b) 동일 이름의 테스트 파일, (c) 본 표 갱신.
- ledger 기록은 use case 마다 한 줄. 다단 use case 는 단계마다 별도 result 로 기록한다.
