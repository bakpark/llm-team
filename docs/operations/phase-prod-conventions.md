# phase-prod-* Branch / Commit / PR 규약

phase-prod-0 ~ phase-prod-6 의 cycle 단위 브랜치/커밋/PR 명명 규약. phase-pipeline skill 이 본 문서를 cycle bootstrap 시 참조한다.

## Branch

```
feat/phase-prod-<N>-<short-slug>
```

- `<N>` — phase-prod 번호 (0 ~ 6).
- `<short-slug>` — kebab-case 4 단어 이내 (예: `scope-cleanup`, `healthcheck-stage1`).

## Commit prefix

| 종류 | prefix |
|---|---|
| feature / 신규 산출물 | `feat(phase-prod-<N>):` |
| 버그 수정 | `fix(phase-prod-<N>):` |
| 리팩토링 | `refactor(phase-prod-<N>):` |

본문은 기존 commit (예: `ea4b2e6`) 양식을 따라 `산출:` / `검증:` 섹션 권장.

## PR title

```
feat(phase-prod-<N>): <one-line summary>
```

PR body 는 `## Summary` / `## 구현` / `## 테스트` / `## Gate` 섹션 사용. 마지막 줄에 planning 문서 tracking 메타데이터 명시 (GitHub closing syntax 아님 — `.human/` 은 gitignored 로컬 plan 참조용):

```
Tracking: phase-prod-<N> per local plan (`.human/draft/2026-05-09-production-implementation-phases.md`, gitignored).
```

## phase-pipeline skill 결합

본 문서는 phase-pipeline skill 의 자동 pre-flight 탐지 대상이 아니라 **수동 참조용 운영 규약**이다. cycle 시작 시 사용자가 본 문서를 명시적으로 참조하거나, skill 이 git log / 직전 PR 의 prefix 패턴 (`feat(phase-prod-<N>):`) 으로 phase-prod cycle 임을 자동 매칭한다. planning 문서 (`.human/draft/2026-05-09-production-implementation-phases.md`) 의 해당 phase 절은 사용자가 수동으로 발췌해 phase-implementer 로 위임한다.
