# Tools and Helper Mapping

본 문서는 외부 CLI와 helper 함수의 구현 매핑이다. 권한 경계는 `llm-team.md`와 `docs/contracts/`가 우선한다.

## Tool Ownership

| Tool | 허용 주체 | 용도 |
|---|---|---|
| LLM CLI | Caller가 Agent 호출에 사용 | 콘텐츠 산출 |
| `gh` | Caller | Issue/PR/label/comment/merge 등 operational write |
| `git` | Caller | worktree, branch, commit, diff, merge/rebase |
| test/lint/typecheck command | Caller | deterministic verification |
| `jq`/`yq` | Caller | structured parsing |

Agent는 도구 실행 권한이 아니라 콘텐츠 산출 권한을 가진다. 구현상 Agent 프로세스가 도구를 사용할 수 있더라도, contract 관점에서는 Caller가 제공한 read-only self-fetch와 isolated workspace 범위로 제한해야 한다.

## LLM Invocation

| Helper | 책임 |
|---|---|
| `lr_invoke` (`lib/ports/llm_runner.sh`) | Context Manifest와 role prompt를 기반으로 1회 Agent 호출 (포트) |
| `agent_output_validate` (`lib/output.sh`) | AGC output envelope 1차 검증 |
| `agent_output_validate_extended` (`application/agent_io.sh`) | role × output_kind 별 확장 검증 |

호출 결과는 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)을 만족해야 한다.

## Context Manifest Helpers

| Helper | 책임 |
|---|---|
| `context_manifest_create` | manifest 파일 생성(target/operation/object 식별자 + 빈 entries) |
| `context_manifest_add_entry` | object_kind/id, fetch_scope(`metadata`/`body`/`body+comments`/`tree`), revision_pin, required, purpose 추가 |
| `context_manifest_validate` | manifest 전체 스키마 검증(`AGC-CONTEXT-MANIFEST`) |
| `revision_pin_revalidate` (`application/agent_io.sh`) | Agent output 적용 전 revision pin 재검증 |

Agent는 manifest 밖 객체를 읽지 않는다.

### Workspace Port Helpers (code_tree용)

| Helper | 책임 |
|---|---|
| `ws_ensure_ro_tree` (`adapters/workspace/git_worktree.sh`) | target 의 read-only code tree 보장. stale 시 재생성 후 경로 반환 |
| `ws_ro_tree_revision_pin` (`adapters/workspace/git_worktree.sh`) | 현재 RO tree 가 고정한 commit SHA 반환 |

## GitHub Helpers

`lib/gh.sh` 는 deprecate 되었다. 모든 GitHub 호출은 `adapters/issue_tracker/github.sh` 의 `it_*` 포트 helper를 통해서만 수행한다.

| Helper | 책임 |
|---|---|
| `it_issue_create` / `it_issue_set_state` | Planner output을 Task Issue로 영속화, 상태 marker 갱신 |
| `change_proposal_create` (`lib/change_proposal.sh`) | Agent artifact를 CP로 영속화 |
| `change_proposal_set_state` | CP state marker 갱신(from_state 명시 시 전이 검증) |
| `it_milestone_set_state` | Milestone state marker 갱신 |
| `human_signal_drain` (`application/human_signal.sh`) | RGC-SIGNALS envelope 읽기·적용 |
| `nt_send` (`adapters/notifier/`) | push-only 알림 |

`gh pr review`, `gh pr merge`, `gh issue close`, label 변경은 모두 `it_*` 포트 어댑터를 통해서만 실행한다.

## Git Helpers

| Helper | 책임 |
|---|---|
| `workspace_create` | isolated workspace 생성 |
| `workspace_diff_collect` | Coder workspace diff 수집 |
| `integration_branch_create` | Milestone integration branch 생성 |
| `change_proposal_merge` | CP를 대상 branch에 병합 |
| `merge_or_rebase_clean` | base가 낡은 Code CP의 deterministic merge/rebase 가능성 검사 |
| `workspace_remove` | workspace 정리 |

Coder는 workspace 내부 파일을 수정할 수 있지만, branch push와 PR 생성은 Caller helper가 수행한다.

## Verification Helpers

| Helper | 책임 |
|---|---|
| `verification_run_for` (`application/verification_runner.sh`) | 환경 fingerprint·revision 기록 + build/test/lint/typecheck 실행 + 로그를 persistent store(`ps_*`)에 저장 |
| `verification_attach_to_manifest` | run envelope를 manifest entry(`fetch_scope=metadata`)로 첨부 |

Reviewer, Integrator, QA는 Verification Run log를 해석한다. 검증 명령 실행은 Caller helper가 수행한다.

## Ledger and Lease Helpers

| Helper | 책임 |
|---|---|
| `lease_claim` | ready 객체 claim |
| `lease_release` | 정상 완료 후 lease 해제 |
| `lease_expire_scan` | 만료 lease 탐지 |
| `transition_ledger_write` | RGC-LEDGER entry 기록 |

Ledger는 감사와 복구의 기준이다. 임시 로그만으로 대체하지 않는다.

## Helper Call-Site Map

[`RGC-VERIFICATION`](../contracts/reliability-and-gate-contract.md#RGC-VERIFICATION) 의 deterministic 검증과 [`AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 의 manifest 작업은 다음 call-site 에서 진입한다.

| Helper | 호출 site |
|---|---|
| `context_manifest_create` / `context_manifest_add_entry` | `scheduler/runner.sh` cycle 단계 [3] (Manifest + Workspace + Prompt) |
| `context_manifest_validate` | `scheduler/runner.sh` LLM 호출 직전 |
| `lease_claim` / `lease_release` | `scheduler/runner.sh` cycle 단계 [2] / [6] |
| `lease_expire_scan` | `application/recovery.sh` `recovery_scan()` |
| `verification_run_for` | `application/verification_runner.sh`, dispatch 의 Reviewer/Integrator/QA pre-action |
| `transition_ledger_write` | `application/caller_dispatch.sh::_caller_ledger_write`, `application/recovery.sh::_recovery_ledger_write`, `scheduler/runner.sh::_runner_ledger_write` |

운영 분석 시 위 매핑은 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 timestamp 와 결합해 cycle 의 어느 helper 에서 시간이 소비/실패되었는지 추적하는 시작점이다.

## Secrets

비밀은 Caller 환경 또는 secret store에만 존재한다. Agent prompt, output, comment, ledger에는 비밀 값을 포함하지 않는다.

허용:

- secret reference name
- masked value

금지:

- token 원문
- webhook URL 원문
- API key 원문
