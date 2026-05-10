# Production Runbook

production target 진입 후의 daemon / 인증 / workdir / diagnostics /
rate-limit 운영 절차. operator 가 5분 안에 읽고 실행한다. 인증 분기는
Stage 1 healthcheck 산출 `Stage1Result.auth_models.{claude,codex,gh}` 의
모드 (`env_token` / `keychain` / `other` / `interactive_only` /
`UNKNOWN_UNTIL_STAGE3` / `unknown`) 를 따른다. Stage 3 의
`verified-auth-model.json.<surface>.status` 는 별개 enum (`PASS` / `FAIL` /
`SKIP`) 으로 live-probe 결과만 기록한다.

## 1. Daemon User ↔ CLI Auth User 일치

daemon 과 CLI 가 동일한 운영 user 로 실행되어야 한다. daemon 은
`launchctl` plist 나 systemd unit 에서 명시된 user 로 기동하며, CLI 는
현재 셸의 user 로 인증 토큰을 읽는다. 불일치 시 `interactive_only` 모드로
강제된다.

```bash
whoami                          # CLI user
ps aux | grep llm-team.daemon   # daemon user 확인
gh auth status                  # gh 인증 상태
```

## 2. 인증 갱신 절차 — `auth_models` 모드별 분기

Stage 1 healthcheck 산출 `Stage1Result.auth_models.{claude,codex,gh}` 에서
인증 모드를 판정한다. Stage 3 의 `<RUN_DIR>/verified-auth-model.json` 은
surface 별 live-probe 결과 (`PASS` / `FAIL` / `SKIP`) 와 `detail` 문자열만
기록하므로 모드 판정에는 사용하지 않는다.

### 2-a. `env_token`

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# 또는 .env 파일에 기록 후 source
launchctl kickstart -k gui/$(id -u)/llm-team.daemon
```

`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 는 redact-suffix policy 대상 (`src/adapters/llm-runner/common/redact.ts`) — 로그에 평문 노출 금지.

### 2-b. `keychain` / `other`

CLI 가 OS credential store 또는 provider-specific local credential 을 읽는
모드. 갱신은 interactive login 후 관련 credential file mode 를 0600 으로
강제한다.

```bash
# claude
claude /login                              # interactive login
chmod 0600 ~/.config/claude/credentials
# codex
codex login                                # interactive (정확한 명령은 codex --help 참조)
chmod 0600 ~/.config/codex/credentials
# 재기동
launchctl kickstart -k gui/$(id -u)/llm-team.daemon
```

binary 버전이 다른 경로를 사용하는 경우 운영자가 수동 확인 — file mode
0600 강제는 운영자 책임 (자동 검사 미구현).

### 2-c. `interactive_only`

non-interactive 환경에서 실행 시 fallback. daemon 재기동 시 interactive
session 이 열리지 않으면 인증이 유지되지 않는다. 운영 서버에서는 이 모드를
사용하지 말 것.

## 3. Workdir 권한 검증

production workdir 는 운영 user 소유 0700 디렉토리여야 한다. 파일은 0600.

```bash
# workdir 생성 (첫 실행 시)
install -d -m 0700 "<identity.workdir_path>"

# 기존 workdir 권한 검증
find "<identity.workdir_path>" -type d -not -perm 700 -exec chmod 0700 {} \;
find "<identity.workdir_path>" -type f -not -perm 600 -exec chmod 0600 {} \;
```

`onboarding.md §운영 환경 요구` 와 일관 — workdir / diagnostics 디렉토리
0700, 파일 0600 을 기준으로 한다.

## 5. Diagnostics Retention (수동 cleanup)

runner diagnostics 는 기본적으로 `${TMPDIR}/llm-team/runner` 에 기록된다.
`LLM_TEAM_RUNNER_DIAG_DIR` 를 설정하면 위치를 바꿀 수 있다. 정식 retention
/ prune 구현 전에는 수동 cleanup 을 사용한다.

```bash
DIAGDIR="${LLM_TEAM_RUNNER_DIAG_DIR:-$(node -e 'console.log(require("os").tmpdir())')/llm-team/runner}"
find "$DIAGDIR" -type f -mtime +30 -print
# 검토 후 삭제
find "$DIAGDIR" -type f -mtime +30 -delete
```

`src/persistence/cycle-bundle-minimal.ts` 는 minimal writer 를 제공하지만 현재
production CLI path 에 자동 통합되어 있지 않다.

## 6. Rate-Limit / Backoff

adapter 는 `transport_error` (`reason: "rate_limit"`) 를 invalid outcome 으로
분류하고 자동 재시도하지 않는다. 현재 cycle 은 실패로 종료되며, 다음
trigger 또는 daemon 재기동 시점까지 대기. 운영자 대응:

- **단일 attempt rate_limit**: cycle 종료 후 다음 trigger / daemon 재기동 시 자연 재시도. 즉시 회복이 필요하면 daemon 재기동.
- **연속 N회 rate_limit**: adapter diagnostics metadata (`os.tmpdir()/llm-team/runner/*.metadata.json`) 에 `"reason":"rate_limit"` 누적 → 운영자가 daemon 일시 정지 + provider quota 확인.

## 7. Failure Report 전송 경로

production failure report 는 위 경로로 전송된다. 별도의 production-o
report collector 가 없는 경우 runner diagnostics metadata 만 남는다.

## 8. See Also

- [`docs/operations/healthcheck.md`](healthcheck.md) — Stage 1~3 healthcheck.
- [`docs/operations/cli.md`](cli.md) — 현재 TypeScript CLI entrypoint.
- [`docs/operations/onboarding.md`](onboarding.md) — target preflight.
- [`docs/operations/production-target.md`](production-target.md) — target.json schema / sandbox 차이.
