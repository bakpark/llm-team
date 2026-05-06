# Architecture Documentation

본 디렉토리는 `llm-team.md`와 `docs/contracts/`를 특정 구현 방식에 매핑하는 adapter 문서다. 최상위 원칙과 규약은 이 디렉토리가 아니라 다음 문서가 정의한다.

1. [`llm-team.md`](../../llm-team.md) — Concept / Constitution.
2. [`docs/contracts/README.md`](../contracts/README.md) — contract set 의 권위 순서, 참조 규칙, 어휘 glossary, legacy phase model → loop-based migration notes.
3. [`docs/contracts/agent-and-context-contract.md`](../contracts/agent-and-context-contract.md) — AgentProfile, Loop / Phase / Purpose, DialogueSession, SessionTurn, Contribution, Context Manifest, output envelope.
4. [`docs/contracts/state-and-operation-contract.md`](../contracts/state-and-operation-contract.md) — 상태, Slice, DialogueSession, SliceMerge, loop / phase / purpose 별 operation.
5. [`docs/contracts/reliability-and-gate-contract.md`](../contracts/reliability-and-gate-contract.md) — lease (4-kind), 회수, 검증, 사람 contribution, ledger.
6. [`docs/contracts/knowledge-contract.md`](../contracts/knowledge-contract.md) — 누적 스펙과 traceability, RefactorBacklog, slice telemetry.
7. [`docs/contracts/target-config-contract.md`](../contracts/target-config-contract.md) — AgentProfile 레지스트리, loop policies, slice class rules, dual-track, refactor metrics.
8. [`docs/contracts/agent-runner-port-contract.md`](../contracts/agent-runner-port-contract.md) — agent runner 포트.

이 디렉토리의 문서는 구현 설명이며 contract를 override하지 않는다. 충돌하면 `llm-team.md`와 `docs/contracts/`가 우선한다.

## 읽는 순서

1. [`pipeline-end-to-end.md`](pipeline-end-to-end.md) — Dual-track scheduler / Dialogue coordinator / Turn worker / Verification 의 4 cycle.
2. [`application-modules.md`](application-modules.md) — `application/` 모듈의 진입점·책임·의존 (`dialogue_coordinator.sh`, `dual_track_scheduler.sh` 포함).
3. [`feature-request-intake.md`](feature-request-intake.md) — `feature-request` issue → `M_INTAKE_QUEUED` milestone 입수 흐름.
4. [`state-machine.md`](state-machine.md) — loop-aware contract state (Milestone dual-slot / Slice / DialogueSession / SliceMerge) 를 GitHub label/marker 로 매핑하는 방식.
5. [`agent-output-format-mapping.md`](agent-output-format-mapping.md) — Agent output envelope (parent_loop / phase|purpose / agent_profile_id / contribution_kind) 과 GitHub markdown artifact 매핑.
6. [`agents/profiles/`](agents/profiles/) — 5 AgentProfile 의 구현 관점 책임.
   - [`atlas.md`](agents/profiles/atlas.md) — outer loop lead, 고수준 설계
   - [`forge.md`](agents/profiles/forge.md) — inner tdd_build 단독 lead, 구현 / patch
   - [`sentinel.md`](agents/profiles/sentinel.md) — middle review / outer Validation lead
   - [`scout.md`](agents/profiles/scout.md) — 탐색 / 증거 / RefactorBacklog scan producer
   - [`human.md`](agents/profiles/human.md) — 사람 승인 (`human_approval` contribution)
7. [`daemons.md`](daemons.md) — AgentProfile worker daemon, `dialogue_coordinator` daemon, `dual_track_scheduler` daemon, lease 운영 방식, daemon lifecycle.
8. [`tools.md`](tools.md) — `gh`/`git`/LLM CLI 와 `lib/*.sh` helper 매핑, helper call-site map.
9. [`lease-and-recovery.md`](lease-and-recovery.md) — `RGC-LEASE-KINDS`/`RGC-RECOVERY` 의 구현 매핑(claim/expire/recovery scan).
10. [`context-snapshot.md`](context-snapshot.md) — `AGC-CONTEXT-MANIFEST.fetch_scope` 와 contribution_kind 별 default 매핑.
11. [`github-side-effect-timeline.md`](github-side-effect-timeline.md) — loop step session CONVERGED 와 SliceMerge 전이 시 GitHub side-effect 시퀀스.
12. [`worktree-pr-lifecycle.md`](worktree-pr-lifecycle.md) — Slice ↔ worktree ↔ SliceMerge 인스턴스(시간순) ↔ PR 의 통합 lifecycle. patch turn workspace 적용 매트릭스, GitHub signal direction (outbound/inbound), failure 결정표 — workflow diagram entry point.
13. [`agent-runner-adapters.md`](agent-runner-adapters.md) — agent runner 포트의 어댑터 매핑 (AgentProfile id 기반).
14. [`adapter-inventory.md`](adapter-inventory.md) — port × production adapter 스냅샷, cross-cutting 운영 가정 (단일 호스트·macOS 호환·외부 도구 의존), 한계 인덱스.

## 진행 중인 방향

- [`../history/direction-2026-05.md`](../history/direction-2026-05.md) — docs 고도화 5-phase 로드맵, contract anchor 추적 매트릭스, draft graduation 분류표. Phase 0–3 머지 후 `docs/history/` 로 이동했으며, 신규 architecture 파일이 추가된 동기를 추적할 때 참조한다.

## 구현 흐름 요약

```text
Human governance/input signal
        ↓
Caller creates/claims workflow object with lease
        ↓
Caller builds Context Manifest + revision pins
        ↓
Agent returns content-only output envelope
        ↓
Caller validates output + revision pins
        ↓
Caller performs operational write
```

기본 제품 개발 흐름은 contract 의 3-loop nested model ([`SOC-LOOPS`](../contracts/state-and-operation-contract.md#SOC-LOOPS)) 을 따른다.

```text
outer (milestone, dual-slot)
  Discovery → Specification → [Planning → middle slice loop ×N → Validation]
                                           │
                                           ▼
                         middle (slice: feature | internal)
                           review ↔ merge
                              │
                              ▼
                       inner (TDD build, forge solo)
                         red → green → refactor
```

- outer 의 Discovery/Specification 은 Discovery slot, Planning/Validation 은 Delivery slot 에서 직렬화된다 ([`SOC-MILESTONE-DUAL-SLOT`](../contracts/state-and-operation-contract.md#SOC-MILESTONE-DUAL-SLOT)).
- middle slice loop 는 outer Planning 산출 Slice DAG 를 1 slice 단위로 dispatch — feature/internal 두 class 가 review depth 를 결정한다 ([`SOC-SLICE-CLASS`](../contracts/state-and-operation-contract.md#SOC-SLICE-CLASS)).
- inner tdd_build 는 forge solo session 으로 red → green → refactor 의 turn 분류 (SOC-SLICE-LIFECYCLE 의 inner loop 절).

## 문서 변경 규칙

- 이 디렉토리는 contract의 구현 매핑만 설명한다.
- 상태명, Agent output envelope, Human signal schema, retry/lease semantics는 contract 문서를 authoritative source로 둔다.
- 이 디렉토리에서 label, marker, helper 함수명을 바꾸면 실제 구현과 테스트도 함께 갱신해야 한다.
