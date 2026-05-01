# sub-common-lib — 공유 lib 모듈 + 라벨 부트스트랩 CLI

- **preparation**: 없음
- **대상 파일**:
  - `lib/common.sh`, `lib/log.sh`, `lib/labels.sh`, `lib/config.sh`, `lib/gh.sh`, `lib/markers.sh`, `lib/notifier.sh`, `lib/stale.sh`, `lib/worktree.sh`, `lib/concurrency.sh`
  - `scripts/bootstrap-labels.sh`
  - `tests/lib/` (각 모듈 smoke test, MVP는 source 가능 + 핵심 동작 1개씩)
- **건드리지 않는 파일**: 디렉토리 골격, `targets/myapp.yaml`, `inputs/myapp/auth.md`, `README.md`, `.gitignore`, `.env.example` (sub-common-skeleton 담당) / `prompts/`, `scheduler/run-*.sh` (Phase 2)

## 목표

Phase 2의 4개 에이전트 sub-task가 의존하는 모든 공유 lib 함수와 라벨 부트스트랩 CLI를 제공한다. 본 태스크의 산출물은 lib API 시그니처가 안정적인 contract로 취급된다.

## 컨텍스트

- 라벨 / 상태 전이 / Stale 복구 / Marker / Notifier 호출 시점: `memory/state-machine.md`
- targets/yaml 스키마 (lib/config.sh의 export 변수명 contract): `planning.md` §3.2
- Notifier 인터페이스: `planning.md` §6.3
- GitHub API 백오프 정책: `planning.md` §7.3 (3회, 2s/8s/30s)
- Secret 누락 fail-fast: `planning.md` §7.5
- 의존 도구: `gh` CLI, `git`, `jq`, `yq`. shell = bash

## 수행 단계

### A. lib 모듈 구현 (10개)

각 모듈은 source 가능한 bash 함수 모음. stderr로 로그, exit code로 성공/실패 반환.

1. **`lib/common.sh`** — 진입점. 다른 모든 lib를 source. `LLM_TEAM_ROOT` env 자동 export (스크립트 위치 기준).

2. **`lib/log.sh`** — 로깅 헬퍼.
   - `log_info <msg>`, `log_warn <msg>`, `log_error <msg>` (stderr로 timestamp + level + message).
   - `log_init <agent> <target>` — `workdir/<target>/logs/<agent>-<ISO>.log`로 stdout/stderr tee 시작.

3. **`lib/labels.sh`** — 12개 라벨 상수 (반드시 `memory/state-machine.md` §1과 일치):
   ```bash
   LABEL_PO_IN_PROGRESS="po:in-progress"
   LABEL_PO_REVIEW="needs-human-review:milestone"
   LABEL_NEEDS_SCENARIOS="needs-scenarios"
   LABEL_PM_IN_PROGRESS="pm:in-progress"
   LABEL_PM_DONE="pm:done"
   LABEL_SCENARIO_REVIEW="needs-human-review:scenario"
   LABEL_NEEDS_DEV="needs-dev"
   LABEL_DEV_IN_PROGRESS="dev:in-progress"
   LABEL_NEEDS_QA="needs-qa"
   LABEL_QA_IN_PROGRESS="qa:in-progress"
   LABEL_QA_CHANGES_REQUESTED="qa:changes-requested"
   LABEL_DEV_FAILURE="needs-human-review:dev-failure"

   ALL_MILESTONE_LABELS=(...) # 5개
   ALL_ISSUE_LABELS=(...)     # 7개
   ```
   `label_with_prefix <prefix> <const>` — yaml의 `labels.prefix`가 비어있지 않으면 prefix 추가.

4. **`lib/config.sh`** — yaml 로더. **export 변수명은 `planning.md` §3.2 yaml 키와 1:1 대응 contract** (sub-common-skeleton의 yaml 작성과 동기화):
   - `load_target <name>` → `targets/<name>.yaml`을 yq로 읽어 export:
     - `TARGET_GH_OWNER` ← `github.owner`
     - `TARGET_GH_REPO` ← `github.repo`
     - `TARGET_DEFAULT_BRANCH` ← `github.default_branch`
     - `TARGET_CLONE_PATH` ← `local.clone_path`
     - `TARGET_INPUTS_DIR` ← `inputs_dir`
     - `TARGET_LABEL_PREFIX` ← `labels.prefix`
     - `TARGET_NOTIFIER_CHANNEL` ← `notifier.channel`
     - `TARGET_NOTIFIER_REF` ← `notifier.webhook_or_id`
     - `TARGET_DEV_CONCURRENCY` ← `dev_concurrency`
     - `TARGET_STALE_THRESHOLD_MIN` ← `stale_threshold_minutes`
     - `TARGET_ENABLED` ← `enabled`
   - `resolve_secret <ref>` — `.env` 또는 `~/.llm-team/.env`에서 ref 키 조회. **누락 시 stderr 에러 로그 + exit 1 (fail-fast)**.
   - `list_active_targets` — `targets/*.yaml` 중 `enabled: true` 항목 이름 stdout.

5. **`lib/gh.sh`** — gh CLI 래퍼.
   - `gh_with_retry <args...>` — 호출이 비-0 종료 시 **2s, 8s, 30s 백오프로 최대 3회 재시도**. 최종 실패 시 비-0 exit + stderr 로그.
   - `issue_set_label <repo> <num> <new_label> <old_label>` — atomic 전이: **반드시 add → remove 순서** (`memory/state-machine.md` §3).
   - `milestone_set_label <repo> <num> <new_label> <old_label>` — 동일 패턴.
   - `milestone_get_progress <repo> <num>` → "open=N closed=M" 형태로 stdout.
   - `milestone_close <repo> <num>` → `gh api repos/.../milestones/N -X PATCH -f state=closed`.
   - `issue_list_by_label <repo> <label>` → 번호 줄당 1개 stdout (오래된 것부터).
   - `milestone_list_by_label <repo> <label>` → 동일.
   - `issue_list_open_milestones <repo>` → open 상태 Milestone 번호 목록 (PO 트리거 조건용).
   - `issue_get_milestone <repo> <issue_num>` → Milestone 번호 stdout.

6. **`lib/markers.sh`** — hidden HTML comment marker (`memory/state-machine.md` §6).
   - `marker_notified <kind>` → 문자열 반환.
   - `marker_qa_attempts <n>` → 문자열 반환.
   - `comments_have_marker <type> <repo> <num> <kind>` (type ∈ `issue|pr|milestone`) → exit 0 if 발견.
   - `pr_body_get_attempts <repo> <pr_num>` → 마지막 marker에서 N 추출 (없으면 `0` stdout).
   - `pr_body_set_attempts <repo> <pr_num> <n>` → PR body 마지막 marker 갱신 (`gh pr edit --body`).

7. **`lib/notifier.sh`** — Notifier (`planning.md` §6.3, `memory/state-machine.md` §7).
   - 시그니처: `notify_review_needed <target> <kind> <object_type> <object_num> <github_url> <summary>`
     - `<kind>` ∈ `milestone | scenario | dev-failure`
     - `<object_type>` ∈ `issue | milestone`
   - 동작:
     1. `comments_have_marker <object_type> <repo> <object_num> <kind>` → 발견 시 즉시 return 0 (멱등성).
     2. `targets/<target>.yaml`의 `notifier.channel` 분기:
        - `discord`: webhook POST (Discord embed)
        - `slack`: webhook POST (Slack blocks)
        - `none`: no-op
     3. 성공 시 대상 객체에 `marker_notified <kind>` 코멘트 추가.
     4. 실패 시 stderr 로그만, exit 0 (알림 실패가 메인 흐름을 막지 않음).

8. **`lib/stale.sh`** — Stale 복구 (`memory/state-machine.md` §5).
   - `recover_stale_milestones <target>` — open Milestone 중 `po:in-progress`/`pm:in-progress` + last update가 `TARGET_STALE_THRESHOLD_MIN` 초과 → 회귀.
   - `recover_stale_issues <target>` — `dev:in-progress`/`qa:in-progress` Issue 중 stale → 회귀 (worktree 정리 포함).
   - `recover_orphan_milestones <target>` — open Milestone 중 라벨 0개 + threshold 초과 → Notifier만 호출 (자동 정리 X).
   - `run_stale_recovery <target>` — 위 3개를 순차 호출 (모든 cron 진입 시 inline).

9. **`lib/worktree.sh`** — git worktree 헬퍼.
   - `worktree_create <target> <branch>` — `workdir/<target>/worktrees/<branch>/`에 `git worktree add`. 기존 브랜치면 fetch + checkout, 신규면 base = `TARGET_DEFAULT_BRANCH`.
   - `worktree_remove <target> <branch>` — `git worktree remove --force` + 디렉토리 정리.
   - `worktree_list <target>` → 현재 등록된 worktree 목록.
   - 호출 전제: 호출자가 `cd $TARGET_CLONE_PATH` 컨텍스트.

10. **`lib/concurrency.sh`** — DEV/QA 병렬 슬롯.
    - `count_in_progress <repo> <label>` → 현재 라벨이 붙은 Issue 수 stdout.
    - **MVP 단순화**: `with_concurrency_limit`는 만들지 않고, 호출자(run-dev/qa.sh)가 직접 `&` + `wait` 패턴으로 spawn. 본 모듈은 `count_in_progress` 한 함수만 제공.

### B. 라벨 부트스트랩 CLI

11. **`scripts/bootstrap-labels.sh <target> [--dry-run]`**:
    - `targets/<target>.yaml` 로드.
    - 12개 라벨을 `gh label create --force`. 이미 있으면 description/color 갱신.
    - 라벨별 색상:
      - `po:*` 보라 `#8957e5` / `pm:*` 파랑 `#0e8a16` / `dev:*` 노랑 `#d4c5f9` / `qa:*` 청록 `#1d76db`
      - `needs-human-review:*` 빨강 `#d73a4a` / `needs-*` (큐) 초록 `#0e8a16`
    - `--dry-run`: 실제 gh 호출 없이 라벨/색상 목록 출력.
    - 종료 시 결과 요약 stdout.

### C. 검증

12. `bash -n` 또는 `shellcheck` 모든 모듈 통과.
13. **`tests/lib/test-gh-retry.sh`** — `gh_with_retry`가 mock 호출 (예: `false` 명령) 3회 후 비-0 exit + 2s/8s/30s 간격(짧게 1s/2s/3s 변수로 조정 가능하게)을 stderr 로그로 확인.
14. **`tests/lib/test-config-secret.sh`** — `.env`에 없는 키로 `resolve_secret missing_key` 호출 시 exit 1 + stderr 에러 메시지 확인.
15. **`tests/lib/test-labels-consistency.sh`** — `lib/labels.sh`의 12개 상수가 `memory/state-machine.md` §1의 정확한 문자열과 일치하는지 grep 검증.
16. **`tests/lib/test-bootstrap-dry-run.sh`** — `scripts/bootstrap-labels.sh myapp --dry-run`이 12개 라벨을 모두 출력하는지 확인 (sub-common-skeleton의 `targets/myapp.yaml` 또는 fixture yaml 사용).

## 완료 체크리스트

- [ ] lib/ 10개 모듈 작성됨, 각각 source 시 에러 없음
- [ ] `lib/labels.sh`의 12개 상수가 `memory/state-machine.md` §1과 정확히 일치 (test-labels-consistency 통과)
- [ ] `lib/config.sh`의 export 변수명이 `planning.md` §3.2 yaml 키와 1:1 대응 (sub-common-skeleton의 yaml과 동기화)
- [ ] **`gh_with_retry`가 3회 백오프 재시도 동작 확인 (test-gh-retry 통과)**
- [ ] **`resolve_secret`가 누락 키 시 exit 1 + stderr 에러 (test-config-secret 통과)**
- [ ] `lib/notifier.sh`가 marker 기반 멱등성 검사 포함
- [ ] `lib/gh.sh`의 atomic 전이 helper가 add → remove 순서 준수
- [ ] `lib/stale.sh`가 4가지 회귀 시나리오(po/pm/dev/qa) + orphan Milestone 처리
- [ ] `scripts/bootstrap-labels.sh myapp --dry-run`이 12개 라벨 출력 (test-bootstrap-dry-run 통과)
- [ ] `bash -n` 또는 `shellcheck` 모든 lib/scripts 통과
- [ ] sub-common-skeleton 미완료 상태에서도 fixture yaml로 lib 단독 검증 가능
