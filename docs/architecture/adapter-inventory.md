# Adapter Inventory

본 문서는 현재 구현된 production adapter 와 운영 전제 조건의 *inventory / navigational index* 다. contract (`docs/contracts/`) 와 기존 architecture 문서가 권위 source 를 그대로 보유하며, 본 문서는 흩어진 사실을 한 표로 모으고 deeper anchor 로 링크아웃한다.

## Authority Stance

- 본 문서는 contract (`docs/contracts/`) 의 사실을 재정의하지 않는다.
- 본 문서는 기존 architecture 문서가 이미 권위 있게 다루는 사실(NFS 한계, PID lockdir, hot-reload 미지원, exit-class 매핑 등)을 **재서술하지 않고** anchor link 만 단다.
- 단, *cross-cutting 운영 가정* 중 기존 어떤 문서에도 명시되지 않은 항목(예: `bash`/`yq` 등 외부 도구 의존 종합)은 본 문서가 신규 authoritative source 가 된다.
- 충돌 시 우선 순위: [`llm-team.md`](../../llm-team.md) > [`docs/contracts/`](../contracts/) > 기존 `docs/architecture/` 문서 > **본 문서** > 코드 주석.

## 1. Adapter Matrix

5 port × active production adapter 스냅샷. "선택 메커니즘" 컬럼은 현재 구현된 *환경변수 / 설정 키* 만 적는다 (contract anchor 가 아니라).

| port | active production | 외부 의존 | test/no-op | 선택 메커니즘 | 상태 |
|---|---|---|---|---|---|
| `issue_tracker` | `adapters/issue_tracker/github.sh` | `gh` CLI + `gh api` REST, `jq`, 자체 `gh_with_retry` (2/8/30s backoff) | `in_memory.sh` (test) | `LLM_TEAM_ADAPTER_ISSUE_TRACKER` (기본 `github`) | production |
| `llm_runner` | `adapters/llm_runner/claude_code.sh` | Claude Code CLI (`claude -p --output-format text`, `LLM_TEAM_CLAUDE_CMD` override) | `fake.sh` (test, fixture + sequence) | `LLM_TEAM_ADAPTER_LLM_RUNNER` (기본 `claude_code`) | production |
| `notifier` | `adapters/notifier/discord.sh` / `slack.sh` | Webhook + `curl` + `jq` (Discord embeds / Slack Block Kit) | `none.sh` (default no-op, **운영용**) | `LLM_TEAM_ADAPTER_NOTIFIER` 기본 `none`. caller 가 `load_target` 후 `registry_rebind_for_target` 을 *명시 호출* 하면 `TARGET_NOTIFIER_CHANNEL` 값으로 rebind. 현재 알림 흐름에서는 `lib/notifier.sh` `notify_review_needed` 가 이를 수행한다. | production / default-no-op |
| `persistent_store` | `adapters/persistent_store/filesystem.sh` | 로컬 FS, atomic `mv`, JSONL append, `mkdir` lock | `in_memory.sh` (test, `filesystem.sh` 재사용 + root override) | `LLM_TEAM_ADAPTER_PERSISTENT_STORE` (기본 `filesystem`) | production |
| `workspace` | `adapters/workspace/git_worktree.sh` | `git`, `git worktree`, HTTPS clone (+ git credential helper 호환 토큰) | `in_memory.sh` (test, JSON patch + sha1 결정성) | `LLM_TEAM_ADAPTER_WORKSPACE` (기본 `git_worktree`) | production |

> 주: `target.yaml` 의 `adapters.*` 키 기반 매핑은 **현재 미구현** 이며 `lib/registry.sh` `registry_rebind_for_target` 본문에 "추후" 로 표기되어 있다. 현재는 위 `LLM_TEAM_ADAPTER_*` 환경변수 + notifier 한정 `TARGET_NOTIFIER_CHANNEL` rebind 가 유일한 매핑 경로다.

## 2. Cross-Cutting Operational Assumptions

port 를 가로지르는 운영 전제. 이미 권위 source 가 있는 항목은 ↦ 우측 문서가 권위를 보유하고 본 문서는 1줄 요약만 둔다. 외부 도구 의존 종합만 본 문서가 신규 authoritative source 다.

- **단일 호스트 가정**: `mkdir`-atomic 은 같은 파일시스템 내에서만 atomic. lease / 락 / fetchlock 모두 이 가정 위. NFS · EFS 등 분산 FS 미지원 ↦ [`lease-and-recovery.md` §4 운영적 한계](lease-and-recovery.md#4-운영적-한계).
- **단일 인스턴스 데몬 (role + target scope 당 1 프로세스)**: PID lockdir 로 중복 기동 차단. lock scope 는 role 과 `LLM_TEAM_DAEMON_TARGET`(미설정 시 `all`) 의 조합이므로 *같은 role 이라도 다른 target scope 라면 공존 가능* ↦ [`daemons.md` §Single Instance · §Daemon Lifecycle](daemons.md#single-instance).
- **macOS 호환**: `flock` 미사용(macOS 기본 부재) → `mkdir` 기반 fetchlock(`adapters/workspace/git_worktree.sh` `_workspace_fetchlock_acquire`). `stat -f %m` (BSD) / `stat -c %Y` (GNU) 양쪽 분기.
- **두 갈래 GitHub 인증 의존**: issue_tracker(`github.sh`)는 `gh` CLI 자체 인증 상태(`gh auth status`)에 의존하고, workspace(`git_worktree.sh`)는 HTTPS clone 시 git credential helper 와 호환되는 토큰을 요구한다(`adapters/workspace/git_worktree.sh` 파일 헤더 주석 §호출자 규칙). 운영자는 두 채널을 *같은 토큰* 으로 맞출 수 있으나 단일 채널이 *강제* 되지는 않는다. **갱신 반영 시점**: 환경변수(`GH_TOKEN` 등)로 토큰을 주입하는 운영 방식이라면 daemon 재기동이 필요하고, `gh` 의 저장된 인증이나 git credential helper 갱신은 *운영 방식에 따라* 다르다 — 본 문서는 단일 시점을 강제하지 않는다.
- **외부 도구 의존 (계층별)** — *본 문서가 authoritative source*:
  - **Baseline (모든 실행에 필수)**: `bash` 3.2+, `jq`, `yq` (`lib/config.sh` `load_target` 이 부재 시 fail-fast), `mktemp`. GNU coreutils 만 사용한다고 가정하지 않는다 — macOS / BSD 도구 셋이 portable subset 안이면 동작.
  - **Production default adapter 사용 시**:
    - `gh` CLI ↦ `issue_tracker=github`.
    - Claude Code CLI ↦ `llm_runner=claude_code`.
    - `git`, `stat`(BSD `-f %m` / GNU `-c %Y` 양쪽 분기) ↦ `workspace=git_worktree`.
  - **Optional (해당 어댑터 사용 시에만)**: `curl` ↦ `notifier=discord` / `slack`.
  - 미설치 시 동작: notifier 는 warn 후 비0 반환(워크플로우 중단 없음), llm_runner 는 `adapter_unavailable` (exit 127), `load_target` 의 `yq` 부재는 fail-fast.
- **`target.yaml` `adapters.*` 매핑 미지원**: 현재 어댑터 선택은 `LLM_TEAM_ADAPTER_*` env + notifier 만 `TARGET_NOTIFIER_CHANNEL` rebind ↦ `lib/registry.sh` `registry_rebind_for_target`.

## 3. Per-Adapter Limitations

각 어댑터별 *현재 알려진 한계* 를 1~3줄로 요약한다. 행 번호는 코드 변동에 따라 drift 하므로 *함수명 / 식별자* 로 anchor 한다.

- **`github.sh`**: GitHub-only. GitLab / Forgejo 는 향후 분리 ↦ [`github-side-effect-timeline.md` 도입부](github-side-effect-timeline.md). label mutation 은 REST `/issues/N/labels` 사용 (GraphQL 회피, rate-limit pool 분리 이유) ↦ `adapters/issue_tracker/github.sh` `_github_issue_add_label` / `_github_issue_remove_label` 코드 주석.
- **`claude_code.sh`**: 어댑터 자체는 0 / 64 / 127 세 코드만 직접 emit 하고, contract enum 변환은 port 헬퍼 `lr_classify_exit` (`lib/ports/llm_runner.sh`) 가 담당한다 — 65 / 67 은 `malformed_output`, 66 은 `adapter_unavailable` 로 매핑되며 그 외 raw 코드만 `transport_error` 로 흡수된다 ↦ [`agent-runner-adapters.md` §3 종료 분류 매핑](agent-runner-adapters.md#3-종료-분류-매핑). stateless 1 회 호출 invariant ↦ `lib/ports/llm_runner.sh` invariant I1.
- **`discord.sh` / `slack.sh`**: best-effort. 시크릿 누락 · `curl` / `jq` 부재 시 워크플로우 중단 없이 warn 후 비0 ↦ `lib/ports/notifier.sh` invariants I1~I3.
- **`none.sh`**: 운영용 default no-op (테스트 전용 아님). stderr INFO 로깅만 하고 0 반환.
- **`filesystem.sh`**: namespace 경로 = `${LLM_TEAM_ROOT}/workdir/<ns>/`. atomic mkdir lock ↦ `adapters/persistent_store/filesystem.sh` `ps_lock_acquire`. 분산 FS 가정 없음 (§2 참조).
- **`git_worktree.sh`**: target 별 fetchlock 직렬화. 60 초 stale-lock 강제 해제 휴리스틱 (`_workspace_fetchlock_acquire` 본문). HTTPS 인증은 git credential helper 호환 토큰에 의존 — SSH · deploy-key 시나리오 미문서화.
- **`fake.sh` / `in_memory.sh`**: 테스트 한정. 운영 사용 금지 ↦ [`agent-runner-adapters.md` §4 fake 어댑터의 위치](agent-runner-adapters.md#4-fake-어댑터의-위치).

## 4. 새 어댑터 추가 가이드

- 신규 어댑터 = `adapters/<port>/<id>.sh` 한 파일. 본 파일은 `lib/registry.sh` 의 `registry_load_adapter` 에 의해 *현재 셸로 source* 되어 함수를 정의한다 (별도 `export -f` 불필요). `registry_verify_port` 가 `lib/ports/<port>.sh` 의 `PORT_*_REQUIRED_FUNCTIONS` 각 함수 존재 여부를 `declare -F` 로 검증한다.
- 어댑터 식별자 (`<id>`) 활성화 경로 (현재 구현):
  - **비-notifier**: `LLM_TEAM_ADAPTER_<PORT>` 환경변수.
  - **notifier**: 기본 `LLM_TEAM_ADAPTER_NOTIFIER` (기본값 `none`) → caller 가 `load_target` 후 `registry_rebind_for_target` 을 명시 호출하면 `TARGET_NOTIFIER_CHANNEL` 값으로 rebind. (`load_target` 자체는 rebind 하지 않는다.)
  - **llm_runner agent-profile 별 매핑**: contract 는 `agent_profiles.<id>.runner` 로 정의하나 *runner 바인딩에는 미연결*. [`target-config-contract.md#TCC-AGENT-PROFILES`](../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 가 `agent_profiles.<id>.runner` / `agent_profiles.<id>.model` 을 정의하지만, `scheduler/runner.sh` 는 현재 이 lookup 을 호출하지 않으며 `lib/common.sh` source 시점에 `LLM_TEAM_ADAPTER_LLM_RUNNER` 단일 값으로 바인딩된다. legacy `lib/config.sh` `config_agent_runner_for_role` 헬퍼는 폐기 대상이며 새 helper 도입이 필요하다. *active binding TBD*.
  - `target.yaml` 의 `adapters.*` 키 기반 매핑은 미구현 (`lib/registry.sh` `registry_rebind_for_target` 본문 "추후" 표기).
- 본 절은 **gateway pointer 만**. 실제 contract 의무는 [`agent-runner-port-contract.md`](../contracts/agent-runner-port-contract.md) 및 각 port 명세 파일 (`lib/ports/*.sh`) 에 위임한다.

## 5. Open Items

각 항목은 GitHub issue 가 있으면 `(#NNN)`, 없으면 `(ISSUE TBD)` 로 표기한다.

- 분산 / 멀티 호스트 배포 시 락 메커니즘 미정 (ISSUE TBD).
- GitLab · Forgejo `issue_tracker` adapter 미존재 (ISSUE TBD).
- SSH 기반 git 인증 시나리오 미커버 (ISSUE TBD).
- 비-Claude `llm_runner` 어댑터 (codex / qwen 등) 미구현 (ISSUE TBD).
- `target.yaml` `adapters.*` 매핑 (`lib/registry.sh` `registry_rebind_for_target` "추후") 미구현 (ISSUE TBD).
- llm_runner role-별 매핑의 active binding (`scheduler/runner.sh` 가 `config_agent_runner_for_role` 미호출) 미구현 (ISSUE TBD).
