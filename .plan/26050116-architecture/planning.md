# LLM Agent Team — System Architecture Design

- **작성일**: 2026-05-01
- **출처**: `spec.md` (LLM Agent Team 협업 모델 컨셉)
- **범위**: 4개 에이전트(PO/PM/DEV/QA) + Scheduler + Notifier로 구성된 다중 타겟 자동화 프레임워크의 시스템 아키텍처. 각 에이전트의 프롬프트 본문, Notifier 양방향 인터랙션, Validation 도구는 후속 스펙으로 분리.

---

## 1. 배경

`spec.md`에 정의된 4개 역할(PO/PM/DEV/QA)을 GitHub 협업 객체(Milestone, Issue, PR, Label)로 매핑하여, 로컬 머신의 cron 기반 1-shot Claude Code 호출로 자동화 파이프라인을 구성한다. 협업의 가시성은 GitHub 자체가 single source of truth가 되는 것으로 확보한다.

### 핵심 결정 요약

| 결정 사항 | 선택 |
|---|---|
| 파이프라인 입력 | 고수준 아이디어 markdown 파일 (`inputs/<target>/*.md`) |
| GitHub 객체 매핑 | PO→Milestone, PM→Issues, DEV→branch+PR, QA→merge |
| 트리거 모델 | 각 에이전트 독립 cron + GitHub 라벨 상태 머신 (B+C 조합) |
| 동시성 | Milestone 레벨 직렬 / Issue 레벨 병렬 (git worktree) |
| Repo 모델 | 다중 타겟 제네릭 프레임워크 |
| 설정/프롬프트/입력 위치 | 모두 프레임워크 측 (`targets/*.yaml`, `prompts/*`, `inputs/<target>/*`) |
| HITL 메커니즘 | Push 알림 + Pull 승인 (사람이 GitHub 라벨 수동 교체) |
| QA 재시도 | 최대 1회, 실패 시 `needs-human-review:dev-failure`로 escalate |

---

## 2. System Overview

### 2.1 구성요소

```
┌─────────────────────────── llm-team/ (프레임워크 repo) ──────────────────────────┐
│                                                                                   │
│  Scheduler (cron)  ──┬─→ PO Agent      (read inputs/<target>/*.md → Milestone)   │
│                      ├─→ PM Agent      (Milestone → Issues with scenarios)       │
│                      ├─→ DEV Agent     (Issue → branch + PR via worktree)        │
│                      └─→ QA Agent      (PR → tests → merge or reject)            │
│                                                                                   │
│  targets/<name>.yaml  ── 타겟 repo 메타                                            │
│  prompts/{po,pm,dev,qa}.md  ── 프레임워크 고정 프롬프트                            │
│  inputs/<target>/*.md  ── PO에게 줄 아이디어 문서                                  │
│  Notifier  ── Discord/Slack로 "사람 승인 필요" 알림 push                          │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                          ┌── Target Repos (등록된 N개) ──┐
                          │  GitHub: Milestones, Issues,    │
                          │           PRs, Labels           │
                          │  Local clone: DEV worktree용   │
                          └────────────────────────────────┘
```

| 구성요소 | 책임 |
|---|---|
| Scheduler | 4개의 독립 cron이 PO/PM/DEV/QA를 주기적으로 깨움. 각 cron은 등록된 모든 활성 타겟 순회. |
| PO Agent | `inputs/<target>/*.md`를 읽어 GitHub Milestone 생성. |
| PM Agent | Milestone을 user scenario 단위 Issue들로 분해. |
| DEV Agent | Issue → branch + PR. git worktree로 격리. 병렬. |
| QA Agent | PR 검증 → merge 또는 코멘트+회귀. 병렬. |
| Notifier | 사람 승인이 필요한 라벨 전이 시점에 Discord/Slack로 메시지 push (단방향). |

### 2.2 핸드오프 매체

GitHub만이 single source of truth (Milestones, Issues, PR, Labels). 에이전트 간 직접 통신, 외부 큐, 외부 DB 없음. 시스템 상태 전체를 GitHub에서 라벨로 즉시 파악 가능.

### 2.3 범위 밖 (후속 스펙)

- Notifier 양방향 인터랙션 (자연어 승인/거절/interrupt)
- Validation 도구 (UI/E2E 검증)
- 각 에이전트의 프롬프트 본문 (4개 별도 스펙)
- Scheduler 구체 구현 (launchd vs cron vs Node)
- Secret/토큰 관리 메커니즘
- 운영/관측성 (메트릭, 대시보드, 비용)

---

## 3. Repo & Deployment Model

### 3.1 프레임워크 repo 디렉토리 구조

```
llm-team/
├── spec.md                          # 원본 컨셉
├── docs/superpowers/specs/          # 본 아키텍처 + 후속 스펙
├── .plan/                           # 작업 계획 (CLAUDE.md 규약)
│
├── targets/                         # 등록된 타겟 카탈로그
│   ├── myapp.yaml
│   └── another.yaml
│
├── prompts/                         # 프레임워크 고정 프롬프트
│   ├── po.md
│   ├── pm.md
│   ├── dev.md
│   └── qa.md
│
├── inputs/                          # 아이디어 문서 (PO 입력)
│   └── <target>/
│       ├── *.md
│       └── processed/               # PO가 처리 후 이동
│
├── scheduler/                       # cron 진입점 스크립트
│   ├── run-po.sh
│   ├── run-pm.sh
│   ├── run-dev.sh
│   └── run-qa.sh
│
├── lib/                             # 공유 유틸 (gh 래퍼, 라벨 상수, 로더)
│
└── workdir/                         # gitignore — 실행 작업공간
    └── <target>/
        ├── worktrees/<branch>/      # DEV/QA worktree
        └── logs/<agent>-<ts>.log
```

### 3.2 `targets/<name>.yaml` 스키마

```yaml
name: myapp
github:
  owner: bakparkbj
  repo: myapp
  default_branch: main
local:
  clone_path: ~/dev/myapp           # DEV가 worktree를 만들 베이스 repo
inputs_dir: inputs/myapp            # 프레임워크 기준 상대경로
labels:
  prefix: ""                        # 빈 문자열 = 표준 라벨 그대로
notifier:
  channel: discord                  # discord | slack | none
  webhook_or_id: <ref-to-secret>    # 비밀 참조 키
dev_concurrency: 3                  # DEV 병렬 상한 (기본 3)
stale_threshold_minutes: 60         # in-progress 라벨 stale 임계값
enabled: true
```

### 3.3 타겟 repo 측 요구사항

타겟 repo는 코드 외 추가 파일을 두지 않는다. 단, GitHub 측에 다음이 사전 세팅돼야 한다:

- 본 스펙의 12개 라벨 (§4.2)
- `gh` CLI가 권한을 가진 토큰 (PR 생성/머지, Milestone CRUD, Label CRUD, Issue CRUD)

라벨 부트스트랩 스크립트는 별도 스펙.

### 3.4 비밀 관리

- 비밀 저장 위치는 별도 스펙 (Keychain vs env file 등)
- `targets/*.yaml`에는 **참조 키만** 저장. 실제 토큰/웹훅 URL 하드코딩 금지.

---

## 4. GitHub Object Mapping & Label State Machine

### 4.1 객체 매핑

| 산출물 | GitHub 객체 |
|---|---|
| 아이디어 문서 (`inputs/<target>/*.md`) | (입력만, GitHub 객체 아님) |
| PO 산출 | Milestone 1개 + 본문(리서치 요약, 큰 그림 분해) |
| PM 산출 | 그 Milestone에 속한 Issue N개 (각 Issue 본문 = 단일 user scenario) |
| DEV 산출 | Issue별 branch + PR (PR이 Issue를 closes) |
| QA 결정 | PR merge **또는** PR 코멘트(실패 케이스) + 라벨 회귀 |

### 4.2 라벨 (총 12개)

```
Milestone 라벨:
  ▸ po:in-progress
  ▸ needs-human-review:milestone     ← Notifier 트리거 (사람 승인 대기)
  ▸ needs-scenarios                  ← PM 픽업 큐
  ▸ pm:in-progress
  ▸ pm:done                          ← Milestone 종료 (모든 Issue 생성 후)

Issue 라벨:
  ▸ needs-human-review:scenario      ← Notifier 트리거 (사람 승인 대기)
  ▸ needs-dev                        ← DEV 픽업 큐 (신규)
  ▸ dev:in-progress
  ▸ needs-qa                         ← QA 픽업 큐
  ▸ qa:in-progress
  ▸ qa:changes-requested             ← DEV 재픽업 큐 (실패 1회차)
  ▸ needs-human-review:dev-failure   ← Notifier 트리거 (QA 2회차 실패 또는 git 실패)
```

승인된 최종 상태(merge 후)는 PR merge + Issue close로 표현. 별도 `qa:approved` 라벨 없음.

### 4.3 상태 전이

```
[Milestone]
  (PO 시작)─→ po:in-progress ─→ needs-human-review:milestone ──┐
                                                                 │ (사람이 라벨 교체)
                                                                 ▼
                                                          needs-scenarios
                                                                 │
                                                  (PM 시작)─→ pm:in-progress
                                                                 │
                                              [Issue들 생성, 각 Issue에 needs-human-review:scenario]
                                                                 ▼
                                                            pm:done

[Issue]  (PM이 생성, needs-human-review:scenario)
        ─→ (사람이 라벨 교체) ─→ needs-dev
        ─→ (DEV 픽업)         ─→ dev:in-progress
        ─→ (PR push 완료)     ─→ needs-qa
        ─→ (QA 픽업)          ─→ qa:in-progress
                ├─ 통과       ─→ PR merge + Issue close (라벨 정리)
                ├─ 1차 실패   ─→ qa:changes-requested  (PR 코멘트에 실패 케이스)
                │                  ↓
                │            (DEV 재픽업, 같은 브랜치) ─→ dev:in-progress ─→ needs-qa
                │                                                                ↓
                │                                                          (QA 2차)
                └─ 2차 실패   ─→ needs-human-review:dev-failure (Notifier)
```

### 4.4 전이 불변식

- 각 객체(Milestone 또는 Issue)는 위 라벨 중 **정확히 1개**만 보유. in-progress와 다음 큐 라벨이 동시에 붙지 않는다.
- 에이전트가 라벨을 교체할 때는 best-effort atomic: 새 라벨 add → 기존 라벨 remove (gh CLI 호출 순서). 이 전이가 §5의 동시성 lock 역할을 한다.
- **알려진 race window**: gh CLI는 진정한 트랜잭션을 제공하지 않는다. 동시에 두 cron이 같은 큐 라벨을 본 경우, 둘 다 `*:in-progress`로 전이하는 작은 가능성이 존재. 완화책은 cron 주기가 짧지 않다는 점(§5.4: DEV/QA 2분, PM 5분, PO 10분)과 PM의 idempotency(§8.3)에 의존. 완전한 lock은 별도 스펙(Scheduler 구체 구현)에서 다룬다.

---

## 5. Concurrency Model

### 5.1 원칙

- **Milestone 레벨**: 같은 타겟 내에서 활성 Milestone은 **항상 1개 이하**. "활성"이란 PO가 Milestone을 생성한 시점부터 그 Milestone에 속한 모든 Issue가 close되고 Milestone 자체가 GitHub에서 close될 때까지를 의미한다. 즉 다음 라벨 상태가 모두 활성으로 간주된다: `po:in-progress`, `needs-human-review:milestone`, `needs-scenarios`, `pm:in-progress`, `pm:done` (그리고 `pm:done` 이후 하위 Issue들이 DEV/QA 단계에서 진행 중인 동안 Milestone이 open으로 남아 있는 기간). 운영적으로는 "같은 타겟에 open Milestone이 존재" = 활성으로 판정한다.
- **Issue 레벨**: 병렬 처리. DEV는 git worktree로 격리.
- **동기화 매체**: GitHub 라벨만. 외부 lock 파일/DB 없음.

### 5.2 에이전트별 동시성

**PO Agent (단일 인스턴스)**

새 작업 시작 조건 (모두 참):
- `inputs/<target>/*.md` 중 미처리 파일 존재
- 같은 타겟에 **open 상태인 Milestone이 존재하지 않음** (§5.1의 활성 정의에 따라, 다음 라벨 중 어느 하나라도 붙은 Milestone이 있으면 차단: `po:in-progress`, `needs-human-review:milestone`, `needs-scenarios`, `pm:in-progress`, `pm:done`)

처리 표시: Milestone 생성 직후 `inputs/<target>/foo.md` → `inputs/<target>/processed/foo.md` 이동.

**PM Agent (단일 인스턴스)**

- `needs-scenarios` Milestone 발견 시 가장 오래된 1개 픽업, 라벨을 `pm:in-progress`로 atomic 교체.
- 타겟별로 직렬.

**DEV Agent (병렬)**

- `needs-dev` 또는 `qa:changes-requested` Issue 픽업. 라벨을 `dev:in-progress`로 atomic 교체.
- 동시 실행 상한: `targets/<name>.yaml`의 `dev_concurrency` (기본 3).
- 작업공간: `workdir/<target>/worktrees/<branch>/`.
- worktree 정리: PR 생성 후 라벨이 `needs-qa`로 넘어가면 worktree remove.

**QA Agent (병렬)**

- `needs-qa` Issue 픽업. 라벨을 `qa:in-progress`로 atomic 교체.
- 임시 worktree 또는 clone에서 PR 브랜치 체크아웃 후 검증.

### 5.3 Stale 복구

cron 시작 시 inline 검사:

- `*:in-progress` 라벨이 붙은 객체 중 마지막 업데이트로부터 `stale_threshold_minutes` (기본 60분) 이상 지난 것은 이전 큐 상태로 회귀:
  - `po:in-progress` → 라벨 제거, Milestone에 코멘트 ("PO crashed, will retry")
  - `pm:in-progress` → `needs-scenarios`
  - `dev:in-progress` → `needs-dev`
  - `qa:in-progress` → `needs-qa`
- PO가 Milestone을 생성했지만 `needs-human-review:milestone` 라벨을 못 붙이고 죽은 경우(상태 라벨이 0개): 자동 삭제하지 않고 Notifier로 사람에게 알림. 사람이 정리.

### 5.4 Cron 스케쥴 (초안)

| 에이전트 | 주기 |
|---|---|
| PO | 10분마다 |
| PM | 5분마다 |
| DEV | 2분마다 |
| QA | 2분마다 |

각 cron 시작 시 stale 검사를 inline으로 실행 (별도 cron 아님).

---

## 6. HITL Approval Flow

### 6.1 게이트 위치

| 게이트 | 트리거 라벨 | 사람의 역할 |
|---|---|---|
| Milestone 승인 (PO 산출 검토) | `needs-human-review:milestone` | Milestone 본문 검토 후 라벨을 `needs-scenarios`로 교체 |
| Scenario 승인 (PM 산출 검토) | `needs-human-review:scenario` (각 Issue마다) | Issue 본문 검토 후 라벨을 `needs-dev`로 교체 |
| Dev-failure escalation | `needs-human-review:dev-failure` | Issue/PR 검토 후 수동 처리 (재시작, scope 변경, close 등) |

### 6.2 알림 흐름

```
PO/PM/QA 에이전트
   │ 라벨을 needs-human-review:* 로 set
   ▼
GitHub
   │ 같은 프로세스가 라벨 set 직후 Notifier 호출
   ▼
Notifier (Discord/Slack webhook)
   │ 메시지: "[<target>] <kind> #<num> 승인 필요" + 본문 요약 + GitHub 링크
   ▼
사람 (알림 받음)
   │ 링크 → GitHub 웹에서 검토
   │ → 라벨 수동 교체
   ▼
다음 에이전트가 다음 cron에서 픽업
```

### 6.3 Notifier 인터페이스 (push-only)

```python
class Notifier:
    def notify_review_needed(
        target: str,
        kind: "milestone" | "scenario" | "dev-failure",
        github_url: str,
        summary: str,
    ) -> None: ...
```

구현체는 `targets/<name>.yaml`의 `notifier.channel`에 따라 분기:
- `discord` — webhook POST
- `slack` — webhook POST
- `none` — no-op (사람이 GitHub만 보고 처리)

### 6.4 거절/재작업 처리

MVP 범위에서 사람의 개입은 **단순 라벨 교체만**. 자연어 거절/재작업 명령은 Notifier v2 스펙에서 다룬다. 사람이 거절하고 싶다면 GitHub UI에서 Issue/Milestone close 또는 본문 편집 후 라벨 전환.

### 6.5 멱등성

같은 객체에 대해 Notifier 중복 호출되더라도 메시지 중복 방지:
- 알림 후 GitHub 객체에 hidden marker 코멘트 (`<!-- llm-team:notified:<kind> -->`).
- 같은 marker가 이미 있으면 알림 스킵.

PM이 N개 Issue를 생성하면 N개 알림이 각각 발송된다 (묶지 않음).

---

## 7. Failure Handling

### 7.1 QA 검증 실패 → DEV 재작업

- QA가 `needs-qa` Issue 처리 중 테스트 실패 시: PR 코멘트(실패 케이스 + 로그) + 라벨 `qa:in-progress` → `qa:changes-requested`.
- DEV가 `qa:changes-requested` Issue 재픽업, 같은 브랜치에서 수정 → push → 라벨 `needs-qa`.
- **재시도는 최대 1회**. 2차 QA도 실패하면 라벨을 `needs-human-review:dev-failure`로 → Notifier.
- 시도 횟수 추적: PR 본문 끝에 `<!-- llm-team:qa-attempts:1 -->` (또는 `:2`) marker.

### 7.2 에이전트 프로세스 크래시 / 타임아웃

§5.3의 stale 복구 메커니즘에 의해 처리. PO 부분 실패 (Milestone 생성 후 라벨 못 붙임)는 자동 삭제하지 않고 Notifier만.

### 7.3 GitHub API 에러

- 모든 gh CLI 호출에 지수 백오프 재시도 (3회까지, 2s/8s/30s).
- 실패 시 cron 종료 (라벨은 손대지 않음). 다음 cron이 픽업.
- `*:in-progress`로 이미 전환한 후 후속 작업이 실패하면 롤백 없이 stale 메커니즘이 처리.

### 7.4 Git 작업 실패 (DEV 영역)

- worktree 생성 실패 / 머지 충돌 / push 거부:
  - DEV 작업 중단
  - Issue 코멘트 ("git 작업 실패: <error>")
  - 라벨 `dev:in-progress` → `needs-human-review:dev-failure`
  - Notifier 발송
  - worktree 정리

### 7.5 Secret 누락 / 잘못된 yaml

- cron 시작 시 fail-fast: 등록된 타겟의 yaml/secrets 검증.
- 잘못되면 해당 타겟 skip + stderr 로그.
- MVP에서는 시스템 레벨 알림 없음 (운영자가 stderr 확인).

### 7.6 관측성 (최소)

- 각 에이전트 실행은 `workdir/<target>/logs/<agent>-<timestamp>.log`로 stdout/stderr 기록.
- gh CLI 모든 호출 로그.
- "객체 상태"는 GitHub 라벨이 곧 진실. 별도 대시보드 불필요.

---

## 8. Per-Agent Contract

각 에이전트의 입출력 계약. 프롬프트 본문 및 **에이전트 간 markdown 본문 contract**(Milestone/Issue/PR 본문에서 사용할 헤딩 구조, 필수 섹션, 필드 명명 규칙)는 별도 스펙(`prompts/{po,pm,dev,qa}.md`)에서 정의한다. 본 §8은 라벨 전이·GitHub 권한·동시성 측면의 계약만 다룬다.

### 8.1 공통 실행 모델

- 모든 에이전트는 1-shot Claude Code 호출 (대화 없음).
- 진입점: `scheduler/run-<agent>.sh <target>`.
- cron이 활성 타겟을 순회하며 각 타겟에 대해 1회 진입.
- 모든 에이전트의 마지막 동작은 라벨 atomic 전이.

### 8.2 PO Agent

| 항목 | 내용 |
|---|---|
| 트리거 | `inputs/<target>/*.md` 미처리 파일 존재 AND 같은 타겟에 `po:in-progress` / `pm:in-progress` Milestone 없음 |
| 입력 | 단일 markdown 파일 (자유 형식 아이디어) |
| 출력 | GitHub Milestone 1개 (제목, 본문에 리서치 요약 + 큰 그림 분해), 라벨 `po:in-progress` |
| 진행 중 표시 | Milestone 라벨 `po:in-progress` |
| 완료 동작 | Milestone 본문 작성 → 라벨 `po:in-progress` → `needs-human-review:milestone` 교체 → Notifier → inputs 파일을 `processed/`로 이동 |
| GitHub 권한 | Milestone CRUD, Label CRUD, 코멘트 작성 |

### 8.3 PM Agent

| 항목 | 내용 |
|---|---|
| 트리거 | `needs-scenarios` Milestone 발견 (가장 오래된 1개) AND 같은 타겟에 `pm:in-progress` Milestone 없음 |
| 입력 | Milestone 본문 (PO 산출) + 사람이 추가한 코멘트(있다면) |
| 출력 | 같은 Milestone에 속하는 Issue N개 (각 Issue 본문 = 단일 user scenario, 수용 기준, 영향 범위) |
| 진행 중 표시 | Milestone 라벨 `needs-scenarios` → `pm:in-progress` |
| 멱등성 | PM은 시작 시 해당 Milestone에 이미 연결된 Issue를 조회. 기존 Issue가 있으면 "이미 생성된 시나리오"로 간주하고 누락된 시나리오만 생성. (stale 복구 후 재실행 시 중복 방지) |
| 완료 동작 | 모든 Issue 생성 → 각 Issue에 `needs-human-review:scenario` → Milestone 라벨을 `pm:in-progress` → `pm:done` → 각 Issue마다 Notifier 호출 (N개 알림) |
| GitHub 권한 | Issue CRUD, Label CRUD |

### 8.4 DEV Agent

| 항목 | 내용 |
|---|---|
| 트리거 | `needs-dev` 또는 `qa:changes-requested` Issue 발견. `dev_concurrency`까지 병렬 |
| 입력 | Issue 본문 + 같은 Issue/PR의 코멘트들 (재작업 시 QA 피드백 포함) |
| 출력 | 신규: 새 branch + PR (PR이 Issue를 closes). 재작업: 기존 브랜치에 commit push. PR 본문에 `<!-- llm-team:qa-attempts:N -->` marker 갱신 |
| 진행 중 표시 | Issue 라벨 atomic 전이 → `dev:in-progress`. `workdir/<target>/worktrees/<branch>/`에 worktree |
| 완료 동작 | PR push 완료 → 라벨 `dev:in-progress` → `needs-qa` 교체 → worktree 정리 |
| 실패 처리 | git 충돌/푸시 거부 → 라벨 `needs-human-review:dev-failure` → Notifier → worktree 정리 |
| GitHub 권한 | branch push, PR CRUD, Issue 코멘트, Label CRUD |

### 8.5 QA Agent

| 항목 | 내용 |
|---|---|
| 트리거 | `needs-qa` Issue 발견. 병렬 |
| 입력 | 연결된 PR (브랜치 + diff), Issue의 user scenario (수용 기준), PR 본문의 `qa-attempts` marker |
| 출력 | merge **또는** PR 코멘트(실패 로그) + 라벨 회귀 |
| 진행 중 표시 | Issue 라벨 atomic 전이 → `qa:in-progress`. 임시 worktree에서 검증 |
| 완료 동작 (성공) | PR merge → Issue close → 모든 라벨 제거 → **소속 Milestone progress 확인 후 모든 Issue가 close 상태이면 Milestone도 close** (다음 PO 사이클을 unblock) |
| 완료 동작 (1차 실패) | PR 코멘트(실패 로그) + Issue 라벨 → `qa:changes-requested` (DEV 재진입) |
| 완료 동작 (2차 실패) | PR 코멘트 + Issue 라벨 → `needs-human-review:dev-failure` → Notifier |
| GitHub 권한 | PR merge, PR 코멘트, Issue 코멘트, Label CRUD |

---

## 9. 후속 스펙 목록

본 아키텍처 스펙이 정의한 골격 위에 다음 스펙들이 작성된다:

1. `prompts/po.md` — PO Agent 프롬프트 본문
2. `prompts/pm.md` — PM Agent 프롬프트 본문
3. `prompts/dev.md` — DEV Agent 프롬프트 본문
4. `prompts/qa.md` — QA Agent 프롬프트 본문
5. Notifier v2 — 양방향 인터랙션 (자연어 승인/거절/interrupt)
6. Validation 도구 — UI/E2E 등 표준 테스트를 넘는 검증
7. Scheduler 구체 구현 — launchd vs cron, 락 메커니즘
8. Secret/토큰 관리
9. 라벨 부트스트랩 CLI — 새 타겟 등록 시 12개 라벨 자동 생성
10. 운영/관측성 (필요 시)

---

## 10. 검증 방법

본 아키텍처 스펙 자체의 검증 방법:

- **사용자 리뷰**: 본 문서를 사용자가 읽고 승인 (현재 단계).
- **후속 단계 가능성 검증**: writing-plans 스킬로 실행 계획을 만들 때, 본 스펙의 모든 결정이 구현 가능한 단위로 분해되는지 확인.
- **MVP 통과 시나리오**: `inputs/myapp/auth.md` 1개 파일 → PO Milestone 생성 → 사람 승인 → PM이 2~3개 Issue 생성 → 사람 승인 → DEV가 PR 작성 → QA가 merge. End-to-end로 1회 통과하면 아키텍처가 검증된다.

---

## 11. 태스크 목록

본 아키텍처를 구현하기 위한 sub-task 분해. 각 sub-task의 상세는 `sub-*.md` 파일을 참조한다. 공유 contract는 `memory/state-machine.md`, `memory/agent-message-contract.md`에 정의.

| 태스크 | 설명 | 대상 파일 (요약) | 선행 조건 | Phase |
|---|---|---|---|---|
| `sub-common-lib.md` | lib 모듈 10개 + 라벨 부트스트랩 CLI + lib smoke test | `lib/*.sh`, `scripts/bootstrap-labels.sh`, `tests/lib/*.sh` | - | 1 |
| `sub-common-skeleton.md` | 디렉토리 골격 + targets/myapp.yaml + sample input + README + .gitignore + .env.example | 디렉토리 8개, `targets/myapp.yaml`, `inputs/myapp/auth.md`, `README.md`, `.gitignore`, `.env.example` | - | 1 |
| `sub-po-agent.md` | PO Agent (Milestone 생성) | `prompts/po.md`, `scheduler/run-po.sh` | sub-common-lib | 2 |
| `sub-pm-agent.md` | PM Agent (Milestone → Issues, 멱등성 포함) | `prompts/pm.md`, `scheduler/run-pm.sh` | sub-common-lib | 2 |
| `sub-dev-agent.md` | DEV Agent (Issue → PR, worktree, 병렬, git 실패 escalation) | `prompts/dev.md`, `scheduler/run-dev.sh` | sub-common-lib | 2 |
| `sub-qa-agent.md` | QA Agent (PR 검증 → merge / 회수 / escalation, Milestone close) | `prompts/qa.md`, `scheduler/run-qa.sh` | sub-common-lib | 2 |
| `sub-e2e-verification.md` | MVP 통과 시나리오 + 라벨 불변식 + secret/백오프 검증 + 통합 이슈 수정 + 보고서 | `tests/e2e/mvp-flow.sh`, `docs/superpowers/specs/e2e-verification-report.md` | sub-common-lib, sub-common-skeleton, Phase 2 전체 | 3 |

**Phase 1 두 태스크 간 contract**: `targets/<name>.yaml`의 키 이름(`planning.md` §3.2)이 곧 `lib/config.sh`의 export 변수명과 1:1 대응. 두 태스크 모두 §3.2를 따르면 자동 정합. README가 lib 내부 함수를 직접 노출하지 않으므로 추가 의존 없음.

### memory/ 파일

| 파일 | 역할 | owner |
|---|---|---|
| `memory/state-machine.md` | 12개 라벨 + 상태 전이 + Stale 복구 + Marker + Notifier 호출 시점 + Milestone close 책임 | create-tasks |
| `memory/agent-message-contract.md` | Milestone/Issue/PR 본문 markdown 구조 (헤딩/섹션 강제) + QA 코멘트 형식 + DEV git 실패 코멘트 형식 | create-tasks |

### 본 spec의 후속 분리 항목 매핑

`§9 후속 스펙 목록` 10개 중 본 태스크 분해에 포함된 범위:

| §9 항목 | 본 분해 처리 |
|---|---|
| 1–4. prompts/{po,pm,dev,qa}.md | 각 sub-{agent}-agent.md에서 작성 |
| 5. Notifier v2 (양방향) | **제외** (본 분해는 v1 push-only만, lib/notifier.sh) |
| 6. Validation 도구 (UI/E2E 검증) | **제외** (QA는 PR 본문의 `## 검증 방법` 명령어 또는 표준 테스트 명령어 실행 수준) |
| 7. Scheduler 구체 구현 | sub-common의 README에 cron 등록 예시. lock 메커니즘은 별도 후속 |
| 8. Secret/토큰 관리 | sub-common의 `.env` + `lib/config.sh` resolve_secret 최소 구현 |
| 9. 라벨 부트스트랩 CLI | sub-common의 `scripts/bootstrap-labels.sh` |
| 10. 운영/관측성 | **제외** (lib/log.sh의 logs/ 출력으로 최소 대체) |

## 12. 실행 순서

```
Phase 1 (2개 병렬)
  ┌─ sub-common-lib       (lib + bootstrap-labels + smoke test)
  └─ sub-common-skeleton  (디렉토리 + yaml + sample + README)
                                    │
                                    ▼
Phase 2 (4개 병렬, sub-common-lib 완료 후 시작)
  ┌─ sub-po-agent
  ├─ sub-pm-agent
  ├─ sub-dev-agent
  └─ sub-qa-agent
                                    │
                                    ▼
Phase 3 (후행 — e2e 검증, 모든 Phase 1+2 완료 후)
  sub-e2e-verification
```

- **Phase 1 병렬성**: sub-common-lib과 sub-common-skeleton은 `targets/yaml` 스키마(§3.2)를 공통 contract로 따르므로 서로 의존 없이 동시 진행 가능. 산출물도 파일 영역이 겹치지 않음 (lib/ + scripts/ vs 디렉토리 + yaml + 문서).
- **Phase 2 병렬성**: 4개 태스크는 서로 다른 `prompts/<agent>.md`와 `scheduler/run-<agent>.sh` 파일만 수정하므로 파일 충돌 없음. 모두 동시 실행 가능. lib API 시그니처(sub-common-lib 산출)에만 의존.
- **Phase 3 권한**: 통합 이슈 발견 시 모든 산출물을 수정할 수 있다. e2e 실행에는 Phase 1의 두 산출물 모두 + Phase 2 4개가 필요하므로 sub-common-skeleton도 선행 조건에 포함된다.
- lib API 시그니처는 sub-common-lib 산출 직후 contract로 고정. yaml 키도 §3.2에 고정. 두 contract는 변경 시 모든 의존 태스크에 영향.
