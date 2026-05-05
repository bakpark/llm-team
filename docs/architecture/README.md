# Architecture Documentation

본 디렉토리는 `llm-team.md`와 `docs/contracts/`를 특정 구현 방식에 매핑하는 adapter 문서다. 최상위 원칙과 규약은 이 디렉토리가 아니라 다음 문서가 정의한다.

1. [`llm-team.md`](../../llm-team.md) — Concept / Constitution.
2. [`docs/contracts/README.md`](../contracts/README.md) — contract set 의 권위 순서, 참조 규칙, 어휘 glossary, role → phase migration notes.
3. [`docs/contracts/agent-and-context-contract.md`](../contracts/agent-and-context-contract.md) — AgentProfile, Phase, Contribution, Context Manifest, output envelope.
4. [`docs/contracts/state-and-operation-contract.md`](../contracts/state-and-operation-contract.md) — 상태, PhaseRun, Contribution, phase 별 operation.
5. [`docs/contracts/reliability-and-gate-contract.md`](../contracts/reliability-and-gate-contract.md) — lease, 회수, 검증, 사람 contribution, ledger.
6. [`docs/contracts/knowledge-contract.md`](../contracts/knowledge-contract.md) — 누적 스펙과 traceability.
7. [`docs/contracts/target-config-contract.md`](../contracts/target-config-contract.md) — AgentProfile 레지스트리, phase policy.
8. [`docs/contracts/agent-runner-port-contract.md`](../contracts/agent-runner-port-contract.md) — agent runner 포트.

이 디렉토리의 문서는 구현 설명이며 contract를 override하지 않는다. 충돌하면 `llm-team.md`와 `docs/contracts/`가 우선한다.

## 읽는 순서

1. [`pipeline-end-to-end.md`](pipeline-end-to-end.md) — Contribution worker cycle (6 단계) 와 Phase coordinator cycle (4 단계).
2. [`application-modules.md`](application-modules.md) — `application/` 모듈의 진입점·책임·의존 (`phase_coordinator.sh` 포함).
3. [`feature-request-intake.md`](feature-request-intake.md) — `feature-request` issue → `DISCOVERY_DRAFT` milestone 입수 흐름.
4. [`state-machine.md`](state-machine.md) — phase-aware contract state 를 GitHub label/marker 로 매핑하는 방식.
5. [`agent-output-format-mapping.md`](agent-output-format-mapping.md) — Agent output envelope (phase / agent_profile / contribution_kind) 과 GitHub markdown artifact 매핑.
6. [`agents/profiles/`](agents/profiles/) — 5 AgentProfile 의 구현 관점 책임.
   - [`atlas.md`](agents/profiles/atlas.md) — phase lead, 고수준 설계
   - [`forge.md`](agents/profiles/forge.md) — 구현 / patch
   - [`sentinel.md`](agents/profiles/sentinel.md) — 리뷰, 통합, 검증 lead
   - [`scout.md`](agents/profiles/scout.md) — 탐색 / 증거
   - [`human.md`](agents/profiles/human.md) — 사람 승인 (`human_approval` contribution)
7. [`daemons.md`](daemons.md) — AgentProfile worker daemon, phase coordinator daemon, lease 운영 방식, daemon lifecycle.
8. [`tools.md`](tools.md) — `gh`/`git`/LLM CLI 와 `lib/*.sh` helper 매핑, helper call-site map.
9. [`lease-and-recovery.md`](lease-and-recovery.md) — `RGC-PHASE-LEASE`/`RGC-RECOVERY` 의 구현 매핑(claim/expire/recovery scan).
10. [`context-snapshot.md`](context-snapshot.md) — `AGC-CONTEXT-MANIFEST.fetch_scope` 와 contribution_kind 별 default 매핑.
11. [`github-side-effect-timeline.md`](github-side-effect-timeline.md) — phase 별 quorum_reached 시 GitHub side-effect 시퀀스.
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

기본 제품 개발 흐름은 contract 의 phase sequence 를 따른다.

```text
Discovery → Specification → Planning → Implementation → CodeReview → Integration → Validation
```

## 문서 변경 규칙

- 이 디렉토리는 contract의 구현 매핑만 설명한다.
- 상태명, Agent output envelope, Human signal schema, retry/lease semantics는 contract 문서를 authoritative source로 둔다.
- 이 디렉토리에서 label, marker, helper 함수명을 바꾸면 실제 구현과 테스트도 함께 갱신해야 한다.
