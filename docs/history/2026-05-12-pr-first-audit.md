---
status: draft
date: 2026-05-12
owner: bakpark
authority: cli-spicy-anchor.md §"Phase 5" + Open Q #13
phase: 5
companion_pr: phase-5-pr-first-audit
---

# Phase 5 — PR-first audit (legacy envelope 폐기 결정용)

## 0. Scope

Phase 1~4 가 PR-first infra (capability policy, outbox, ReviewSurface, lead/reviewer invoker, caller-dispatch-prfirst, pr-watcher 5-gate, recovery-coordinator) 를 additive 로 도입했다. envelope path 는 여전히 default — 새 path 는 `cfg.leadPath === "pr_first"` / `deps.reviewerPath === "pr_first"` toggle 로만 활성. 본 audit 은 legacy envelope path 폐기 시점/방식 결정을 위한 grep 기반 증거 수집이다.

**Audit 정책**: 코드 변경 0. 본 PR 의 typecheck/test/build 결과는 base (`origin/main` = 4909864) 와 byte-동일해야 한다. baseline = 1131 tests passing.

---

## 1. envelope.verdict / rationale / artifacts read site

전체 `src/` + `tests/` 를 grep 한 결과, **envelope 의 `verdict` / `rationale` / `artifacts` / `summary` 4 필드를 직접 읽는 site** 는 다음과 같다 (코멘트/도큐먼트 라인 제외, 실제 식 표현만).

### 1-A. `envelope.artifacts` / `envelope.verdict` / `envelope.summary` 직접 read site (src/)

| # | site | 목적 | PR-first 대체 | 폐기 권고 |
|---|---|---|---|---|
| 1 | `src/application/reviewer-invoker.ts:477` | `envelope.artifacts as ReviewerEnvelopeArtifacts` — `deriveReviewerIntent()` 가 agent envelope 에서 `body` / `file_comments` 추출 | **마이그레이션 브리지** — PR-first path 가 envelope 출력 agent 로부터 ReviewerIntent 를 derive 하는 변환 지점. agent 가 직접 ReviewerIntent JSON 을 출력하면 제거 가능 | 단계적: agent prompt 가 ReviewerIntent 직접 출력으로 전환된 후 |
| 2 | `src/application/reviewer-invoker.ts:481` | `envelope.verdict?.result` — `verdictResult` 를 ReviewerIntent.intent 로 매핑 | 동상 (#1 과 동일 derive 경로) | 동상 |
| 3 | `src/application/reviewer-invoker.ts:485` | `envelope.summary` — body fallback | 동상 | 동상 |
| 4 | `src/application/lead-invoker.ts:769` | `envelope.artifacts as EnvelopePatchArtifacts` — `extractPatchFiles()` 가 lead 의 patch 파일 추출 (forge inner build) | **마이그레이션 브리지** — LeadIntent 가 `changed_files` 만 가지므로, agent envelope 의 `artifacts.files[].content` 가 worktree commit 의 단일 source. agent 가 직접 worktree write 한다면 제거 가능하지만 capability policy L1 (`agent edit=deny`) 와 충돌 → **외부 write 권위는 Caller 가 유지해야 하므로 이 derive 는 envelope path 폐기 후에도 유지 (LeadIntent 에 `files[].content` 추가하는 것이 자연스러운 경로)** | 보류 — LeadIntent schema 확장 필요 |
| 5 | `src/application/lead-invoker.ts:781,791` | `envelope.artifacts as EnvelopePatchArtifacts` — `extractTrackedFilesFromEnvelope()` / `deriveLeadIntent()` | 동상 #4 | 보류 |
| 6 | `src/application/lead-invoker.ts:798-799` | `envelope.summary` — LeadIntent.summary fallback | LeadIntent.summary 가 이미 존재; agent envelope 가 summary 를 제공하므로 derive 한다. agent 가 LeadIntent JSON 출력으로 전환되면 제거 | 단계적 |
| 7 | `src/application/turn-worker.ts:733-734` | `agentOut.envelope.artifacts` + `envelope.summary` — forge inner build 의 commit 생성 (`extractPatchFiles` + `[forge] <summary>`) | 동상 #4 — LeadIntent 가 `files[].content` 를 보유하면 turn-worker 가 LeadIntent 를 직접 읽도록 전환 가능 | 보류 — LeadIntent schema 확장 후 |
| 8 | `src/application/manifest-resolve.ts:273,285` | `turn.output_envelope` 의 `verdict` 를 manifest body 에 노출 (turn-log resolution) | turn body resolver 가 `output_intent_ref` / `output_receipt_ref` 를 우선시하도록 분기 필요 | 단계적 (manifest-resolve 우선 분기 추가) |
| 9 | `src/application/envelope-extended-validator.ts:232,242-243` | `env.verdict != null` 검증 + dispatch matrix `allowed_verdict_results` 매칭 | dispatch-matrix 가 ReviewerIntent.intent / LeadIntent / final_verdict 로 분기되면 envelope 자체가 검증 대상에서 빠짐. **PR-first 의 §10 dispatch matrix 는 이미 caller-dispatch-prfirst 에서 verdict 를 input 으로 받는 형태** (envelope 의 verdict 는 derive 결과를 그대로 전달) → 폐기 가능 | 단계적 |
| 10 | `src/application/outer-turn.ts:1366,1416,1429,1441,1482-1500,1616,1642,1679` | `t.verdict?.result` / `last.verdict` — outer turn 의 lead 응답 누적 / TURN_OUTPUT 합산 / approve-like 카운트 | outer-turn 은 milestone parent_kind 의 leadPath PR-first 진입점. SessionTurn 의 verdict 가 LeadIntent 의 derive 결과 (`spec_accept` / `plan_accept` / `approve`) 와 일치하므로 **SessionTurn 에 별도 `intent_summary` cache 를 추가**하거나 LeadIntent 를 직접 read 하는 방향 | 단계적 — outer-turn 의 verdict 의존을 점진적 분리 |
| 11 | `src/application/termination-evaluator.ts:220,228,250,261,263,291,300` | turn.verdict?.result — finalization rule 평가 (lead_only / unanimous_approve / quorum / any_request_changes) | 동상 #10 — termination-evaluator 는 envelope.verdict 가 sole 신호. PR-first path 에서 verdict 가 ReviewerIntent.intent 와 일치하므로 두 path 모두 호환. envelope path 폐기 시 verdict 정보는 LeadIntent/ReviewerIntent + AgentRunReceipt 조합으로 재합성 가능 | 단계적 |
| 12 | `src/application/dialogue-coordinator.ts:1600,1609` | `output_envelope?.verdict` — TurnSummary 의 verdict 채움 (legacy path) | PR-first path 는 reviewer-invoker 가 ReviewerIntent.intent → ReviewSurface.review_state 전이로 verdict 를 표현. dialogue-coordinator 의 PR-first 진입점은 별도. legacy path 만의 read | envelope path 폐기 시 함께 제거 |
| 13 | `src/application/caller-dispatch-prfirst.ts:182,235` | `input.verdict === "approve" / "request_changes"` — PR-first dispatch 의 입력 | PR-first 가 verdict 를 **input parameter** 로 받음 (envelope 에서 derive 하지 않음) — 정상 boundary | 유지 (PR-first 의 외부 API 일부) |
| 14 | `src/application/prompt-compose.ts:295,343,361` | base.verdict = {...} — prompt 작성 시 prior turn verdict 컨텍스트화 | prompt 에는 prior intent summary 가 들어가야 하므로 LeadIntent/ReviewerIntent 로 대체 | 단계적 |
| 15 | `src/application/human-signal-binding.ts:397,414` | `signal.rationale` (envelope 외부) | envelope 무관 | n/a |
| 16 | `src/adapters/workspace/git-worktree.ts:66` | 코멘트만 (Inv #4 설명) | n/a | n/a |

**총 src/ read site**: 52 raw → comment/declaration 제외 시 envelope path 만의 의존 site 약 35 개. PR-first 마이그레이션 브리지 (lead-invoker / reviewer-invoker derive) 7 개. 나머지 28 개는 envelope path 폐기 시 함께 정리해야 하는 read site.

### 1-B. `tests/` 의 envelope 직접 read

- `tests/integration/awaiting-human-flow.test.ts:139-140` — `turn.output_envelope.contribution_kind` / `.verdict?.result` 검증
- `tests/integration/middle-review-cycle.test.ts:884` — `output_envelope: null` (fixture)
- `tests/integration/outer-turn.test.ts:331,490` — output_envelope fixture
- `tests/integration/inner-cycle.test.ts:179` — `turn.output_envelope.contribution_kind`
- `tests/application/outer-turn.test.ts:53` — fixture
- `tests/application/agent-io.test.ts:499` — fixture
- `tests/application/human-signal-binding.test.ts:85-86` — verdict assertion
- `tests/application/manifest-resolve.test.ts:236,434` — fixture + missing-field 검증
- `tests/e2e/outer-discovery-mock.test.ts:154` — fixture
- `tests/domain/schema-phase-1.test.ts:227,247` — schema parse
- `tests/domain/schema-1b.test.ts:249,269` — schema parse

→ envelope schema 자체를 폐기하려면 위 fixture/assertion 을 LeadIntent/ReviewerIntent 기반으로 재작성해야 함. 영향 범위 11 개 test file.

### 1-C. 권고 (envelope 폐기 정책)

| 옵션 | 영향 | 권고 |
|---|---|---|
| **즉시 폐기** | 28+ src read site 동시 수정 + 11 test file 재작성 + SessionTurn.output_envelope 필드 제거 → 변경 폭이 너무 크고 single-PR 위험 | 비권고 |
| **단계적 deprecate (권고)** | (1) Phase 5.1: agent prompt 가 LeadIntent/ReviewerIntent JSON 을 직접 출력하도록 전환 (envelope.artifacts/verdict derive 의존 0). (2) Phase 5.2: turn-worker / outer-turn / termination-evaluator 가 SessionTurn.output_intent_ref / output_receipt_ref 를 우선 read 하도록 분기 (envelope path 는 deprecation warning + fallback). (3) Phase 5.3: legacy fixture 재작성 + output_envelope 필드 optional 화. (4) Phase 5.4: schema 에서 output_envelope 제거 | **권고** |
| **보류** | PR-first activation 후 모니터링 (1~2 cycle) 후 결정 | 차선 |

---

## 2. SliceMerge 잔존 정보 audit

ReviewSurface (PR-backing aggregate) 와 SliceMerge (slice merge lifecycle) 는 plan §4 에서 "1:N 공존 (Phase 5 audit 후 결정)" 으로 보류됨. 본 audit 은 두 schema 의 책임 중복 / 고유 정보를 비교한다.

### 2-A. ReviewSurface vs SliceMerge 필드 매핑

| SliceMerge 필드 | 의미 | ReviewSurface 대체 | 고유 정보 여부 |
|---|---|---|---|
| `slice_merge_id` | aggregate id | `review_surface_id` (parent_kind=slice 일 때) | **중복** |
| `slice_id` | parent slice | `parent_id` (parent_kind=slice) | **중복** |
| `target_id` | target governance | (target 은 caller cfg 에서 주입; SliceMerge 가 보유할 필요 없음) | 중복/잉여 |
| `pre_merge_workspace_revision` | merge 직전 workspace SHA | ReviewSurface.base_ref (PR base) 와 의미 유사 | **부분 중복** (PR base SHA vs workspace revision; rebase pre-state 의 별도 필드는 신규 필요) |
| `merge_revision` | merge 결과 SHA | ReviewSurface.head_sha (post-merge merge commit SHA 로 갱신 가능) | 중복 |
| `inner_session_id` | forge inner build session | (slice 의 contribution_id / session 매핑은 SessionTurn 으로 추적) | **고유** (현재 ReviewSurface 에 없음) |
| `review_session_id` | review session | (slice → 현재 활성 review session 매핑) | **고유** |
| `verification_run_id` | verification 결과 | ReviewSurface.latest_verification_run_id | **중복** |
| `state` (SM_DRAFT/READY/APPROVED/MERGED/REQUEST_CHANGES/CLOSED/STALE) | slice-merge 단계 | ReviewSurface.lifecycle_state (open/merged/closed/externally_closed) + review_state (pending_review/changes_requested/approved) + build_state (ready/rebuilding/stale/not_applicable) 의 **3D 조합으로 표현 가능** | **거의 대체 가능 (단, SM_DRAFT 의 "PR open 전" state 는 lifecycle_state=open + review_state=pending_review + build_state=rebuilding/not_applicable 로 표현)** |
| `merged_at` / `merged_by_caller_id` / `lease_token` | merge audit | ReviewSurface 에는 lease_token 없음 (`DialogueSession.lease_token` 별도). audit 은 ledger event 로 대체 가능 | **부분 중복** |
| `audit_chain_predecessor_id` | rebuild-on-fail audit chain | ReviewSurface 에 없음. **rebuild 시 동일 PR 유지 (same-PR continuation) → predecessor 자체가 사라짐 (review_round 으로 cycle 추적)** | 폐기 가능 (PR-first 의 same-PR continuation 가 audit chain 대체) |
| `external_refs` | GitHub PR/review/merge ref | ReviewSurface.pr_ref 가 PR 1개로 대체. ledger event 가 review ref 추적 | **중복** |

### 2-B. SliceMerge 폐기 영향

| 영향 영역 | 변경 필요 사항 |
|---|---|
| **slice 라이프사이클** | SLICE_BUILDING → SLICE_REVIEWING → SLICE_INTEGRATING → SLICE_VALIDATED 전이가 현재 SliceMerge.state 와 결합. ReviewSurface.lifecycle_state / review_state / build_state 3D 조합으로 매핑 테이블 신규 필요 |
| **manifest resolver** | `src/application/manifest-resolve.ts:130,375-389` 의 `resolveSliceMergeBody` 가 SliceMerge body inline 을 제공. ReviewSurface body resolver 가 동일 책임 (parent_kind=slice 일 때) 을 대체해야 함 |
| **verification re-run** | `slice-merge.ts:integrateSliceMerge` 가 trunk rebase 후 reverify 수행. ReviewSurface.latest_verification_run_id 가 동일 ref 보유. integrate 책임을 caller-dispatch-prfirst 의 approve branch 가 흡수 (이미 `merge_op` outbox 로 흡수됨) |
| **inner build session 연결** | SliceMerge.inner_session_id 가 forge build session 을 가리킴. ReviewSurface 가 동등 필드 (`inner_session_id?` optional) 를 추가하거나, slice 자체에 active inner session 포인터 |
| **dialogue-coordinator 분기** | dialogue-coordinator 의 30+ SliceMerge import site (현재 baseline) → ReviewSurface 기반 path 로 단계적 대체. **PR-first reviewerPath=pr_first 가 이미 ReviewSurface 만 사용하므로 SliceMerge 의존 0** |
| **사용처 30+ 파일** | grep 결과 30+ 파일이 SliceMerge import. 일괄 제거가 아니라 동등한 ReviewSurface 보조 ops + slice 라이프사이클 매핑 layer 가 필요 |

### 2-C. SliceMerge 폐기 권고

| 옵션 | 권고 |
|---|---|
| **즉시 폐기** | 비권고 — 30+ 사용처 + slice 라이프사이클 매핑 테이블 부재. legacy envelope path 와 결합되어 있어 envelope 폐기 후가 자연스러움 |
| **단계적 (권고)** | (a) ReviewSurface 에 `inner_session_id?` / `review_session_id?` optional 필드 추가 (additive). (b) slice 라이프사이클 ↔ ReviewSurface 3D state 매핑 테이블 도입 (`docs/contracts/state-and-operation-contract.md` §10 갱신). (c) manifest resolver 가 parent_kind=slice 일 때 SliceMerge 대신 ReviewSurface body 제공하도록 분기 (deprecation warning). (d) Phase 5.5 cycle 에서 SliceMerge schema 제거 + caller-dispatch 단일화. 예상 timeline: envelope 폐기 (Phase 5.1-5.4) 완료 후 1~2 cycle |
| **보류** | PR-first activation 후 1 cycle 운영하며 SliceMerge 사용처가 실제로 정리 가능한지 모니터링 |

---

## 3. SessionTurn.output_envelope (legacy) vs output_receipt_ref / output_intent_ref

### 3-A. Schema 현황 (`src/domain/schema/session-turn.ts`)

```yaml
SessionTurn:
  output_envelope: Envelope        # required (legacy, embedded)
  output_receipt_ref?: string      # Phase 1 additive (optional)
  output_intent_ref?: string       # Phase 1 additive (optional)
```

**중요 발견**: plan §5 의 "output_envelope_ref?" 는 schema 의 **embedded `output_envelope` 필드를 가리키는 별칭**이다. 실제 schema 코멘트 (line 11-17) 가 "the contract's `output_envelope_ref` slot is satisfied by embedding rather than introducing a separate `envelopes/` directory" 로 명시. 즉 ref ↔ inline embed 의 변환은 이미 결정됨.

### 3-B. write site (SessionTurn 영속화 지점)

| site | output_envelope | output_receipt_ref | output_intent_ref |
|---|---|---|---|
| `src/application/session-turn-persist.ts:79,85,88` | required (input.envelope) | optional spread (input.outputReceiptRef) | optional spread (input.outputIntentRef) |
| `src/application/human-signal-binding.ts:453` | required (validated.value) | (legacy path — additive ref 미주입) | (동) |

### 3-C. read site (SessionTurn 소비 지점)

| site | 필드 |
|---|---|
| `src/application/manifest-resolve.ts:273` | turn.output_envelope (verdict 노출용) |
| `src/application/outer-turn.ts:1167-1169,1350-1366,1600-1616,1890-1904` | parsed output_envelope (turn log resolution) |
| `src/application/dialogue-coordinator.ts:1600,1609` | output_envelope?.verdict |
| `src/application/lead-invoker.ts:179,182` | (코멘트만 — output_receipt_ref / output_intent_ref 가 invoker 의 영속화 대상) |
| `src/application/turn-worker.ts:418` | (코멘트만 — additive Phase 1 refs) |

### 3-D. 마이그레이션 계획 (output_envelope 제거 시점)

| 단계 | 조건 | output_envelope status |
|---|---|---|
| 현재 (Phase 4 완료) | leadPath/reviewerPath=pr_first 가 wired 안 됨 (toggle 만 코드에 존재) | required (legacy) |
| Phase 5.1 (envelope deprecate 시작) | PR-first activation (target.json 토글 ON) 후 envelope path 가 fallback only | required (legacy fallback) |
| Phase 5.2 | manifest-resolve / outer-turn / dialogue-coordinator 가 output_intent_ref 우선 read 로 전환 | required → **optional** 로 schema 변경 (legacy turn 만 가짐) |
| Phase 5.3 | termination-evaluator 가 LeadIntent/ReviewerIntent + AgentRunReceipt 기반으로 final_verdict 산출 | optional |
| Phase 5.4 (제거) | 1~2 cycle 운영 후 envelope read site 0 확인 | **schema 에서 제거** |

### 3-E. 권고

- **output_receipt_ref / output_intent_ref** 는 이미 schema 에 additive 도입됨. legacy turn 은 미보유, PR-first turn 은 보유.
- **output_envelope** 를 optional 화하는 schema 변경은 Phase 5.2 시점 (모든 read site 가 ref-우선 분기 완료된 후) 이 적절.
- 즉시 optional 화는 비권고 (현재 legacy path 가 default 이므로 envelope 미존재 시 large surface 가 깨짐).

---

## 4. DialogueSession.state machine PR-driven 대체 완전성

### 4-A. 5 SessionState 의 source

| SessionState | 도달 path | PR-driven 대체 가능? |
|---|---|---|
| `SESSION_OPEN` | session 생성 시 default | n/a (생성 상태) |
| `CONVERGED` | turn-worker:496,857 (inner build 성공) / outer-turn:974,988 (outer turn approve) / caller-dispatch-prfirst:519 (PR-first approve) | **PR-first 도 사용**: caller-dispatch-prfirst 가 approve 시 `session_state: "CONVERGED"` 로 전이 |
| `TIMEOUT` | termination-evaluator (timeout_only) / outer-turn (max_turns 초과) | dispatch-matrix:74,109,130,160,189,218,254 등 다수 row 가 `session_state: "TIMEOUT"`. PR-first path 도 termination-evaluator 를 호출하므로 동등 |
| `ABANDONED` | turn-worker:1076 (no_progress 등) / dialogue-coordinator:2116 (`abandoned:pr_first_reviewer:<reasonTag>`) / dispatch-matrix:82,116,137,167,196,225,261 | **PR-first 도 사용**: dialogue-coordinator 가 `pr_first_reviewer_abandoned` event 와 함께 ABANDONED 전이 |
| `AWAITING_REVALIDATION` | cross-slot-stale.ts:190,207,208 + recovery.ts:199,218,219 | **PR-first 무관** (workspace pin drift 감지 시점 — PR ↔ workspace 일치 보장) |

### 4-B. PR-driven path 매핑 표

| ReviewSurface.lifecycle_state | ReviewSurface.review_state | ReviewSurface.build_state | 대응 SessionState | 비고 |
|---|---|---|---|---|
| open | pending_review | ready | SESSION_OPEN | PR open + review 대기 |
| open | pending_review | rebuilding | SESSION_OPEN | follow-up commit 진행 중 |
| open | pending_review | stale | SESSION_OPEN (verification fail) | drift-observer + 5-gate 미통과 |
| open | changes_requested | ready/stale | SESSION_OPEN (continue) | review_round 증가, follow-up 대기 |
| open | approved | ready | SESSION_OPEN → CONVERGED (dispatch 시점) | caller-dispatch-prfirst:519 가 전이 |
| merged | approved | ready | CONVERGED (post-merge) | merge_op 완료 |
| closed | * | * | ABANDONED | dispatch-matrix abandoned row |
| externally_closed | * | * | ABANDONED (5-gate dropped) | external close = caller proxy 외부 작용 → §9 recovery |

### 4-C. dead-zone 위험

| 잠재 dead-zone | 분석 |
|---|---|
| **PR open + review_round=0 + 무한 dispatch 없음** | termination-evaluator 가 max_turns / timeout 으로 TIMEOUT 전이 보장. dispatch-matrix:74 등 TIMEOUT row 존재 → 도달 가능 |
| **request_changes 후 follow-up commit 0 + lease 만료** | recovery.ts:199 가 AWAITING_REVALIDATION 으로 전이 후 reanimator (PR #115 incident-12 회귀) 가 SESSION_OPEN 으로 복귀 가능. PR-first 도 동일 path 사용 |
| **PR externally closed (인간이 GitHub UI 에서 close)** | 5-gate ⑤ (review_signal_applied 없음) + lifecycle_state=externally_closed → dispatch-matrix abandoned row 로 ABANDONED 전이. plan §9 follow-up 복구 전이가 처리. **dead-zone 없음** 확인 |
| **lifecycle_state=open + review_state=approved 인데 merge_op 실패 반복** | outbox crash recovery + recovery-coordinator backfill 이 5-gate full-tuple correlation 으로 dedup. 최종적으로 ABANDONED (failure cap) 또는 TIMEOUT |

### 4-D. PR-driven 대체 완전성 결론

- 5 SessionState **모두 PR-first path 에서 도달 가능** (caller-dispatch-prfirst + termination-evaluator + recovery + dialogue-coordinator abandoned event).
- AWAITING_REVALIDATION 은 PR-first 와 직교 (workspace pin drift) → 둘 다 대응.
- 명확한 dead-zone 없음.

### 4-E. 권고

- DialogueSession.state machine 은 PR-first activation 즉시 사용 가능. 추가 schema 변경 불필요.
- 모니터링 항목: `pr_first_reviewer_abandoned` reasonTag 분포 — abandoned 케이스가 envelope path 대비 증가하지 않는지 1 cycle 관찰.

---

## 5. 사용자 결정 요청 (Decision Request)

본 audit 의 4 항목 결과를 바탕으로 다음 4 가지 결정을 요청드립니다.

### 5-A. envelope.verdict / rationale / artifacts 즉시 폐기 vs 단계적 deprecate vs 보류

**권고: 단계적 deprecate (5 sub-cycle)**

| sub-cycle | 작업 | 코드 변경 규모 |
|---|---|---|
| Phase 5.1 | agent prompt 가 LeadIntent / ReviewerIntent JSON 을 직접 출력 (deriveLeadIntent / deriveReviewerIntent 가 fallback only) | prompt-compose + agent runner |
| Phase 5.2 | manifest-resolve / outer-turn / dialogue-coordinator 가 output_intent_ref 우선 read 분기 (envelope fallback warning) | 4 파일 |
| Phase 5.3 | termination-evaluator 가 intent + receipt 조합으로 final_verdict 산출 | 1 파일 + test rewrite |
| Phase 5.4 | legacy fixture 11 file 재작성 + SessionTurn.output_envelope optional 화 | 11 test + 1 schema |
| Phase 5.5 | output_envelope 제거 + envelope schema 자체 제거 (또는 reduced subset) | broad |

**근거**: 즉시 폐기는 28+ src read site + 11 test file + schema 변경을 single-PR 에 묶어야 함 → 회귀 위험 매우 큼. 보류는 PR-first activation 의 효익을 늦춤.

### 5-B. SliceMerge 폐기 timeline

**권고: envelope 폐기 (Phase 5.1-5.4) 완료 후 Phase 5.5 cycle 에서 진행**

| 사전 조건 | 작업 |
|---|---|
| ReviewSurface 에 `inner_session_id?` / `review_session_id?` optional 필드 추가 | Phase 5.5a (schema) |
| slice 라이프사이클 ↔ ReviewSurface 3D state 매핑 테이블 도입 + state-and-operation-contract.md §10 갱신 | Phase 5.5b (docs) |
| manifest resolver / verification-runner / caller-dispatch 의 SliceMerge 의존 30+ 파일을 ReviewSurface 기반으로 단계적 전환 | Phase 5.5c (refactor, 2~3 sub-PR) |
| SliceMerge schema 제거 | Phase 5.5d |

**근거**: SliceMerge 는 ReviewSurface 의 거의 superset 으로 대체 가능하나 `inner_session_id` / slice 라이프사이클 매핑이 신규 작업. envelope 와 결합되어 있어 envelope 폐기 후가 자연스러움.

### 5-C. SessionTurn.output_envelope (= 코드 내 embedded form, plan 의 output_envelope_ref) 제거 시점

**권고: Phase 5.2 에서 optional 화 → Phase 5.4 에서 제거**

| 단계 | output_envelope status |
|---|---|
| 현재 | required (legacy) |
| Phase 5.1 | required (envelope path 가 여전히 default fallback) |
| Phase 5.2 | required (read site 가 ref-우선 분기 완료 후 optional 화 직전) |
| Phase 5.3 | **optional** (schema 변경 + legacy turn 만 보유) |
| Phase 5.4 | schema 에서 제거 + 모든 fixture 재작성 |

**근거**: §3 분석대로 12+ read site 가 envelope 직접 의존. 모든 read site 가 ref-우선 분기를 완료한 후에야 optional 화 가능.

### 5-D. PR-first activation 시점 (target.json experiments.lead_pr_first / reviewer_pr_first ON)

**현황**:
- `cfg.leadPath` / `deps.reviewerPath` toggle 은 코드에 존재 (turn-worker / outer-turn / dialogue-coordinator).
- 그러나 cli / daemon 에서 target.json 의 `experiments.*` 를 읽어 toggle 을 주입하는 **wiring 이 아직 0** (grep 결과 cli/ 에서 leadPath/reviewerPath 참조 없음).

**권고**: **Phase 5 audit 승인 즉시 wiring → 1 cycle 운영 → 환경별 활성**

| 단계 | 작업 |
|---|---|
| Phase 5.0a (audit 승인 후) | cli/daemon 에서 target.json `experiments.lead_pr_first` / `experiments.reviewer_pr_first` 를 읽어 leadPath / reviewerPath 에 주입 (additive, default false) |
| Phase 5.0b | 개발 환경 target.json 에서 두 toggle 을 true 로 설정 + 1 cycle 운영 |
| Phase 5.0c | 1 cycle 결과 검토 후 production target.json 에 toggle 활성 |
| Phase 5.1+ | envelope deprecate 작업 시작 (위 5-A 참조) |

**근거**: PR-first infra (Phase 1-4) 가 완비되었으나 사용되지 않는 상태 → activation 이 없으면 envelope 폐기 결정 근거가 약함. 1 cycle 실측 데이터가 envelope 폐기 timeline 의 confidence 를 결정.

---

## 6. 검증

- 본 PR 의 변경: docs/history/2026-05-12-pr-first-audit.md 1개 파일 신규 생성. 코드/test/build 0 변경.
- baseline (origin/main = 4909864) tests: 1131 passing / 4 skipped.
- 본 PR tests: **1131 passing / 4 skipped 동일** (byte-동일 회귀).
- typecheck / build: clean (baseline 과 동일).

## 7. 다음 단계

사용자의 위 §5 4 항목 결정 후, Phase 5.0a (cli wiring) 부터 sub-cycle 진입.
