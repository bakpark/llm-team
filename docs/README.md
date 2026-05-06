# Docs Index

`llm-team` 의 문서 트리 진입점이다. 본 README 는 색인이며 권위 문서가 아니다. 권위 순서는 [`llm-team.md`](../llm-team.md) → `docs/contracts/*.md` (entry: [`contracts/README.md`](contracts/README.md)) → 그 외 구현 / 보조 문서 순이다 ([`contracts/README.md#CONTRACT-AUTHORITY`](contracts/README.md#CONTRACT-AUTHORITY)).

문서를 처음 읽는 사람은 다음 4 bucket 중 자기 목적에 맞는 것만 읽으면 된다. **각 bucket 의 상태는 다르다 — Active 만 신규 코드·문서가 의존할 수 있다.**

## Active normative — 규범 (신규 의존 허용)

최상위 Concept 과 operational contract 권위. 충돌 시 본 bucket 이 다른 모든 문서보다 우선한다.

- [`../llm-team.md`](../llm-team.md) — Concept / Constitution. 철학, layer, 권한 경계, core invariant.
- [`contracts/README.md`](contracts/README.md) — contract set 권위 순서, reference 규칙, `CONTRACT-GLOSSARY` (1급 어휘 권위), architecture mapping.
- [`contracts/agent-and-context-contract.md`](contracts/agent-and-context-contract.md) — AgentProfile, Loop / Phase / Purpose, Contribution, Context Manifest, output envelope.
- [`contracts/state-and-operation-contract.md`](contracts/state-and-operation-contract.md) — Milestone / Slice / DialogueSession / SessionTurn / SliceMerge 상태와 loop 별 Caller operation.
- [`contracts/reliability-and-gate-contract.md`](contracts/reliability-and-gate-contract.md) — 4-lease kind, 회수, 검증, 사람 contribution, transition ledger, dual-gate queue.
- [`contracts/knowledge-contract.md`](contracts/knowledge-contract.md) — 누적 스펙, manifest, decision log, context summary, AC traceability, RefactorBacklog, turn_log compaction.
- [`contracts/target-config-contract.md`](contracts/target-config-contract.md) — AgentProfile 레지스트리, loop policies, slice class rules, dual-track, refactor metrics.
- [`contracts/agent-runner-port-contract.md`](contracts/agent-runner-port-contract.md) — agent runner 포트.

## Active implementation mapping — 구현 매핑 (advisory)

`llm-team.md` / contract 를 구체 구현·운영 방식에 매핑하는 보조 문서. contract 를 override 하지 않는다 — 충돌 시 contract 가 우선 ([`contracts/README.md#CONTRACT-AUTHORITY`](contracts/README.md#CONTRACT-AUTHORITY)).

- [`architecture/`](architecture/) — 구현 매핑 문서 모음. 진입은 [`architecture/README.md`](architecture/README.md) 의 *읽는 순서* 를 따른다 (pipeline → application-modules → state-machine → AgentProfile → daemons → tools → adapter inventory).
- [`operations/`](operations/) — 운영 절차.
  - [`operations/cli.md`](operations/cli.md)
  - [`operations/onboarding.md`](operations/onboarding.md)

## Draft / planning record — 제안·계획 기록 (참고)

라운드별 제안 spec 과 implementation plan. 결정 라운드의 *기록* 이지 현재 읽어야 할 설계가 아니다. 신규 의존 금지 — 채택된 결과는 위 Active bucket 으로 graduation 된다.

- [`superpowers/specs/`](superpowers/specs/) — proposal artifact (사람 작성).
- [`superpowers/plans/`](superpowers/plans/) — implementation plan (라운드 실행 기록).

## Historical record — 기록·보존

지나간 라운드의 방향 / 스냅샷 / archive. 의존 정책은 항목마다 다르다.

- [`history/legacy-phase-model/`](history/legacy-phase-model/) — amendment 이전 phase model archive. **신규 코드·문서 의존 금지** (lint rule 강제). historical reader / fixture / migration tooling 만 예외 ([`contracts/README.md#CONTRACT-AUTHORITY`](contracts/README.md#CONTRACT-AUTHORITY)).
- [`history/direction-2026-05.md`](history/direction-2026-05.md) — docs 고도화 5-phase 로드맵 (Phase 0–3 머지 후 이동). 신규 architecture 파일 추가 동기 추적용 참조 — [`architecture/README.md`](architecture/README.md) 의 *진행 중인 방향* 절에서 인용.
- [`history/e2e-pipeline-2026-05-03.md`](history/e2e-pipeline-2026-05-03.md) — 2026-05-03 시점 e2e pipeline 스냅샷.
