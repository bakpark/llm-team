# Agent Domain Consumer Guide

> **Advisory only.** 권위는 [`docs/contracts/README.md#CONTRACT-GLOSSARY`](../contracts/README.md#CONTRACT-GLOSSARY) 가 단일 유지한다. 본 문서는 agent self-fetch manifest 의 *소비 순서* 와 *허용 범위* 를 형식화한 보조 가이드이며, glossary / contract anchor 의 권위를 override 하지 않는다. 본 가이드와 `CONTRACT-GLOSSARY` 가 충돌하면 후자가 권위다 (§4 참조).

## Scope

본 가이드의 적용 대상:

- agent 가 turn 입력 manifest 를 소비할 때 어떤 entry 를 어느 순서로 읽는가
- glossary 미정의 용어가 contract 본문에 등장했을 때 agent 가 취해야 하는 행동
- consumer guide / glossary 자체에 대한 read / write 권한

본 가이드의 적용 대상이 *아닌* 것:

- manifest 의 *생성* 규칙 (Caller 책임 — `agent-and-context-contract.md#AGC-SESSION-INPUT`, `#AGC-CONTEXT-MANIFEST`)
- prompt 본문 직렬화 (`#AGC-PROMPT-SERIALIZATION`, [`prompt-build-pipeline.md`](prompt-build-pipeline.md))
- 신규 어휘의 1급 정의 (`CONTRACT-GLOSSARY` 의 갱신은 사람 게이트 + Caller 영속화로만)

## Rule 1 — Manifest 소비 측 가정 (생성 측 권위 아님)

> **본 rule 은 manifest 의 *생성/검증* 규칙이 아니다.** manifest 의 entry 순서·구성·검증 권위는 `agent-and-context-contract.md#AGC-CONTEXT-MANIFEST` + `#AGC-SESSION-INPUT` 가 단일 유지하며, 현 contract 는 ordering 을 강제하지 않는다. 본 rule 은 *소비 측 가정* — agent 가 manifest 를 어떻게 읽으면 일관된 해석에 도달하는지 — 의 권고일 뿐이다.

소비 측 권고:

- agent 는 manifest 가 제공하는 순서를 그대로 소비한다 (자체 재정렬 금지 — `#AGC-INVALID` 의 manifest 외 read 와 동일 원칙).
- manifest 에 `CONTRACT-GLOSSARY` entry 가 *없으면* agent 는 그 부재를 임의로 보완하지 않으며, glossary 미정의 용어가 등장한 시점에 Rule 3 의 분기 (NEED_CONTEXT 또는 `glossary_term_proposal` 후보) 를 따른다.
- manifest 가 `CONTRACT-GLOSSARY` 를 *포함하는* 경우, agent 는 후속 contract anchor 의 용어 해석을 glossary 정의에 우선 정합시킨다.

manifest 의 ordering / 첫 entry 강제 / 자동 inject 정책은 본 advisory 가 아니라 Caller 의 manifest 생성 정책 (TCC 또는 `#AGC-CONTEXT-MANIFEST` amendment) 에서 결정한다.

## Rule 2 — Section 단위 fetch (소비 측 권고)

> **본 rule 도 manifest 생성 규칙이 아니다.** Caller 가 anchor 단위로 manifest 를 구성했을 때 agent 가 어떻게 소비하는지의 권고.

- agent 는 manifest entry 의 *입자도* 를 그대로 받아들인다 — 1급 anchor 단위 entry 가 들어오면 그 anchor 의 본문만 해석에 사용하고, 같은 파일의 다른 anchor 를 자력으로 보강하지 않는다 (manifest 외 read 금지).
- manifest entry 가 전체 파일을 가리키는 경우에만 전체 파일을 일관된 본문으로 해석한다.

입자도 결정 (anchor 단위 vs 전체 파일) 은 Caller 의 manifest-plan 이 결정하며, 본 가이드는 그 결정을 *받아들이는* 측의 행동만 정의한다. manifest 비용 (`#AGC-CONTEXT-BUDGET`) 의 최적화 자체는 Caller 측 정책의 책임이다.

## Rule 3 — 권위 우선순위 (Glossary 미정의 용어)

`CONTRACT-GLOSSARY` 에 정의된 용어는 contract anchor 인용 없이 agent 출력에 그대로 사용 가능하다. glossary 에 *없는* 용어가 contract 본문 또는 manifest entry 에서 발견되면, agent 는 해당 용어에 대해 임의 정의를 만들지 않는다. 두 행동 중 하나를 선택한다:

1. `output_kind=failure`, `failure.type=need_context` 로 반환 (manifest 보강 필요)
2. `proposal` contribution 에 `glossary_term_proposal` 후보 (proposal_kind, PoC 단계는 자유 텍스트) 로 등재

agent 의 turn 산출물에서 glossary 미정의 용어를 임의로 새 의미로 사용하면 invalid 다 (`agent-and-context-contract.md#AGC-INVALID` 의 envelope content 일관성 위반).

## Rule 4 — 충돌 시 fallback

본 consumer guide (architecture 보조) 와 `CONTRACT-GLOSSARY` (1급 권위) 가 충돌하면 **후자가 권위**. consumer guide 는 *최적화 가이드* 이며 권위 표면이 아니다. 본 가이드의 rule 적용이 contract anchor 의 명시 정의와 어긋날 경우 contract 가 이긴다.

마찬가지로 본 가이드와 `llm-team.md` Core Invariants 가 충돌하면 invariant 가 권위다 (`llm-team.md` 우선 원칙).

## Rule 5 — Read-only 보장

agent 는 본 consumer guide 또는 `CONTRACT-GLOSSARY` 를 *직접 수정하지 않는다*. 변경은 `glossary_term_proposal` (또는 본 가이드 rule 변경 시 `consumer_guide_amendment_proposal` 후보) 산출 → 사람 게이트 → Caller 영속화 경로로만 가능하다.

본 read-only 보장은 `agent-and-context-contract.md#AGC-INVALID` 의 *manifest 외 write 금지* 와 동일 원칙이다 — manifest 외 read 가 invalid 인 것처럼, agent 산출이 본 가이드 / glossary / contract 본문을 직접 갱신하는 형태도 invalid 다 (`llm-team.md` Core Invariants §4 — Caller-only operational write).
