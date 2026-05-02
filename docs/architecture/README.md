# Architecture Documentation

본 디렉토리는 `llm-team.md`와 `docs/contracts/`를 특정 구현 방식에 매핑하는 adapter 문서다. 최상위 원칙과 규약은 이 디렉토리가 아니라 다음 문서가 정의한다.

1. [`llm-team.md`](../../llm-team.md) — Concept / Constitution.
2. [`docs/contracts/README.md`](../contracts/README.md) — contract set의 권위 순서와 참조 규칙.
3. [`docs/contracts/agent-and-context-contract.md`](../contracts/agent-and-context-contract.md) — Agent, Context Manifest, output envelope.
4. [`docs/contracts/state-and-operation-contract.md`](../contracts/state-and-operation-contract.md) — 상태와 operation.
5. [`docs/contracts/reliability-and-gate-contract.md`](../contracts/reliability-and-gate-contract.md) — lease, 회수, 검증, gate, ledger.
6. [`docs/contracts/knowledge-contract.md`](../contracts/knowledge-contract.md) — 누적 스펙과 traceability.

이 디렉토리의 문서는 구현 설명이며 contract를 override하지 않는다. 충돌하면 `llm-team.md`와 `docs/contracts/`가 우선한다.

## 읽는 순서

1. [`pipeline-end-to-end.md`](pipeline-end-to-end.md) — Caller 단일 cycle 의 6 단계와 dispatch 분기 매트릭스.
2. [`application-modules.md`](application-modules.md) — `application/` 12 개 use-case 모듈의 진입점·책임·의존.
3. [`feature-request-intake.md`](feature-request-intake.md) — `feature-request` issue → milestone 입수 흐름.
4. [`state-machine.md`](state-machine.md) — contract state를 GitHub label/marker로 매핑하는 방식.
5. [`agent-output-format-mapping.md`](agent-output-format-mapping.md) — Agent output envelope와 GitHub markdown artifact 매핑.
6. [`agents/`](agents/) — 7개 Agent 역할의 구현 관점 책임.
   - [`po.md`](agents/po.md)
   - [`pm.md`](agents/pm.md)
   - [`planner.md`](agents/planner.md)
   - [`coder.md`](agents/coder.md)
   - [`reviewer.md`](agents/reviewer.md)
   - [`integrator.md`](agents/integrator.md)
   - [`qa.md`](agents/qa.md)
7. [`daemons.md`](daemons.md) — Caller runner, worker slot, lease 운영 방식, daemon lifecycle.
8. [`tools.md`](tools.md) — `gh`/`git`/LLM CLI와 `lib/*.sh` helper 매핑, helper call-site map.
9. [`lease-and-recovery.md`](lease-and-recovery.md) — `RGC-LEASE`/`RGC-RECOVERY` 의 구현 매핑(claim/expire/recovery scan).
10. [`context-snapshot.md`](context-snapshot.md) — `AGC-CONTEXT-MANIFEST.fetch_scope` 와 트렁케이션 책임 매핑.
11. [`github-side-effect-timeline.md`](github-side-effect-timeline.md) — 하나의 operation 에서 발생하는 GitHub side-effect 시퀀스.
12. [`self-hosting.md`](self-hosting.md) — `TCC-ONBOARDING.self_hosting` 의 의미와 안전 장치.
13. [`agent-runner-adapters.md`](agent-runner-adapters.md) — agent runner 포트의 어댑터 매핑(`claude_code`, `fake`, 향후).

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

기본 제품 개발 흐름은 contract의 진행 동사를 따른다.

```text
Compose-PO → Compose-PM → Decompose → Implement → Review → Refactor → Validate
```

## 문서 변경 규칙

- 이 디렉토리는 contract의 구현 매핑만 설명한다.
- 상태명, Agent output envelope, Human signal schema, retry/lease semantics는 contract 문서를 authoritative source로 둔다.
- 이 디렉토리에서 label, marker, helper 함수명을 바꾸면 실제 구현과 테스트도 함께 갱신해야 한다.
