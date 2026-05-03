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
- enum 값을 추가·변경하면 contract 본문, 구현 값, ledger/dashboard 집계 값이 같은 어휘를 쓰는지 확인해야 한다.
- 같은 필드명이 다른 entity에서 쓰이면 scope를 명시해야 한다. 예: Agent output envelope idempotency key 와 Recover ledger idempotency key 는 같은 `idempotency_key` 필드명을 쓰지만 entity scope 가 다르다.
- anchor 를 추가·변경하면 `#CONTRACT-CONFORMANCE` matrix 를 함께 갱신해야 한다. 구현이 아직 없으면 contract 를 forward-looking prose 로 숨기지 말고 `spec-only` 또는 `partial` 로 표시한다.

<a id="CONTRACT-STATUS"></a>
## CONTRACT-STATUS: Status

현재 contract set은 Active로 간주한다. 구현이 contract를 충족하지 못하면 구현을 수정하거나, 사람 승인으로 contract 변경 제안을 제출해야 한다.

<a id="CONTRACT-CONFORMANCE"></a>
## CONTRACT-CONFORMANCE: Anchor Conformance Matrix

`CONTRACT-STATUS=Active` 는 contract set 이 권위 있는 규약이라는 뜻이다. 각 anchor 가 현재 구현에서 어느 정도 보장되는지는 아래 matrix 가 따로 정의한다.

Status enum:

| Status | 의미 |
|---|---|
| `active` | 현재 production path 또는 문서 권위 구조가 해당 anchor 를 보장한다 |
| `partial` | 일부 production path 만 보장하거나 알려진 미구현 path 가 남아 있다 |
| `spec-only` | contract/helper/문서 정의는 있으나 production binding 이 없다 |
| `deprecated` | 더 이상 새 구현이 의존하면 안 되는 anchor 다 |

### Contract README

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `CONTRACT-AUTHORITY` | active | contract authority | 문서 권위 순서 |
| `CONTRACT-STRUCTURE` | active | repository layout | contract file set |
| `CONTRACT-REFERENCE` | active | markdown anchors | stable reference rule |
| `CONTRACT-CHANGE` | active | review checklist | 변경 규칙과 drift guardrail |
| `CONTRACT-STATUS` | active | contract prose | contract set 의 권위 상태 |
| `CONTRACT-CONFORMANCE` | active | this matrix | anchor 별 구현 conformance 상태 |

### Agent and Context

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `AGC-SCOPE` | active | contract authority | 문서 scope anchor |
| `AGC-ROLES` | active | `lib/roles.sh`, `prompts/*.md` | role enum 과 기본 산출 kind 매핑 |
| `AGC-CALL-BOUNDARY` | partial | `application/agent_io.sh`, `lib/ports/*` | port 경계는 있으나 모든 adapter side-effect surface 자동 검증은 아님 |
| `AGC-CONTEXT-MANIFEST` | active | `lib/context.sh`, `scheduler/runner.sh` | manifest 생성·검증·첨부 path |
| `AGC-OUTPUT` | partial | `lib/output.sh`, `application/agent_io.sh` | role↔kind 검증은 active. Caller-enriched idempotency key 분리는 구현 catch-up 필요 |
| `AGC-OUTPUT-RUNTIME-ENRICH` | spec-only | contract prose | runtime metadata/idempotency enrichment 순서가 production helper 에 완전히 분리되지 않음 |
| `AGC-ROLE-OUTPUTS` | active | `lib/roles.sh` `role_output_kind` | role × output_kind × verdict matrix 가 contract 정본 |
| `AGC-WORKSPACE` | partial | `adapters/workspace/*`, `application/caller_dispatch.sh` | Coder worktree path 검증은 있으나 모든 cleanup/recovery path 는 부분 구현 |
| `AGC-ISSUE-BODY` | spec-only | `docs/architecture/agent-output-format-mapping.md` | rendering 규약은 있으나 parser/enforcer 없음 |
| `AGC-INVALID` | partial | `application/agent_io.sh`, `lib/output.sh` | manifest 외 참조·secret·path 검증은 있음. body layer 검증은 없음 |

### State and Operation

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `SOC-SCOPE` | active | contract authority | 문서 scope anchor |
| `SOC-OBJECTS` | active | `lib/state.sh`, `lib/labels.sh`, issue tracker adapters | workflow object/state label 매핑 |
| `SOC-STATES` | active | `application/caller_dispatch.sh`, `application/human_signal.sh` | 주요 상태 전이 path 구현 |
| `SOC-DEPENDENCIES` | partial | `application/ready_object.sh`, `application/caller_dispatch.sh` | dependency 대기는 구현. cycle/edge 전수 검증은 Decompose path 에 의존 |
| `SOC-INTAKE` | active | `application/feature_request.sh` | feature request promote path |
| `SOC-OPERATIONS` | partial | `scheduler/runner.sh`, `application/caller_dispatch.sh` | 주요 operation 구현. 일부 gate/amendment edge 는 human_signal path 에 의존 |
| `SOC-RECOVERY-OPERATION` | partial | `application/recovery.sh` | stale/lease-expiry 회수는 구현. generic partial-fail rollback 은 미구현 |
| `SOC-DISPATCH-MATRIX` | partial | `application/caller_dispatch.sh` | 정상/FAIL/STALE path 구현. matrix 전체 자동 검증은 없음 |
| `SOC-MERGE-POLICY` | spec-only | contract prose | adapter-neutral merge policy. deterministic merge/rebase helper 없음 |
| `SOC-IDEMPOTENCY` | active | `application/caller_dispatch.sh`, `lib/ledger.sh` | `applied`/`duplicate` ledger 기반 |

### Reliability and Gate

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `RGC-SCOPE` | active | contract authority | 문서 scope anchor |
| `RGC-WRITES` | active | `application/caller_dispatch.sh`, `application/human_signal.sh`, `lib/ports/*` | governance/input write 와 operational write 분리 |
| `RGC-SIGNALS` | partial | `application/human_signal.sh`, `lib/signals.sh` | approve/reject/pause/resume/stop path 구현. amendment approval 은 제한적 |
| `RGC-LEASE` | active | `lib/lease.sh`, `scheduler/runner.sh` | lease claim/release/token guard |
| `RGC-RECOVERY` | partial | `application/recovery.sh` | stale recovery 구현. gate/closed/merged 정책은 일부 human path 의존 |
| `RGC-FAILURE` | partial | `application/recovery.sh`, `scripts/cli/daemon.sh` | daemon startup rollback 은 구현. generic multi-step rollback 은 미구현 |
| `RGC-VERIFICATION` | active | `application/verification_runner.sh` | verification run persistence + manifest attach |
| `RGC-HUMAN-GATES` | partial | `application/human_signal.sh` | PO/PM gate path 구현. amendment/generic gate 확장은 제한적 |
| `RGC-LEDGER` | active | `lib/ledger.sh`, `application/caller_dispatch.sh`, `application/human_signal.sh` | canonical normal completion value 는 `applied` |
| `RGC-PAUSE` | active | `lib/signals.sh`, `scripts/cli/control.sh`, `application/human_signal.sh` | `RUNNING`, `PAUSED`, `STOPPED` |
| `RGC-NOTIFICATION` | partial | `lib/notifier.sh`, `adapters/notifier/*` | no-op default + notifier adapter. 알림 coverage 는 제한적 |
| `RGC-FAIRNESS` | partial | `application/ready_object.sh`, `scheduler/runner.sh` | ready object 선택은 구현. priority 예외 ledger 검증은 없음 |
| `RGC-DAEMON-STARTUP` | active | `scripts/cli/daemon.sh` | partial startup rollback ledger 포함 |

### Knowledge

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `KAC-SCOPE` | active | contract authority | 문서 scope anchor |
| `KAC-ACCUMULATION` | partial | `application/knowledge.sh`, `scheduler/runner.sh` | merged/context summary 누적 일부 구현. rejected spec 사유 누적은 catch-up 필요 |
| `KAC-MANIFEST` | partial | `lib/context.sh`, `application/knowledge.sh` | manifest entry 형식은 구현. 누적 spec index 완전성은 부분 |
| `KAC-MANIFEST-FROM-KNOWLEDGE` | partial | `scheduler/runner.sh` | PO/PM context summary auto-inject path |
| `KAC-DECISION-LOG` | active | `application/knowledge.sh`, tests | alternatives/decision field gate |
| `KAC-CONTEXT-SUMMARY` | partial | `application/knowledge.sh`, `scheduler/runner.sh` | summary snapshot/inject 구현. QA 품질 검증은 없음 |
| `KAC-TRACEABILITY` | partial | `application/agent_io.sh`, tests | Planner/QA AC mapping 검증 일부 |
| `KAC-CONFLICTS` | spec-only | contract prose | conflict resolver 구현 없음 |
| `KAC-EQUIVALENCE` | spec-only | contract prose | spec/code 동등성 원칙. 별도 enforcer 없음 |

### Target Configuration

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `TCC-SCOPE` | active | contract authority | 문서 scope anchor |
| `TCC-IDENTITY` | active | `scripts/cli/target.sh`, `lib/ledger.sh` | `target_id` ledger 분리 |
| `TCC-LEASE-CONFIG` | active | `lib/config.sh`, `scheduler/runner.sh` | ttl default/by_role lookup |
| `TCC-ONBOARDING` | partial | `scripts/cli/target.sh`, `application/onboarding/*` | preset/checklist path 구현. skip governance 검증은 제한적 |
| `TCC-AGENT-RUNNER-MAP` | spec-only | `lib/config.sh` helper | `config_agent_runner_for_role` 는 있으나 runner active binding 미연결 |
| `TCC-PRECEDENCE` | partial | `lib/config.sh`, env loading | lease/config 일부에 적용. 모든 key 전수 적용은 아님 |
| `TCC-CHANGE-RULES` | spec-only | contract prose | target config 변경 ledger helper 없음 |

### Agent Runner Port

| Anchor | Status | 구현 / 검증 표면 | 비고 |
|---|---|---|---|
| `ARC-SCOPE` | active | contract authority | 문서 scope anchor |
| `ARC-PORT-SIGNATURE` | active | `lib/ports/llm_runner.sh`, `adapters/llm_runner/*` | role/operation/manifest/prompt_ref/cwd/timeout/idempotency inputs |
| `ARC-CALL-SEMANTICS` | active | `scheduler/runner.sh`, `adapters/llm_runner/*` | stdin prompt handoff + timeout path |
| `ARC-EXIT-CLASSES` | active | `lib/ports/llm_runner.sh` | `lr_classify_exit` raw-code mapping |
| `ARC-IDEMPOTENCY` | partial | `application/caller_dispatch.sh`, `lib/ledger.sh` | ledger idempotency active. adapter-level reuse cache 없음 |
| `ARC-ADAPTER-SUBSTITUTION` | partial | `lib/registry.sh`, `adapters/llm_runner/*` | env-based adapter swap. target role binding 은 TCC 미구현 |
| `ARC-FAILURE-MODES` | active | `lib/ports/llm_runner.sh`, `scheduler/runner.sh` | timeout/transport/malformed output 분류 |
