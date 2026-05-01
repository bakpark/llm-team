# sub-po-agent — PO Agent (prompt + 진입점)

- **preparation**: sub-common-lib (sub-common-skeleton과는 yaml 스키마 contract만 공유, 산출물 실행 검증은 skeleton의 `targets/myapp.yaml` 필요)
- **대상 파일**:
  - `prompts/po.md`
  - `scheduler/run-po.sh`

## 목표

PO Agent를 구현한다. PO Agent는 `inputs/<target>/*.md` 미처리 파일을 읽어 GitHub Milestone을 생성하고, 사람 승인 게이트로 넘긴다.

## 컨텍스트

- 에이전트 계약: `planning.md` §8.2
- 트리거 조건: `memory/state-machine.md` §4 (PO 행) — **같은 타겟에 open Milestone 0개**가 핵심
- 라벨 전이: `po:in-progress` → `needs-human-review:milestone`
- 산출 본문 구조: `memory/agent-message-contract.md` §1 (Milestone 본문)
- Notifier 호출 시점: `memory/state-machine.md` §7 (kind=`milestone`)
- 1-shot Claude Code 실행 모델: `planning.md` §8.1
- 사용 가능 lib: sub-common-lib이 정의한 `lib/common.sh` 진입점 + 모든 하위 모듈 (`lib/labels.sh`, `lib/config.sh`, `lib/gh.sh`, `lib/notifier.sh`, `lib/markers.sh`, `lib/stale.sh`, `lib/log.sh`)

## 수행 단계

### A. `prompts/po.md` 작성

Claude Code에 1-shot으로 전달될 프롬프트 본문. 최소 다음을 포함한다.

1. **역할 선언** — "당신은 PO Agent다. 입력 아이디어 파일을 리서치하여 GitHub Milestone 1개를 작성한다."
2. **입력 형식 안내** — 입력 파일 경로와 본문이 호출자(`run-po.sh`)에서 placeholder로 주입됨을 명시.
3. **리서치 가이드** — 도메인 배경, 유사 사례, 기술 제약을 조사. (MVP에서는 외부 web fetch 없이 LLM의 사전 지식만 사용 가정.)
4. **출력 contract** — `memory/agent-message-contract.md` §1의 Milestone 본문 구조를 정확히 따라 출력. 헤딩 이름·순서를 본문에 명시적으로 적시.
5. **금지 사항** — Milestone을 직접 생성하지 않는다 (`gh milestone create`는 호출자가 수행). LLM은 본문 markdown만 출력.
6. **출력 형식 강제** — 첫 줄은 `# <Milestone 제목>`, 그 뒤로 §1의 섹션들. 다른 메타 텍스트나 설명 금지.
7. **`## 큰 그림 분해` 항목 수 가이드** — 2~10개 권장. PM이 1개 항목 = 1개 Issue로 분해함을 명시.

### B. `scheduler/run-po.sh` 작성

```
용법: scheduler/run-po.sh <target>
```

1. `set -euo pipefail`, `source lib/common.sh`.
2. `load_target <target>` → env 로드.
3. `log_init po <target>` → 로그 파일 시작.
4. `run_stale_recovery <target>` → stale 복구 inline 실행.
5. **트리거 조건 검사**:
   - `inputs/$TARGET_INPUTS_DIR/*.md` (processed/ 제외) 중 가장 오래된 1개 선택. 없으면 exit 0.
   - `issue_list_open_milestones <repo>` 호출 → 결과가 비어있지 않으면 exit 0 (다른 Milestone이 활성).
6. **Milestone 생성**:
   - `gh milestone create --title "<placeholder>" --description ""`로 빈 Milestone 먼저 생성, 번호 획득.
   - 생성 직후 라벨 `po:in-progress` 부착.
7. **1-shot Claude Code 호출**:
   - prompt 본문 = `prompts/po.md` + 입력 파일 본문을 placeholder 치환.
   - 호출 방법: `claude -p "$prompt" --output-format text` (또는 프로젝트의 표준 CLI invocation. README 또는 sub-common이 정한 표준 명령어).
   - 출력은 markdown. 첫 줄 `# <title>`을 추출해 Milestone 제목을 `gh milestone edit ... --title`로 갱신, 나머지를 `--description`으로 set.
8. **라벨 전이**: `milestone_set_label <repo> <num> --remove po:in-progress --add needs-human-review:milestone` (atomic).
9. **Notifier 호출**: `notify_review_needed <target> milestone <milestone_url> "<제목 + 첫 200자 요약>"`.
10. **입력 파일 이동**: `inputs/<target>/foo.md` → `inputs/<target>/processed/foo.md` (mv).
11. 모든 단계는 try/error 처리. Milestone 생성 후 라벨 부착 실패 시 stale 복구 메커니즘에 위임 (자동 정리 X).

### C. 에러 처리

- `inputs/.../*.md` 0개 → exit 0 (정상).
- open Milestone 존재 → exit 0 (정상).
- gh CLI 실패 → `lib/gh.sh`의 백오프 재시도 활용. 3회 실패 시 cron 종료 (라벨 손대지 않음).
- Claude Code 호출 실패 → Milestone에 코멘트 ("PO claude call failed: <error>") + 라벨은 `po:in-progress` 그대로 (stale 복구가 처리).
- 입력 파일 mv 실패 → 라벨은 이미 `needs-human-review:milestone`이므로 사람 검토 진행됨. mv 실패 로그만 기록 (다음 cron이 같은 입력으로 재실행 시 트리거 조건의 "open Milestone 0개"에서 차단되므로 중복 생성 안 됨).

## 완료 체크리스트

- [ ] `prompts/po.md`가 `memory/agent-message-contract.md` §1 구조를 명시적으로 강제
- [ ] `scheduler/run-po.sh`가 `bash -n` 통과
- [ ] 트리거 조건 3개(미처리 파일 / open Milestone 0개) 모두 검사
- [ ] Milestone 생성 → 라벨 → Claude → 라벨 전이 → Notifier → 파일 이동 순서 준수
- [ ] Notifier 호출이 `kind=milestone`으로 정확
- [ ] 입력 파일 mv 실패가 다음 cron에서 중복 생성을 유발하지 않음 (open Milestone 차단으로)
- [ ] `lib/gh.sh`의 atomic 전이 helper만 사용 (직접 `gh issue edit` 금지)
- [ ] `lib/notifier.sh`만 사용 (직접 webhook 호출 금지)
- [ ] dry-run 옵션 (`--dry-run`)으로 실제 gh/claude 호출 없이 흐름 검증 가능
