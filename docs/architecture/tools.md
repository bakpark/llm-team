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
| `llm_invoke` | Context Manifest와 role prompt를 기반으로 1회 Agent 호출 |
| `agent_output_validate` | AGC output envelope 검증 |

호출 결과는 [`AGC-OUTPUT`](../contracts/agent-and-context-contract.md#AGC-OUTPUT)을 만족해야 한다.

## Context Manifest Helpers

| Helper | 책임 |
|---|---|
| `context_manifest_create` | object id, fetch scope, revision pin 목록 생성 |
| `context_manifest_fetch` | Agent self-fetch용 read-only fetch 수행 |
| `context_manifest_verify` | Agent output 적용 전 revision pin 재검증 |

Agent는 manifest 밖 객체를 읽지 않는다.

## GitHub Helpers

| Helper | 책임 |
|---|---|
| `issue_create_from_task` | Planner output을 Task Issue로 영속화 |
| `change_proposal_create` | Agent artifact를 CP로 영속화 |
| `change_proposal_set_state` | CP state marker 갱신 |
| `workflow_object_set_state` | Milestone/Task state marker 갱신 |
| `human_signal_read` | RGC-SIGNALS envelope 읽기 |
| `notification_send` | push-only 알림 |

`gh pr review`, `gh pr merge`, `gh issue close`, label 변경은 모두 Caller helper를 통해서만 실행한다.

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
| `verification_run_create` | target revision과 환경 fingerprint 기록 |
| `verification_run_execute` | build/test/lint/typecheck 실행 |
| `verification_log_store` | 로그를 persistent store에 저장 |

Reviewer, Integrator, QA는 Verification Run log를 해석한다. 검증 명령 실행은 Caller helper가 수행한다.

## Ledger and Lease Helpers

| Helper | 책임 |
|---|---|
| `lease_claim` | ready 객체 claim |
| `lease_release` | 정상 완료 후 lease 해제 |
| `lease_expire_scan` | 만료 lease 탐지 |
| `transition_ledger_write` | RGC-LEDGER entry 기록 |

Ledger는 감사와 복구의 기준이다. 임시 로그만으로 대체하지 않는다.

## Secrets

비밀은 Caller 환경 또는 secret store에만 존재한다. Agent prompt, output, comment, ledger에는 비밀 값을 포함하지 않는다.

허용:

- secret reference name
- masked value

금지:

- token 원문
- webhook URL 원문
- API key 원문
