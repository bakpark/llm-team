# llm-team

LLM Team은 사람과 LLM Agent가 소프트웨어 작업을 분업하기 위한 문서 우선 협업 모델이다. 핵심은 Agent를 자율 실행 주체로 보지 않고, **무상태 1회 호출로 콘텐츠만 만드는 역할**로 제한하는 것이다. 상태 전이와 영속 저장소 변경은 Caller가 수행하고, 사람은 승인·거부·회수·중단 같은 governance/input signal을 제공한다.

이 저장소의 현재 최우선 기준은 구현 코드가 아니라 `llm-team.md`와 `docs/contracts/`에 정의된 헌법 및 규약이다.

## Document Map

| 문서 | 역할 |
|---|---|
| [`llm-team.md`](llm-team.md) | 최상위 Concept / Constitution. 철학, layer, 권한 경계, 핵심 invariant를 정의한다. |
| [`docs/contracts/README.md`](docs/contracts/README.md) | Contract 문서 색인, 권위 순서, reference 규칙을 정의한다. |
| [`docs/contracts/agent-and-context-contract.md`](docs/contracts/agent-and-context-contract.md) | Agent 역할, Context Manifest, revision pin, output envelope를 정의한다. |
| [`docs/contracts/state-and-operation-contract.md`](docs/contracts/state-and-operation-contract.md) | Milestone / Task / Change Proposal 상태와 operation 전이를 정의한다. |
| [`docs/contracts/reliability-and-gate-contract.md`](docs/contracts/reliability-and-gate-contract.md) | lease, retry, 회수, 검증, human gate, ledger, pause 규칙을 정의한다. |
| [`docs/contracts/knowledge-contract.md`](docs/contracts/knowledge-contract.md) | 누적 스펙, manifest, decision log, context summary, AC traceability를 정의한다. |
| [`docs/architecture/`](docs/architecture/) | 위 헌법과 contract를 특정 구현 방식에 매핑하는 adapter 문서다. |

권위 순서는 다음과 같다.

1. [`llm-team.md`](llm-team.md)
2. [`docs/contracts/`](docs/contracts/)
3. [`docs/architecture/`](docs/architecture/) 및 구현 코드

하위 문서나 구현이 상위 문서와 충돌하면 상위 문서가 우선한다.

## Core Model

```text
Human governance/input signal
        ↓
Caller creates or claims workflow object with lease
        ↓
Caller builds Context Manifest + revision pins
        ↓
Agent returns content-only output envelope
        ↓
Caller validates output + revision pins
        ↓
Caller performs operational write
```

핵심 원칙은 한 줄로 요약된다.

> Agent는 콘텐츠만, Caller는 operational transition만, 사람은 governance/input signal만.

이 분리는 race condition, 비멱등 전이, LLM 메모리 의존, 책임 불명확성을 줄이기 위한 구조적 장치다. Agent 간 직접 호출이나 공유 메모리는 사용하지 않고, 모든 핸드오프는 영속 저장소 객체를 통해 이루어진다.

## Layers

| Layer | 책임 | 금지 |
|---|---|---|
| People | 스펙 입력, 승인·거부·회수·중단 signal, 모델 수정 승인 | 자동 workflow 전이의 비공식 우회 |
| Agents | Context Manifest 기반 self-fetch, 콘텐츠 생성 | 영속 저장소 직접 쓰기, 상태 변경, 병합, 검증 실행 |
| Caller | Agent 호출, output 검증, 상태 전이, lease, 회수, 알림, 병합, deterministic verification | 헌법과 contract 우회 |
| Persistent Store | 큐, 단일 진실 원천, 누적 산출물 저장 | 임의의 비공식 상태 소유 |

## Agent Roles

현재 contract는 7개 Agent 역할을 기준으로 한다.

| Agent | 주 책임 |
|---|---|
| PO | 제품 의도와 문제 정의를 Milestone 수준 산출물로 정리한다. |
| PM | Milestone을 사용자 시나리오와 acceptance criteria로 구체화한다. |
| Planner | Task 분해, 의존성, 작업 순서, 필요한 context 범위를 설계한다. |
| Coder | 할당된 Task 범위에서 코드 변경 콘텐츠를 만든다. |
| Reviewer | 변경 제안의 결함, 누락, 회귀 위험, contract 위반을 검토한다. |
| Integrator | 승인 가능한 변경을 통합 가능한 형태로 정리하고 충돌·재작업을 조정한다. |
| QA | Caller가 실행한 결정적 검증 결과를 해석하고 release 가능성을 판단한다. |

각 Agent의 상세 출력 계약은 [`Agent and Context Contract`](docs/contracts/agent-and-context-contract.md)가 정의한다. 구현 관점의 역할 설명은 [`docs/architecture/agents/`](docs/architecture/agents/)에 있다.

## Workflow Shape

기본 진행 동사는 다음 순서를 따른다.

```text
Compose-PO → Compose-PM → Decompose → Implement → Review → Refactor → Validate
```

역방향 이동은 명시적 회수로만 허용된다. 자동 재시도는 유한해야 하며, 한도를 넘으면 ESCALATED 상태로 사람에게 넘어간다. Human gate에 진입한 객체는 사람의 signal 전까지 다음 큐로 진행하지 않지만, Caller 프로세스는 다른 큐 처리를 계속할 수 있다.

상태와 operation의 authoritative source는 [`State and Operation Contract`](docs/contracts/state-and-operation-contract.md)다.

## Human Gates

사람은 상태 라벨이나 내부 marker를 임의로 다음 단계로 바꾸는 운영자가 아니다. 사람은 다음과 같은 signal을 영속 저장소에 남긴다.

- 승인
- 거부
- 수정 요청
- 회수 요청
- 시스템 pause / resume 요청
- 헌법 또는 contract 변경 승인

Caller는 signal의 권한, 대상 revision, gate 조건을 검증한 뒤 전이를 집행한다. 이 규칙은 [`Reliability and Gate Contract`](docs/contracts/reliability-and-gate-contract.md)가 정의한다.

## Architecture Adapters

[`docs/architecture/`](docs/architecture/)는 헌법과 contract를 구현 세계의 label, marker, helper, runner, CLI 호출에 매핑한다.

읽는 순서는 다음을 권장한다.

1. [`docs/architecture/state-machine.md`](docs/architecture/state-machine.md)
2. [`docs/architecture/agent-output-format-mapping.md`](docs/architecture/agent-output-format-mapping.md)
3. [`docs/architecture/agents/`](docs/architecture/agents/)
4. [`docs/architecture/daemons.md`](docs/architecture/daemons.md)
5. [`docs/architecture/tools.md`](docs/architecture/tools.md)

Architecture 문서는 adapter다. 상태명, output envelope, human signal schema, retry/lease semantics를 바꾸려면 먼저 contract를 확인해야 한다.

## Runtime Scaffold

권장 런타임 진입점은 [`bin/llm-team`](bin/llm-team) CLI다. CLI는 기존 runner,
daemon, label bootstrap 스크립트를 감싸는 얇은 control plane이다.

```bash
./scripts/install-cli.sh
llm-team doctor myapp
llm-team target add myapp --repo owner/repo
llm-team target add --url https://github.com/owner/repo.git

./bin/llm-team doctor myapp
./bin/llm-team target list
./bin/llm-team labels bootstrap myapp --dry-run
./bin/llm-team run po myapp --dry-run
./bin/llm-team daemon status myapp
./bin/llm-team status myapp
```

하위 실행 엔진은 [`scheduler/runner.sh`](scheduler/runner.sh)다.

```bash
./scheduler/runner.sh po myapp --dry-run
./scheduler/runner.sh planner myapp --dry-run
./scheduler/runner.sh coder myapp --dry-run
```

현재 runner는 contract 기반 골격을 먼저 보장한다. 역할과 operation을 매핑하고, Context Manifest를 만들고, prompt 위치와 기본 invariant를 검증한다. 실제 GitHub ready-object adapter는 이 골격 위에 붙여야 한다.

## Onboarding Gate

`run` / `run-once` / `daemon start` 진입점은 target 의 onboarding 체크리스트
(`github-pipeline/v1` preset) 를 hard gate 로 평가한다. block severity 항목이
하나라도 FAIL 이면 exit 2 로 차단한다.

```bash
llm-team onboarding status myapp        # PASS/FAIL/WARN/SKIP TSV
llm-team onboarding status myapp --json # JSON 형식
llm-team onboarding ack myapp branch_protection_policy_decided --note "도입 결정 완료"
llm-team onboarding wizard myapp        # TTY 대화형
llm-team onboarding list-schemas
```

게이트 우회 (각각 의도가 다르다):

- `--dry-run`: 실제 실행 없이 흐름만 확인. 게이트 자체를 건너뜀.
- `--allow-incomplete-onboarding`: 운영 권한자가 1 회 강제로 진행. warn 메시지 출력.
- `LLM_TEAM_SKIP_ONBOARDING_GATE=1`: 자동화/CI 환경에서 환경변수 우회. warn 메시지 출력.

### Existing targets migration

본 PR 이전에 만든 target.yaml 은 `onboarding:` 섹션이 없다. 게이트는 기본값
(`schema=github-pipeline/v1`, `self_hosting=false`, `acks={}`) 을 가정해 평가
하므로, `run` / `daemon start` 가 갑자기 차단될 수 있다. 기존 target 은 다음
순서로 보강한다.

1. `llm-team onboarding status <target>` 로 현재 FAIL 항목 확인.
2. 자동 검증 가능한 항목은 환경/파일 시스템 측에서 직접 해결 (예: workdir
   scaffold 누락이면 `llm-team target init <target>`).
3. 정책 결정 항목은 `llm-team onboarding ack <target> <key> --note "..."` 로
   ack. 키 목록은 `llm-team onboarding list-schemas` 의 출력 6 번째 칼럼.
4. 임시 우회가 필요한 자동화 흐름이 있다면 `LLM_TEAM_SKIP_ONBOARDING_GATE=1`
   또는 `--allow-incomplete-onboarding` 사용.

### Override `LLM_TEAM_ROOT`

`bin/llm-team` 은 외부에서 `LLM_TEAM_ROOT` 가 export 되어 있으면 그 값을
존중한다 (테스트 sandbox, symlink 배포, 외부 체크아웃 시 사용). 잘못된 root
가 export 되어 있으면 silent 하게 따라가므로, `doctor` 출력이 의외라면
환경변수를 먼저 점검한다.

## Implementation Notes

이 모델을 특정 저장소와 도구 위에 구현하려면 보통 다음 요소가 필요하다.

- 이슈 트래커 또는 queue 역할을 할 영속 저장소
- 버전 관리 시스템과 변경 제안 단위
- Caller runner와 worker slot / lease 관리
- LLM CLI 또는 provider adapter
- 결정적 검증을 실행할 빌드·테스트·린트·타입체크 명령
- 선택적 알림 채널

도구 제품명은 모델의 본질이 아니다. GitHub, 다른 이슈 트래커, 다른 LLM CLI, 다른 CI 환경으로 교체해도 `llm-team.md`의 invariant와 contract가 유지되어야 한다.

## Change Rules

- 최상위 철학, layer, 권한 경계, invariant를 바꾸는 변경은 [`llm-team.md`](llm-team.md)를 수정해야 한다.
- 구체 상태, output 형식, retry, gate, knowledge 형식을 바꾸는 변경은 [`docs/contracts/`](docs/contracts/)를 수정해야 한다.
- 구현 adapter만 바꾸는 변경은 [`docs/architecture/`](docs/architecture/)에서 처리하되 contract를 override할 수 없다.
- 같은 개념을 여러 문서에 중복 정의하지 않는다. 한 문서를 authoritative source로 두고 다른 문서는 reference한다.

## Current Status

현재 저장소는 문서와 contract 정합성을 우선으로 정리되어 있다. 구현 코드가 contract와 다르면 구현을 수정하거나, 사람 승인으로 contract 변경 제안을 제출해야 한다.
