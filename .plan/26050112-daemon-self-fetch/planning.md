# Daemon + Self-Fetch DEV/QA

- **작성일**: 2026-05-01
- **선행**: `.plan/26050116-architecture/` (architecture spec + 1차 구현 완료)
- **목적**: 1차 구현의 두 가지 한계를 해소
  1. DEV/QA가 prompt argv로 issue body / PR body / 200KB diff를 전달 → `ARG_MAX` 위험 (Phase A 분석 §A1)
  2. cron 기반 트리거의 운영 한계 (PATH/`.env` 인증 누락, sleep wake 누락, 외부 lock 부재)

---

## 1. 핵심 변경

### 1.1 DEV/QA "self-fetch" prompt 전환

**현재**: scheduler가 issue body, PR body, 코멘트, diff를 모두 fetch해서 prompt argv에 인젝션 → claude 호출 → 출력 파싱.

**변경 후**: scheduler는 작은 식별자(target, repo, issue#, mode, branch, worktree_path, attempts)만 prompt에 인젝션. **LLM이 직접 `gh issue view`, `gh pr view`, `git diff` 등을 cwd=worktree에서 호출**해 컨텍스트를 자체 수집.

이로써:
- argv는 항상 ~1KB 미만 → ARG_MAX 무관
- LLM이 필요한 만큼만 fetch하여 토큰도 절감 가능
- prompt가 "환경 구성 가이드" 형태로 더 자연스러워짐

mutation(라벨 atomic 전이, PR merge, Notifier)은 여전히 scheduler가 수행 — contract 일관성 유지.

### 1.2 단일 데몬 운영 모델

**현재**: cron 4개 라인 (PO 10분, PM 5분, DEV/QA 2분).

**변경 후**: `scheduler/daemon.sh <agent> [interval]` 단일 진입점이 long-running 루프로 polling. agent별 1개 데몬 = 시스템 전체에 4개 데몬 프로세스. launchd `KeepAlive=true` 또는 systemd `Restart=always`로 관리.

동시성 제어:
- **데몬 단위 단일 인스턴스**: `flock -n` on `workdir/daemon-<agent>.lock`
- **agent 간 동시성**: GitHub 라벨 atomic 전이 (기존 contract 그대로)
- **외부 lock 추가하지 않음** — 사용자 요구사항

장점:
- macOS sleep 후 wake 시 즉시 다음 tick 실행 (cron은 wake 사이 누락)
- env/PATH는 데몬 시작 시 1회만 보장하면 됨 (.env source는 launchd plist 또는 데몬 wrapper에서)
- 4개 데몬이 별개 프로세스라 한 agent의 stuck이 다른 agent를 막지 않음

### 1.3 lib/claude.sh — claude 호출 통일

4개 scheduler가 각자 다른 방식으로 claude를 호출하던 것을 `claude_invoke <prompt>` 한 함수로 통일. 항상 stdin 전달, env override 지원, output을 stdout으로.

---

## 2. 변경 파일

| 파일 | 변경 내용 |
|---|---|
| `lib/claude.sh` (신규) | `claude_invoke` 단일 helper |
| `lib/common.sh` | `lib/claude.sh` source 추가 |
| `prompts/dev.md` | self-fetch 가이드로 재작성 |
| `prompts/qa.md` | self-fetch 가이드로 재작성 |
| `scheduler/run-dev.sh` | argv 인젝션 제거 → 작은 식별자만 전달, claude_invoke 사용 |
| `scheduler/run-qa.sh` | 동일 패턴 |
| `scheduler/run-po.sh` | claude_invoke 사용으로 정리 |
| `scheduler/run-pm.sh` | claude_invoke 사용으로 정리 |
| `scheduler/daemon.sh` (신규) | 단일 인스턴스 long-running 데몬 (4 agent 공통) |
| `README.md` | cron 가이드 → daemon 가이드 (launchd plist 예시 + .env source 명시 + PATH 명시) |
| `docs/superpowers/specs/launchd/com.llm-team.<agent>.plist` (신규, 4개) | macOS launchd 예시 plist |

---

## 3. Contract 변경

### 3.1 DEV/QA prompt 입력 contract

scheduler가 prompt 끝에 인젝션할 섹션 (모두 짧음):

**DEV**:
```
## 작업 컨텍스트

- TARGET: <name>
- REPO: <owner/repo>
- ISSUE_NUMBER: <num>
- MODE: new | rework
- BRANCH: <branch_name>            # new면 scheduler가 생성한 신규 브랜치명, rework면 기존 head ref
- BASE_BRANCH: <main 등>
- WORKTREE_PATH: <절대경로>
- ATTEMPTS: <PR이 이미 있는 경우 현재 marker N, 없으면 0>
```

LLM이 직접:
1. `cd $WORKTREE_PATH`
2. `gh issue view $ISSUE_NUMBER --repo $REPO --json title,body,comments` 호출
3. (rework면) `gh pr list --repo $REPO --search "in:body \"Closes #$ISSUE_NUMBER\""` → PR 번호/본문 fetch
4. 코드 작성 + `git add` + `git commit`
5. `git push` (new: `--set-upstream`, rework: `--force-with-lease`)
6. (new) `gh pr create --base $BASE_BRANCH --head $BRANCH --title ... --body ...` (PR 본문에 `Closes #N` + `<!-- llm-team:qa-attempts:1 -->`)
7. (rework) `gh pr edit <PR#> --body ...` (`<!-- llm-team:qa-attempts:2 -->` marker 갱신)

LLM 출력 contract:
```
<<<RESULT>>>
SUCCESS | EMPTY_CHANGE | GIT_FAILURE
<<<END_RESULT>>>

<<<DETAIL>>>
<한두 문장 요약 — scheduler가 issue/PR comment에 사용 가능>
<<<END_DETAIL>>>
```

scheduler 분기:
- `SUCCESS` → 라벨 `dev:in-progress` → `needs-qa`
- `EMPTY_CHANGE` 또는 `GIT_FAILURE` → §6 형식 코멘트 + 라벨 → `needs-human-review:dev-failure` + Notifier

**QA**:
```
## 작업 컨텍스트

- TARGET: <name>
- REPO: <owner/repo>
- ISSUE_NUMBER: <num>
- PR_NUMBER: <num>
- ATTEMPTS: 1 | 2
- WORKTREE_PATH: <절대경로>
- BASE_BRANCH: <main 등>
```

LLM이 직접: `gh issue view`, `gh pr view`, `git diff $BASE_BRANCH...HEAD`, 검증 명령 실행, 판정.

LLM 출력 contract: 기존과 동일 (`RESULT: PASS | FAIL` + 본문).

### 3.2 Cron 모델 → Daemon 모델

- `memory/state-machine.md` §4 트리거 조건은 그대로 (라벨 기반, daemon이 매 tick에 검사)
- §5 Stale 복구도 그대로 (daemon이 매 tick 시작에 inline 실행)
- 새로운 contract: **시스템 전체에서 agent별 단일 데몬 인스턴스**가 보장. flock으로 강제. 같은 agent의 동시 실행은 일어나지 않음

---

## 4. 위험 / 고려사항

- LLM이 `gh` CLI를 호출해야 하므로 worktree 환경에 gh 인증 필요 — 데몬 프로세스의 env가 worktree subshell로 상속되므로 OK
- LLM이 mutation 권한(`gh pr create`, `gh pr edit`)을 가짐 → 잘못 호출 시 부작용. prompt에 "라벨 변경/머지 금지"는 명시하되 "PR 생성/edit/push는 허용" 명시
- 단일 데몬은 단일 장애점 — 데몬 죽으면 그 agent가 정지. launchd `KeepAlive`/systemd `Restart=always`로 자동 재시작. README에 명시
- `lib/claude.sh#claude_invoke`로 호출 통일 시 PO/PM의 기존 동작이 변경됨 — Phase A 27/27 PASS 회귀 확인 필요

---

## 5. 검증

1. `bash -n` 모든 신규/수정 파일
2. `tests/e2e/mvp-flow.sh --phase=a` 27/27 PASS 재현 (회귀 확인)
3. `scheduler/daemon.sh po --once` 추가 옵션으로 단일 tick 검증 (또는 SIGTERM으로 종료 검증)
4. `flock` 동시 실행 차단 검증

---

## 6. 본 plan의 분해

본 변경은 sub-task로 나누지 않고 단일 세션에서 직접 구현한다 — 변경이 인터록되어 있고 (lib/claude.sh → 4 scheduler → daemon → README) 한 사람이 일관되게 처리하는 게 효율적.

태스크 트래킹은 TodoWrite 대신 본 planning.md의 §2 변경 파일 표를 직접 참조한다.
