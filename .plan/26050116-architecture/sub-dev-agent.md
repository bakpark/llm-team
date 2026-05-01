# sub-dev-agent — DEV Agent (prompt + 진입점, 병렬 + worktree)

- **preparation**: sub-common-lib (실제 실행 검증은 sub-common-skeleton의 `targets/myapp.yaml` 필요)
- **대상 파일**:
  - `prompts/dev.md`
  - `scheduler/run-dev.sh`

## 목표

DEV Agent를 구현한다. DEV Agent는 `needs-dev` 또는 `qa:changes-requested` 라벨이 붙은 Issue를 picking up, git worktree에서 코드를 작성하고 PR을 생성/푸시한다. **`dev_concurrency`까지 병렬** 실행.

## 컨텍스트

- 에이전트 계약: `planning.md` §8.4
- 트리거 조건: `memory/state-machine.md` §4 (DEV 행)
- 라벨 전이: 신규 `needs-dev` → `dev:in-progress` → `needs-qa`, 재작업 `qa:changes-requested` → `dev:in-progress` → `needs-qa`
- 입력 본문 구조: `memory/agent-message-contract.md` §2 (Issue) + 1차 실패 시 `memory/agent-message-contract.md` §4 (PR 코멘트)
- 출력 본문 구조: `memory/agent-message-contract.md` §3 (PR 본문) + qa-attempts marker
- git 실패 escalation: `planning.md` §7.4
- worktree 헬퍼: `lib/worktree.sh` (sub-common-lib 산출)
- 병렬 슬롯 관리: `lib/concurrency.sh`의 `count_in_progress` (sub-common-lib 산출). MVP는 호출자가 `&` + `wait`로 spawn

## 수행 단계

### A. `prompts/dev.md` 작성

1. **역할 선언** — "당신은 DEV Agent다. Issue의 user scenario를 구현하는 코드를 작성한다."
2. **입력 형식** — Issue 본문 + 같은 Issue/PR의 코멘트들(특히 1차 QA 실패 코멘트가 있으면) + 현재 worktree 경로 + 베이스 브랜치 이름이 placeholder로 주입.
3. **작업 환경** — Claude Code는 이미 worktree 디렉토리에 cwd. 자유롭게 파일 수정/생성/삭제 + `git`, `pnpm`/`npm`/`pytest` 등 호출 가능.
4. **수용 기준** — Issue의 `## 수용 기준` 체크리스트를 구현하는 것이 목표.
5. **재작업 모드 인식** — PR 코멘트에 "QA 검증 실패" 섹션이 있으면 그것을 수정 가이드로 해석.
6. **출력 contract** — LLM은 코드 변경만 수행하고, 마지막에 다음 항목을 텍스트로 출력:
   - PR title (한 줄)
   - PR body의 `## 변경 요약`에 들어갈 markdown
   - PR body의 `## 검증 방법`에 들어갈 markdown (실행한 테스트 명령어)
7. **금지 사항** — `gh pr create`, `git push` 직접 호출 금지. 호출자가 수행. `git commit`은 LLM이 수행 가능 (변경 커밋).

### B. `scheduler/run-dev.sh` 작성

```
용법: scheduler/run-dev.sh <target>
```

1. `set -euo pipefail`, `source lib/common.sh`.
2. `load_target <target>`, `log_init dev <target>`, `run_stale_recovery <target>`.
3. **후보 Issue 수집**:
   - `issue_list_by_label <repo> needs-dev` + `issue_list_by_label <repo> qa:changes-requested` → 합집합. 가장 오래된 것부터.
   - `count_in_progress <repo> dev:in-progress` 호출 → 현재 진행 수.
   - 가용 슬롯 = `TARGET_DEV_CONCURRENCY` - 현재 진행 수. 0 이하면 exit 0.
4. **슬롯 수만큼 백그라운드 처리**:
   - 후보 Issue 중 가용 슬롯 수만큼 선택, 각각을 `process_one_issue <target> <issue_num> &`로 백그라운드 spawn.
   - 마지막에 `wait`.

### C. `process_one_issue <target> <issue_num>` 함수 (run-dev.sh 내부)

1. **라벨 atomic 전이**: 현재 라벨(`needs-dev` 또는 `qa:changes-requested`) → `dev:in-progress`.
   - 재작업 모드 판정: 현재 라벨이 `qa:changes-requested`이면 재작업, 아니면 신규.
2. **Issue 본문/코멘트 fetch**: `gh issue view <num> --json body,comments,title`.
3. **PR 결정**:
   - 신규 모드: 새 브랜치명 생성 (`llm-team/issue-<num>-<slug>`).
   - 재작업 모드: 기존 PR 조회 → 그 PR의 head 브랜치명 사용.
4. **worktree 준비**: `worktree_create <target> <branch>`. 실패 시 git 실패 처리(아래 G).
5. **Claude Code 호출**:
   - prompt = `prompts/dev.md` + Issue 본문 + 코멘트(1차 QA 실패 포함) + worktree 경로 + 베이스 브랜치.
   - cwd = worktree 디렉토리.
   - 호출: `(cd $worktree && claude -p "$prompt" --output-format text > $output_file)`.
6. **출력 파싱**: PR title / 변경 요약 / 검증 방법 추출.
7. **git 검사**:
   - `git status --porcelain`이 비어 있으면 LLM이 변경 안 함 → 실패 처리 (Issue 코멘트 + git 실패 escalation).
   - LLM이 commit을 수행했는지 확인. 안 했으면 `git add -A && git commit -m "..."`로 자동 커밋.
   - `git push -u origin <branch>` (재작업 시 force-with-lease 옵션 — 같은 브랜치라 단순 push만 시도, 거부되면 git 실패 처리).
8. **PR 생성 또는 갱신**:
   - 신규: `gh pr create --base $TARGET_DEFAULT_BRANCH --head <branch> --title "<t>" --body "<built body>"`. body에는 `Closes #<num>`, 변경 요약, 검증 방법, `<!-- llm-team:qa-attempts:1 -->` marker 포함.
   - 재작업: 기존 PR body의 marker를 `:2`로 갱신 (`pr_body_set_attempts`). 변경 요약 끝에 "### 재작업 (1차 QA 피드백 반영)" 섹션 append.
9. **라벨 atomic 전이**: `dev:in-progress` → `needs-qa`.
10. **worktree 정리**: `worktree_remove <target> <branch>`.

### G. git 실패 처리 (G = git failure)

위 단계 중 worktree 생성/머지 충돌/push 거부/빈 변경 발생 시:

1. Issue 코멘트 작성 (`memory/agent-message-contract.md` §6 형식).
2. 라벨 atomic 전이: `dev:in-progress` → `needs-human-review:dev-failure`.
3. `notify_review_needed <target> dev-failure <issue_url> "<요약>"` 호출.
4. worktree 정리.

### D. 병렬 안전성

- `process_one_issue`는 자체 worktree(`workdir/<target>/worktrees/<branch>/`)에서 작업하므로 다른 인스턴스와 파일 충돌 없음.
- 라벨 atomic 전이가 픽업 시점의 lock 역할 (race window는 §4.4의 알려진 한계).
- `count_in_progress`는 picking up 전 시점이므로, 동시 spawn된 다른 인스턴스가 같은 카운트를 보고 같은 Issue를 픽업할 미세 가능성. 라벨 add → remove 순서가 중복 픽업을 어느 정도 방지 (이미 `dev:in-progress`가 붙은 Issue는 후속 인스턴스의 후보 목록에 안 잡힘).

## 완료 체크리스트

- [ ] `prompts/dev.md`가 재작업 모드(QA 실패 코멘트 인식)를 명시
- [ ] `scheduler/run-dev.sh`가 `bash -n` 통과
- [ ] `dev_concurrency` 상한 준수 (가용 슬롯 = 상한 - 진행 중)
- [ ] 신규/재작업 모드 분기가 라벨 기반으로 정확
- [ ] PR 본문에 `Closes #N` + qa-attempts marker 포함
- [ ] 재작업 시 같은 브랜치 + marker `:2`로 갱신
- [ ] worktree가 신규/재작업/실패 모든 경로에서 정리됨
- [ ] git 실패 시 §6 형식 코멘트 + Notifier(`kind=dev-failure`)
- [ ] 백그라운드 spawn 후 `wait`로 모든 자식 종료 대기
- [ ] 빈 변경(LLM 노옵) 케이스가 git 실패로 분류됨
