# Legacy Phase Model — Historical Archive

본 디렉토리는 **2026-05-05 의 loop-based workflow amendment** 이전의 phase-based workflow model 의 raw doc set 영구 보존본이다. 본 amendment 가 채택된 직전 commit (`2731668`) 의 상태를 그대로 옮긴 것이며, 이후 변경되지 않는다 (`deprecated_historical_reference`).

## 목적

- amendment 이전의 모형을 사람이 읽고 비교 가능하도록 보존
- legacy ledger row / fixture / migration tooling 이 참조할 수 있는 단일 archive 위치
- 새 코드 / 새 doc 의 history 의존을 *명시적* 으로만 허용 (lint rule 으로 신규 코드의 본 디렉토리 import 차단 — Stage 1 commit C 이후 enforce)

## 무엇이 폐기되었는가

| Legacy 어휘 / anchor | 새 어휘 / anchor |
|---|---|
| 7-phase sequence (Discovery / Specification / Planning / Implementation / CodeReview / Integration / Validation) | 3-loop nested model (outer 4-phase + middle slice + inner TDD) |
| `Task` | `Slice` (책임 확장: 코드 → 가치) |
| `PhaseRun` (`SOC-PHASE-RUN`) | `DialogueSession` |
| `Code CP` / `Integration CP` | `SliceMerge` (lifecycle 7-state 흡수) |
| `agent_role` | `agent_profile_id` |
| `operation` | `action_kind` |
| `phase_run_id` | `session_id + turn_index` |
| `phase_policies.<phase>` (TCC) | `loop_policies.<loop>.<phase\|purpose>` |
| `RGC-PHASE-LEASE` (2 종) | `RGC-LEASE-KINDS` (4 종 + acquisition order) |
| `quorum.rule` (5 종) | `session_termination.{finalization_rule, required_evidence, composite_rule}` |
| `evidence` contribution_kind | `RequiredEvidence` + `VerificationRun` + `MetricRun` (인프라 영역) |
| `rework_patch` contribution_kind | `lead_draft` + `parent_review_verdict_id` |
| `summary` contribution_kind | outer Validation `lead_draft` artifact |
| `IMPLEMENTATION_IN_PROGRESS` / `INTEGRATION_*` milestone state | `M_DELIVERY_BUILDING` / `M_DELIVERY_VALIDATING` (dual-slot serialization) |
| Single-milestone serialization | Dual-slot (Discovery + Delivery) serialization |
| 평행 quorum submission as primary review | DialogueSession primary; quorum 은 `finalization_rule` enum 의 한 종류 |
| Spec CP `CP_AWAITING_QUORUM` | Spec CP `CP_AWAITING_HUMAN` (interim — Spec CP 자체는 보존됨) |

상세 환산표는 `docs/contracts/README.md#CONTRACT-MIGRATION-NOTES` (commit E 후) 가 단일 권위.

## 사용 정책

- **신규 코드 / 신규 doc 의 history 의존 금지** — lint rule 으로 강제. historical reader / fixture / migration map 만 예외.
- **legacy row 의 read-only 보존** — Stage 2 ledger.sh rewrite 에서 union read 로 양 schema 동시 지원. 신규 row 는 새 schema 만.
- **삭제 시점 없음** — 영구 보존 (`deprecated_historical_reference` 정책, spec §12-3).
- **Stage 5 grep 0건 정책** — 신규 writer / dispatcher 코드 한정. 본 archive 의 legacy 어휘는 grep 검출 예외.

## 디렉토리 구조

```text
docs/history/legacy-phase-model/
  README.md                    # 본 문서
  llm-team.md                  # 이전 헌법 (14 invariants + 7-phase Workflow Shape)
  contracts/
    README.md                  # 이전 contract 색인 + migration notes (legacy role → phase 환산표)
    agent-and-context-contract.md
    state-and-operation-contract.md
    reliability-and-gate-contract.md
    knowledge-contract.md
    target-config-contract.md
    agent-runner-port-contract.md
  architecture/
    pipeline-end-to-end.md     # contribution cycle + phase coordinator cycle 의 2-cycle 모형
    state-machine.md           # GitHub label 매핑 (legacy)
    daemons.md
    application-modules.md
    lease-and-recovery.md
    agent-runner-adapters.md
    agents/profiles/
      atlas.md
      forge.md
      sentinel.md
      scout.md
      human.md
```

## 원본 commit

- **추출 base**: `2731668` ("docs(specs): add loop-based workflow design spec") — amendment 직전의 main worktree 상태
- **본 archive 의 commit**: `feat/phase-agent-profile-pivot` 브랜치의 commit D
- **이전 amendment commits**: `c143df5..31016e8` 사이의 7-phase / agent_profile / contribution 모델 도입 (이전 round 의 contract rewrite)
