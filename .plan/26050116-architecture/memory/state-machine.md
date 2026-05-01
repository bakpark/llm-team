# State Machine Contract (라벨 · 전이 · Marker)

본 문서는 모든 에이전트(PO/PM/DEV/QA)가 공유하는 GitHub 라벨 상태 머신과 marker 컨벤션을 정의한다. 출처: `planning.md` §4–§7. 에이전트 구현자는 본 문서만 참조해도 라벨 작업이 가능하도록 한다.

---

## 1. 라벨 (총 12개)

### Milestone 라벨 (5개)

| 라벨 | 의미 |
|---|---|
| `po:in-progress` | PO Agent가 Milestone 작성 중 |
| `needs-human-review:milestone` | PO 작업 완료, 사람 검토 대기 (Notifier 트리거) |
| `needs-scenarios` | 사람 승인 완료, PM 픽업 큐 |
| `pm:in-progress` | PM Agent가 Issue 분해 중 |
| `pm:done` | PM 작업 완료, 모든 Issue 생성됨. Milestone은 여전히 open (하위 Issue 진행 중) |

### Issue 라벨 (7개)

| 라벨 | 의미 |
|---|---|
| `needs-human-review:scenario` | PM이 Issue 생성 직후, 사람 검토 대기 (Notifier 트리거) |
| `needs-dev` | 사람 승인 완료, DEV 픽업 큐 (신규) |
| `dev:in-progress` | DEV Agent가 코드 작성 중 |
| `needs-qa` | DEV 완료(PR 푸시), QA 픽업 큐 |
| `qa:in-progress` | QA Agent가 검증 중 |
| `qa:changes-requested` | QA 1차 실패, DEV 재픽업 큐 (실패 케이스는 PR 코멘트) |
| `needs-human-review:dev-failure` | QA 2차 실패 또는 git 작업 실패, 사람 escalation (Notifier 트리거) |

### 종료 상태

PR merge + Issue close + 라벨 전부 제거. 별도 `qa:approved` 라벨 없음.

### Milestone 라벨 인코딩 (구현 노트)

GitHub Milestone은 native label을 지원하지 않는다. `lib/gh.sh`의 `milestone_set_label` / `milestone_list_by_label`은 Milestone description에 hidden HTML marker(`<!-- llm-team:milestone-label:<LABEL> -->`)를 추가/검색하는 방식으로 라벨 효과를 구현한다. **에이전트 구현 시에는 lib 함수 시그니처만 사용하면 되며 marker 인코딩을 직접 다루지 않는다.** 사람이 GitHub web에서 Milestone "라벨"을 확인하려면 description의 marker를 봐야 한다.

---

## 2. 상태 전이

### Milestone

```
(PO 시작)─→ po:in-progress ─→ needs-human-review:milestone
   ↓ (사람이 라벨 교체)
needs-scenarios ─→ pm:in-progress ─→ pm:done
   (Milestone은 모든 하위 Issue가 close될 때까지 open)
   ↓ (마지막 Issue close 시 QA가 Milestone도 close)
[Milestone closed]
```

### Issue

```
(PM 생성) needs-human-review:scenario
   ↓ (사람이 라벨 교체)
needs-dev ─→ dev:in-progress ─→ needs-qa ─→ qa:in-progress
   ├─ 통과    → PR merge + Issue close + 라벨 전부 제거
   ├─ 1차 실패 → qa:changes-requested ─→ dev:in-progress ─→ needs-qa ─→ qa:in-progress
   └─ 2차 실패 → needs-human-review:dev-failure (Notifier)
```

---

## 3. 전이 불변식

- **단일 라벨 보장**: 각 객체(Milestone 또는 Issue)는 위 라벨 중 정확히 1개만 보유한다 (종료 상태 제외). `*:in-progress`와 다음 큐 라벨이 동시에 붙지 않는다.
- **Atomic 전이 절차**: 라벨 교체 시 반드시 다음 순서로 호출한다.
  1. 새 라벨 add (`gh label add` / `gh issue edit --add-label`)
  2. 기존 라벨 remove (`--remove-label`)
- **알려진 race window**: gh CLI는 트랜잭션을 제공하지 않으므로 동시 두 cron이 같은 큐 라벨을 보면 중복 픽업 가능성이 작게 존재. 완화: cron 주기(§5.4)와 PM의 멱등성(§8.3 — 기존 Issue 조회 후 누락분만 생성)에 의존.

---

## 4. 트리거 조건 (cron 진입 직후 검사)

| 에이전트 | 픽업 조건 |
|---|---|
| **PO** | `inputs/<target>/*.md` 미처리 파일 존재 AND **같은 타겟에 open 상태인 Milestone 0개** (open = 위 5개 Milestone 라벨 중 어느 하나라도 붙은 것) |
| **PM** | 같은 타겟에 `needs-scenarios` Milestone 존재 (가장 오래된 1개 픽업) AND 같은 타겟에 `pm:in-progress` Milestone 없음 |
| **DEV** | `needs-dev` 또는 `qa:changes-requested` Issue 존재. `targets/<name>.yaml`의 `dev_concurrency`까지 병렬 픽업 |
| **QA** | `needs-qa` Issue 존재. 병렬 픽업 |

---

## 5. Stale 복구 (모든 cron 진입 시 inline 실행)

`stale_threshold_minutes` (기본 60분) 이상 업데이트 없는 `*:in-progress` 객체는 이전 큐 상태로 회귀한다.

| 현재 라벨 | 회귀 후 라벨 | 추가 동작 |
|---|---|---|
| `po:in-progress` | (라벨만 제거) | Milestone 코멘트: "PO crashed, will retry" |
| `pm:in-progress` | `needs-scenarios` | — |
| `dev:in-progress` | `needs-dev` | worktree 정리 (있으면) |
| `qa:in-progress` | `needs-qa` | 임시 worktree 정리 |

**예외**: PO가 Milestone을 생성했으나 라벨을 못 붙이고 죽은 경우(라벨 0개) → 자동 삭제하지 않음. Notifier로만 사람에게 알림.

---

## 6. Marker 컨벤션

라벨 외에 코멘트/PR 본문에 hidden HTML comment marker를 사용한다.

### 6.1 Notifier 멱등성 marker

- **위치**: 알림 대상 객체(Milestone 또는 Issue)에 코멘트로 추가
- **형식**: `<!-- llm-team:notified:<kind> -->` — `<kind>` ∈ `milestone`, `scenario`, `dev-failure`
- **사용**: Notifier 호출 전 객체 코멘트를 조회해 같은 marker가 있으면 스킵 (중복 알림 방지)

```bash
# 예시
gh issue comment <num> --body "<!-- llm-team:notified:scenario -->"
```

### 6.2 QA 시도 횟수 marker

- **위치**: PR 본문의 가장 끝 줄
- **형식**: `<!-- llm-team:qa-attempts:N -->` — `N` ∈ `1`, `2`
- **사용**: DEV가 PR 생성 시 `:1` 추가. DEV 재작업(qa:changes-requested 회수) 시 `:2`로 갱신. QA가 검증 결과를 결정할 때 N을 읽어 1차/2차 분기.

---

## 7. Notifier 호출 시점

다음 라벨 전이 직후, **같은 프로세스에서** Notifier를 호출한다.

| 트리거 라벨 | kind | 호출자 |
|---|---|---|
| `needs-human-review:milestone` | `milestone` | PO |
| `needs-human-review:scenario` | `scenario` | PM (Issue마다 1회, N개 알림) |
| `needs-human-review:dev-failure` | `dev-failure` | QA (2차 실패) 또는 DEV (git 실패) |

### Notifier 인터페이스

```
notify_review_needed(target, kind, github_url, summary)
```

구현 분기는 `targets/<name>.yaml`의 `notifier.channel` (`discord` | `slack` | `none`) 기준. 자세한 시그니처는 sub-common이 정의하는 `lib/notifier.sh`를 참조한다.

---

## 8. Milestone Close 책임 (M2 결과)

QA가 Issue를 close할 때 마지막으로 다음을 수행한다.

1. Issue가 속한 Milestone의 progress(GitHub API: open/closed Issue 수)를 조회.
2. 모든 Issue가 close 상태이면 Milestone도 close (`gh api ... -X PATCH -f state=closed`).
3. Milestone close가 PO의 다음 사이클을 unblock한다 (§4 트리거 조건의 "open Milestone 0개").
