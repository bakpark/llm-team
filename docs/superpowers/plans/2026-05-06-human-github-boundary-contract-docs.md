# Human·GitHub 경계 contract — 문서/스키마 반영 (Plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec `docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md` 의 §6 (Contract / 문서 변경) 과 TCC governance 추가를 codebase 에 반영한다. component (`human_signal_drain`/`signal_dispatch`/`drift_observer`) 구현은 별도 plan 으로 분리.

**Architecture:** 7 개 contract / architecture markdown 파일을 spec §6 에 맞게 갱신하고, TS 런타임의 `src/config/target-schema.ts` 에 `target.governance` Zod 블록을 추가한다. 모든 변경은 additive (스키마) 또는 의미 갱신 (markdown) 이며, 신규 component 코드는 도입하지 않는다.

**Tech Stack:** Markdown (contracts/architecture docs), TypeScript + Zod 3 (`src/config/target-schema.ts`), Vitest.

**Spec coverage** (이 plan 이 닫는 범위):
- spec §6.1 → Task 1 (TCC-GOVERNANCE markdown + scope/precedence/change-rules 보강) + Task 7 (Zod)
- spec §6.2 → Task 3 (AGC-SESSION-INPUT)
- spec §6.3 → Task 2 (RGC-SIGNALS)
- spec §6.4 → Task 5 (human.md)
- spec §6.5 → Task 4 (external-tracking-mapping §1 + §6 전부)
- spec §6.6 → Task 6 (github-side-effect-timeline)
- spec §6.7 → Task 2 (RGC-LEDGER `external_observation`)
- contract conformance (README.md) → Task 8 (anchor 추가에 따른 CONTRACT-CONFORMANCE matrix + CONTRACT-ARCHITECTURE-MAPPING 갱신)

다루지 않는 범위 (후속 plan / `.human/draft/`):
- 신규 component (drain / dispatch / observer) 구현
- IT port (`it_*`) 도입 및 GitHub 어댑터
- Ledger 인프라 (현재 codebase 미존재)
- DialogueSession / SliceMerge state machine 구현
- GitHub Teams API 클라이언트, webhook/poll 어댑터

---

## File Structure

| 파일 | 변경 종류 | 책임 |
|---|---|---|
| `docs/contracts/target-config-contract.md` | append section + 3 list 보강 | TCC-GOVERNANCE 신규 + TCC-SCOPE / TCC-PRECEDENCE / TCC-CHANGE-RULES 에 governance 항목 추가 |
| `docs/contracts/README.md` | 2 곳 갱신 | CONTRACT-CONFORMANCE matrix 의 "Target Configuration" 절에 TCC-GOVERNANCE row, CONTRACT-ARCHITECTURE-MAPPING 의 TCC row 에 anchor 추가 |
| `docs/contracts/reliability-and-gate-contract.md` | edit RGC-LEDGER + RGC-SIGNALS | `action_kind=external_observation` 추가, signal envelope source/external_ref/awaiting binding 명시 |
| `docs/contracts/agent-and-context-contract.md` | edit AGC-SESSION-INPUT | middle review session 의 advisory `prior_review_context` slot 정의 |
| `docs/architecture/external-tracking-mapping.md` | edit §1·§3·§5·§6 | mapping 표에 tracker/control/contract_change 3 행 추가, `kind` enum 확장, drift/sync_status 정책 |
| `docs/architecture/agents/profiles/human.md` | edit "Contribution 변환 path" | 입력 채널 후보 3종 → comment command 단일 명시 |
| `docs/architecture/github-side-effect-timeline.md` | edit outer Discovery + 신규 bootstrap 절 | Tracker Issue 생성 + awaiting block 갱신, repo bootstrap 의 Control / Contract Change Issue 1회 생성 |
| `src/config/target-schema.ts` | append schema block | `target.governance` Zod 블록, default 값, strict 검증 |
| `tests/config/registry.test.ts` | append describe block | `target.governance` parse / default / reject 테스트 |

---

## Task 1: TCC-GOVERNANCE 섹션 추가

**Files:**
- Modify: `docs/contracts/target-config-contract.md` — 새 anchor `<a id="TCC-GOVERNANCE"></a>` 절을 TCC-AGENT-PROFILES 다음, TCC-LOOP-POLICIES 직전에 삽입

- [ ] **Step 1: 삽입 지점 확인**

Run:
```bash
grep -n -E '^<a id="TCC-(AGENT-PROFILES|LOOP-POLICIES)"' docs/contracts/target-config-contract.md
```
Expected: 두 줄 출력. AGENT-PROFILES 와 LOOP-POLICIES 라인 번호 기록 (이 사이에 신규 섹션을 삽입).

- [ ] **Step 2: TCC-GOVERNANCE 섹션 삽입**

`docs/contracts/target-config-contract.md` 에서 `<a id="TCC-LOOP-POLICIES"></a>` 직전에 다음을 삽입 (markdown 파일 내부에 코드블록과 표가 있으므로 **4-backtick fence** 사용):

````markdown
<a id="TCC-GOVERNANCE"></a>
## TCC-GOVERNANCE: Governance Surface & Human Authority

`target.governance.*` 는 사람·GitHub 경계의 단일 권위 설정이다. 본 절은 [`docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md`](../../docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md) 의 결정을 contract 로 반영한다.

| 키 | 필수 | default | 의미 |
|---|---|---|---|
| `target.governance.human_team` | yes | — | GitHub Team 슬러그 (예: `myorg/approvers`). comment command 의 author authority 검증 단일 권위. v1 은 단일 team. |
| `target.governance.control_issue_number` | yes | — | system signal (`pause` / `resume` / `stop`) 입력 surface — repo-level Issue 번호 (1 repo당 1개). |
| `target.governance.contract_change_issue_number` | yes | — | `{contract, change_proposal}` 집합 surface — verb 가 target_kind 결정 (예: `amendment-approve` → `change_proposal`). |
| `target.governance.signal_command_prefix` | no | `/` | comment command verb prefix. slash-command 충돌 회피용 운영 override. |
| `target.governance.human_team_cache_ttl_seconds` | no | `300` | drain 의 GitHub Teams API 응답 캐시 TTL. RGC-LEASE-KINDS 의 lease TTL 과 별개. |
| `target.governance.unauthorized_author_alert` | no | `false` | 비-멤버이지만 repo collaborator 인 author 의 1차 시도 시 비공개 운영 알림 (RGC-NOTIFICATION). 공개 surface 에는 노출하지 않음. |

`human_team` 캐시 미스 + GitHub Teams API 실패 시 drain 은 fail-closed (envelope 큐 진입 보류, backoff 재시도). 한도 초과 시 RGC-NOTIFICATION 운영 알림.

`control_issue_number` 와 `contract_change_issue_number` 가 각각 1개 Issue 만 가리키는 이유는 외부 surface 단일 권위 보장이다. 다중 Issue 라우팅은 미도입.

````

- [ ] **Step 3: TCC-SCOPE bullet list 보강**

`docs/contracts/target-config-contract.md` 의 TCC-SCOPE 절 (파일 상단) bullet list 의 `- 설정값 우선순위` 직전에 다음 한 줄 삽입:

```markdown
- Governance surface — 사람 입력 채널, GitHub Team authority, control / contract change Issue 번호 (`TCC-GOVERNANCE`)
```

- [ ] **Step 4: TCC-PRECEDENCE anchor 목록에 추가**

`docs/contracts/target-config-contract.md` 의 TCC-PRECEDENCE 의 다음 문장:

```markdown
2. target 단위 설정 (`TCC-LEASE-CONFIG`, `TCC-ONBOARDING`, `TCC-AGENT-PROFILES`, `TCC-LOOP-POLICIES`, `TCC-SLICE-CLASS-RULES`, `TCC-DUAL-TRACK`, `TCC-CONTEXT-BUDGET`, `TCC-REFACTOR-METRICS`, `TCC-ENFORCEMENT` 등)
```

을 다음으로 교체:

```markdown
2. target 단위 설정 (`TCC-LEASE-CONFIG`, `TCC-ONBOARDING`, `TCC-AGENT-PROFILES`, `TCC-LOOP-POLICIES`, `TCC-SLICE-CLASS-RULES`, `TCC-DUAL-TRACK`, `TCC-CONTEXT-BUDGET`, `TCC-REFACTOR-METRICS`, `TCC-ENFORCEMENT`, `TCC-GOVERNANCE` 등)
```

- [ ] **Step 5: TCC-CHANGE-RULES key 목록에 governance 추가**

`docs/contracts/target-config-contract.md` 의 TCC-CHANGE-RULES 의 다음 bullet:

```markdown
- `lease`, `onboarding`, `agent_profiles`, `loop_policies`, `internal_escalation_rules`, `dual_track`, `context_budget`, `refactor_metrics` 키는 다음 cycle 시작 시점부터 적용된다. 진행 중인 lease 와 DialogueSession 은 이전 설정으로 끝까지 처리된다.
```

을 다음으로 교체:

```markdown
- `lease`, `onboarding`, `agent_profiles`, `loop_policies`, `internal_escalation_rules`, `dual_track`, `context_budget`, `refactor_metrics`, `governance` 키는 다음 cycle 시작 시점부터 적용된다. 진행 중인 lease 와 DialogueSession 은 이전 설정으로 끝까지 처리된다. `governance.human_team` / `governance.control_issue_number` / `governance.contract_change_issue_number` 변경은 외부 surface 재바인딩을 요구하므로 caller 가 새 cycle 시작 전에 awaiting block / Tracker Issue 의 정합을 검증한다.
```

- [ ] **Step 6: 정합 확인**

Run:
```bash
grep -nE '<a id="TCC-(AGENT-PROFILES|GOVERNANCE|LOOP-POLICIES)"|TCC-GOVERNANCE|Governance surface' docs/contracts/target-config-contract.md
```
Expected:
- 세 anchor 가 위 순서로 등장 (line 70 영역, 신규, 87 영역).
- TCC-PRECEDENCE bullet 에 `TCC-GOVERNANCE` 1회 등장.
- TCC-CHANGE-RULES bullet 에 `governance` 1회 등장.
- TCC-SCOPE 에 `Governance surface` 1회 등장.

- [ ] **Step 7: Commit**

```bash
git add docs/contracts/target-config-contract.md
git commit -m "docs(contracts): add TCC-GOVERNANCE + scope/precedence/change-rules 보강

human·GitHub 경계 spec (2026-05-06) 의 §6.1 반영. human_team /
control_issue_number / contract_change_issue_number 등 6개 키 단일 권위.
SCOPE bullet, PRECEDENCE 안커 list, CHANGE-RULES 키 list 도 함께 갱신해
contract 정합 확보.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: RGC-LEDGER + RGC-SIGNALS 갱신

**Files:**
- Modify: `docs/contracts/reliability-and-gate-contract.md` — RGC-LEDGER 의 `action_kind` enum 확장, RGC-SIGNALS envelope 의 `source` / `external_ref` 표준값 / `signal_id` 산출 / pin 슬롯의 `awaiting` block 출처 명시

- [ ] **Step 1: 두 anchor 라인 확인**

Run:
```bash
grep -nE '^<a id="(RGC-LEDGER|RGC-SIGNALS)">|^### 필수 필드|^Caller 는 signal' docs/contracts/reliability-and-gate-contract.md
```
Expected: RGC-LEDGER, RGC-SIGNALS, "필수 필드", "Caller 는 signal" 라인 출력. 아래 step 의 위치 단서.

- [ ] **Step 2: RGC-LEDGER `action_kind` enum 확장**

`docs/contracts/reliability-and-gate-contract.md` 의 RGC-LEDGER "필수 필드" 표에서 `action_kind` 행을 다음으로 교체:

```markdown
| `action_kind` | 폭넓은 분류 — `intake` / `slot_promotion` / `session_progress` / `session_finalize` / `slice_merge` / `verification` / `recover` / `pause_resume` / `signal_apply` / `external_observation`. legacy `operation` 폐기. `external_observation` 은 transition 이 아닌 외부 이벤트 관찰 (예: GitHub lifecycle drift) 의 ledger 표현으로, `from_state=to_state` 동일하고 `output_hash` / `manifest_id` 는 null 가능 |
```

- [ ] **Step 3: RGC-SIGNALS envelope 표 확장 — `source` / `external_ref`**

`docs/contracts/reliability-and-gate-contract.md` 의 RGC-SIGNALS envelope 필드 표에서 마지막 행 (`rationale`) 다음에 두 행 추가:

```markdown
| `source` | yes | signal 입력 어댑터 식별자. 표준값: `github_comment` (Issue comment 어댑터, node_id prefix `IC_` 한정) |
| `external_ref` | recommended | 출처 surface 의 외부 식별자. `github_comment` 인 경우 `{ comment_node_id, html_url }` |
```

- [ ] **Step 4: `signal_id` 산출 + pin 출처 명시**

`docs/contracts/reliability-and-gate-contract.md` 의 RGC-SIGNALS 의 envelope 표 직후 단락 ("Caller 는 signal 집행 전에 다음을 검증한다." 가 시작되는 곳) 직전에 다음 단락 삽입:

```markdown
**`signal_id` 산출**: `source=github_comment` 일 때 `signal_id = comment.node_id` (GitHub GraphQL node_id, REST `id` 와 1:1, 영속·전역 유일).

**pin / session 슬롯 출처**: `source=github_comment` 인 envelope 은 동일 surface 의 Issue body 에 Caller 가 유지하는 `awaiting:` machine block 에서 `target_revision_pin`, `related_object_id`, `related_object_revision_pin`, `session_id` 를 채운다. block 부재 시 envelope 는 invalid 처리 (`docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md` §4.4 참조).

```

- [ ] **Step 5: 정합 확인**

Run:
```bash
grep -nE 'external_observation|github_comment|comment_node_id|awaiting:' docs/contracts/reliability-and-gate-contract.md
```
Expected: 4 종 키워드 모두 1회 이상 등장.

- [ ] **Step 6: Commit**

```bash
git add docs/contracts/reliability-and-gate-contract.md
git commit -m "docs(contracts): RGC-LEDGER external_observation + RGC-SIGNALS source/awaiting

human·GitHub 경계 spec (2026-05-06) §6.3 / §6.7 반영.
- action_kind enum 에 external_observation 추가 (드리프트 관찰 row 표현)
- envelope 의 source/external_ref 표준값 + signal_id 산출 + awaiting block 출처 명시

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: AGC-SESSION-INPUT — `prior_review_context` slot 추가

**Files:**
- Modify: `docs/contracts/agent-and-context-contract.md` — AGC-SESSION-INPUT 에 advisory slot 정의 추가

- [ ] **Step 1: AGC-SESSION-INPUT 위치 확인**

Run:
```bash
grep -n -E '^<a id="AGC-SESSION-INPUT"|^## AGC-SESSION-INPUT' docs/contracts/agent-and-context-contract.md
```
Expected: anchor 와 헤더 라인 출력. 다음 anchor 직전을 삽입 지점으로 사용.

- [ ] **Step 2: 그 다음 anchor 라인 확인**

Run:
```bash
awk '/^<a id="AGC-SESSION-INPUT"/{found=1; next} found && /^<a id="AGC-/{print NR": "$0; exit}' docs/contracts/agent-and-context-contract.md
```
Expected: AGC-SESSION-INPUT 다음 anchor 의 라인 번호 + 텍스트. 그 직전이 본 task 의 삽입 지점.

- [ ] **Step 3: advisory slot 정의 삽입**

`docs/contracts/agent-and-context-contract.md` 에서 AGC-SESSION-INPUT 절의 마지막 (다음 anchor 직전) 에 다음 단락 추가 (markdown 안에 yaml 코드블록 포함이라 **4-backtick fence** 사용):

````markdown
### Advisory slot — `prior_review_context` (middle review session 한정)

middle review DialogueSession 의 input manifest 는 *직전* SliceMerge 가 `SM_REQUEST_CHANGES → SM_CLOSED` 로 종료된 직후의 새 SliceMerge 인 경우에 한해 다음 advisory 슬롯을 포함할 수 있다.

```yaml
prior_review_context:
  prior_slice_merge_id: <string>
  final_verdict_summary: <string>
  key_findings:
    - kind: review_finding
      path: <string>
      line: <int|null>
      summary: <string>
```

- **Advisory only**: contribution chain 에 영향 없음. reviewer 는 새 코드 기준 독립 판단. prompt 의 "참고 컨텍스트" 로만 동봉된다.
- **동봉 조건**: 동일 Slice 의 직전 SliceMerge 가 `SM_CLOSED` 이며 종료 사유가 `SM_REQUEST_CHANGES → SM_CLOSED` (request_changes) 인 경우만. 그 외 사유 (`abandon`, `escalate`, SM_STALE→BLOCKED) 또는 직전 SliceMerge 부재 시 슬롯은 omit.
- **출처**: 본 슬롯의 contract 결정은 [`docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md`](../../docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md) §4.7.

````

- [ ] **Step 4: 정합 확인**

Run:
```bash
grep -n 'prior_review_context' docs/contracts/agent-and-context-contract.md
```
Expected: 본 contract 안에 1회 이상 등장.

- [ ] **Step 5: Commit**

```bash
git add docs/contracts/agent-and-context-contract.md
git commit -m "docs(contracts): AGC-SESSION-INPUT advisory prior_review_context slot

human·GitHub 경계 spec (2026-05-06) §4.7 반영. middle review 재진입 시
직전 SliceMerge 의 final_verdict_summary + key_findings 를 advisory 로
동봉. contribution chain 영향 없음.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: external-tracking-mapping — §1 mapping + §6 inbound 정책 갱신

**Files:**
- Modify: `docs/architecture/external-tracking-mapping.md` — **§1** (provider="github" 객체 매핑) 표에 신규 row 3행, §6 inbound 정책의 3개 bullet 전체 교체

> **주의**: spec 본문 (`design.md` §6.5) 의 "§3 (mapping 표)" 표기는 spec 작성 시점 오류 (실제 §1 이 매핑 표). 본 plan 은 정확히 §1 을 가리킨다. spec 본문 수정은 별도 commit 으로 함께 처리 (Step 4 참조).

- [ ] **Step 1: 변경 지점 확인**

Run:
```bash
grep -nE '^## 1\.|^## 5\.|^## 6\.|sync_status|kind.*GitHub' docs/architecture/external-tracking-mapping.md | head -30
```
Expected: §1 (provider="github" 객체 매핑), §5 (동기화 메타 스키마), §6 (동기화 방향과 inbound 정책) 헤더 + sync_status / `external_refs[].kind` 위치 출력. 매핑 표는 §1 직후 라인 11 부근에 위치함을 확인.

- [ ] **Step 2: §1 mapping 표 행 추가**

`docs/architecture/external-tracking-mapping.md` 의 §1 매핑 표 — 마지막 row (`inner tdd_build DialogueSession`) 직후에 다음 3 row 추가:

```markdown
| MilestoneTracker | GitHub Issue (label `kind/milestone-tracker` + body machine block) | `milestone_tracker` | 1 milestone : 1 Tracker Issue. outer Discovery / Specification / Validation 의 사람 승인 surface (Issue body `awaiting:` block 갱신 + comment command 입력). 보조용 — Milestone CP / Spec CP 본문은 GitHub Milestone description 에 누적되는 기존 정책 유지. spec: `docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md` §4.2 |
| Control | GitHub Issue (1 repo당 1개) | `control` | system signal (`pause`/`resume`/`stop`) 단일 입력 surface. `target.governance.control_issue_number` 로 식별. terminal state 없음 (close 안 함) |
| ContractChange | GitHub Issue (1 repo당 1개) | `contract_change` | `{contract, change_proposal}` 집합 surface — verb 가 target_kind 결정. `target.governance.contract_change_issue_number` 로 식별. terminal state 없음 |
```

- [ ] **Step 3: §6 inbound 정책 — 3개 bullet 전부 교체**

`docs/architecture/external-tracking-mapping.md` 의 §6 의 inbound 정책에 있는 다음 3 bullet 블록 (현재 4 bullet, 첫 bullet `**inbound (외부 → 내부)**` 가 헤더이고 그 아래 3 sub-bullet):

```markdown
- **inbound (외부 → 내부)**: 외부 surface 의 변경은 *내부 state 를 직접 변경하지 않는다*.
  - GitHub webhook 또는 polling 으로 감지된 변경은 [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS) 의 사람 governance signal 로만 변환된다 (예: Issue close → `request_recover` 또는 `cross_milestone_amendment` signal).
  - 변환은 `application/human_signal.sh` 또는 그에 상응하는 어댑터에서 수행한다.
  - signal 검증을 통과한 후에야 [`RGC-HUMAN-CONTRIBUTION`](../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION) 의 contribution 으로 envelope 화되어 dialogue_coordinator 가 평가한다.
```

을 다음 4 bullet 블록으로 교체 (헤더 + 3 sub-bullet):

```markdown
- **inbound (외부 → 내부)**: 외부 surface 의 변경은 *내부 state 를 직접 변경하지 않는다*.
  - GitHub Issue comment (REST `/issues/{n}/comments`, GraphQL node_id prefix `IC_`) 의 strict line-prefix command 만이 [`RGC-SIGNALS`](../contracts/reliability-and-gate-contract.md#RGC-SIGNALS) envelope 로 변환되어 사람 governance signal 의 입력으로 인정된다. PR inline review comment (`PRRC_`) / PR review native (`PRR_`) / lifecycle 이벤트 (close/reopen/label/milestone state edit/draft toggle 등) 는 신호로 승격되지 않는다.
  - 비-신호 lifecycle 이벤트는 `drift_observer` 가 대응 `external_refs[].sync_status` 를 `conflict` 로 전이하고 ledger 에 `action_kind=external_observation` row 를 기록한다. 회복은 §7 의 `conflict` 회복 정책 (사람 governance signal) 으로 일원화한다 — 자동 reopen / state mutate 없음.
  - signal envelope 변환과 dispatch 는 [`사람·GitHub 경계 spec`](../superpowers/specs/2026-05-06-human-github-boundary-contract-design.md) 의 `human_signal_drain` / `signal_dispatch` 컴포넌트가 수행한다. envelope 검증을 통과한 `approve` / `reject` 는 [`RGC-HUMAN-CONTRIBUTION`](../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION) 의 contribution 으로 enveloping 되어 dialogue_coordinator 가 평가한다.
```

- [ ] **Step 4: spec 본문의 "§3" 표기 정정**

`docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md` §6.5 의 다음 문장:

```markdown
- §3 (mapping 표) 에 신규 row 추가: `MilestoneTracker → GitHub Issue (kind: milestone_tracker)`, `Control → GitHub Issue (kind: control)`, `ContractChange → GitHub Issue (kind: contract_change)`. `external_refs[].kind` enum 에 동일 3종 추가.
```

을 다음으로 교체:

```markdown
- §1 (provider="github" 객체 매핑 표) 에 신규 row 추가: `MilestoneTracker → GitHub Issue (kind: milestone_tracker)`, `Control → GitHub Issue (kind: control)`, `ContractChange → GitHub Issue (kind: contract_change)`. `external_refs[].kind` enum 에 동일 3종 추가.
```

- [ ] **Step 5: 정합 확인**

Run:
```bash
grep -nE 'milestone_tracker|^\| Control \|.*control \|.*system|^\| ContractChange|drift_observer|sync_status.*conflict|comment command' docs/architecture/external-tracking-mapping.md
```
Expected: 6개 키워드 패턴 모두 1회 이상 등장. 다음 두 표기는 더 이상 등장하지 않아야 함:
```bash
grep -cE 'Issue close → request_recover|application/human_signal\.sh' docs/architecture/external-tracking-mapping.md
```
Expected: `0`. (`application/human_signal.sh` 가 §6 에서 폐기되었음을 확인.)

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/external-tracking-mapping.md docs/superpowers/specs/2026-05-06-human-github-boundary-contract-design.md
git commit -m "docs(architecture): tracker/control/contract_change kinds + drift policy

human·GitHub 경계 spec (2026-05-06) §6.5 반영.
- §1 (provider=github 객체 매핑 표) 에 milestone_tracker/control/
  contract_change 3 row 추가
- §6 inbound 정책 3 bullet 전부 교체: lifecycle 이벤트 → signal 승격 폐기,
  drift_observer 가 sync_status=conflict + external_observation ledger row
  기록. application/human_signal.sh 표기 폐기 → human_signal_drain 컴포넌트
- spec 본문의 §3 → §1 표기 정정 (스펙 작성 시점 오류)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: human.md — 채널 단일 명시

**Files:**
- Modify: `docs/architecture/agents/profiles/human.md` — "Contribution 변환 path" 섹션의 채널 후보 (label / comment / form 중 하나) 를 comment command 단일로 명시

- [ ] **Step 1: 대상 문장 확인**

Run:
```bash
grep -nE 'GitHub label, comment, 또는 별도 form|application/human_signal\.sh' docs/architecture/agents/profiles/human.md
```
Expected: 두 표현 모두 등장하는 라인 번호 출력.

- [ ] **Step 2: 채널 문구 교체**

`docs/architecture/agents/profiles/human.md` 의 다음 문장:

```markdown
사람은 직접 envelope 을 작성하지 않는다. [`#RGC-SIGNALS`](../../../contracts/reliability-and-gate-contract.md#RGC-SIGNALS) 의 `approve` / `reject` 신호 (GitHub label, comment, 또는 별도 form) 가 다음 절차로 contribution 으로 변환된다:
```

을 다음으로 교체:

```markdown
사람은 직접 envelope 을 작성하지 않는다. [`#RGC-SIGNALS`](../../../contracts/reliability-and-gate-contract.md#RGC-SIGNALS) 의 `approve` / `reject` 신호는 GitHub Issue comment (REST `/issues/{n}/comments`, GraphQL node_id prefix `IC_`) 의 strict line-prefix command 단일 채널로 입력된다 ([`사람·GitHub 경계 spec`](../../../superpowers/specs/2026-05-06-human-github-boundary-contract-design.md) §4.1). PR inline review comment / PR review native UI 는 신호로 인정되지 않으며 drift_observer 가 lifecycle 로 관찰한다. 입력은 다음 절차로 contribution 으로 변환된다:
```

- [ ] **Step 3: 정합 확인**

Run:
```bash
grep -cE 'GitHub label, comment, 또는 별도 form' docs/architecture/agents/profiles/human.md
```
Expected: `0`. 문구 폐기 확인.

```bash
grep -nE 'IC_|strict line-prefix|drift_observer' docs/architecture/agents/profiles/human.md
```
Expected: 신규 키워드 모두 1회 이상 등장.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/agents/profiles/human.md
git commit -m "docs(profiles): human approval = Issue comment (IC_) command 단일

human·GitHub 경계 spec (2026-05-06) §6.4 반영. label / form 후보 폐기,
PR review native / inline 은 drift_observer 로 분리.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: github-side-effect-timeline — Tracker 생성 + bootstrap 절 추가

**Files:**
- Modify: `docs/architecture/github-side-effect-timeline.md` — outer Discovery 진입 step 에 Milestone Tracker Issue 생성 + awaiting block 갱신, 신규 §"Repo Bootstrap" 절에 Control / Contract Change Issue 1회 생성 추가

- [ ] **Step 1: 대상 라인 확인**

Run:
```bash
grep -nE '^\| outer Discovery|^## |bootstrap|repo' docs/architecture/github-side-effect-timeline.md
```
Expected: outer Discovery 표 행 + 모든 `##` 섹션 + bootstrap/repo 키워드 라인 출력. 삽입 지점 단서 확보.

- [ ] **Step 2: outer Discovery 행 갱신**

`docs/architecture/github-side-effect-timeline.md` 의 outer Discovery 행 (현재):

```markdown
| outer Discovery | `it_milestone_create()` 또는 `it_milestone_update()` → `it_milestone_set_state()` (`M_DISCOVERY_*` 전이) | milestone description 의 동시 편집(거의 없음) |
```

을 다음으로 교체:

```markdown
| outer Discovery | `it_milestone_create()` 또는 `it_milestone_update()` → `it_issue_create(kind=milestone_tracker)` (1 milestone당 1회, 라벨 `kind/milestone-tracker` + body machine block) → `it_issue_body_update_awaiting()` (AWAITING_HUMAN 진입 시 awaiting block 갱신) → `it_milestone_set_state()` (`M_DISCOVERY_*` 전이) | milestone description 또는 tracker body 의 동시 편집 |
```

- [ ] **Step 3: outer Specification 행 갱신**

현재:

```markdown
| outer Specification | `it_milestone_update()` → `it_milestone_set_state()` (`M_SPECIFICATION_*` → `M_SPEC_APPROVED`) | 위와 동일 |
```

을 다음으로 교체:

```markdown
| outer Specification | `it_milestone_update()` → `it_issue_body_update_awaiting()` (Specification 의 AWAITING_HUMAN 진입 시) → `it_milestone_set_state()` (`M_SPECIFICATION_*` → `M_SPEC_APPROVED`) | 위와 동일 |
```

- [ ] **Step 4: outer Validation 행 갱신**

현재:

```markdown
| outer Validation | `it_milestone_set_state()` (`M_DELIVERY_VALIDATING` → `M_DONE`) → close note 또는 release 발행 | 검증 도중 slice 회귀 |
```

을 다음으로 교체:

```markdown
| outer Validation | `it_milestone_set_state()` (`M_DELIVERY_VALIDATING` → `M_DONE`) → `it_issue_set_state(milestone_tracker, closed)` → close note 또는 release 발행 | 검증 도중 slice 회귀 |
```

- [ ] **Step 5: 신규 §"Repo Bootstrap" 절 추가**

`docs/architecture/github-side-effect-timeline.md` 파일 끝에 다음 절 추가:

```markdown

## Repo Bootstrap (1회 실행)

repo 첫 운영 시점에 다음 외부 surface 를 1회 생성한다 — 이후에는 재사용. 본 절은 [`사람·GitHub 경계 spec`](../superpowers/specs/2026-05-06-human-github-boundary-contract-design.md) §4.2 의 Control / Contract Change surface 도입에 대응한다.

| 단계 | 호출 | 외부 효과 |
|---|---|---|
| Bootstrap 1 | `it_issue_create(kind=control, pinned=true)` | `target.governance.control_issue_number` 가 가리키는 Issue 1개. system signal (`pause`/`resume`/`stop`) 입력 surface. body machine block 의 안내문 포함. |
| Bootstrap 2 | `it_issue_create(kind=contract_change, pinned=true)` | `target.governance.contract_change_issue_number` 가 가리키는 Issue 1개. `{contract, change_proposal}` signal 입력 surface. |

두 Issue 모두 terminal state 가 없으며 (close 안 함), TCC 의 issue_number 키와 1:1 매핑된다. 운영자가 수동으로 close 하면 `drift_observer` 가 `sync_status=conflict` + ledger `external_observation` row 로 처리한다 (자동 reopen 없음).

```

- [ ] **Step 6: 정합 확인**

Run:
```bash
grep -nE 'milestone_tracker|control_issue_number|contract_change_issue_number|awaiting|Repo Bootstrap' docs/architecture/github-side-effect-timeline.md
```
Expected: 5종 키워드 모두 1회 이상 등장.

- [ ] **Step 7: Commit**

```bash
git add docs/architecture/github-side-effect-timeline.md
git commit -m "docs(architecture): outer Discovery → Tracker Issue + bootstrap 절

human·GitHub 경계 spec (2026-05-06) §6.6 반영.
- outer Discovery / Specification / Validation 에 Milestone Tracker Issue
  생성 / awaiting block 갱신 / close 단계 추가
- 신규 Repo Bootstrap 절: Control / Contract Change Issue 1회 생성

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: target-schema.ts — `target.governance` Zod 스키마 (TDD)

**Files:**
- Modify: `tests/config/registry.test.ts` — 새 `describe("target.governance")` 블록 추가
- Modify: `src/config/target-schema.ts` — `Governance` Zod object + `TargetConfig` 에 `governance` optional field 추가

- [ ] **Step 1: 실패 테스트 작성**

`tests/config/registry.test.ts` 의 마지막 `describe` 블록 직후에 다음 추가:

```typescript
describe("target.governance", () => {
  const baseProfiles = {
    atlas: { runner: "claude_code" },
    forge: { runner: "claude_code" },
    sentinel: { runner: "claude_code" },
    scout: { runner: "claude_code" },
  } as const;

  it("accepts a fully populated governance block with defaults", () => {
    const cfg = parseTargetConfig({
      agent_profiles: baseProfiles,
      governance: {
        human_team: "myorg/approvers",
        control_issue_number: 1,
        contract_change_issue_number: 2,
      },
    });
    expect(cfg.governance?.human_team).toBe("myorg/approvers");
    expect(cfg.governance?.control_issue_number).toBe(1);
    expect(cfg.governance?.contract_change_issue_number).toBe(2);
    // defaults
    expect(cfg.governance?.signal_command_prefix).toBe("/");
    expect(cfg.governance?.human_team_cache_ttl_seconds).toBe(300);
    expect(cfg.governance?.unauthorized_author_alert).toBe(false);
  });

  it("permits explicit override of optional fields", () => {
    const cfg = parseTargetConfig({
      agent_profiles: baseProfiles,
      governance: {
        human_team: "myorg/approvers",
        control_issue_number: 10,
        contract_change_issue_number: 11,
        signal_command_prefix: ":",
        human_team_cache_ttl_seconds: 60,
        unauthorized_author_alert: true,
      },
    });
    expect(cfg.governance?.signal_command_prefix).toBe(":");
    expect(cfg.governance?.human_team_cache_ttl_seconds).toBe(60);
    expect(cfg.governance?.unauthorized_author_alert).toBe(true);
  });

  it("default human_team_cache_ttl_seconds matches TCC-GOVERNANCE doc value (300)", () => {
    const cfg = parseTargetConfig({
      agent_profiles: baseProfiles,
      governance: {
        human_team: "myorg/approvers",
        control_issue_number: 1,
        contract_change_issue_number: 2,
        human_team_cache_ttl_seconds: 300,
      },
    });
    expect(cfg.governance?.human_team_cache_ttl_seconds).toBe(300);
  });

  it("rejects governance with missing required field", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: baseProfiles,
        governance: {
          // human_team missing
          control_issue_number: 1,
          contract_change_issue_number: 2,
        },
      }),
    ).toThrow();
  });

  it("rejects unknown governance keys via .strict()", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 1,
          contract_change_issue_number: 2,
          typo_key: "x",
        },
      }),
    ).toThrow();
  });

  it("rejects non-positive issue numbers", () => {
    expect(() =>
      parseTargetConfig({
        agent_profiles: baseProfiles,
        governance: {
          human_team: "myorg/approvers",
          control_issue_number: 0,
          contract_change_issue_number: 2,
        },
      }),
    ).toThrow();
  });

  it("permits omitting the governance block entirely", () => {
    const cfg = parseTargetConfig({ agent_profiles: baseProfiles });
    expect(cfg.governance).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 baseline 확인**

Run:
```bash
cd /Users/macpro/dev/llm-team && npx vitest run tests/config/registry.test.ts -t "target.governance"
```

> **TDD baseline 분석**: 현재 `TargetConfig` 는 `.strict()` 이며 `governance` 필드 자체가 없다. 따라서 **`governance` 객체를 입력에 포함하는 모든 테스트는 parse 단계에서 throw 한다** — `.toThrow()` 를 기대하는 negative 테스트들은 이 throw 를 그대로 받기 때문에 baseline 에서 PASS 하지만, 의도된 이유 (`human_team` missing / `typo_key` / `0` issue number 등) 가 아닌 "governance 필드 자체가 unknown" 으로 throw 하는 것이라 *의도와 다른* PASS 다. 본 task 의 진짜 baseline 은 positive (parse 성공 기대) 테스트의 FAIL 만 보면 된다.

Expected (baseline):
- **3 FAIL** — `accepts a fully populated`, `permits explicit override`, `default human_team_cache_ttl_seconds matches ...`. 모두 governance 객체를 parse 하려고 하나 schema 가 거부하므로 throw → `expect(...).toBe(...)` 단계에 도달 못 함.
- **4 PASS (의도와 다른 이유로)** — `rejects governance with missing required field`, `rejects unknown governance keys`, `rejects non-positive issue numbers` 는 throw 를 기대하는데 schema 가 governance 자체를 reject 해 throw → 우연히 통과. `permits omitting the governance block entirely` 는 의도대로 정상 통과.

이 baseline 은 TDD 의 의도와 일치한다 — Step 3 의 schema 추가 후 6 PASS 모두 *의도된 이유* 로 통과해야 한다.

- [ ] **Step 3: schema 구현**

`src/config/target-schema.ts` 를 다음 전체 내용으로 교체:

```typescript
import { z } from "zod";

export const RunnerIdEnum = z.enum(["claude_code", "codex_cli", "fake"]);
export type RunnerId = z.infer<typeof RunnerIdEnum>;

export const ProfileCfg = z
  .object({
    runner: RunnerIdEnum,
    model: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    extraArgs: z.array(z.string()).optional(),
    killGraceMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ProfileCfg = z.infer<typeof ProfileCfg>;

export const Governance = z
  .object({
    human_team: z.string().min(1),
    control_issue_number: z.number().int().positive(),
    contract_change_issue_number: z.number().int().positive(),
    signal_command_prefix: z.string().min(1).default("/"),
    human_team_cache_ttl_seconds: z.number().int().positive().default(300),
    unauthorized_author_alert: z.boolean().default(false),
  })
  .strict();

export type Governance = z.infer<typeof Governance>;

export const TargetConfig = z
  .object({
    agent_profiles: z
      .object({
        atlas: ProfileCfg,
        forge: ProfileCfg,
        sentinel: ProfileCfg,
        scout: ProfileCfg,
      })
      .strict(),
    governance: Governance.optional(),
  })
  .strict();

export type TargetConfig = z.infer<typeof TargetConfig>;

export function parseTargetConfig(raw: unknown): TargetConfig {
  return TargetConfig.parse(raw);
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run:
```bash
cd /Users/macpro/dev/llm-team && npx vitest run tests/config/registry.test.ts -t "target.governance"
```
Expected: 7개 테스트 모두 PASS — positive 3종이 의도대로 parse 성공, negative 3종이 의도된 reason (필수 필드 누락 / 알 수 없는 키 / non-positive number) 으로 throw, omit 1종이 governance optional 로 정상 처리.

- [ ] **Step 5: 회귀 — 전체 테스트 + typecheck**

Run:
```bash
cd /Users/macpro/dev/llm-team && npm run typecheck && npm test
```
Expected: typecheck 0 error, 모든 vitest 테스트 PASS (기존 + 신규).

- [ ] **Step 6: Commit**

```bash
git add src/config/target-schema.ts tests/config/registry.test.ts
git commit -m "feat(config): add target.governance Zod block (TCC-GOVERNANCE)

human·GitHub 경계 spec (2026-05-06) §6.1 반영. human_team /
control_issue_number / contract_change_issue_number 필수 + 3 optional
default 키. .strict() 로 알 수 없는 키 reject.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: README — CONTRACT-CONFORMANCE 매트릭스 + ARCHITECTURE-MAPPING 갱신

**Files:**
- Modify: `docs/contracts/README.md` — `<a id="CONTRACT-CONFORMANCE">` 의 "Target Configuration" 절에 TCC-GOVERNANCE row 추가, `CONTRACT-ARCHITECTURE-MAPPING` 의 TCC row 에 anchor 추가

본 task 는 README §"`anchor 를 추가·변경하면 #CONTRACT-CONFORMANCE matrix 를 함께 갱신해야 한다`" 규약을 따른다.

- [ ] **Step 1: 갱신 지점 확인**

Run:
```bash
grep -nE 'TCC-LEASE-CONFIG|TCC-PRECEDENCE \||TCC-CHANGE-RULES \||CONTRACT-ARCHITECTURE-MAPPING' docs/contracts/README.md
```
Expected: CONTRACT-CONFORMANCE matrix 의 Target Configuration 행들 (`TCC-LEASE-CONFIG`, `TCC-AGENT-PROFILES`, `TCC-PRECEDENCE`, `TCC-CHANGE-RULES`) + ARCHITECTURE-MAPPING anchor 위치 출력.

- [ ] **Step 2: CONTRACT-CONFORMANCE matrix 에 TCC-GOVERNANCE row 추가**

`docs/contracts/README.md` 의 Target Configuration 절 — 다음 row:

```markdown
| `TCC-CHANGE-RULES` | spec-only | contract prose. ledger helper (Stage 2) | always_hard (변경 ledger 기록) | 2026-05-05-loop (invariant_enforcement 변경 ledger 추가) |
```

직후에 다음 row 1개 추가 (Stage 정렬을 유지하기 위해 `TCC-CHANGE-RULES` 다음, `TCC-PHASE-POLICIES` 앞):

```markdown
| `TCC-GOVERNANCE` ★ | partial | `src/config/target-schema.ts` (Zod parse) — runtime consumer 미구현 (drain / dispatch / observer 후속 plan) | always_hard (governance schema 검증) | 2026-05-06-human-github-boundary |
```

- [ ] **Step 3: CONTRACT-ARCHITECTURE-MAPPING 의 TCC row 에 anchor 추가**

`docs/contracts/README.md` 의 ARCHITECTURE-MAPPING 표 — 다음 row:

```markdown
| [`TCC-LEASE-CONFIG`](target-config-contract.md#TCC-LEASE-CONFIG), [`TCC-ONBOARDING`](target-config-contract.md#TCC-ONBOARDING), [`TCC-AGENT-PROFILES`](target-config-contract.md#TCC-AGENT-PROFILES), [`TCC-LOOP-POLICIES`](target-config-contract.md#TCC-LOOP-POLICIES), [`TCC-SLICE-CLASS-RULES`](target-config-contract.md#TCC-SLICE-CLASS-RULES), [`TCC-DUAL-TRACK`](target-config-contract.md#TCC-DUAL-TRACK), [`TCC-REFACTOR-METRICS`](target-config-contract.md#TCC-REFACTOR-METRICS), [`TCC-ENFORCEMENT`](target-config-contract.md#TCC-ENFORCEMENT) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md), [`daemons.md`](../architecture/daemons.md) |
```

을 다음으로 교체 (anchor 1개 추가 + architecture 파일 2개 추가):

```markdown
| [`TCC-LEASE-CONFIG`](target-config-contract.md#TCC-LEASE-CONFIG), [`TCC-ONBOARDING`](target-config-contract.md#TCC-ONBOARDING), [`TCC-AGENT-PROFILES`](target-config-contract.md#TCC-AGENT-PROFILES), [`TCC-LOOP-POLICIES`](target-config-contract.md#TCC-LOOP-POLICIES), [`TCC-SLICE-CLASS-RULES`](target-config-contract.md#TCC-SLICE-CLASS-RULES), [`TCC-DUAL-TRACK`](target-config-contract.md#TCC-DUAL-TRACK), [`TCC-REFACTOR-METRICS`](target-config-contract.md#TCC-REFACTOR-METRICS), [`TCC-ENFORCEMENT`](target-config-contract.md#TCC-ENFORCEMENT), [`TCC-GOVERNANCE`](target-config-contract.md#TCC-GOVERNANCE) | [`lease-and-recovery.md`](../architecture/lease-and-recovery.md), [`agent-runner-adapters.md`](../architecture/agent-runner-adapters.md), [`daemons.md`](../architecture/daemons.md), [`external-tracking-mapping.md`](../architecture/external-tracking-mapping.md), [`github-side-effect-timeline.md`](../architecture/github-side-effect-timeline.md) |
```

- [ ] **Step 4: 정합 확인**

Run:
```bash
grep -cE '`TCC-GOVERNANCE`' docs/contracts/README.md
```
Expected: `2` (CONTRACT-CONFORMANCE row + ARCHITECTURE-MAPPING row 양쪽 한 번씩, 단 한 번만 검색 — 실제 grep 패턴은 backtick 포함이라 안전한 카운트는 `grep -c`).

```bash
grep -nE 'TCC-GOVERNANCE.*partial.*src/config/target-schema|external-tracking-mapping\.md.*github-side-effect-timeline\.md' docs/contracts/README.md
```
Expected: 두 패턴 모두 1회 이상 매칭.

- [ ] **Step 5: Commit**

```bash
git add docs/contracts/README.md
git commit -m "docs(contracts/README): conformance + architecture-mapping for TCC-GOVERNANCE

human·GitHub 경계 spec (2026-05-06) §6.1 의 anchor 추가에 따른 README
규약 보강.
- CONTRACT-CONFORMANCE matrix 의 Target Configuration 절에 TCC-GOVERNANCE
  row (status=partial, surface=Zod schema)
- CONTRACT-ARCHITECTURE-MAPPING 의 TCC row 에 anchor + 영향 architecture
  파일 (external-tracking-mapping, github-side-effect-timeline) 추가

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 최종 정합 확인

**Files:** (변경 없음 — 검증만)

- [ ] **Step 1: 모든 spec §6 항목 → 변경 파일 매핑 확인**

Run:
```bash
git log --oneline -10
```
Expected: 본 plan 이 만든 8 개 commit (Task 1-8) 가 모두 보임.

- [ ] **Step 2: spec 의 §6 키워드가 contract / architecture 에 모두 등장하는지 확인**

Run:
```bash
for kw in 'TCC-GOVERNANCE' 'external_observation' 'prior_review_context' \
          'milestone_tracker' 'IC_' 'Repo Bootstrap'; do
  echo "=== $kw ==="
  grep -rn "$kw" docs/contracts docs/architecture | head -3
done
```
Expected: 6 키워드 모두 1회 이상 출현.

- [ ] **Step 3: 폐기된 표기가 모두 사라졌는지 확인**

Run:
```bash
grep -rn -E 'Issue close → request_recover|GitHub label, comment, 또는 별도 form|application/human_signal\.sh' docs/contracts docs/architecture
```
Expected: 출력 없음 (모두 0 매칭). 폐기 문구 잔존 시 본 plan 의 Task 4·5 가 미완.

- [ ] **Step 4: 빌드 + 테스트 최종 확인**

Run:
```bash
cd /Users/macpro/dev/llm-team && npm run typecheck && npm test
```
Expected: 통과.

- [ ] **Step 5: Plan 1 종료 보고**

Plan 의 모든 task 가 commit 으로 이어졌고 회귀 없음 확인. 후속 plan (component 구현, FU-1~FU-9 — `.human/draft/2026-05-06-human-github-boundary-followups.md`) 의 prerequisite 인 contract 정합이 닫힘.
