# llm-team

PO/PM/DEV/QA 4개 에이전트 + Scheduler + Notifier로 구성된 다중 타겟 GitHub 자동화 프레임워크. 4개의 long-running 데몬이 1-shot Claude Code 호출로 각 에이전트를 깨우고, 협업은 GitHub의 Milestones/Issues/PR/Labels로 이루어진다.

## 개요

`inputs/<target>/*.md` 아이디어 문서를 시작점으로, PO가 GitHub Milestone을 만들고, PM이 Milestone을 user scenario 단위 Issue로 분해하고, DEV가 Issue마다 branch+PR을 작성하고, QA가 PR을 검증해 merge 또는 회수한다. 각 에이전트 간 핸드오프는 GitHub 라벨 상태 머신으로만 이루어지며, 사람의 승인은 `needs-human-review:*` 라벨 시점에 Discord/Slack 알림과 함께 발생한다.

```
inputs/<target>/*.md
        ↓
PO ─→ Milestone ─→ [사람 승인]
        ↓
PM ─→ Issue × N ─→ [사람 승인]
        ↓                    ↑
DEV ─→ branch + PR     (1차 실패 시 재작업)
        ↓                    │
QA ─→ merge or 회수 ─────────┘
```

자세한 설계는 `.plan/26050116-architecture/planning.md`, daemon/self-fetch 변경은 `.plan/26050112-daemon-self-fetch/planning.md` 참조.

## 요구사항

- [`gh`](https://cli.github.com/) CLI (인증 완료 — `gh auth login`)
- [`claude`](https://docs.claude.com/en/docs/claude-code) CLI (인증 완료)
- `git`, `flock`
- [`jq`](https://stedolan.github.io/jq/) — JSON 파싱
- [`yq`](https://github.com/mikefarah/yq) — YAML 파싱

macOS Homebrew 설치 예시:

```bash
brew install gh git jq yq flock
gh auth login
# claude는 별도 설치 + 인증 (Anthropic 가이드 참조)
```

## 새 타겟 등록 절차

1. `targets/<name>.yaml` 작성. 스키마는 `targets/myapp.yaml` 참고.
2. `cp .env.example .env` 후 `GH_TOKEN`과 필요한 webhook 값 채우기.
3. `scripts/bootstrap-labels.sh <name>` 실행 → 12개 라벨을 타겟 repo에 생성.
4. `inputs/<name>/` 디렉토리에 아이디어 markdown 추가 (PO Agent의 입력).

## 데몬 운영 모델

각 agent는 **단일 인스턴스 long-running 데몬**으로 실행한다. 시스템 전체에서 동일 agent의 동시 실행이 일어나지 않도록 `flock`이 자체 보장하며, agent 간 동시성 제어는 GitHub 라벨 atomic 전이만 사용한다 (외부 lock 추가 없음).

### 수동 실행 (개발/테스트)

```bash
# 기본 polling 주기 (PO 600s / PM 300s / DEV 120s / QA 120s) 사용
./scheduler/daemon.sh po &
./scheduler/daemon.sh pm &
./scheduler/daemon.sh dev &
./scheduler/daemon.sh qa &

# 종료
kill -TERM <pid>   # graceful: 진행 중 tick 마무리 후 종료
```

### 1회 tick (smoke test)

```bash
LLM_TEAM_DAEMON_ONCE=1 LLM_TEAM_DAEMON_TARGET=myapp ./scheduler/daemon.sh po
```

### 환경 변수

| 변수 | 용도 |
|---|---|
| `LLM_TEAM_DAEMON_INTERVAL` | polling 주기 초 단위 override (기본은 agent별) |
| `LLM_TEAM_DAEMON_ONCE=1` + `LLM_TEAM_DAEMON_TARGET=<name>` | 1 tick 실행 후 종료 (테스트용) |
| `LLM_TEAM_CLAUDE_CMD` | claude CLI 호출 명령 override (기본 `claude -p --output-format text`) |

### macOS launchd 등록

데몬 자동 시작/재시작은 launchd로 관리한다. 예시 plist는 `docs/superpowers/specs/launchd/`에 있다.

```bash
# plist 4개를 LaunchAgents로 복사 + path 치환
for agent in po pm dev qa; do
  sed "s|__LLM_TEAM_ROOT__|$(pwd)|g; s|__USER_HOME__|${HOME}|g" \
    docs/superpowers/specs/launchd/com.llm-team.${agent}.plist \
    > ~/Library/LaunchAgents/com.llm-team.${agent}.plist
  launchctl load ~/Library/LaunchAgents/com.llm-team.${agent}.plist
done

# 상태 확인 / 종료
launchctl list | grep llm-team
launchctl unload ~/Library/LaunchAgents/com.llm-team.po.plist
```

`KeepAlive=true`이므로 데몬이 죽으면 launchd가 자동 재시작한다.

### Linux systemd 등록 (참고)

systemd unit은 `docs/superpowers/specs/launchd/`에 포함되지 않으나, 동일 패턴으로 작성:

```ini
# /etc/systemd/system/llm-team-po.service
[Service]
Type=simple
WorkingDirectory=/path/to/llm-team
ExecStart=/path/to/llm-team/scheduler/daemon.sh po
EnvironmentFile=/path/to/llm-team/.env
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

### 인증 / PATH 주의사항

데몬 환경의 PATH가 좁으면 `gh`, `claude`, `jq`, `yq` 호출이 실패한다. launchd plist에서 PATH를 명시하거나 `.env`에 export하는 것을 권장:

```bash
# .env에 추가 (데몬이 source하지는 않으나, lib/config.sh#resolve_secret이 .env를 lazy-read함)
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
GH_TOKEN=ghp_...
ANTHROPIC_API_KEY=sk-ant-...   # claude CLI가 사용하는 경우
```

`gh`/`claude`가 자체 config(`~/.config/gh/`, `~/.claude/`)로 인증되어 있다면 위 토큰은 불필요. 단, launchd plist의 `EnvironmentVariables.HOME`이 사용자 홈을 가리키도록 설정되어 있어야 자체 config 접근 가능.

## 사람 승인 게이트

`needs-human-review:*` 라벨이 붙으면 GitHub web에서 Milestone/Issue 본문을 검토한 뒤 라벨을 다음 상태로 수동 교체한다:

| 트리거 라벨 | 검토 대상 | 다음 라벨 |
|---|---|---|
| `needs-human-review:milestone` | Milestone 본문 (PO 산출) | `needs-scenarios` |
| `needs-human-review:scenario` | Issue 본문 (PM 산출) | `needs-dev` |
| `needs-human-review:dev-failure` | Issue/PR (QA 2차 실패 또는 git 실패) | 수동 처리 (재시작 / scope 변경 / close) |

알림은 `targets/<name>.yaml`의 `notifier.channel` (`discord` | `slack` | `none`)에 따라 분기된다.

## 로그 위치

- 각 에이전트 실행 로그: `workdir/<target>/logs/<agent>-<timestamp>.log`
- 데몬 표준 출력: launchd plist의 `StandardOutPath` / `StandardErrorPath` 참조
- `workdir/daemon-<agent>.lock` / `workdir/daemon-<agent>.lock.pid` — 단일 인스턴스 lock

`workdir/`은 `.gitignore`에 의해 추적되지 않는다. 누적 로그 정리는 별도 cron 권장:

```
0 3 * * * find /path/to/llm-team/workdir -name "*.log" -mtime +14 -delete
```

## cron 운영 (legacy / 대안)

데몬 대신 cron을 쓰고 싶다면 다음 라인을 사용. 단 macOS sleep 시 trigger가 누락되며 외부 lock 부재라 동시 실행 위험이 있으므로 **데몬 사용을 권장**한다.

```
*/10 * * * * cd /path/to/llm-team && set -a; [ -f .env ] && . .env; set +a; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH scheduler/run-po.sh myapp >> workdir/myapp/logs/po-cron.log 2>&1
*/5  * * * * cd /path/to/llm-team && set -a; [ -f .env ] && . .env; set +a; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH scheduler/run-pm.sh myapp >> workdir/myapp/logs/pm-cron.log 2>&1
*/2  * * * * cd /path/to/llm-team && set -a; [ -f .env ] && . .env; set +a; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH scheduler/run-dev.sh myapp >> workdir/myapp/logs/dev-cron.log 2>&1
*/2  * * * * cd /path/to/llm-team && set -a; [ -f .env ] && . .env; set +a; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH scheduler/run-qa.sh myapp >> workdir/myapp/logs/qa-cron.log 2>&1
```

## MVP 통과 시나리오

`inputs/myapp/auth.md` 1개 파일을 시작점으로 PO → 사람 승인 → PM → 사람 승인 → DEV → QA → merge까지 end-to-end 1회 통과를 검증한다. 자세한 절차는 `.plan/26050116-architecture/planning.md` §10 또는 `.plan/26050116-architecture/sub-e2e-verification.md` 참조.
