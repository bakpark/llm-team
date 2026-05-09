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

## Implementation Status

새 구현은 TypeScript / Node ≥ 20 기반으로 진행 중이며, 현재 **agent runner port + LLM provider adapter 계층** (`src/ports/llm-runner*.ts`, `src/adapters/llm-runner/{claude-code,codex-cli,fake}.ts`, `src/config/`) 이 자리 잡혀 있다. workspace adapter, prompt builder, caller dispatch, envelope parser 등 나머지 영역은 후속 plan 으로 이어진다.

docs 본문에 남아 있는 `application/...sh`, `lib/...sh`, `adapters/...sh` 등의 경로는 새 TS 모듈로 재매핑이 진행되면 docs 가 갱신된다.

### 빠른 시작

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p tsconfig.json → dist/
```

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
