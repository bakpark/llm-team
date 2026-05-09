# Phase-prod Definition of Done — Evidence

planning §12 (`.human/draft/2026-05-09-production-implementation-phases.md`, gitignored) 의 DoD 8 항목별 현재 상태 + evidence link. PR 본문 대신 본 문서가 추적 source.

## DoD Items

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Phase 0 의 결정 6건이 닫혔다: healthcheck TS, exitStatus enum 유지, CI auth 모델 발견 방식, cycle bundle minimal subset, checklist anchor 호환성, Phase 3+ 비용 승인/cap. | [x] CLOSED | PR #83 (target fixture + production-target.md), [`docs/operations/production-target.md`](production-target.md), [`docs/operations/migration-inventory.md`](migration-inventory.md), [`docs/operations/phase-prod-conventions.md`](phase-prod-conventions.md) |
| 2 | Phase 1 healthcheck stage1 이 local/CI 에서 통과한다. | [x] CLOSED | PR #84 (healthcheck stage 1 CLI), [`docs/operations/healthcheck.md`](healthcheck.md), `npm run healthcheck:stage1` |
| 3 | Phase 2 adapter hardening tests 가 통과한다. | [x] CLOSED | PR #85 (env policy / redact / attempt diagnostics / transport reason), `src/adapters/llm-runner/*`, `src/adapters/llm-runner/common/redact.ts` |
| 4 | Phase 3 live healthcheck stage2/stage3 이 opt-in 으로 통과한다. | [~] PARTIAL — code merged, **live e2e rehearsal 1회 sandbox 통과는 deferred-to-human** | PR #86 (Stage 2 + Stage 3 1-shot smoke). live rehearsal 은 [`e2e-go-no-go.md §4`](e2e-go-no-go.md) decision row 에서 closure. |
| 5 | Phase 4 최소 e2e 시나리오가 sandbox 에서 통과한다. | [x] CLOSED | PR #87 (e2e sandbox harness + inner tdd_build mock smoke) |
| 6 | Phase 5 PR workflow 와 manual/nightly e2e workflow 가 존재한다. | [x] CLOSED | PR #88 (full e2e + CI workflows + ledger-summary CLI) |
| 7 | Phase 6 production runbook 과 go/no-go 문서가 존재한다. | [x] CLOSED (본 cycle) | [`production-runbook.md`](production-runbook.md), [`e2e-go-no-go.md`](e2e-go-no-go.md), [`production-migration-checklist.md`](production-migration-checklist.md), 본 문서 |
| 7b | cost cap / rollback / migration inventory 가 go/no-go 문서에 반영되어 있다. | [x] CLOSED | [`e2e-go-no-go.md §2`](e2e-go-no-go.md) (cost cap), [`e2e-go-no-go.md §3`](e2e-go-no-go.md) (rollback), [`production-migration-checklist.md`](production-migration-checklist.md) (migration) |
| 8 | `.human/checklist/pre-e2e-checklist.md` 의 Critical 항목이 실행 결과로 닫혔다. | [ ] **DEFERRED-TO-HUMAN** | `.human/checklist/pre-e2e-checklist.md` 는 gitignored local-only 문서. rehearsal 실행 후 운영자가 직접 `[x]` + 날짜/검증자 기록. |

## Deferred-to-Human

본 cycle 의 Gate 에서 의도적으로 제외한 항목 (planning §9 "deferred-to-human (Gate excluded)" 와 정합):

- **DoD #4 후반부**: `LLM_TEAM_E2E=1` live e2e 1회 sandbox 통과 — phase-prod-6 closure 가 아님. 운영자가 rehearsal 시점에 `e2e-go-no-go.md §1` Phase 3/4 row 에 결과 기록.
- **DoD #8**: `pre-e2e-checklist.md` Critical 항목 PASS 날짜 — gitignored 문서이므로 commit 으로 추적 불가. local 기록만.
- **production target 전환 승인**: `e2e-go-no-go.md §4` 결정 row 가 `GO` 일 때만 진행.

## Update Policy

- DoD 항목 status 변경 시 본 표를 업데이트하고 evidence link (PR # 또는 doc path) 를 첨부.
- live rehearsal 통과 시 DoD #4 status 를 `[x] CLOSED` 로, evidence 에 RUN_DIR 경로 / cost ledger 합계 첨부.
- 8개 항목 모두 CLOSED 또는 DEFERRED-TO-HUMAN 명시 후에만 production 전환 승인.

## See Also

- [`docs/operations/production-runbook.md`](production-runbook.md)
- [`docs/operations/e2e-go-no-go.md`](e2e-go-no-go.md)
- [`docs/operations/production-migration-checklist.md`](production-migration-checklist.md)
- [`docs/operations/phase-prod-conventions.md`](phase-prod-conventions.md) — phase-prod branch / commit / PR 규약.
