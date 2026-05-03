# LLM Team Contracts

이 디렉토리는 `llm-team.md`의 철학을 구현 가능한 규약으로 구체화한다. `llm-team.md`가 Constitution이면, 이 디렉토리는 operational contract set이다.

<a id="CONTRACT-AUTHORITY"></a>
## CONTRACT-AUTHORITY: Authority

문서 권위 순서는 다음과 같다.

1. `llm-team.md`
2. `docs/contracts/*.md`
3. 구현 문서, 프롬프트, 스크립트, 상태 표지 매핑, 도구별 adapter

상위 문서와 하위 문서가 충돌하면 상위 문서가 우선한다. contract 문서끼리 충돌하면 더 구체적인 scope의 문서가 우선하되, 충돌 자체를 수정 대상으로 기록해야 한다.

`docs/architecture/`는 구현 설명 또는 기존 설계 자료로 간주한다. 이 디렉토리의 contract를 override하지 않는다.

<a id="CONTRACT-STRUCTURE"></a>
## CONTRACT-STRUCTURE: Directory Structure

```text
llm-team.md
docs/contracts/
  README.md
  agent-and-context-contract.md
  state-and-operation-contract.md
  reliability-and-gate-contract.md
  knowledge-contract.md
  target-config-contract.md
  agent-runner-port-contract.md
```

각 contract의 책임은 다음과 같다.

| 문서 | 책임 |
|---|---|
| `agent-and-context-contract.md` | Agent 역할, Context Manifest, revision pin, output envelope, role별 산출 계약, 영속 본문 렌더링 |
| `state-and-operation-contract.md` | Milestone / Task / Change Proposal 상태, 허용 전이, operation별 Caller action, dispatch 매트릭스, Recover operation |
| `reliability-and-gate-contract.md` | lease, retry, stale recovery, deterministic verification, human gate, transition ledger, pause, daemon 시작 |
| `knowledge-contract.md` | 누적 스펙, manifest, decision log, context summary, AC traceability, manifest materialization |
| `target-config-contract.md` | target 식별·바인딩, lease TTL 정책, onboarding 게이트 설정, agent runner 매핑, 설정 우선순위 |
| `agent-runner-port-contract.md` | agent runner 포트 시그니처, 호출 의미, 종료 분류, idempotency, adapter 교체 invariant |

<a id="CONTRACT-REFERENCE"></a>
## CONTRACT-REFERENCE: Reference Method

모든 안정 참조 대상 section은 명시적 HTML anchor를 가진다.

```md
<a id="AGC-OUTPUT"></a>
## AGC-OUTPUT: Output Contract
```

다른 문서에서 참조할 때는 repo root 기준 상대 경로로 다음 형식을 사용한다.

```text
<relative-path>#<section-id>
```

예:

- `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT`
- `docs/contracts/agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH`
- `docs/contracts/agent-and-context-contract.md#AGC-ISSUE-BODY`
- `docs/contracts/state-and-operation-contract.md#SOC-INTAKE`
- `docs/contracts/state-and-operation-contract.md#SOC-OPERATIONS`
- `docs/contracts/state-and-operation-contract.md#SOC-DISPATCH-MATRIX`
- `docs/contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION`
- `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER`
- `docs/contracts/reliability-and-gate-contract.md#RGC-DAEMON-STARTUP`
- `docs/contracts/knowledge-contract.md#KAC-TRACEABILITY`
- `docs/contracts/knowledge-contract.md#KAC-MANIFEST-FROM-KNOWLEDGE`
- `docs/contracts/target-config-contract.md#TCC-LEASE-CONFIG`
- `docs/contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE`

Section ID prefix는 문서별로 고정한다.

| Prefix | 문서 |
|---|---|
| `AGC` | Agent and Context Contract |
| `SOC` | State and Operation Contract |
| `RGC` | Reliability and Gate Contract |
| `KAC` | Knowledge Contract |
| `TCC` | Target Configuration Contract |
| `ARC` | Agent Runner Port Contract |
| `CONTRACT` | Contract README |

<a id="CONTRACT-ARCHITECTURE-MAPPING"></a>
## CONTRACT-ARCHITECTURE-MAPPING: Architecture Mapping Index

Contract 문서만 읽는 contributor 는 다음 표에서 구현 매핑 문서로 이동한다. Architecture 문서는 contract 를 override 하지 않으며, contract 절의 적용 위치와 구현 선택만 설명한다.

| Contract anchor | Architecture mapping |
|---|---|
| [`AGC-CONTEXT-MANIFEST`](agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) | [`context-snapshot.md`](../architecture/context-snapshot.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`AGC-OUTPUT`](agent-and-context-contract.md#AGC-OUTPUT), [`AGC-OUTPUT-RUNTIME-ENRICH`](agent-and-context-contract.md#AGC-OUTPUT-RUNTIME-ENRICH), [`AGC-ISSUE-BODY`](agent-and-context-contract.md#AGC-ISSUE-BODY) | [`agent-output-format-mapping.md`](../architecture/agent-output-format-mapping.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`SOC-OBJECTS`](state-and-operation-contract.md#SOC-OBJECTS), [`SOC-OPERATIONS`](state-and-operation-contract.md#SOC-OPERATIONS), [`SOC-DISPATCH-MATRIX`](state-and-operation-contract.md#SOC-DISPATCH-MATRIX) | [`state-machine.md`](../architecture/state-machine.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
| [`SOC-RECOVERY-OPERATION`](state-and-operation-contract.md#SOC-RECOVERY-OPERATION) | [`state-machine.md`](../architecture/state-machine.md), [`lease-and-recovery.md`](../architecture/lease-and-recovery.md) |
| [`RGC-LEASE`](reliability-and-gate-contract.md#RGC-LEASE), [`RGC-RECOVERY`](reliability-and-gate-contract.md#RGC-RECOVERY), [`RGC-FAILURE`](reliability-and-gate-contract.md#RGC-FAILURE), [`RGC-LEDGER`](reliability-and-gate-contract.md#RGC-LEDGER) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`daemons.md`](../architecture/daemons.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
| [`RGC-FAIRNESS`](reliability-and-gate-contract.md#RGC-FAIRNESS), [`RGC-DAEMON-STARTUP`](reliability-and-gate-contract.md#RGC-DAEMON-STARTUP) | [`daemons.md`](../architecture/daemons.md), [`self-hosting.md`](../architecture/self-hosting.md) |
| [`RGC-VERIFICATION`](reliability-and-gate-contract.md#RGC-VERIFICATION) | [`tools.md`](../architecture/tools.md), [`pipeline-end-to-end.md`](../architecture/pipeline-end-to-end.md) |
| [`KAC-MANIFEST-FROM-KNOWLEDGE`](knowledge-contract.md#KAC-MANIFEST-FROM-KNOWLEDGE), [`KAC-TRACEABILITY`](knowledge-contract.md#KAC-TRACEABILITY) | [`context-snapshot.md`](../architecture/context-snapshot.md), [`application-modules.md`](../architecture/application-modules.md) |
| [`TCC-LEASE-CONFIG`](target-config-contract.md#TCC-LEASE-CONFIG), [`TCC-ONBOARDING`](target-config-contract.md#TCC-ONBOARDING), [`TCC-AGENT-RUNNER-MAP`](target-config-contract.md#TCC-AGENT-RUNNER-MAP) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`self-hosting.md`](../architecture/self-hosting.md), [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md) |
| [`ARC-PORT-SIGNATURE`](agent-runner-port-contract.md#ARC-PORT-SIGNATURE), [`ARC-EXIT-CLASSES`](agent-runner-port-contract.md#ARC-EXIT-CLASSES), [`ARC-ADAPTER-SUBSTITUTION`](agent-runner-port-contract.md#ARC-ADAPTER-SUBSTITUTION) | [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md), [`adapter-inventory.md`](../architecture/adapter-inventory.md) |

<a id="CONTRACT-CHANGE"></a>
## CONTRACT-CHANGE: Change Rules

- Contract 변경은 변경 제안으로 제출한다.
- 본질적 철학이나 권한 경계를 바꾸는 변경은 먼저 `llm-team.md`를 수정해야 한다.
- 상태명, 필드명, operation semantics를 바꾸면 참조 문서와 구현 adapter를 함께 갱신해야 한다.
- 같은 개념을 여러 문서에 중복 정의하지 않는다. 한 문서는 authoritative source가 되고, 다른 문서는 reference만 둔다.

<a id="CONTRACT-STATUS"></a>
## CONTRACT-STATUS: Status

현재 contract set은 Active로 간주한다. 구현이 contract를 충족하지 못하면 구현을 수정하거나, 사람 승인으로 contract 변경 제안을 제출해야 한다.
