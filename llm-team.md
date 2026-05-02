# LLM Team

본 문서는 LLM 에이전트와 사람이 협업해 소프트웨어를 만드는 최상위 Concept 문서다. 도구·플랫폼 중립적이며, 어떤 이슈 트래커·버전 관리 시스템·알림 채널·런타임 위에서도 동일한 원칙으로 구현 가능해야 한다.

이 문서는 모델의 철학과 불변식을 정의한다. 구체 상태명, 출력 형식, 전이 조건, 회수 정책, 누적 지식 형식은 `docs/contracts/` 아래 contract 문서가 정의한다. contract 문서나 구현이 본 문서와 충돌하면 **본 문서가 우선**한다.

---

## Document Set

규범 문서는 두 층으로 나뉜다.

| 문서 | 역할 |
|---|---|
| `llm-team.md` | 최상위 Concept / Constitution. 철학, layer, 권한 경계, 핵심 invariant를 정의한다. |
| `docs/contracts/README.md` | Contract 문서 색인, 권위 순서, reference 규칙을 정의한다. |
| `docs/contracts/agent-and-context-contract.md` | Agent 역할, Context Manifest, revision pin, output contract를 정의한다. |
| `docs/contracts/state-and-operation-contract.md` | Milestone / Task / Change Proposal 상태와 operation 전이를 정의한다. |
| `docs/contracts/reliability-and-gate-contract.md` | lease, 회수, 검증, human gate, transition ledger, pause 정책을 정의한다. |
| `docs/contracts/knowledge-contract.md` | 누적 스펙, manifest, decision log, context summary, AC traceability를 정의한다. |

`docs/architecture/` 등 다른 문서는 구현 또는 설명 문서로 간주한다. 그 문서들은 본 문서와 contract 문서를 보완할 수 있지만, override하지 않는다.

---

## Core Idea

LLM에게 소프트웨어를 만들게 하는 흔한 접근은 둘 중 하나다. 단일 LLM에게 거대한 작업을 한 번에 끝까지 끌고 가게 하거나, 여러 에이전트를 직접 호출·메모리 공유로 묶어 자율적으로 협업시키는 것이다. 전자는 컨텍스트 폭주와 검증 부재로 무너지고, 후자는 race condition·책임 분산·비멱등성으로 무너진다. 사람이 모든 검토를 떠안으면 처리량이 한계가 된다.

본 모델의 접근은 다르다. **에이전트는 무상태 1회 호출로 콘텐츠만 만들고, 호출자(스케줄러)는 workflow의 operational transition만 수행하며, 사람은 governance/input signal로 스펙·게이트를 정의한다.** 세 주체는 단방향 큐 위에서 협업하고, 핸드오프는 직접 호출이 아니라 영속 저장소 객체로만 일어난다.

핵심 통찰은 한 줄이다.

> 에이전트는 콘텐츠만, 호출자는 operational transition만, 사람은 governance/input signal만.

이 책임 격리가 신뢰성을 만든다. 어떤 에이전트도 상태 표지를 바꾸거나 변경 제안을 병합하지 못하므로 race가 구조적으로 줄어든다. 모든 결정과 산출은 영속 저장소에 기록되므로 LLM의 무상태 한계를 self-fetch로 보완할 수 있다. 검증되지 않은 변경은 사람 게이트 또는 자동 검증을 통과하지 못한다.

---

## Architecture

시스템은 4개의 layer로 구성된다.

1. **People**  
   스펙 입력, 게이트 승인·거부, 회수 요청, 시스템 일시정지 요청, 본 모델 수정 승인. 사람은 영속 저장소에 governance/input write를 직접 남길 수 있다. 호출자는 그 시그널을 해석해 workflow 전이를 집행한다.

2. **Agents**  
   무상태 1회 호출로 콘텐츠만 생성한다. 콘텐츠는 마크다운, 코드 patch, 코멘트, 결정문, 요약문이다. 에이전트는 Context Manifest에 지정된 대상을 읽기 전용 self-fetch하고, 영속 저장소에 직접 쓰지 않는다.

3. **Caller**  
   에이전트를 호출하고, 결과를 검증하며, 모든 operational write를 수행한다. 상태 전이, 변경 제안 생성·병합, Issue 생성·종료, 알림, 작업 공간 lifecycle, lease, 결정적 검증, 자동 회수는 호출자의 영역이다.

4. **Persistent Store**  
   이슈 트래커, 버전 관리 시스템, 누적 스펙 저장소를 묶어 부르는 추상 layer다. 큐와 단일 진실 원천을 동시에 담당한다.

Layer 간 직접 통신은 제한된다. Agent 간 직접 통신은 금지된다. Agent의 출력은 반드시 영속 저장소 객체로 영속화된 뒤 다음 Agent의 입력이 된다.

---

## Authority Boundaries

| 주체 | 허용 | 금지 |
|---|---|---|
| Human | governance/input write, 승인·거부·중단·회수 요청, 모델 수정 승인 | 자동 workflow 전이의 비공식 우회 |
| Agent | Context Manifest 기반 self-fetch, 콘텐츠 생성, 할당 workspace 내부 임시 수정 | 영속 저장소 직접 쓰기, 상태 변경, 병합, Issue 생성·종료, 알림, lease, 결정적 검증 실행 |
| Caller | 모든 operational write, 상태 전이, 검증 실행, 회수, 알림, 병합 | 본 Concept 문서의 원칙 우회 |

사람이 직접 산출한 콘텐츠도 동일 큐와 동일 멱등성 규칙으로 처리한다. 산출자가 사람이든 에이전트든 operational transition은 Caller가 수행한다.

---

## Core Invariants

- **무상태 1회 호출**: 모든 Agent 호출은 이전 호출의 메모리에 의존하지 않는다.
- **Context Manifest + revision pin**: Caller는 호출 전에 읽기 대상과 revision pin을 고정한다. Agent는 manifest 밖의 객체를 읽지 않는다.
- **Caller-only operational write**: 상태 전이와 영속 workflow 변경은 Caller만 수행한다.
- **Queue-based handoff**: 핸드오프는 직접 호출이나 공유 메모리가 아니라 영속 저장소 객체로만 일어난다.
- **Milestone serialization**: 한 시점에 진행 중인 마일스톤은 1개다. 확장 시 마일스톤 단위 namespace 분리가 필요하다.
- **Task parallelism by lease**: 한 마일스톤 안의 Task는 의존성을 존중하며 병렬 처리될 수 있고, 동일 객체 실행은 lease로 직렬화된다.
- **Deterministic verification by Caller**: 빌드·테스트·린트·타입체크·정적 분석은 Caller가 실행하고, Agent는 로그를 해석한다.
- **Human gate blocking**: 게이트 진입 객체는 사람의 governance/input signal 전까지 다음 큐로 진행하지 않는다. Caller 프로세스는 다른 큐 처리를 계속한다.
- **Finite retry**: 자동 재시도는 유한하다. 한도를 넘으면 ESCALATED 상태로 사람에게 넘긴다.
- **Knowledge accumulation**: 스펙, 결정, 거부된 대안, Context Summary는 누적되어 다음 마일스톤의 1급 입력이 된다.

---

## Workflow Shape

기본 진행 동사는 다음 순서를 따른다.

```text
Compose → Decompose → Implement → Review → Refactor → Validate
```

역방향 이동은 명시적 회수로만 허용된다. Recover는 진행 동사가 아니라 회복 동사이며, stale, fail, lease 만료, 사람의 회수 요청을 처리한다.

세부 상태와 전이는 [State and Operation Contract](docs/contracts/state-and-operation-contract.md)가 정의한다.

---

## Contract Reference Rules

Contract 문서는 stable section ID를 사용한다. 다른 문서에서 세부 규칙을 참조할 때는 다음 형식을 쓴다.

```text
<path>#<section-id>
```

예:

- `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`
- `docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`
- `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER`
- `docs/contracts/knowledge-contract.md#KAC-TRACEABILITY`

Reference와 권위 순서는 [Contract README](docs/contracts/README.md)가 정의한다.

---

## Adaptation

본 문서는 의도적으로 추상이다. 다음은 본 문서에 들어가지 않는다.

- 영속 저장소·이슈 트래커·알림 채널·버전 관리 시스템의 제품명
- 상태 표지의 구체 이름·색·인코딩
- 디렉토리 구조 / CLI 호출 / 프롬프트 / 데몬 폴링 주기
- 슬롯 수치 / 임계 시간 / 재시도 한도 / lease TTL

도구는 자유롭게 교체할 수 있다. 단 본 모델의 원칙은 새 도구 위에서도 동일하게 보장되어야 한다.

---

## Amendment

- 본 문서의 변경은 사람의 명시적 승인을 필요로 한다.
- 변경은 변경 제안 + 사람의 승인 시그널 + Caller의 병합 + 새 commit으로만 발생한다.
- 구현 또는 contract 문서가 본 문서와 충돌하면 본 문서가 우선하며, 하위 문서를 정정해야 한다.
- 본 모델 위반이 발견되면 즉시 작업을 중단하고 사람에게 보고한다. 위반을 우회·은폐하지 않는다.
