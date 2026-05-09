# E2E Go / No-Go Decision

production target 으로 전환하기 전, sandbox 에서 live e2e 1회를 통과시키고 cost cap / rollback 조건을 명문화한다. 본 문서는 rehearsal 결과 기록 양식이며, **rehearsal 1회 PASS 자체는 deferred-to-human** 이다.

## 1. Phase 0 ~ 5 Gate 결과

각 phase 의 gate 통과 여부를 evidence link 와 함께 기록.

| Phase | Gate (planning §3~§8) | 결과 | 날짜 | 검증자 | Evidence |
|---|---|---|---|---|---|
| Phase 0 | scope 정리 + production target 기준 | [ ] PASS / [ ] FAIL | YYYY-MM-DD | — | PR #83 |
| Phase 1 | non-live preflight stage 1 | [ ] PASS / [ ] FAIL | YYYY-MM-DD | — | PR #84 |
| Phase 2 | adapter hardening | [ ] PASS / [ ] FAIL | YYYY-MM-DD | — | PR #85 |
| Phase 3 | live healthcheck stage 2/3 | [ ] PASS / [ ] FAIL | YYYY-MM-DD | — | PR #86 |
| Phase 4 | e2e sandbox harness | [ ] PASS / [ ] FAIL | YYYY-MM-DD | — | PR #87 |
| Phase 5 | full e2e + CI workflows | [ ] PASS / [ ] FAIL | YYYY-MM-DD | — | PR #88 |

`pre-e2e-checklist.md` 의 Critical 항목 PASS 기록은 `.human/checklist/pre-e2e-checklist.md` (gitignored, local-only) 에 운영자가 직접 표기.

## 2. Cost Cap 승인

live smoke / e2e 비용을 운영자가 사전에 승인한다. 기본값은 `docs/operations/healthcheck.md §Cost ledger` 와 정합.

| 항목 | 기본 | 승인값 | 비고 |
|---|---|---|---|
| `LLM_TEAM_LIVE_COST_CAP_USD` (healthcheck Stage 3 per-run) | $0.10 | $______ | healthcheck Stage 3 1회 상한 (cost ledger). e2e harness 비용에는 적용되지 않음 |
| `LLM_TEAM_LIVE_DAILY_COST_CAP_USD` (daily) | $1.00 | $______ | UTC day 누적 ledger 합 |
| `LLM_TEAM_E2E_COST_CAP_USD` (e2e harness per-run) | $0.20 | $______ | `tests/helpers/e2e-harness.ts` rehearsal 1회 상한 |
| 1회 e2e 예상 비용 (claude smoke + codex default + codex qwen + 시나리오) | — | $______ | 견적 |

승인일: `____-__-__` 승인자: `____________`

cap 초과 attempt 는 **SKIP** 으로 ledger 에 기록되고 FAIL 로 분류되지 않는다 (planning §11). cap 자체 계산이 불가능하면 live phase 진입 차단.

## 3. Rollback / Stop 조건

rehearsal 중 다음 조건 발생 시 즉시 e2e 를 중단하고 본 문서 §4 의 결정 row 에 `blocker` 로 기록.

- **production target 에 partial side effect 감지** — sandbox 가 아닌 production repo / workdir / ledger 에 의도치 않은 쓰기.
- **sandbox GitHub side effect 가 격리 prefix 외로 누출** — `identity.label_prefix` (예: `e2e:`) 외의 label / branch / issue 가 생성됨.
- **rate_limit / quota 한 번에 다수 발생** — 1 cycle 안에 N≥3 attempt 가 `reason=rate_limit` (Phase-prod-2 adapter) 로 분류.
- **healthcheck Stage 3 FAIL** — rehearsal 직전 stage 3 에서 어느 surface 라도 FAIL.
- **cost ledger 일치 불가** — ledger 합계와 provider 측 청구 사이에 비합리적 차이.

중단 시 **반드시 보존**:
- `<RUN_DIR>` (healthcheck artifact + verified-auth-model.json + failure md)
- cycle bundle 디렉토리 (`<workdir>/<target>/cycles/...`) — `LLM_TEAM_CYCLE_BUNDLE_DISABLED` 미설정 시 자동 보존
- sandbox repo 의 side effect summary — label / branch / issue / PR prefix 별 enumeration

## 4. Go / No-Go 결정

| 항목 | 결과 |
|---|---|
| 모든 Phase gate PASS | [ ] yes / [ ] no |
| pre-e2e-checklist Critical PASS | [ ] yes / [ ] no |
| migration-checklist 의 모든 blocker `applied` 또는 `not_applicable` | [ ] yes / [ ] no |
| live e2e rehearsal 1회 sandbox 통과 (deferred-to-human) | [ ] yes / [ ] no |
| cost cap 승인 완료 | [ ] yes / [ ] no |
| rollback 조건 위반 0건 | [ ] yes / [ ] no |

**최종 결정**: [ ] **GO** (production target 전환 승인) / [ ] **NO-GO** (blocker 잔존) / [ ] **ADVISORY** (조건부 진행)

결정일: `____-__-__` 결정자: `____________`

NO-GO 또는 ADVISORY 인 경우 blocker 사유 + 다음 rehearsal 일정 기록.

## 5. See Also

- [`docs/operations/production-runbook.md`](production-runbook.md) — daemon / 인증 / rotation / workdir / rate-limit.
- [`docs/operations/production-migration-checklist.md`](production-migration-checklist.md) — migration 적용 결과 + blocker decision.
- [`docs/operations/phase-prod-DoD.md`](phase-prod-DoD.md) — Phase 0~5 DoD evidence.
- [`docs/operations/healthcheck.md`](healthcheck.md) — Stage 1~3 + cost ledger.
- [`.human/checklist/pre-e2e-checklist.md`](../../.human/checklist/pre-e2e-checklist.md) — Critical 항목 (gitignored, local-only).
