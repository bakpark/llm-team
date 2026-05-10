# Onboarding / Preflight

현재 코드에는 standalone `llm-team onboarding ...` CLI 가 없다. 운영 진입
전 검증은 target schema validation, healthcheck, workdir/auth 점검을 조합해
수행한다. `TCC-ONBOARDING` contract 항목은 남아 있지만 runtime
`TargetConfig` schema 에는 아직 onboarding block 이 wired 되어 있지 않다.

## Target Config

1. production target JSON 을 작성한다. 필드별 권장값은
   [`production-target.md`](production-target.md) 를 따른다.
2. schema validation 은 `src/application/config-validator.ts` 의
   `validateOrThrow` 가 기준이다. CLI 진입점도 target load 시 이 validation 을
   먼저 수행한다.
3. 운영 전 최소 확인:

```bash
npm run typecheck
npm run healthcheck:stage1 -- --target <target.json>
npm run healthcheck:stage2 -- --target <target.json>
```

live LLM smoke 가 필요한 경우에만 비용 cap 을 설정하고 Stage 3 를 실행한다.

```bash
LLM_TEAM_LIVE_COST_CAP_USD=0.10 \
LLM_TEAM_LIVE_DAILY_COST_CAP_USD=1.00 \
LLM_TEAM_LIVE_HEALTHCHECK=1 \
npm run healthcheck:stage3 -- --target <target.json> --out <run-dir>
```

## 운영 환경 요구

- Node.js 는 `package.json#engines.node` 기준을 만족해야 한다.
- `claude`, `codex`, `gh`, `git`, `node` 가 PATH 에 있어야 한다. `jq` 는
  optional 이다.
- `timeout` 또는 `gtimeout` 바이너리가 PATH 에 있어야 한다. macOS 는 기본
  미포함이므로 필요 시 GNU coreutils 를 설치한다.
- daemon user 와 CLI auth user 를 일치시킨다. 자세한 인증 분기는
  [`production-runbook.md`](production-runbook.md) 를 따른다.
- production workdir 는 운영 user 소유 0700 디렉토리로 만든다.

```bash
install -d -m 0700 "<identity.workdir_path>"
```

## Runtime Artifacts

- daemon log: `<workdir>/log/daemon.ndjson`
- daemon role lock: `<workdir>/log/daemon-<role>.pid.lock`
- runner diagnostics: `${LLM_TEAM_RUNNER_DIAG_DIR}` 또는
  `${TMPDIR}/llm-team/runner`
- healthcheck cost ledger:
  `LLM_TEAM_HEALTHCHECK_COST_LEDGER`, target workdir, 또는
  `~/.llm-team/healthcheck-cost-ledger.ndjson`

`src/persistence/cycle-bundle-minimal.ts` 는 minimal cycle bundle writer 를
제공하지만 현재 production CLI path 에는 자동 통합되어 있지 않다. 일반
운영 디버깅은 runner diagnostics 를 기준으로 한다.

## See Also

- [`cli.md`](cli.md) — 현재 TypeScript CLI entrypoint.
- [`healthcheck.md`](healthcheck.md) — healthcheck stages.
- [`production-target.md`](production-target.md) — target.json 작성 가이드.
- [`production-runbook.md`](production-runbook.md) — daemon / 인증 / workdir 운영.
