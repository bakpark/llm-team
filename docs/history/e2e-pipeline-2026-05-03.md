# Pipeline E2E 실행 결과 — 2026-05-03

워크트리 `test/pipeline-e2e-260503` 에서 `bakpark/llm-team` 대상 7-role daemon 폴링을
실제 GitHub + 실제 Claude 호출로 약 7시간 가동한 결과 보고.

## 실행 개요

- **기간:** 2026-05-03 10:00 ~ 18:30 KST (~7h)
- **베이스:** `d8983c8` (main 직전 BUG-1/BUG-2 fix 머지본) + 본 worktree 5 커밋
- **타겟:** `bakpark/llm-team`, lease TTL 30분, 폴링 120s
- **모니터링:** 30초 tick 워처 + 게이트 자동 approve injector
- **종료 사유:** Coder 단계에서 `ws_apply_patch` 무한 retry — ROI 한계

## 파이프라인 도달 깊이

10단계 중 6단계 정상 통과:

| Stage | ms#7 (issue #22, M1) | ms#8 (issue #23, M2) |
|-------|----------------------|----------------------|
| 0. Promote (issue → milestone) | ✅ | ✅ |
| 1. PO Compose-PO → PO_GATE | ✅ | ✅ |
| 2. Auto-approve PO_GATE → PM_DRAFT | ✅ (CP merged) | ✅ (CP merged) |
| 3. PM Compose-PM → PM_GATE | ✅ | ✅ |
| 4. Auto-approve PM_GATE → DECOMPOSE_READY | ✅ (CP merged) | ✅ (CP merged) |
| 5. Planner Decompose → IMPLEMENTING | ✅ (6 tasks #24-#29) | ✅ (14 tasks #30-#43) |
| 6. Coder Implement → TASK_REVIEW_READY | ❌ (47회 시도 후 stop) | (블록됨 — 의존성) |
| 7. Reviewer Review → TASK_INTEGRATED | — | — |
| 8. Sweep IMPLEMENTING → REFACTOR_READY | — | — |
| 9. Integrator + QA → DONE | — | — |

## ledger 통계

- 총 154 row
- applied 14, error 138, stale 1, recovered 1
- error 분포: Implement 47 / Decompose 46 / Compose-PM 46 (대부분 transport_error 또는 ws_apply_patch 실패)
- 백업: `/tmp/e2e-260503-ledger-final.jsonl`

## 발견된 결함

### A. 코드 수정으로 해결 (4건, 본 worktree에 커밋됨)

| # | 커밋 | 결함 | 수정 내용 |
|---|---|---|---|
| 1 | `7bba753 fix(feature-request)` | promote가 milestone description에 source issue body를 임베드하지 않아 PO snapshot이 placeholder만 노출 → "TBD/placeholder" 골격 spec 산출 | `it_object_get_snapshot(issue, N)`을 promote에서 호출, milestone body의 `## Source content (issue #N)` 섹션에 임베드. 어댑터 미지원 시 기존 placeholder로 폴백. |
| 2 | `2930f4d fix(it)` | `it_revision_pin_get`가 `feature_request_issue` kind 거부 → envelope revalidate가 actual을 못 가져와 ledger 'stale' 처리 | github / in_memory 어댑터 case에 `task / feature_request_issue` alias 추가 (`it_object_get_snapshot`와 동일 정책) |
| 3 | `911ac8b fix(ready_object)` | `_ready_object_pick_po`가 raw `feature_request_issue` 픽업 → `_caller_apply_spec_proposal`가 nonexistent milestone#N update 시도 → `milestone_update body failed` | PO picker는 PO_DRAFT milestone만 반환. promote가 다음 cycle에서 잔여 흡수하므로 처리 누락 없음. |
| 4 | `66ef67e chore(target)`, `f73afba chore(e2e)` | (운영 편의) lease TTL 600s 폴백, debug envelope 보존 옵션, onboarding ack 3건 | `targets/llm-team.yaml`에 `lease.ttl_default: 1800`, `LLM_TEAM_DEBUG_KEEP_STALE_ENVELOPE` 환경변수 분기 |

각 fix는 단위 테스트 + 4 e2e suite (`contract-smoke`, `full-flow`, `full-flow-fail`, `runner-pipeline`) 회귀 통과.

### B. 미해결 (운영 환경 + 코드 가능성 혼재)

#### B-1. GH milestone title 중복 시 promote 실패
- **증상:** 같은 e2e를 반복 실행하면 `gh api POST repos/.../milestones`가 `Validation Failed: title already_exists`로 거부 (closed milestone도 title 점유). 결과: promote silently fail (`>/dev/null 2>&1 || true`로 swallow), 이후 PO가 unaccepted feature_request_issue를 픽업해 (B-2 fix 이전엔) apply 실패.
- **운영 영향:** 신규 워크플로우에선 발생 빈도 낮음. 반복 e2e/수동 cleanup 시나리오에 한정.
- **권장 수정:** promote에서 title 중복 감지 시 (a) 기존 milestone 재사용 (state를 PO_DRAFT로 강제) 또는 (b) title에 timestamp suffix. 단, idempotency 보장 필요.

#### B-2. Coder `ws_apply_patch: patch precheck failed (malformed or non-applicable)` — 47회 무한 루프
- **증상:** Coder가 task #24 픽업 → Claude 호출 (~3분) → unified diff 생성 → ws_apply_patch precheck 실패 → claim_rollback → TASK_READY → 다음 cycle 같은 task 재픽업 → ... 7시간 반복. 비용 다수 누적.
- **진단 한계:** precheck 메시지가 "malformed or non-applicable"로만 나와 정확한 원인(잘못된 path / context line / charset / git refs?) 불명. 환경: `workdir/llm-team/wt/task-24/` 워크스페이스 존재.
- **원인 후보:** (a) Claude 4.7 Opus 패치 품질 — manifest snapshot과 실제 워크스페이스 상태 차이로 인한 hunk drift, (b) generated diff의 `--- a/` `+++ b/` path가 워크스페이스 root와 불일치, (c) 같은 task 재시도 시 직전 cycle의 잔여 변경이 남아있을 가능성.
- **권장 조치:**
  1. `ws_apply_patch` precheck에 진단 정보 추가 (실패 hunk + 첫 mismatch line + dry-run output 샘플).
  2. 무한 루프 차단: 같은 (task, manifest_id)에 대한 연속 error N회 후 ESCALATED로 격상하거나 lease backoff 적용.
  3. 워크스페이스 reset 정책 명시: 각 cycle 시작 시 `ws_refresh`가 실제로 origin tip으로 reset 하는지 검증.

#### B-3. Planner / PM `lr_invoke non-ok (transport_error)` — 다수 retry
- **증상:** Anthropic API 호출이 transport_error로 종종 실패. ms#8 Decompose는 1+시간 retry 끝에 결국 성공.
- **원인:** Anthropic API 측 일시 장애 또는 rate limit (코드 결함 아님).
- **현재 동작:** 데몬이 매 cycle (120s) 재시도로 자연스럽게 흡수. 코드 변경 불필요.
- **권장 보완:** transport_error에 대해 exponential backoff + 5xx와 4xx 구분된 ledger reason 기록.

## 모니터링 / 자동화 자산

- `/tmp/e2e-auto-approve.sh` — milestone 본문에 approve signal 주입 (pin 생략, drain 시점 stale 회피)
- `/tmp/e2e-approved.txt` — 처리한 (ms, gate) 멱등 추적
- 모니터 워처 — daemon liveness / pipeline state / ledger growth / role log error / gh state diff / milestone state diff 6종을 30s tick으로 변화 감지

## 핵심 학습

1. **파이프라인 코어 로직 (PO ~ Planner) 은 견고**. 진단 가능한 결함 3건은 모두 promote ↔ pick ↔ apply 경계의 누락된 alias / 누락된 데이터 주입 / 잘못된 픽업 후보였고, 단위 + e2e 테스트로 안정화 가능.
2. **Coder 단계가 LLM 출력 품질에 가장 민감**. ws_apply_patch precheck의 진단 부족이 디버깅을 가로막고, 무한 retry로 비용 폭증. **infinite-loop guard는 e2e 안정성의 1순위 후속 작업.**
3. **외부 API 불안정** (transport_error)이 daemon retry 패턴과 잘 맞물려 있어 자동 회복은 동작. 단, 무한 retry 비용 누적 위험은 (2)와 같은 형태로 일반화 가능.
4. **promote enrichment** (source issue body → milestone body) 가 PO 출력 품질을 결정짓는 단일 가장 큰 레버. legacy 마일스톤 #1/#2가 호소했던 INPUT-GAP의 근본 원인.

## 후속 권장 (우선순위순)

1. **P0** — Coder/Planner 무한 retry guard: 같은 (object, op) 연속 error N회 또는 같은 manifest_id 재시도 N회 후 ESCALATED.
2. **P0** — `ws_apply_patch` precheck 실패 시 진단 정보 (failed hunk + dry-run apply output) ledger reason에 캡처.
3. **P1** — `feature_request_promote`에 milestone title 중복 fallback (재사용 or unique suffix).
4. **P2** — `lr_invoke` transport_error에 exponential backoff + ledger reason 분리.

## GitHub 부산물 정리

본 실행 후 cleanup 완료:
- task issue #24-#43 (20개) → CLOSED
- ms#7, ms#8 → DELETE
- issue #22, #23 → label `feature-request:accepted` 제거 + `feature-request` 복원, milestone unlink
- 결과: feature-request open issue 2건, milestone 0건 — 실행 시작 시점과 동일

## 본 worktree에 남는 산출

- 5개 fix/chore 커밋 (위 표 A 참고)
- 본 문서 (`docs/history/e2e-pipeline-2026-05-03.md`)
- workdir/llm-team/* (manifests, ledger, daemon log) — gitignored, 보존됨

---

## 재실행 (fix 적용 후, 2026-05-03 20:49 ~ 23:32 KST, ~2h45m)

위 B 섹션의 미해결 결함 3건 (B-1 / B-2 / B-3) 에 대한 코드 fix 4 commit
(`7c9e6ea` ledger reason+backoff infra, `0d96fdc` B-2, `eb8f198` B-1,
`4b7a720` B-3) 적용 후 동일 e2e 절차 재실행. 이전 실행과 같은 worktree·daemon
설정 (interval 120s, lease TTL 30m, 30s 모니터, auto-approve injector).

### 도달 깊이 비교

| Stage | 이전 e2e (~7h) | 재실행 (~2h45m) |
|-------|----------------|-----------------|
| 0. Promote (issue → milestone) | ✅ ms#7, #8 | ✅ ms#9, #10 |
| 1. PO Compose-PO → PO_GATE | ✅✅ | ✅✅ |
| 2. Auto-approve PO_GATE → PM_DRAFT | ✅✅ | ✅✅ |
| 3. PM Compose-PM → PM_GATE | ✅✅ | ✅✅ |
| 4. Auto-approve PM_GATE → DECOMPOSE_READY | ✅✅ | ✅✅ |
| 5. Planner Decompose → IMPLEMENTING | ✅✅ (ms#7 6 task / ms#8 14 task) | ✅✅ (ms#9 4 task / ms#10 6 task) |
| 6. Coder Implement | ❌ 47회 무한 retry 후 ROI 한계 | ❌ → **자동 ESCALATED** (4 task × 3회 = 12 error 후 차단) |

→ 양 milestone 모두 IMPLEMENTING 통과. Coder 단계의 LLM 출력 품질 한계는
변하지 않았지만 **무한 retry 가 retry guard 로 결정적으로 차단됨**.

### Ledger 통계 비교

| 지표 | 이전 e2e | 재실행 | 비고 |
|---|---|---|---|
| 총 row 증가분 | 154 (이전 e2e 전체) | 36 (재실행 본 segment) | 재실행은 이전 ledger 위에 append (155–190) |
| applied | 14 | 16 | 도달 깊이 동일하면서 약간 증가 (PO/PM/Planner 통과 정상) |
| error | 138 | **12** | retry guard 가 무한 retry 차단 → 비용 1/12 |
| escalated | 0 | **4** | 새 retry guard 발동 (task #44, #45, #48, #52) |
| stale | 1 | 2 | 비슷한 수준 |
| recovered | 1 | 2 | recovery_scan 정상 |

### Fix 검증 결과

#### B-1 (title suffix + silent swallow 제거) — 검증 ✓
- 생성된 milestone title:
  - ms#9 = `draft: feature-request #22 @2026-05-03T09:34:21Z`
  - ms#10 = `draft: feature-request #23 @2026-05-03T09:34:23Z`
- 두 milestone 모두 promote 단계에서 422 충돌 0건 (이전 closed milestone 잔존
  이 없는 환경이라 직접 충돌은 자연 발생 안 함; suffix 적용은 단위 테스트
  + 실 e2e title 모두 확인).
- promote silent swallow 제거 효과는 본 e2e 에선 promote 실패 0건이라 발동
  없음 (단위 테스트로 fallback 경로 cover).

#### B-2 (ws_apply_patch 진단 + retry guard) — 검증 ✓ (핵심)
- 4 task (#44, #45, #48, #52) 모두 같은 패턴:
  ```
  cycle 1: stale (envelope pin 자체-stale; LLM 호출 ~3분 동안 milestone updated_at 바뀜)
  cycle 2-4: error 3회
  cycle 5: ESCALATED, reason="retry_guard:3 consecutive errors"
  ```
- 이전 e2e 의 task #24 (47회 동일 패턴 반복) 와 비교: **47회 → 5회로 차단**.
  Coder 비용/시간이 단일 task 당 ~10× 절감.
- ESCALATED 도달 후에는 ready_object_pick 이 더 이상 픽업 안 함 → daemon 이
  계속 idle 사이클만 돌고 신규 비용 0. 이전 실행의 7시간 → 2h45m 으로 전체
  실행 시간도 절반 이하.

#### B-3 (lr_invoke transport_error 분류 + backoff retry) — 발동 없음
- 본 실행에서는 Anthropic API 가 transport_error 를 한 번도 반환하지 않음
  (이전 e2e 의 ms#8 Decompose 1+시간 retry 같은 이벤트 0건). 코드 경로 자체
  는 단위 테스트 (`tests/lib/test-llm-runner-port.sh` 확장) 로 cover.
- runner 의 lr_call 로그 형식 변경은 적용 확인:
  `runner: lr_call exit_status=ok reason=none attempt=1/3` (이전엔 `exit_status=ok` 만).

### 잔존 이슈 (재실행에서 새로 관찰)

- **첫 cycle stale**: Coder 의 첫 ws_apply_patch 시도가 매번 stale revision 으로
  실패 (ledger 의 task #44 첫 row 의 `result=stale` 참조). 원인 추정: lr_call
  이 ~3분 걸리는데 그동안 task issue 의 updated_at 이 다른 사이클 활동
  (라벨 transition, 코멘트 추가 등) 으로 바뀌어 envelope 의 input_revision_pin
  이 stale 처리됨. 본 retry guard 는 stale 후 error 3회 까지 대기하는데, stale
  자체도 retry guard 카운트에 포함시킬지는 별도 정책 결정 필요.
- **task 간 격상 후 milestone-level 정리 부재**: ms#9 의 4 task 가 모두
  ESCALATED 됐지만 milestone 자체는 IMPLEMENTING 으로 머묾. milestone-level
  격상 (`milestone-IMPLEMENTING-ESCALATED`) 매트릭스가 없어서 자동 진전 불가.
  운영상 사람이 task 들을 진단/리셋하거나 milestone 도 격상해야 함.

### 후속 권장 (변경)

이전 권장 P0 (Coder/Planner 무한 retry guard) 와 P0 (precheck 진단) 는 본
fix 로 해결됨. 새 우선순위:

1. **P1** — 첫 cycle stale 자체 흡수 또는 카운트: lr_call 동안 발생한
   metadata-only updated_at 변경은 무해하므로, revision_pin_revalidate 가 이를
   체질 (예: timestamp 만 변하고 본문/state 변동 없는 경우 ok) 하거나, retry
   guard 가 stale 도 카운트하도록 확장.
2. **P1** — `ws_apply_patch` precheck 의 진단 정보를 ledger reason 에도 캡처.
   현재는 log_error 에만 들어가고 ledger 의 reason 필드는 null. precheck
   diag 첫 줄을 reason 으로 옮기면 문서/통계에서 즉시 확인 가능.
3. **P2** — milestone-level 자동 격상: 모든 task 가 ESCALATED 면 milestone 도
   자동으로 ESCALATED 로 전이 (state matrix 확장 필요).
4. **P2** — `lr_invoke` transport_error 의 backoff retry 동작 검증을 fake
   adapter 시퀀스 fixture 로 통합 테스트 cover (현재는 단위 분류만).

### 본 재실행에서 추가된 산출

- 4 fix/feat 커밋 (`7c9e6ea` / `0d96fdc` / `eb8f198` / `4b7a720`).
- 본 섹션 (`docs/history/e2e-pipeline-2026-05-03.md` 추가).
- 백업 ledger: `/tmp/e2e-260503-ledger-rerun.jsonl` (190 rows).
