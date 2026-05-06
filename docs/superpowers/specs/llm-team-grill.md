---
status: draft
date: 2026-05-06
scope: skill-proposal-spec
related:
  - .human/draft/2026-05-06-mattpocock-skills-borrow.md
  - docs/contracts/agent-and-context-contract.md
  - docs/contracts/README.md
  - docs/architecture/agent-domain-consumer-guide.md
---

# `grill-discovery` — Skill Proposal Spec (PoC)

> **이것은 skill proposal spec 이며 runtime bundle 이 아니다.** mattpocock/skills 의 `grill-with-docs` *형식만* 차용해 llm-team 의 envelope 제약 (P5 5필드) 안에서 동작하도록 재구성한 단일 dispatch 클래스 후보다. 영속화 권한은 Caller 단독이며 (`llm-team.md` Core Invariants §4), agent 의 산출은 envelope 안 (`#AGC-CONTRIBUTION` 의 `proposal` 또는 `lead_draft` + `next_action_request`) 으로 제한된다. 본 spec 의 카탈로그 등록 / registry 위치는 옵션 D 후속 결정에 의존하며 본 PoC 단계에서는 `.human/poc-metrics/2026-05-mattpocock-skills-borrow.md` 가 측정 hook 의 단일 기록 위치다.

## §1 Goal

`grill-with-docs` 의 *형식* (한 번에 한 질문 + 추천답 + 결정트리 가지치기) 을 Discovery 단계 입력 인터뷰에 적용한다. 인터뷰 결과의 영속화는 사람 결정 + Caller 영속 write 로만 일어난다. 본 skill 의 산출은 envelope 안의 `proposal_artifact` 1건이다 — agent 가 `CONTEXT.md` / `CONTRACT-GLOSSARY` / ADR 을 직접 갱신하지 않는다.

본 skill 이 닫는 표류 패턴 3종:

1. **Misalignment** — Discovery 단계에서 사람의 의도와 agent 의 해석이 맞물리지 않은 채 spec 작성으로 진입.
2. **도메인 용어 표류** — `CONTRACT-GLOSSARY` 미정의 용어가 spec 본문에 슬쩍 등장.
3. **9 invariant 위반 가능성** — 새 milestone / contract 변경 / 새 AgentProfile 제안이 invariant 위반을 안고 본문에 들어옴.

## §2 Scope / Non-goals

**Scope:**

- outer Discovery 단계의 사람 입력 인터뷰 (새 milestone 진입, contract 변경 제안, 새 AgentProfile 후보, 새 skill 후보).
- 인터뷰 결과를 `proposal_artifact` 1건으로 응축. `next_action_request.addressed_to=human` 로 후속 라운드 트리거.

**Non-goals:**

- trunk write 또는 contract 본문 직접 수정 (금지 — `forbidden_side_effects` §4).
- Issue / PR / 라벨 상태 변경 (mattpocock `triage` 차용 안 함 — P4).
- middle / inner loop 의 turn (다른 skill 의 책임).
- skill bundle 의 runtime 등록 (옵션 D 후속 결정 — Q8).

## §3 인터뷰 트리 — 9 invariant 위반 가능성 체크리스트

`grill-with-docs` 의 "한 번에 한 질문 + 추천답" 패턴을 강제한다. 결정트리는 9 invariant 별 1 질문 (`llm-team.md` Core Invariants §1~§9 순서) 로 구성한다. 각 질문은 추천답 1개와 분기 조건을 함께 제시한다. 인터뷰 trigger 는 사람의 자유서술 입력 1건 (Discovery 진입 트리거).

| 순서 | invariant | 질문 형태 (요약) | 분기 조건 |
|---|---|---|---|
| Q1 | §1 — agent stateless 1-shot | "본 제안의 agent 산출이 단일 SessionTurn 으로 닫히는가?" | "아니오" → multi-turn 분해 후보 산출 |
| Q2 | §2 — agent content-only | "본 제안이 agent 가 trunk / contract 본문을 직접 수정하는 형태인가?" | "예" → forbidden, proposal 으로 변환 권고 |
| Q3 | §3 — Caller turn coordination | "본 제안의 turn ordering / fairness / lease 영향이 평가됐는가?" | "아니오" → fairness violation 후보 표기 |
| Q4 | §4 — Caller-only operational write | "agent 산출이 envelope 안에 머무는가?" | "아니오" → invalid envelope 경고 |
| Q5 | §5 — Human governance signal | "본 제안이 feature slice 인가? 인 경우 사람 게이트가 명시됐는가?" | "예 + 미명시" → required_participants 보강 권고 |
| Q6 | §6 — deterministic verification by Caller | "internal slice 인 경우 deterministic verification 항목이 정의됐는가?" | "아니오" → required_evidence 후보 표기 |
| Q7 | §7 — persistent object handoff | "본 제안의 핸드오프 단위가 직접 호출이 아니라 영속 객체인가?" | "아니오" → 영속 객체 후보 (Slice / Session / Contribution) 산출 권고 |
| Q8 | §8 — idempotency 3-scope | "본 제안의 retry 시 idempotency 3-scope 중 어느 것이 적용되는가?" | "불명" → ARC-IDEMPOTENCY 인용 권고 |
| Q9 | §9 — self-fetch + manifest + revision pin | "manifest 의 첫 entry 가 `CONTRACT-GLOSSARY` 인가? 미정의 용어가 있는가?" | "미정의 용어 있음" → `glossary_term_proposal` 후보 등재 |

각 질문은 한 번에 1개만 사람에게 제시한다 (mattpocock §2-1 의 "한 번에 한 질문" 패턴). 사람 응답 후에만 다음 질문 또는 분기 산출로 진입한다.

## §4 Envelope 제약 (P5 5필드)

본 skill 이 dispatch 될 때 Caller 가 검증해야 하는 envelope 제약:

| 필드 | 값 |
|---|---|
| `required_manifest_entries` | `docs/contracts/README.md#CONTRACT-GLOSSARY`, `llm-team.md` Core Invariants (§1~§9), `docs/architecture/agent-domain-consumer-guide.md` |
| `allowed_contribution_kind` | `proposal` (`#AGC-CONTRIBUTION`) |
| `allowed_output_kind` | `proposal_artifact` (`#AGC-CONTRIBUTION-OUTPUTS` line 495 — `(any) / proposal / proposal_artifact` 행) |
| `forbidden_side_effects` | trunk write, contract 본문 수정, `CONTRACT-GLOSSARY` 항목 직접 추가, Issue / PR / 라벨 상태 변경, runtime metadata (`idempotency_key` 등) 임의 산출 |
| `caller_materialization` | (a) 사람 결정 후 Caller 가 spec / glossary / ADR 후보를 영속화. (b) `next_action_request.addressed_to=human` 으로 후속 라운드 (spec-draft 또는 glossary 갱신 라운드) 트리거. (c) 측정 hook 6개 중 본 skill 영향 4개를 `.human/poc-metrics/2026-05-mattpocock-skills-borrow.md` 에 기록 |

`(parent_loop, contribution_kind, output_kind)` 매트릭스 정합 — 본 skill 의 출력 envelope 은 `#AGC-CONTRIBUTION-OUTPUTS` 의 `(any) / proposal / proposal_artifact` 행에 정합한다 (`#AGC-INVALID` 의 매트릭스 외 조합 항목 위반 회피). `lead_draft + proposal_artifact` 조합은 매트릭스에 존재하지 않으므로 본 skill 은 `proposal` contribution 으로만 모델링한다.

`forbidden_side_effects` 의 모든 항목은 `#AGC-INVALID` 의 manifest 외 write 금지 / envelope content 일관성 위반과 동일 원칙이다.

## §5 출력 매핑

- `contribution_kind` = `proposal` (canonical — `#AGC-CONTRIBUTION` enum)
- `output_kind` = `proposal_artifact` (canonical — `#AGC-CONTRIBUTION-OUTPUTS` line 495)
- `proposal_kind` = `discovery_question_set` (★ **proposed enum extension**, *not* canonical) — 현 매트릭스의 acceptance_test_amendment / discovered_dependency / refactor / cross_milestone_amendment 4개 enum 에 포함되지 않음.
- `next_action_request.addressed_to` = `human`

**PoC 단계 enum 처리 — 이는 contract amendment 가 필요한 sub-type 이다.** 매트릭스 line 495 는 "proposal_kind 필수 (acceptance_test_amendment / discovered_dependency / refactor / cross_milestone_amendment)" 로 enum 을 명시하므로, `discovery_question_set` 을 자유 텍스트로 사용하는 것은 envelope content 일관성 위반 (`#AGC-INVALID`) 이 된다. 따라서 본 skill 의 PoC 운영은 다음 두 분기 중 하나를 따른다:

1. **분기 A (권장 — `#AGC-CONTRIBUTION-OUTPUTS` 매트릭스 amendment 우선)** — PoC turn 운영 *전* 에 매트릭스의 proposal_kind enum 에 `discovery_question_set` 을 추가하는 contract amendment 를 1건 수행 (별도 spec/plan 라운드, 본 plan 범위 밖). amendment 머지 후 PoC turn 운영.
2. **분기 B (PoC 측정만 우선)** — amendment 진행 *전* 에는 PoC turn 을 실제 dispatch 하지 않고, 본 spec 의 인터뷰 트리 (§3) 와 envelope 제약 (§4) 만 *문서로* 검토. 측정 hook 의 의미 있는 값은 amendment 머지 후에 채워진다.

본 PoC 의 `.human/poc-metrics/2026-05-mattpocock-skills-borrow.md` 측정 슬롯에 *amendment 진행 여부* 를 1줄 메모로 기록한다.

## §6 측정 hook (PoC §4 의 4개 학습 지표)

본 skill 이 직접 영향을 주는 측정 항목 (.human draft §4 의 6개 중 4개):

| 지표 | 본 skill 의 영향 |
|---|---|
| 권한 경계 신호 (AGC-INVALID 발생 수) | envelope 의 invalid 비율. 목표 0건 |
| sub-type 부담 신호 (★ proposal_kind 종류) | 본 skill 이 도입한 `discovery_question_set` 1종 + 인터뷰 결과로 등재된 ★ 후보 누적 |
| NEED_CONTEXT 발생 신호 | manifest 의 `CONTRACT-GLOSSARY` 첫 entry 가 부족했던 횟수 |
| proposal 채택 신호 | `discovery_question_set` proposal 의 사람 게이트 통과율 |

기록 위치: `.human/poc-metrics/2026-05-mattpocock-skills-borrow.md` (PoC 측정 스캐폴드 — 자동 수집 인프라 부재 하의 manual 기록).

## §7 Open

다음 질문은 본 PoC 단계에서 닫지 않는다. 측정값이 모인 뒤 별도 결정 라운드로 진입:

- **Q6 (5필드 권위 분할)** — `required_manifest_entries` / `allowed_contribution_kind` / `allowed_output_kind` 의 1급 권위가 `agent-and-context-contract.md` 에, `forbidden_side_effects` / `caller_materialization` 의 1급 권위가 `target-config-contract.md` 에 분할 등재될지. 신규 anchor `AGC-SKILL-MANIFEST` + `TCC-SKILL-REGISTRY` 후보.
- **Q8 (registry 위치)** — `.llm-team/skills/` (D-i 중립) vs `.claude/skills/` (D-ii UX entry stub). 외부 런타임 자율 invoke 가능성 평가 결과를 입력으로 사용.
- **Q9 (★ enum 등재 시점)** — PoC turn 운영 전 분기 A 의 단발 amendment 로 `discovery_question_set` 1건만 등재할지, PoC 종료 후 누적된 ★ enum 들을 일괄 등재할지. §5 의 분기 A/B 결정과 함께 닫힌다.

위 3 질문은 `.human/draft/2026-05-06-mattpocock-skills-borrow.md` §5 의 Q6 / Q8 / Q9 와 동일하며 본 spec 의 후속 spec brainstorming 입력으로 사용된다.
