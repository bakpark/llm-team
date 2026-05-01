# sub-qa-agent — QA Agent (prompt + 진입점, 병렬 + Milestone close)

- **preparation**: sub-common-lib (실제 실행 검증은 sub-common-skeleton의 `targets/myapp.yaml` 필요)
- **대상 파일**:
  - `prompts/qa.md`
  - `scheduler/run-qa.sh`

## 목표

QA Agent를 구현한다. QA Agent는 `needs-qa` 라벨이 붙은 Issue/PR을 검증하고, 통과 시 PR merge + Issue close + (필요 시 Milestone close)를 수행한다. 1차 실패는 DEV에 회수, 2차 실패는 사람 escalation.

## 컨텍스트

- 에이전트 계약: `planning.md` §8.5
- 트리거 조건: `memory/state-machine.md` §4 (QA 행)
- 라벨 전이: `needs-qa` → `qa:in-progress` → (성공: 라벨 전부 제거 + Issue close) / (1차 실패: `qa:changes-requested`) / (2차 실패: `needs-human-review:dev-failure`)
- 입력 본문 구조: `memory/agent-message-contract.md` §2 (Issue 수용 기준) + §3 (PR 본문)
- 출력 본문 구조: `memory/agent-message-contract.md` §4 (1차 실패 코멘트), §5 (2차 실패 코멘트)
- qa-attempts marker: `memory/state-machine.md` §6.2
- **Milestone close 책임**: `memory/state-machine.md` §8 — 마지막 Issue close 시 Milestone progress 확인 후 close
- 병렬 슬롯 관리: `lib/concurrency.sh`의 `count_in_progress` (sub-common-lib 산출). DEV와 동일하게 호출자가 `&` + `wait` 패턴

## 수행 단계

### A. `prompts/qa.md` 작성

1. **역할 선언** — "당신은 QA Agent다. PR을 검증하여 수용 기준 충족 여부를 판정한다."
2. **입력 형식** — Issue 본문(특히 `## 수용 기준`) + PR 본문(`## 변경 요약`, `## 검증 방법`) + 현재 worktree 경로 + 시도 횟수(N=1 또는 2) + diff가 placeholder로 주입.
3. **검증 절차**:
   - PR 본문의 `## 검증 방법`에 명령어가 있으면 실행. 없으면 프로젝트 표준(예: `pnpm test`, `pytest`, `npm test`)을 시도.
   - Issue의 `## 수용 기준` 각 항목을 확인 (코드/테스트 결과/실행 결과 종합 판단).
4. **출력 contract** — LLM은 검증을 수행하고 마지막에 다음 텍스트를 출력:
   - 첫 줄: `RESULT: PASS` 또는 `RESULT: FAIL`
   - PASS 시: `## 검증 요약` markdown (어떤 명령어를 실행했고 어떤 출력을 봤는지)
   - FAIL 시: `## 실패한 수용 기준` 체크리스트 (Issue의 수용 기준 항목 그대로 인용) + `## 실패 로그/증거` + `## 재작업 가이드` (1차 실패) 또는 `## 권장 조치` (2차 실패)
5. **금지 사항** — `gh pr merge`, `gh issue close`, 라벨 변경 직접 호출 금지. 호출자가 수행.

### B. `scheduler/run-qa.sh` 작성

```
용법: scheduler/run-qa.sh <target>
```

1. `set -euo pipefail`, `source lib/common.sh`.
2. `load_target <target>`, `log_init qa <target>`, `run_stale_recovery <target>`.
3. **후보 Issue 수집**: `issue_list_by_label <repo> needs-qa`.
4. **병렬 처리** (DEV와 같은 패턴):
   - 가용 슬롯 = 적절한 상한 (MVP에서는 별도 yaml 필드 없음. `dev_concurrency`와 동일 값 사용 또는 hardcoded 3).
   - 각 후보를 `process_one_issue <target> <issue_num> &`로 spawn.
   - 마지막에 `wait`.

### C. `process_one_issue <target> <issue_num>` 함수 (run-qa.sh 내부)

1. **라벨 atomic 전이**: `needs-qa` → `qa:in-progress`.
2. **데이터 fetch**:
   - Issue 본문, 연결된 PR 번호 (`gh pr list --search "linked:issue=<num>"` 또는 PR 본문의 `Closes #N` 역방향 조회).
   - PR 본문, qa-attempts marker (`pr_body_get_attempts <repo> <pr_num>`) → N (1 또는 2).
   - PR head 브랜치명, base 브랜치명, diff.
3. **임시 worktree 준비**: `worktree_create <target> <branch>` (DEV가 만든 브랜치를 fetch + checkout).
4. **Claude Code 호출**:
   - prompt = `prompts/qa.md` + Issue 본문 + PR 본문 + 시도 횟수 N + worktree 경로 + diff.
   - cwd = worktree.
   - 호출: `(cd $worktree && claude -p "$prompt" --output-format text > $output_file)`.
5. **출력 파싱**: 첫 줄에서 `RESULT: PASS` 또는 `RESULT: FAIL` 추출. 나머지를 코멘트 본문으로 사용.
6. **결과 분기**:

   **PASS**:
   - `gh pr merge <pr_num> --squash --delete-branch` (또는 yaml에 머지 전략 옵션 추가 — MVP는 squash 고정).
   - `gh issue close <issue_num>` (PR merge가 자동 close 시켜줄 수도 있으나 명시적 호출).
   - 라벨 전부 제거 (`gh issue edit --remove-label`).
   - **Milestone close 검사**:
     - Issue가 속한 Milestone 번호 획득.
     - `milestone_get_progress <repo> <milestone_num>` → open Issue 수 0이면 → `milestone_close <repo> <milestone_num>`.

   **FAIL + N=1 (1차 실패)**:
   - LLM 출력 본문을 `memory/agent-message-contract.md` §4 형식으로 PR에 코멘트 (`gh pr comment`).
   - 라벨 atomic 전이: `qa:in-progress` → `qa:changes-requested`.
   - DEV가 다음 cron에서 픽업.

   **FAIL + N=2 (2차 실패)**:
   - LLM 출력 본문을 `memory/agent-message-contract.md` §5 형식으로 PR에 코멘트.
   - 라벨 atomic 전이: `qa:in-progress` → `needs-human-review:dev-failure`.
   - `notify_review_needed <target> dev-failure <issue_url> "<요약>"`.

7. **worktree 정리**: 모든 분기에서 `worktree_remove <target> <branch>`.

### D. 에러 처리

- worktree 체크아웃 실패 → Issue 코멘트("QA worktree 실패: <error>") + 라벨 `qa:in-progress` 유지 (stale 복구가 `needs-qa`로 회수).
- Claude Code 호출 실패 → 동일.
- merge 충돌 (PASS 판정 후 머지 거부) → PR 코멘트("merge conflict") + 라벨 → `needs-human-review:dev-failure` + Notifier (DEV git 실패와 같은 처리).
- LLM 출력에 `RESULT:` 라인 없음 → 잘못된 출력으로 간주, FAIL N=1 처리 (단, 코멘트에 "QA Agent output malformed" 명시).

### E. 병렬 안전성

- 각 인스턴스가 자체 worktree 사용. 충돌 없음.
- Milestone close 호출이 동시에 발생할 수 있으나, GitHub API는 close가 멱등(이미 closed면 정상 응답). 안전.

## 완료 체크리스트

- [ ] `prompts/qa.md`가 `RESULT: PASS|FAIL` 첫 줄 출력 형식 강제
- [ ] `scheduler/run-qa.sh`가 `bash -n` 통과
- [ ] qa-attempts marker로 N 분기 (1차 실패 vs 2차 실패)
- [ ] PASS 시 PR merge + Issue close + 라벨 제거 + **Milestone progress 확인 후 close** 모두 수행
- [ ] 1차 실패 코멘트가 §4 형식, 2차 실패 코멘트가 §5 형식
- [ ] 2차 실패 시 Notifier(`kind=dev-failure`) 호출
- [ ] 모든 분기에서 worktree 정리
- [ ] 병렬 인스턴스가 같은 Issue를 중복 픽업하지 않음 (라벨 atomic 전이로 차단)
- [ ] merge 충돌 시 dev-failure로 escalate
