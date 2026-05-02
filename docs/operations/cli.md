# CLI Operations

`bin/llm-team` 은 기존 runner, daemon, label bootstrap 스크립트를 감싸는 얇은 control plane CLI 다. 일상 운영은 이 CLI 를 진입점으로 한다.

## Install / Target Bootstrap

```bash
./scripts/install-cli.sh                                  # ~/.local/bin/llm-team symlink
./bin/llm-team target add <target> --repo owner/repo
./bin/llm-team target add --url https://github.com/owner/repo.git
./bin/llm-team target init <target>                       # workdir scaffold 생성
./bin/llm-team doctor <target>
```

`~/.local/bin` 이 `PATH` 에 있으면 이후부터는 `./bin/` 접두사 없이 `llm-team ...` 으로 호출할 수 있다. `install-cli.sh` 는 PATH 미포함 시 warn 만 출력하므로, 신규 셸에서 명령이 보이지 않는다면 PATH 부터 확인한다.

## Common Commands

`<target>` 자리에는 `target add` 로 만든 yaml 의 `name` 을 넣는다.

```bash
./bin/llm-team target list
./bin/llm-team labels bootstrap <target> --dry-run
./bin/llm-team run po <target> --dry-run
./bin/llm-team daemon status <target>
./bin/llm-team status <target>
```

## Underlying Runner

CLI 가 호출하는 하위 실행 엔진은 [`scheduler/runner.sh`](../../scheduler/runner.sh) 다. 직접 호출이 필요할 때는 다음과 같이 사용한다.

```bash
./scheduler/runner.sh po <target> --dry-run
./scheduler/runner.sh planner <target> --dry-run
./scheduler/runner.sh coder <target> --dry-run
```

현재 runner 는 contract 기반 골격을 먼저 보장한다. 역할과 operation 을 매핑하고, Context Manifest 를 만들고, prompt 위치와 기본 invariant 를 검증한다. 실제 GitHub ready-object adapter 는 이 골격 위에 붙는다.

## `LLM_TEAM_ROOT` Override

`bin/llm-team` 은 외부에서 `LLM_TEAM_ROOT` 가 export 되어 있으면 그 값을 존중한다. 다음 상황에서 사용한다.

- 테스트 sandbox
- symlink 배포
- 외부 체크아웃 위에서 CLI 만 실행하고 싶은 경우

잘못된 root 가 export 되어 있으면 silent 하게 따라가므로, `doctor` 출력이 의외라면 환경변수를 가장 먼저 점검한다.

## See Also

- [`docs/operations/onboarding.md`](onboarding.md) — onboarding gate 평가 / ack / migration.
- [`docs/architecture/daemons.md`](../architecture/daemons.md) — daemon lifecycle / worker slot / lease 운영.
- [`docs/architecture/tools.md`](../architecture/tools.md) — `gh`/`git`/LLM CLI 매핑.
