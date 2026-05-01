# sub-e2e-verification — MVP 통과 시나리오 검증

- **preparation**: sub-common-lib, sub-common-skeleton, sub-po-agent, sub-pm-agent, sub-dev-agent, sub-qa-agent
- **대상 파일**:
  - `tests/e2e/mvp-flow.sh` (생성)
  - `tests/e2e/fixtures/` (검증용 fixture)
  - `docs/superpowers/specs/e2e-verification-report.md` (검증 결과 보고서)
  - 통합 이슈 발견 시: 모든 sub-task 산출물(lib, prompts, scheduler) 수정 가능

## 목표

`planning.md` §10 MVP 통과 시나리오를 end-to-end로 1회 실행하여 architecture spec이 실제로 동작함을 입증한다. 또한 라벨 상태 머신 불변식, marker 멱등성, Milestone close 책임 등 critical 동작을 검증한다.

## 컨텍스트

- MVP 통과 시나리오: `planning.md` §10
- 라벨 상태 머신: `memory/state-machine.md`
- 본문 contract: `memory/agent-message-contract.md`
- Phase 2 산출물: `prompts/{po,pm,dev,qa}.md`, `scheduler/run-{po,pm,dev,qa}.sh`
- Phase 1 산출물: `lib/*.sh`, `scripts/bootstrap-labels.sh` (sub-common-lib) + `targets/myapp.yaml`, `inputs/myapp/auth.md`, `README.md`, `.env.example` (sub-common-skeleton)

## 수행 단계

### A. 환경 준비

1. **테스트 GitHub repo 준비**:
   - 옵션 1 (권장): `bakparkbj/llm-team-e2e-test` 신규 repo 생성 (private, empty default branch).
   - 옵션 2: 기존 dummy repo 사용. `targets/myapp.yaml`의 `github.owner/repo`를 테스트 repo로 일시 변경.
2. **`scripts/bootstrap-labels.sh myapp` 실행**: 테스트 repo에 12개 라벨 생성. 결과를 `gh label list`로 verify.
3. **secret 설정**: `.env`에 `GH_TOKEN` 및 (선택) Discord/Slack webhook 설정. Notifier 채널을 `none`으로 두면 webhook 없이도 검증 가능.
4. **`inputs/myapp/auth.md`** 존재 확인 (sub-common이 만든 sample input).

### B. MVP 시나리오 실행 (수동 step-by-step)

**Step 1 — PO**:
- `scheduler/run-po.sh myapp` 실행.
- 검증:
  - 새 Milestone이 생성됨 (제목 + 본문 = `memory/agent-message-contract.md` §1 구조 준수).
  - 라벨 = `needs-human-review:milestone` 1개만 부착.
  - `inputs/myapp/auth.md` → `inputs/myapp/processed/auth.md` 이동됨.
  - Notifier 호출됨 (channel이 `none`이 아니면 메시지 수신, `none`이면 marker 코멘트만).
  - Milestone에 `<!-- llm-team:notified:milestone -->` marker 코멘트 존재.
- **재진입 검증**: 같은 입력 없이 다시 `run-po.sh myapp` 호출 → exit 0 (open Milestone 차단).

**Step 2 — 사람 승인 (Milestone)**:
- 수동으로 GitHub web에서 Milestone 라벨을 `needs-human-review:milestone` → `needs-scenarios`로 교체.

**Step 3 — PM**:
- `scheduler/run-pm.sh myapp` 실행.
- 검증:
  - 같은 Milestone에 N개 (2~5 권장) Issue 생성됨.
  - 각 Issue 본문 = `memory/agent-message-contract.md` §2 구조 준수.
  - 각 Issue 라벨 = `needs-human-review:scenario` 1개만 부착.
  - Milestone 라벨 = `pm:done` 1개만 부착.
  - 각 Issue마다 Notifier 호출 (marker 코멘트 N개).
- **멱등성 검증**: 인위적으로 Milestone 라벨을 `needs-scenarios`로 되돌리고 1개 Issue를 수동 close → `run-pm.sh myapp` 재실행 → close된 Issue를 다시 만들지 않고 누락된 것만 생성하는지 (또는 0개 생성 후 `pm:done`).

**Step 4 — 사람 승인 (Scenarios)**:
- 1개 Issue에 대해 라벨 `needs-human-review:scenario` → `needs-dev`로 교체.
- 다른 Issue는 그대로 두어 병렬 동작은 다음 별도 단계에서 검증.

**Step 5 — DEV (1개)**:
- `scheduler/run-dev.sh myapp` 실행.
- 검증:
  - Issue 라벨 → `needs-qa`로 전이.
  - PR 생성됨 (본문에 `Closes #N` + qa-attempts marker `:1` 포함).
  - PR head 브랜치가 origin에 푸시됨.
  - `workdir/myapp/worktrees/<branch>/` 정리됨.

**Step 6 — QA (PASS 케이스)**:
- `scheduler/run-qa.sh myapp` 실행.
- 검증:
  - PR merge됨, Issue close됨, 라벨 전부 제거됨.
  - 만약 마지막 남은 Issue였다면 Milestone도 close됨.

**Step 7 — DEV 병렬 + QA 1차 실패 시나리오**:
- 다른 2개 Issue를 동시에 `needs-dev`로 교체.
- `scheduler/run-dev.sh myapp` 1회 실행 (`dev_concurrency=2` 또는 3) → 2개 PR 동시 생성 검증.
- `scheduler/run-qa.sh myapp` 실행. **인위적 실패 유도**: PR 1개의 코드를 일부러 깨뜨리거나 수용 기준을 강하게 만든 Issue 사용.
- 1차 실패 검증:
  - PR 코멘트 = `memory/agent-message-contract.md` §4 형식.
  - Issue 라벨 → `qa:changes-requested`.
- DEV 재진입: `scheduler/run-dev.sh myapp` 재실행 → 같은 브랜치에 push, PR marker `:2`로 갱신.
- QA 재실행: `scheduler/run-qa.sh myapp` → 인위 실패 제거된 케이스라면 PASS, 그대로면 2차 실패.
- 2차 실패 검증:
  - PR 코멘트 = §5 형식.
  - Issue 라벨 → `needs-human-review:dev-failure`.
  - Notifier `kind=dev-failure` 호출 (marker 코멘트 존재).

**Step 8 — Stale 복구**:
- 인위적으로 한 Issue 라벨을 `dev:in-progress`로 set, 라벨의 last update를 strict하게 만들기 어려우면 `stale_threshold_minutes=1`로 yaml 임시 수정.
- 1분 대기 후 `run-dev.sh myapp` 또는 `run-qa.sh myapp` 호출.
- 검증: 라벨이 `needs-dev`로 회귀, 코멘트/log에 stale 회복 메시지.

**Step 9 — 다음 PO 사이클 unblock**:
- 모든 Issue가 close되고 Milestone이 close된 상태에서, `inputs/myapp/foo2.md` 새 입력 추가.
- `scheduler/run-po.sh myapp` 실행 → 새 Milestone 생성됨 (open Milestone 0개 조건 충족 검증).

**Step 10 — Secret 누락 fail-fast** (`planning.md` §7.5):
- 임시로 `targets/myapp.yaml`의 `notifier.channel`을 `discord`로 바꾸고 `notifier.webhook_or_id`를 `.env`에 정의되지 않은 키(`MISSING_HOOK_KEY`)로 설정.
- `scheduler/run-po.sh myapp` 또는 `scripts/bootstrap-labels.sh myapp` 실행.
- 검증:
  - `lib/config.sh`의 `resolve_secret`이 stderr 에러 메시지 출력 + 비-0 exit code.
  - 부분 작업이 라벨을 손대지 않고 종료 (시스템 상태 손상 없음).
  - 원복 후 정상 동작 복귀.

**Step 11 — GitHub API 백오프 재시도** (`planning.md` §7.3, 옵션):
- `lib/gh.sh`의 `gh_with_retry`에 인위적 실패를 주입하기 어려우면, sub-common-lib의 `tests/lib/test-gh-retry.sh`를 e2e 환경에서 재실행하여 PASS 확인으로 대체.
- 검증: 3회 재시도 후 비-0 exit, 백오프 간격이 stderr 로그에 표시.

### C. 자동화 (선택)

위 시나리오를 `tests/e2e/mvp-flow.sh`로 스크립트화한다. 사람 승인 단계는 자동으로 라벨을 교체하는 helper를 사용 (실제 운영과 다르지만 e2e 자동화 목적).

```bash
# tests/e2e/mvp-flow.sh
# 사용: tests/e2e/mvp-flow.sh <test-target>
# 1. bootstrap-labels
# 2. PO 실행 → 자동으로 needs-scenarios로 라벨 전환 (사람 승인 simulate)
# 3. PM 실행 → 자동으로 모든 Issue를 needs-dev로 전환
# 4. DEV 병렬 실행
# 5. QA 실행 → 결과 검증
# 6. Milestone close 확인
```

### D. 라벨 상태 머신 불변식 검증

각 step 후 다음을 확인:

- 모든 Milestone/Issue가 5/7개 라벨 중 정확히 1개만 보유 (또는 종료 상태 0개).
- `*:in-progress`와 다음 큐 라벨이 동시에 붙은 객체 없음.
- 모든 Notifier 트리거 라벨 객체에 marker 코멘트 존재.

### E. 통합 이슈 수정

검증 중 발견된 통합 문제(타입 불일치, 헤딩 이름 불일치, lib 함수 시그니처 mismatch, 누락된 import 등)를 직접 수정한다. 수정 대상이 prompts나 lib에 있으면 그쪽을 고치고 변경 이유를 본 sub-task의 완료 보고에 기록한다.

### F. 보고서 작성

`docs/superpowers/specs/e2e-verification-report.md`에 다음을 기록:
- 실행 일시, 사용한 테스트 repo
- 각 Step의 결과 (PASS/FAIL + 증거: 라벨 스크린샷 또는 `gh issue view` 출력)
- 발견된 이슈 및 수정 내역
- 알려진 한계 (race window 발생 여부, MVP에서 검증되지 않은 항목)

## 완료 체크리스트

- [ ] 테스트 repo에 12개 라벨 부트스트랩 성공
- [ ] Step 1 PO 실행 → Milestone 생성 + 라벨 + Notifier marker 모두 검증
- [ ] Step 1 재진입 → open Milestone 차단으로 exit 0
- [ ] Step 3 PM 실행 → N개 Issue 생성 + 본문 contract 준수
- [ ] Step 3 멱등성 시나리오 통과
- [ ] Step 5 DEV 1개 → PR 생성 + qa-attempts:1 marker
- [ ] Step 6 QA PASS → merge + Issue close + Milestone close (마지막 Issue인 경우)
- [ ] Step 7 DEV 병렬 → 2개 PR 동시 생성, dev_concurrency 상한 준수
- [ ] Step 7 QA 1차 실패 → §4 형식 코멘트 + qa:changes-requested
- [ ] Step 7 DEV 재작업 → 같은 브랜치 + qa-attempts:2 marker
- [ ] Step 7 QA 2차 실패 → §5 형식 코멘트 + needs-human-review:dev-failure + Notifier
- [ ] Step 8 Stale 복구 → 라벨 회귀 작동
- [ ] Step 9 새 PO 사이클 시작 가능 (Milestone close가 unblock 정확히 수행)
- [ ] Step 10 Secret 누락 시 `resolve_secret` fail-fast (비-0 exit + 라벨 손상 없음)
- [ ] Step 11 (옵션) `gh_with_retry` 백오프 동작 확인 (test-gh-retry 재실행 PASS)
- [ ] 라벨 불변식 위반 0건
- [ ] 발견된 통합 이슈 모두 수정됨
- [ ] e2e-verification-report.md 작성됨
