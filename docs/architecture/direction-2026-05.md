# Documentation Direction — 2026-05

본 문서는 `llm-team.md`(Constitution)와 `docs/contracts/`(operational contract set)의 정합성을 유지한 채 docs 계층을 고도화하기 위한 *방향성 합의 문서*다. 정식 contract/architecture 변경의 *제안* 과 *분류* 만을 담으며, 그 자체로는 normative 가 아니다(권위 순서: `llm-team.md` > `docs/contracts/*` > 본 문서 및 기타 architecture).

본 문서가 합의되면 Phase 1 부터 실제 contract/architecture 수정 PR 이 진행되고, 본 문서는 그때마다 "Phase X 머지됨" 표지로 갱신된다. 모든 항목 흡수 완료 시 본 문서는 archive 로 이동한다.

## 1. 배경

`llm-team.md` 는 10 개 invariant 와 권한 경계만 정의하고 구체 형식은 5 개 contract 에 위임한다. 분석 결과(`.human/draft/design-and-pipeline-analysis.md`, `.human/draft/pipeline-fixes-known-issues.md`, `.human/draft/pipeline-fixes-integrated-design.md`, `.human/draft/design-review-and-issue-strategy.md`)는 다음을 보고했다.

- 계약-구현 정합성은 강함(13 milestone × 8 task × 10 CP 상태 1:1 매핑, output envelope 강제, 마커 단일 출처).
- 그러나 *권한 경계 혼선* 이 contract 수준에 잔존: Reviewer/Integrator/QA 가 LLM 이 알 수 없는 runtime metadata(`pr_number`, `cp_path`, `cp_kind`, `artifact_ref`)를 envelope 에 직접 쓰도록 요구되는 부분(헌법 Inv#3 위반 소지).
- architecture 공백: application-layer 12 개 모듈 맵, feature-request 인입 흐름, GitHub side-effect 타임라인, lease/recovery 의미론, fetch_scope 정책 미문서화.
- 운영 안전성 contract 외연 부족: target.yaml 스키마, agent_runner 포트, role-specific lease TTL, ledger result 세분화, partial-fail rollback, daemon atomic 시작.

본 direction 은 위 갭을 헌법 위반 없이 닫는 5-phase 로드맵을 합의 대상으로 제시한다.

## 2. 헌법 Invariant ↔ Contract Anchor 추적 매트릭스

`llm-team.md:72-83` 의 10 개 invariant 가 어느 contract anchor 로 강제되는지 추적한다. *제안 후* 컬럼은 본 direction 의 항목이 머지되면 추가될 anchor 다.

| # | Invariant | 현재 anchor | 제안 후 anchor (추가/확장) |
|---|---|---|---|
| 1 | Stateless single-call | AGC-AGENT (AGC-ROLES + AGC-CALL-BOUNDARY) | 유지 |
| 2 | Context Manifest + revision pin | AGC-CONTEXT-MANIFEST | + `fetch_scope` enum 명시 + 역할별 default scope 표 |
| 3 | Caller-only operational write | 헌법 + AGC-CALL-BOUNDARY + RGC-WRITES | **+ AGC-OUTPUT-RUNTIME-ENRICH** (Phase 1, drift 정정 핵심) |
| 4 | Queue-based handoff | SOC-OBJECTS + persistent store (전 영역) | + `target-config-contract.md` (target 식별·격리 normative 화) |
| 5 | Milestone serialization | SOC-STATES (Milestone FSM) | 유지 |
| 6 | Task parallelism by lease | RGC-LEASE | + role-specific TTL 정책 + idempotency_token/monotonic counter |
| 7 | Deterministic verification by Caller | RGC-VERIFICATION | + `tools.md` 매핑 명시(architecture) |
| 8 | Human gate blocking | RGC-SIGNALS + RGC-HUMAN-GATES | 유지 |
| 9 | Finite retry → escalate | RGC-FAILURE | + RGC-LEDGER `result` enum 확장(`escalated`, `rolled_back`, `result_detail`) |
| 10 | Knowledge accumulation | KAC (전 anchor) | + KAC-MANIFEST-FROM-KNOWLEDGE (누적 spec → manifest 변환 규약) |

## 3. `.human/draft/` 항목 Graduation 분류표

draft 의 모든 issue/제안을 다음 4 개 destination 으로 분류한다. (C) = contract 변경 제안, (A) = architecture 작성, (B) = 보류, (X) = 본 plan 범위 밖(별도 코드 PR).

| # | Draft 항목 | Destination | 대상 anchor / 파일 |
|---|---|---|---|
| 1 | Reviewer/Integrator/QA envelope 의 runtime metadata 요구 | (C) | **AGC-OUTPUT-RUNTIME-ENRICH** 신설 + SOC-OPERATIONS 정정 (Phase 1) |
| 2 | Context snapshot 5000+ chars truncation 부재 | (C)+(A) | AGC-CONTEXT-MANIFEST.fetch_scope 확장 + `architecture/context-snapshot.md` |
| 3 | Lease TTL 단일 600s 한계 | (C)+(A) | RGC-LEASE 확장(role-specific) + `architecture/lease-and-recovery.md` |
| 4 | Lease 원자성 / clock skew 위험 | (C) | RGC-LEASE 의 idempotency_token + monotonic counter MUST |
| 5 | Orphan task 누적(partial-fail 무복구) | (C) | RGC-FAILURE + RGC-LEDGER 의 `rolled_back` MUST |
| 6 | Daemon atomic 시작 race | (C) | RGC 신설 절 RGC-DAEMON-STARTUP |
| 7 | Self-hosting 의 worktree=framework clone 의미 | (C)+(A) | `target-config-contract.md` (`onboarding.self_hosting`) + `architecture/self-hosting.md` |
| 8 | ws_apply_patch 절대경로 가드 | (X) | code PR (CLAUDE.md "코드 수정은 본 plan 범위 밖") |
| 9 | Issue body 의 human/machine 2-layer 분리 | (C)+(A) | AGC-ISSUE-BODY 신설 + `architecture/agent-output-format-mapping.md` 예시 추가 |
| 10 | GitHub side-effect 타임라인 부재 | (A) | `architecture/github-side-effect-timeline.md` |
| 11 | Application-layer 12 모듈 맵 부재 | (A) | `architecture/application-modules.md` |
| 12 | Feature-request 인입 흐름 미문서화 | (A) | `architecture/feature-request-intake.md` |
| 13 | Multi-model agent runner(CODER/QWEN36) | (C)+(A) | `agent-runner-port-contract.md` 신설 + `architecture/agent-runner-adapters.md` |
| 14 | recovery.sh / human_signal.sh silent failure | (C) | RGC-FAILURE 의 `escalated` ledger result MUST + 아키 매핑 |
| 15 | Fenced JSON parser 약점(no-block/multi-block) | (C) | RGC-LEDGER 의 `result_detail` 자유필드 |
| 16 | Reviewer stale-check best-effort | (X) | code PR (architecture 매핑은 lease-and-recovery.md 에서 언급) |
| 17 | Pipeline 단일 cycle 흐름의 정식 architecture 문서 부재 | (A) | `architecture/pipeline-end-to-end.md` |
| 18 | Onboarding gate / preset(`github-pipeline/v1`) 스키마 미정의 | (C) | `target-config-contract.md` |
| 19 | Agent output accessor 산재(37 inline jq) | (X) | code PR — `lib/agent_output.sh` 신설 |
| 20 | Role-specific 모델 매핑(`role_model_map`) | (C) | `target-config-contract.md` + `agent-runner-port-contract.md` |

## 4. 5-Phase 로드맵

- **Phase 0** (현재): 본 문서. 사람 승인 게이트.
- **Phase 1** (단독 PR): AGC-OUTPUT-RUNTIME-ENRICH 신설 + SOC-OPERATIONS 의 Implement/Review/Refactor/Validate 절을 metadata-free envelope 로 정정. **이 PR 머지 전 다른 contract/architecture 작업 대기.**
- **Phase 2**: P0 architecture 작성 — `pipeline-end-to-end.md`, `application-modules.md`, `feature-request-intake.md`, `architecture/README.md` 인덱스 갱신.
- **Phase 3**: 운영 안전성 contract 확장 PR(분할).
  - PR-β: AGC-CONTEXT-MANIFEST(fetch_scope), RGC-LEASE(role-specific TTL + idempotency_token), RGC-LEDGER(result enum 확장).
  - PR-γ: AGC-ISSUE-BODY 신설, SOC-OPERATIONS side-effect 표(보강), RGC-FAILURE(partial-fail rollback), RGC-DAEMON-STARTUP 신설, KAC-MANIFEST-FROM-KNOWLEDGE.
  - PR-δ: `target-config-contract.md`(prefix `TCC`), `agent-runner-port-contract.md`(prefix `ARC`).
  - 이어서 P1/P2 architecture(`github-side-effect-timeline.md`, `lease-and-recovery.md`, `context-snapshot.md`, `self-hosting.md`, `agent-runner-adapters.md`) + 기존 architecture 확장(daemons, tools, state-machine, agent-output-format-mapping).
- **Phase 4**: `.human/draft/` 의 graduate 항목 → `.human/archive/2026-05-pipeline-fixes/` 이동.

## 5. Open Questions — 본 direction 의 기본 선택

| # | 질문 | 기본 선택 | 변경 시 영향 |
|---|---|---|---|
| Q1 | draft 운영 정책 | Phase 4 에서 archive | 그대로 유지 시 Phase 4 생략 |
| Q2 | 신설 contract(`target-config`, `agent-runner-port`) 분리 | 분리 | 흡수 시 RGC + AGC 비대화, prefix 미신설 |
| Q3 | 문서 언어 | 한국어 유지 | 영문 병기 시 Phase 3 PR 분량 ×2 |
| Q4 | anchor prefix 신설 | TCC, ARC | 거부 시 Q2 와 연동 |
| Q5 | Phase 0 산출물 위치 | `docs/architecture/direction-2026-05.md` (본 문서) | contracts/CHANGELOG-DIRECTION.md 로 이전 시 architecture 가 단일 진입점 |

다른 결정을 원하면 본 문서를 수정한 뒤 Phase 1 진입.

## 6. 검증

본 direction 의 무결성 점검은 다음으로 수행한다.

1. 위 §2 매트릭스의 모든 행이 contract anchor 로 연결되는지 grep 으로 확인:
   ```sh
   grep -rE '<a id="(AGC|SOC|RGC|KAC|TCC|ARC)-[A-Z-]+"></a>' docs/contracts/
   ```
2. 위 §3 분류표의 모든 (C) 항목이 Phase 1 또는 Phase 3 PR 에 1:1 대응하는지 확인.
3. 위 §3 분류표의 모든 (A) 항목이 Phase 2 또는 Phase 3 의 architecture 파일 목록과 1:1 대응하는지 확인.
4. 헌법 위반 검사: contract 변경안의 어떤 절도 `llm-team.md` 의 10 invariant 또는 권한 경계와 충돌하지 않음을 사람 리뷰에서 확인.

---

**Status**: Draft (Phase 0). 사람 승인 시 본 문서 §4 의 Phase 1 진입.
