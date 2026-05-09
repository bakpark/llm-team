# Production Runbook

production target 진입 후의 daemon / 인증 / workdir / cycle bundle / rate-limit 운영 절차. operator 가 5분 안에 읽고 실행한다. 인증 분기는 Stage 1 healthcheck 산출 `Stage1Result.auth_models.{claude,codex,gh}` 의 4 모드 (`env_token` / `credential_file` / `interactive_only` / `unknown`) 를 따른다. Stage 3 의 `verified-auth-model.json.<surface>.status` 는 별개 enum (`PASS` / `FAIL` / `SKIP`) 으로 live-probe 결과만 기록한다.

## 1. Daemon User ↔ CLI Auth User 일치

Daemon 을 띄우는 unix user 와 `claude` / `codex` / `gh` 인증이 묶인 user 가 동일해야 한다. 불일치 시 credential file 을 읽지 못해 `interactive_only` 모드에서 fail-fast.

```bash
# daemon 으로 띄우려는 user 로 직접 실행
whoami                                  # daemon user 확인
id -u; id -g                            # uid/gid
claude /config 2>/dev/null | head       # auth 결과 가시화 (interactive_only 인 경우)
codex --version                         # codex binary 도달 여부
gh auth status                          # gh 인증 상태
```

운영 권장: daemon 을 systemd / launchd 로 띄울 때도 `User=` 가 위 `whoami` 와 동일해야 한다. 검증은 Stage 1 healthcheck (`npm run healthcheck:stage1`) 가 cover.

## 2. 인증 갱신 절차 — `auth_models` 모드별 분기

Stage 1 healthcheck 산출 `Stage1Result.auth_models.{claude,codex,gh}` 에서 4 모드 (`env_token` / `credential_file` / `interactive_only` / `unknown`) 를 읽어 모드를 판정한다. Stage 3 의 `<RUN_DIR>/verified-auth-model.json` 은 surface 별 live-probe 결과 (`PASS` / `FAIL` / `SKIP`) 와 `detail` 문자열만 기록하므로 모드 판정에는 사용하지 않는다.

### 2-a. `env_token`

CLI 가 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GH_TOKEN` 을 읽는 모드. 갱신은 환경변수 교체 후 daemon 재기동.

```bash
# claude
export ANTHROPIC_API_KEY="<new>"
# codex
export OPENAI_API_KEY="<new>"
# gh
export GH_TOKEN="<new>"
# daemon 재기동 (운영체계 의존; 예시는 launchd)
launchctl kickstart -k gui/$(id -u)/llm-team.daemon
```

`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 는 redact-suffix policy 대상 (`src/adapters/llm-runner/common/redact.ts`) — 로그에 평문 노출 금지.

### 2-b. `credential_file`

CLI 가 OS 의 credential file 을 읽는 모드. 갱신은 interactive login 후 file mode 0600 강제.

```bash
# claude — phase-prod-5 e2e workflow 와 동일 경로
claude /login                              # interactive login
chmod 0600 ~/.config/claude/credentials
# codex — phase-prod-5 e2e workflow 와 동일 경로
codex login                                # interactive (정확한 명령은 codex --help 참조)
chmod 0600 ~/.config/codex/credentials
# 재기동
launchctl kickstart -k gui/$(id -u)/llm-team.daemon
```

위 경로는 phase-prod-5 `.github/workflows/e2e.yml` 이 materialize 하는 위치와 정렬된다. binary 버전이 다른 경로를 사용하는 경우 운영자가 수동 확인 — file mode 0600 강제는 운영자 책임 (자동 검사 미구현).

### 2-c. `interactive_only`

env token 도, credential file 도 detect 되지 않는 모드 (`detectCliAuthModel` 가 `auth` / `login` 서브커맨드만 발견). daemon user 로 ssh 후 interactive login 필수.

```bash
ssh <daemon-host>                          # daemon user 로 로그인
sudo -u <daemon-user> -i                   # daemon user 로 shell 진입
claude /login                              # interactive
codex login
gh auth login
ls -la ~/.claude ~/.codex ~/.config/gh     # credential file 확인
launchctl kickstart -k gui/$(id -u)/llm-team.daemon
```

자동화 불가 — 운영자 손이 필요하다. `interactive_only` 모드는 CI / nightly e2e 에서 사용 금지 (`docs/operations/healthcheck.md` 의 Stage 3 ledger gate).

### 2-d. `unknown`

CLI 가 PATH 에 없거나 help 출력이 예상 surface 와 다른 경우. 갱신 전에 binary 자체를 재설치.

```bash
which claude codex gh
claude --version; codex --version; gh --version
# 재설치 후 Stage 1 healthcheck 재실행
npm run healthcheck:stage1
```

`UNKNOWN_UNTIL_STAGE3` 도 유사 — Stage 3 (`LLM_TEAM_LIVE_HEALTHCHECK=1 npm run healthcheck:stage3`) 로 확정한 뒤 위 모드 중 하나로 분류.

## 3. GH_TOKEN Rotation

`github` provider 사용 target 한정. fs-mirror provider 만 쓰는 target 은 본 절 불필요.

```bash
# 1. 새 token 발급 (GitHub UI). scope 는 기존 token 과 동일.
# 2. env 모드:
export GH_TOKEN="<new>"
# 또는 credential 모드:
gh auth refresh -s repo,workflow             # interactive
# 3. daemon 재기동
launchctl kickstart -k gui/$(id -u)/llm-team.daemon
# 4. phase-9a TeamMembership cache 만료 대기 또는 강제 무효화
#    (cache TTL 은 target.governance.human_team_cache_ttl_seconds 참조 — 단위: 초, default 300)
```

cache TTL 이 길게 설정된 경우 daemon 재기동만으로는 즉시 반영되지 않을 수 있다 — 재기동이 cache 를 비우는지 target 별로 확인.

## 4. Workdir 권한 정책

```bash
# production target 의 workdir 생성 / 검증
install -d -m 0700 "<identity.workdir_path>"
# 운영 user 가 owner 인지 확인
stat -f '%Su %Sp' "<identity.workdir_path>"   # macOS
stat -c '%U %a'   "<identity.workdir_path>"   # linux
# 파일 단위 0600 준수 — 위반 시 chmod
find "<identity.workdir_path>" -type f -not -perm 600 -exec chmod 0600 {} \;
find "<identity.workdir_path>" -type d -not -perm 700 -exec chmod 0700 {} \;
```

`onboarding.md §운영 환경 요구` 와 일관 — cycle bundle 디렉토리 0700 / 파일 0600 강제.

## 5. Cycle Bundle Retention (수동 cleanup)

phase-10b 정식 retention 구현 전 수동 가이드. cycle bundle 위치: `<workdir>/<target>/cycles/<Role>-<obj_id>-<hash12>/`.

```bash
# 30일 이상 디렉토리 archive
WORKDIR="<identity.workdir_path>/<target_id>/cycles"
find "$WORKDIR" -maxdepth 1 -type d -mtime +30 -print
# 검토 후 tarball 로 archive
find "$WORKDIR" -maxdepth 1 -type d -mtime +30 -print0 | \
  xargs -0 -I{} tar -czf "{}.tar.gz" "{}" && \
  find "$WORKDIR" -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
# 90일 이상 archive 도 정리
find "$WORKDIR" -maxdepth 1 -name "*.tar.gz" -mtime +90 -delete
```

정식 retention / prune (자동 archive, 신규 bundle 생성 차단 토글 등) 은 phase-10b backlog — 현재 소스에는 미구현. `LLM_TEAM_CYCLE_BUNDLE_DISABLED` 같은 차단 env 도 미구현이므로 수동 cleanup 만 가능.

## 6. Rate-Limit / Backoff

Phase-prod-2 의 adapter 는 `transport_error` (`reason: "rate_limit"`) 를 invalid outcome 으로 분류하고 **자동 재시도하지 않는다** (`src/application/turn-worker.ts` — "No retry"). 현재 cycle 은 실패로 종료되며, 다음 trigger 또는 daemon 재기동 시점까지 대기. 운영자 대응:

- **단일 attempt rate_limit**: cycle 종료 후 다음 trigger / daemon 재기동 시 자연 재시도. 즉시 회복이 필요하면 daemon 재기동.
- **연속 N회 rate_limit**: adapter diagnostics metadata (`os.tmpdir()/llm-team/runner/*.metadata.json`) 에 `"reason":"rate_limit"` 누적 → 운영자가 daemon 일시 정지 + provider quota 확인.
- **daily cap 도달**: healthcheck cost ledger (`~/.llm-team/healthcheck-cost-ledger.ndjson`) SKIP. 운영자가 cap 상향 또는 다음 UTC day 까지 대기.

```bash
# rate_limit 이 누적 중인지 빠르게 확인 — adapter diagnostics metadata
DIAGDIR="$(node -e 'console.log(require("os").tmpdir())')/llm-team/runner"
grep -lE '"reason":\s*"rate_limit"' "$DIAGDIR"/*.metadata.json 2>/dev/null | tail -20
# daemon 일시 정지 (운영체계 의존)
launchctl unload ~/Library/LaunchAgents/llm-team.daemon.plist
# provider 에서 quota 회복 후 재기동
launchctl load   ~/Library/LaunchAgents/llm-team.daemon.plist
```

## 7. Notifier Production 경로

기존 어댑터 재사용 — 본 cycle 에서 신규 notifier 코드 추가 없음.

| target.governance | NotifierPort 구현 | 산출 위치 |
|---|---|---|
| `human_team_provider: "github"` | `src/adapters/notifier/github.ts` (`GitHubNotifier`) | target issue/PR 댓글 |
| `human_team_provider: "fs-mirror"` | `src/adapters/notifier/fs-mirror.ts` (`FsMirrorNotifier`) | `<workdir>/<target>/external_mirror/notifications.ndjson` |

production failure report 는 위 경로로 전송된다. 별도의 production-only adapter 는 *없다* — `github` provider 사용 target 에 한해 phase-10 backlog 로 production-grade alerting (PagerDuty / Slack) 검토.

## 8. See Also

- [`docs/operations/healthcheck.md`](healthcheck.md) — Stage 1~3 healthcheck.
- [`docs/operations/onboarding.md`](onboarding.md) — onboarding gate / cycle bundle layout.
- [`docs/operations/production-target.md`](production-target.md) — target.json schema / sandbox 차이.
- [`docs/operations/e2e-go-no-go.md`](e2e-go-no-go.md) — go/no-go 결정 양식.
- [`docs/operations/production-migration-checklist.md`](production-migration-checklist.md) — migration 적용 결과.
- [`docs/operations/phase-prod-DoD.md`](phase-prod-DoD.md) — Phase 0~5 DoD evidence.
