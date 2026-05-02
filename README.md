# llm-team

LLM Team 은 사람과 LLM Agent 가 소프트웨어 작업을 분업하기 위한 문서 우선 협업 모델이다. Agent 는 무상태 1회 호출로 콘텐츠만 만들고, Caller 가 상태 전이와 영속 저장소 변경을 수행하며, 사람은 승인·거부·회수·중단 같은 governance/input signal 을 제공한다.

이 저장소의 최우선 기준은 구현 코드가 아니라 [`llm-team.md`](llm-team.md) 와 [`docs/contracts/`](docs/contracts/) 에 정의된 헌법 및 규약이다.

> Agent 는 콘텐츠만, Caller 는 operational transition 만, 사람은 governance/input signal 만.

## Read in This Order

| 목적 | 시작 문서 |
|---|---|
| 모델의 철학·원칙·layer·invariant 를 이해하려면 | [`llm-team.md`](llm-team.md) |
| 상태·output·gate·knowledge 규약을 알아야 한다면 | [`docs/contracts/README.md`](docs/contracts/README.md) |
| 구현·CLI·GitHub adapter 를 매핑해야 한다면 | [`docs/architecture/README.md`](docs/architecture/README.md) |
| 일상 운영 (CLI / onboarding gate) | [`docs/operations/`](docs/operations/) |

권위 순서와 reference 규칙은 [`docs/contracts/README.md#CONTRACT-AUTHORITY`](docs/contracts/README.md#CONTRACT-AUTHORITY) 가 정의한다. 하위 문서가 상위 문서와 충돌하면 상위 문서가 우선한다.

## Repository Map

| 경로 | 역할 |
|---|---|
| [`llm-team.md`](llm-team.md) | 최상위 Concept / Constitution. |
| [`docs/contracts/`](docs/contracts/) | Operational contract set (authoritative). |
| [`docs/architecture/`](docs/architecture/) | Contract → 구현 매핑 (adapter). |
| [`docs/operations/`](docs/operations/) | CLI / onboarding gate 등 운영 매뉴얼. |
| [`docs/history/`](docs/history/) | 진행 중·완료된 방향성 기록. |
| `bin/`, `scheduler/`, `scripts/` | CLI, runner, 설치 스크립트. |
| `application/`, `lib/`, `adapters/` | Caller use-case 모듈, helper, GitHub/LLM adapter. |
| `prompts/` | 7 개 Agent 역할 prompt. |
| `targets/`, `workdir/` | Target 설정과 작업 디렉토리. |
| `tests/` | bash / contract 테스트. |

## Quick Start

```bash
./scripts/install-cli.sh                                  # ~/.local/bin/llm-team symlink (PATH 필요)
./bin/llm-team target add <target> --repo owner/repo
./bin/llm-team target init <target>                       # workdir scaffold 생성
./bin/llm-team doctor <target>
./bin/llm-team run po <target> --dry-run
```

`~/.local/bin` 이 PATH 에 있으면 `./bin/` 접두사 없이 `llm-team` 으로 호출할 수 있다. CLI 사용법 / `LLM_TEAM_ROOT` override 는 [`docs/operations/cli.md`](docs/operations/cli.md), onboarding gate 는 [`docs/operations/onboarding.md`](docs/operations/onboarding.md) 를 본다.

## Change Routing

| 변경 종류 | 수정할 곳 |
|---|---|
| 철학, layer, 권한 경계, invariant | [`llm-team.md`](llm-team.md) (사람 승인 필요) |
| 상태, output 형식, retry, gate, knowledge schema | [`docs/contracts/`](docs/contracts/) |
| 구현 매핑 (label, marker, helper, runner, adapter) | [`docs/architecture/`](docs/architecture/) — contract 를 override 할 수 없음 |
| CLI / onboarding 운영 절차 | [`docs/operations/`](docs/operations/) |
| 코드 변경 | 해당 모듈 + 관련 contract 정합성 확인 |

같은 개념을 여러 문서에 중복 정의하지 않는다. 한 문서가 authoritative source 가 되고 다른 문서는 reference 만 둔다.

## Status

문서와 contract 정합성을 우선으로 정리되어 있다. 구현이 contract 를 충족하지 못하면 구현을 수정하거나, 사람 승인으로 contract 변경 제안을 제출한다.
