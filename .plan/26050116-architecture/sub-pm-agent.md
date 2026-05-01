# sub-pm-agent — PM Agent (prompt + 진입점)

- **preparation**: sub-common-lib (실제 실행 검증은 sub-common-skeleton의 `targets/myapp.yaml` 필요)
- **대상 파일**:
  - `prompts/pm.md`
  - `scheduler/run-pm.sh`

## 목표

PM Agent를 구현한다. PM Agent는 `needs-scenarios` 라벨이 붙은 Milestone을 user scenario 단위 Issue N개로 분해한다. **멱등성**: 이미 같은 Milestone에 연결된 Issue가 있으면 누락분만 생성한다.

## 컨텍스트

- 에이전트 계약: `planning.md` §8.3
- 트리거 조건: `memory/state-machine.md` §4 (PM 행)
- 라벨 전이: `needs-scenarios` → `pm:in-progress`, 최종 → `pm:done`
- 입력 본문 구조 (PO 산출): `memory/agent-message-contract.md` §1
- 출력 본문 구조 (Issue 생성): `memory/agent-message-contract.md` §2
- Notifier 호출 시점: 각 Issue마다 1회 (kind=`scenario`)
- 멱등성: `planning.md` §8.3 — stale 복구 후 재실행 시 중복 방지

## 수행 단계

### A. `prompts/pm.md` 작성

1. **역할 선언** — "당신은 PM Agent다. Milestone 본문을 user scenario 단위 Issue들로 분해한다."
2. **입력 형식** — Milestone 본문 + Milestone에 달린 사람 코멘트(있다면) + **이미 생성된 Issue들의 제목 목록**(멱등성용)이 호출자에 의해 placeholder로 주입됨.
3. **분해 규칙**:
   - `## 큰 그림 분해` 섹션의 항목 1개 = Issue 1개 원칙.
   - 이미 생성된 Issue가 있으면, **제목 매칭으로 누락된 항목만** 출력.
   - 매칭은 LLM의 의미 기반 판단 (제목 정확 일치가 아니어도 같은 항목이면 skip).
4. **출력 contract** — JSON-like 구조로 N개 Issue를 출력. 각 Issue는 `title` + `body` 두 필드. body는 `memory/agent-message-contract.md` §2 구조.
5. **출력 형식 강제 예시**:
   ```
   --- ISSUE 1 ---
   TITLE: <title>
   BODY:
   ## User Scenario
   ...
   ## 수용 기준
   - [ ] ...
   ## 영향 범위
   ...
   --- END ---
   --- ISSUE 2 ---
   ...
   --- END ---
   ```
   호출자(`run-pm.sh`)가 이 구분자를 파싱한다.
6. **금지 사항** — `gh issue create` 직접 호출 금지. 라벨 부착 금지. 모두 호출자가 수행.

### B. `scheduler/run-pm.sh` 작성

```
용법: scheduler/run-pm.sh <target>
```

1. `set -euo pipefail`, `source lib/common.sh`.
2. `load_target <target>`, `log_init pm <target>`, `run_stale_recovery <target>`.
3. **트리거 조건 검사**:
   - `milestone_list_by_label <repo> needs-scenarios` 결과 중 가장 오래된 1개 선택. 없으면 exit 0.
   - 같은 타겟에 `pm:in-progress` Milestone 있으면 exit 0.
4. **라벨 atomic 전이**: `needs-scenarios` → `pm:in-progress`.
5. **멱등성 준비**:
   - `gh issue list --milestone <num> --json number,title,labels` → 기존 Issue 목록 획득.
   - 기존 Issue 제목 목록을 prompt placeholder로 주입.
6. **1-shot Claude Code 호출** (prompt 본문 = `prompts/pm.md` + Milestone 본문 + 코멘트 + 기존 Issue 제목 목록).
7. **출력 파싱**: `--- ISSUE N ---` 블록을 추출. 각 블록에서 `TITLE:`과 `BODY:` 영역 분리.
8. **Issue 생성 루프** (각 블록마다):
   - `gh issue create --milestone <num> --title <t> --body <b> --label needs-human-review:scenario` (Issue 본문에 `## 출처 Milestone` 자동 append).
   - 생성된 Issue 번호 보관.
9. **Milestone 라벨 전이**: `pm:in-progress` → `pm:done`.
10. **Notifier 호출 루프** (생성된 각 Issue마다):
    - `notify_review_needed <target> scenario <issue_url> "<제목 + scenario 첫 200자>"`.
    - `lib/notifier.sh`가 marker 멱등성을 자동 처리하므로 호출자는 단순 호출.

### C. 멱등성 시나리오

- **Stale 복구 후 재실행**: `pm:in-progress`가 stale → `needs-scenarios`로 복귀. 다음 PM cron이 픽업 → 5번 단계에서 기존 Issue 목록 확인 → 누락분만 생성.
- **이미 모든 Issue가 생성된 경우**: LLM이 빈 출력 반환 또는 0개 ISSUE 블록. 정상 처리, 라벨만 `pm:done`으로 전이.

### D. 에러 처리

- `gh issue create` 1개 실패 → 나머지 시도. 마지막에 부분 실패 코멘트를 Milestone에 작성, 라벨은 `pm:in-progress` 유지 (stale 복구 후 재시도가 누락분 생성).
- 모든 Issue 생성 성공 후 `pm:done` 전이 실패 → 다음 cron이 `needs-scenarios`로 보지 않으므로 (아직 `pm:in-progress`) stale 복구가 처리.
- Claude Code 출력 형식 위반 (블록 파싱 실패) → Milestone 코멘트로 원본 출력 + 에러 기록 + `pm:in-progress` 유지.

## 완료 체크리스트

- [ ] `prompts/pm.md`가 `memory/agent-message-contract.md` §2 구조를 명시적으로 강제
- [ ] `prompts/pm.md`가 멱등성 규칙(기존 Issue 제목 매칭)을 LLM에 지시
- [ ] `scheduler/run-pm.sh`가 `bash -n` 통과
- [ ] 트리거 조건 2개 검사
- [ ] 출력 파싱이 `--- ISSUE N ---` 구분자 기반으로 robust
- [ ] Issue 생성 시 `needs-human-review:scenario` 라벨 자동 부착
- [ ] N개 Issue마다 Notifier 1회씩 호출 (`kind=scenario`)
- [ ] 부분 실패 시 stale 복구가 누락분을 회수 가능
- [ ] 이미 모든 Issue가 있을 때(0개 신규) 라벨만 `pm:done` 전이
