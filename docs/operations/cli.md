# CLI Operations

현재 운영 CLI 는 repository-local TypeScript entrypoint 다. `bin/llm-team`,
`scheduler/runner.sh`, `scripts/install-cli.sh` 기반 shell wrapper 는 더 이상
존재하지 않는다.

## Entrypoints

| 목적 | 명령 |
|---|---|
| Stage 1~3 healthcheck | `npm run healthcheck -- --stage <1\|2\|3> [--target <path>] [--out <dir>] [--json]` |
| 단일 inner forge turn | `npx tsx src/cli/runner.ts --once --agent-profile forge --target <target.json>` |
| 단일 middle review turn | `npx tsx src/cli/runner.ts --once --dialogue-coordinator --target <target.json>` |
| daemon role | `npx tsx src/cli/daemon.ts --role <role> --target <target.json>` |
| ledger summary | `npm run ledger-summary -- --ledger <path> [--out <path>] [--format json\|text]` |

`--workdir <path>` 를 주면 target 의 `identity.workdir_path` 대신 해당
디렉토리를 사용한다. 테스트용으로만 `--fake-llm-fixtures`,
`--fake-workspace`, `--fake-verification`, `LLM_TEAM_ALLOW_FAKE_RUNNER=1` 을
사용한다.

## Daemon Roles

`src/cli/daemon.ts` 는 다음 role 을 지원한다.

```text
turn-worker
dialogue-coordinator
outer-coordinator
dual-track-scheduler
recovery
drift-observer
scout-scanner
```

기본 cycle interval 은 1초다. `drift-observer` 는 기본 60초,
`scout-scanner` 는 기본 300초를 쓴다. 명시적으로 조정하려면
`--cycle-interval-ms <ms>` 를 넘긴다. 한 cycle 만 실행하려면 `--once` 를
사용한다.

각 daemon 은 `<workdir>/log/daemon-<role>.pid.lock` 을 잡는다. 같은 role 을
중복 기동하면 lockdir 충돌로 fail-fast 한다.

## Healthcheck

```bash
npm run healthcheck:stage1
npm run healthcheck:stage2
LLM_TEAM_LIVE_HEALTHCHECK=1 npm run healthcheck:stage3
```

Stage 3 live probe 는 비용 cap 을 따른다.

| env | default |
|---|---|
| `LLM_TEAM_LIVE_COST_CAP_USD` | `0.10` |
| `LLM_TEAM_LIVE_DAILY_COST_CAP_USD` | `1.00` |
| `LLM_TEAM_HEALTHCHECK_COST_LEDGER` | unset 시 workdir 또는 `~/.llm-team/healthcheck-cost-ledger.ndjson` |

## Diagnostics

LLM runner attempt 는 기본적으로 `${TMPDIR}/llm-team/runner` 아래에
`*.prompt`, `*.stdout`, `*.stderr`, `*.envelope`, `*.metadata.json` 을 남긴다.
위치는 `LLM_TEAM_RUNNER_DIAG_DIR` 로 바꿀 수 있다. 디렉토리는 0700, 파일은
0600 으로 강제된다.

## See Also

- [`healthcheck.md`](healthcheck.md) — Stage 1~3 probe 의미와 산출물.
- [`onboarding.md`](onboarding.md) — 신규 target 운영 전 preflight 절차.
- [`production-runbook.md`](production-runbook.md) — daemon / 인증 / workdir 운영.
- [`../architecture/daemons.md`](../architecture/daemons.md) — daemon lifecycle / worker slot / lease 운영.
