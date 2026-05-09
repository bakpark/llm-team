# Production Runbook

production target 진입 후의 daemon / 인증 / workdir / cycle bundle / rate-limit 운영 절차. operator 가 5분 안에 읽고 실행한다. 인증 분기는 `verified_auth_model` (Phase 1 stage 1 + Phase 3 stage 3) 의 4 모드 (`env_token` / `credential_file` / `interactive_only` / `unknown`) 를 따른다.

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

## 2. 인증 갱신 절차 — `verified_auth_model` 모드별 분기

`<RUN_DIR>/verified-auth-model.json` (Stage 3 산출) 에서 `claude.status` / `codex.status` / 운영 정보로 모드를 판정한다. Stage 1 의 `auth_models.{claude,codex,gh}` 도 동일 enum 사용.

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
# claude — credential path 후보 (실제 경로는 binary 버전 의존, healthcheck stage 3 산출에서 확정)
claude /login                              # interactive login
chmod 0600 ~/.claude/credentials.json      # 또는 ~/.config/claude/credentials.json
# codex — credential path 후보 (binary 버전 의존)
codex login                                # interactive (정확한 명령은 codex --help 참조)
chmod 0600 ~/.codex/credentials.json       # 또는 ~/.config/codex/auth.json
# 재기동
launchctl kickstart -k gui/$(id -u)/llm-team.daemon
```

실제 credential path 는 운영 시점 healthcheck Stage 3 의 `verified-auth-model.json.detail` 에서 확정. file mode 0600 미충족 시 daemon healthcheck 가 advisory 로 warn.

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
#    (cache TTL 은 target.governance.team_membership_cache_ttl_ms 참조)
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
WORKDIR="<identity.workdir_path>/cycles"
find "$WORKDIR" -maxdepth 1 -type d -mtime +30 -print
# 검토 후 tarball 로 archive
find "$WORKDIR" -maxdepth 1 -type d -mtime +30 -print0 | \
  xargs -0 -I{} tar -czf "{}.tar.gz" "{}" && \
  find "$WORKDIR" -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
# 90일 이상 archive 도 정리
find "$WORKDIR" -maxdepth 1 -name "*.tar.gz" -mtime +90 -delete
```

`LLM_TEAM_CYCLE_BUNDLE_DISABLED=1` 로 신규 bundle 생성을 일시 차단 가능. 정식 retention / prune 은 phase-10b backlog.

## 6. Rate-Limit / Backoff

Phase-prod-2 의 adapter 가 `transport_error` (`reason: "rate_limit"`) 로 분류한 attempt 는 retry 정책에 따라 자동 backoff. 운영자 대응:

- **단일 attempt 실패**: adapter 가 다음 attempt 로 자동 재시도. 운영자 개입 불필요.
- **연속 N회 rate_limit**: cycle bundle 의 `attempts/*/diagnostics.txt` 에 `reason=rate_limit` 누적 → 운영자가 daemon 일시 정지 + provider quota 확인.
- **daily cap 도달**: healthcheck cost ledger (`~/.llm-team/healthcheck-cost-ledger.ndjson`) SKIP. 운영자가 cap 상향 또는 다음 UTC day 까지 대기.

```bash
# rate_limit 이 누적 중인지 빠르게 확인
WORKDIR="<identity.workdir_path>/cycles"
grep -lr 'reason=rate_limit' "$WORKDIR" | tail -20
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
