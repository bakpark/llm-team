# Agent Message Contract (Milestone / Issue / PR 본문 구조)

본 문서는 PO/PM/DEV/QA 에이전트가 GitHub 객체에 작성하는 markdown 본문의 구조를 정의한다. 에이전트들은 서로 통신하지 않고 GitHub 본문을 통해서만 핸드오프하므로, **헤딩 이름과 섹션 순서는 정확히 본 contract를 따라야 한다.** 본문 자유 서술 영역은 LLM이 자연어로 채운다.

---

## 1. Milestone 본문 (PO 산출 → PM 입력)

```markdown
## 리서치 요약

<3~10문단. 입력 아이디어를 바탕으로 PO가 수행한 리서치 결과 요약. 도메인 배경, 유사 사례, 기술 제약 등.>

## 큰 그림 분해

<불릿 리스트. 각 항목은 PM이 1개 user scenario로 분해할 수 있는 단위. 항목 수: 2~10개 권장.>

- <분해 단위 1>
- <분해 단위 2>
- ...

## 제약/주의사항

<선택. 호환성, 성능, 의존성 등 주의사항. 없으면 섹션 자체를 생략 가능.>

## 입력 출처

`inputs/<target>/<filename>.md` (PO Agent가 자동 기재)
```

**파싱 규칙 (PM이 사용)**:
- `## 큰 그림 분해` 섹션의 불릿 리스트 항목 수 = 생성할 Issue 수의 상한선. PM은 항목을 user scenario로 풀어쓰되, 1개 항목 = 1개 Issue 원칙.
- `## 리서치 요약`은 PM이 시나리오 작성 시 컨텍스트로 사용.
- `## 제약/주의사항`은 모든 Issue의 "영향 범위" 작성 시 반영.

---

## 2. Issue 본문 (PM 산출 → DEV 입력)

```markdown
## User Scenario

<단일 시나리오. 1~3문단 자유 서술. "사용자가 X를 한다 → 시스템이 Y로 응답한다" 형태.>

## 수용 기준

- [ ] <검증 가능한 조건 1>
- [ ] <검증 가능한 조건 2>
- ...

## 영향 범위

<선택. 관련 파일/모듈/기능. DEV가 변경 범위를 추정하는 데 사용. 없으면 "TBD" 또는 섹션 생략.>

## 출처 Milestone

#<milestone_number> (PM Agent가 자동 기재)
```

**파싱 규칙 (DEV가 사용)**:
- `## User Scenario`는 구현 목표.
- `## 수용 기준`의 체크리스트는 QA의 검증 항목과 1:1 대응. DEV는 모든 항목을 통과하도록 구현.
- `## 영향 범위`는 변경 범위 추정. 없으면 DEV가 코드베이스 탐색으로 추정.

**파싱 규칙 (QA가 사용)**:
- `## 수용 기준` 체크리스트가 곧 QA 검증 시나리오.

---

## 3. PR 본문 (DEV 산출 → QA 입력)

```markdown
## Closes

Closes #<issue_number>

## 변경 요약

<1~3문단. 무엇을 어떻게 변경했는지.>

## 검증 방법

<선택. QA가 검증할 때 참고할 명령어 또는 절차. 예: `pnpm test src/auth`>

<!-- llm-team:qa-attempts:1 -->
```

**파싱 규칙 (QA가 사용)**:
- `Closes #N`에서 issue 번호를 추출 → Issue 본문의 `## 수용 기준`을 검증 시나리오로 사용.
- `## 변경 요약`은 검증 컨텍스트.
- `## 검증 방법`이 있으면 그것을 우선 실행. 없으면 프로젝트 표준(예: `pnpm test`, `pytest`) 시도.
- 마지막 줄의 `<!-- llm-team:qa-attempts:N -->`로 1차/2차 분기.

**갱신 규칙 (DEV 재작업 시)**:
- DEV가 `qa:changes-requested` Issue를 재픽업해 commit push할 때, PR 본문의 마지막 marker를 `:2`로 갱신.
- `## 변경 요약` 끝에 "### 재작업 (1차 QA 피드백 반영)" 하위 섹션을 append (옵션).

---

## 4. PR 코멘트 (QA 1차 실패 시)

QA가 1차 실패를 통보할 때 PR에 작성하는 코멘트 형식:

```markdown
## QA 검증 실패 (1차)

### 실패한 수용 기준

- [ ] <Issue의 수용 기준 중 실패한 항목들 그대로 옮겨 적기>

### 실패 로그/증거

<로그 발췌, 스크린샷 경로, 명령어 출력 등>

### 재작업 가이드

<DEV가 무엇을 수정해야 하는지 구체적 지시>
```

**갱신 규칙**: QA는 동시에 Issue 라벨을 `qa:in-progress` → `qa:changes-requested`로 atomic 전이.

---

## 5. PR 코멘트 (QA 2차 실패 시)

```markdown
## QA 검증 실패 (2차) — Human Review Required

DEV의 1회 재시도 후에도 검증 실패. 사람의 개입이 필요합니다.

### 1차 실패 요약
<요약 또는 위 1차 코멘트 링크>

### 2차 실패 상세
<로그/증거>

### 권장 조치
<재시작 / scope 변경 / Issue close 등 옵션>
```

**갱신 규칙**: QA는 Issue 라벨을 `qa:in-progress` → `needs-human-review:dev-failure`로 atomic 전이 → Notifier 호출.

---

## 6. Issue 코멘트 (DEV git 실패 시)

```markdown
## DEV git 작업 실패 — Human Review Required

### 실패 종류
<worktree 생성 실패 / 머지 충돌 / push 거부 등>

### 에러 로그
<git 출력>

### 권장 조치
<수동 충돌 해결 / 강제 push / scope 변경 등>
```

**갱신 규칙**: DEV는 Issue 라벨을 `dev:in-progress` → `needs-human-review:dev-failure`로 atomic 전이 → Notifier 호출 → worktree 정리.

---

## 7. Milestone 코멘트 (PO 크래시 회복 시)

```markdown
## PO Agent crashed

Stale 복구 메커니즘이 `po:in-progress` 라벨을 제거했습니다. 다음 PO cron이 같은 입력을 재처리합니다.

- 입력 파일: `inputs/<target>/<filename>.md`
- 마지막 라벨 업데이트: <ISO timestamp>
```

---

## 8. 본 contract의 owner

- 본 문서는 `prompts/{po,pm,dev,qa}.md` 작성 시 **공유 reference**다. 각 prompt는 자기 산출물의 헤딩 구조를 본 문서에 맞춰 출력하도록 지시해야 한다.
- 본 문서를 변경하면 4개 에이전트 prompts를 모두 검토해야 한다.
- 본 contract는 MVP에서 **헤딩 이름·순서만 강제**하고, 본문 자유 서술 길이/스타일은 LLM에 위임한다. 더 엄격한 schema 검증(예: yaml frontmatter)은 후속 spec에서 다룬다.
