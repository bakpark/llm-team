# sub-common-skeleton — 디렉토리 골격 + targets/yaml + sample input + 문서

- **preparation**: 없음
- **대상 파일**:
  - 디렉토리: `targets/`, `prompts/`, `inputs/myapp/processed/`, `scheduler/`, `lib/`, `workdir/`, `scripts/`, `docs/superpowers/specs/` (각 디렉토리에 필요시 `.gitkeep`)
  - 골격 파일: `.gitignore`, `README.md`, `.env.example`
  - 예제: `targets/myapp.yaml`, `inputs/myapp/auth.md`
- **건드리지 않는 파일**: `lib/`, `scripts/bootstrap-labels.sh` (sub-common-lib 담당) / `prompts/`, `scheduler/run-*.sh` (Phase 2)

## 목표

프레임워크의 디렉토리 골격, 운영 문서, 예제 타겟 설정을 제공한다. sub-common-lib과 독립적으로 진행 가능하며, 산출물의 yaml 키는 `planning.md` §3.2 스키마를 정확히 따라 sub-common-lib의 `lib/config.sh` export 변수와 자동 정합한다.

## 컨텍스트

- 디렉토리 구조: `planning.md` §3.1
- targets/yaml 스키마 (반드시 정확히 따름): `planning.md` §3.2
- 비밀 관리 원칙: `planning.md` §3.4 (yaml에는 ref 키만)
- cron 주기: `planning.md` §5.4
- MVP 통과 시나리오의 입력: `planning.md` §10 — `inputs/myapp/auth.md` 1개

## 수행 단계

### A. 디렉토리 골격

1. 8개 디렉토리 생성: `targets/`, `prompts/`, `inputs/myapp/processed/`, `scheduler/`, `lib/`, `workdir/`, `scripts/`, `docs/superpowers/specs/`. 각 디렉토리가 git에서 추적되도록 빈 디렉토리에는 `.gitkeep` 추가 (단, `workdir/`는 gitignore되므로 `.gitkeep` 불필요).
2. 기존 파일 보존: `spec.md`, `.plan/` 디렉토리는 그대로.

### B. .gitignore

3. `.gitignore` 작성:
   ```
   # 워크스페이스 (DEV/QA worktree, 로그)
   workdir/

   # 비밀
   .env
   .env.local
   *.local

   # macOS
   .DS_Store
   ```

### C. .env.example

4. `.env.example` 작성 — 키 형식 예시:
   ```
   # GitHub 토큰 (gh CLI가 권한을 가진 PAT)
   GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

   # Notifier webhooks (targets/<name>.yaml의 webhook_or_id가 참조하는 키)
   DISCORD_WEBHOOK_MYAPP=https://discord.com/api/webhooks/...
   SLACK_WEBHOOK_MYAPP=https://hooks.slack.com/services/...
   ```
   주석으로 "실제 키는 `.env`에 복사 후 채워 넣을 것" 안내.

### D. 예제 타겟 yaml

5. `targets/myapp.yaml` 작성 — `planning.md` §3.2 스키마를 정확히 따름:
   ```yaml
   name: myapp
   github:
     owner: bakparkbj
     repo: myapp
     default_branch: main
   local:
     clone_path: ~/dev/myapp
   inputs_dir: inputs/myapp
   labels:
     prefix: ""
   notifier:
     channel: none           # MVP 검증 시 none으로 두면 webhook 없이 동작
     webhook_or_id: DISCORD_WEBHOOK_MYAPP
   dev_concurrency: 3
   stale_threshold_minutes: 60
   enabled: true
   ```
   **중요**: 키 이름은 `planning.md` §3.2와 정확히 일치해야 함 (sub-common-lib의 `lib/config.sh` export 변수가 이 키를 읽음).

### E. 샘플 입력

6. `inputs/myapp/auth.md` 작성 — MVP 통과 시나리오용 1~2문단 분량의 실제처럼 보이는 아이디어. 예시:
   ```markdown
   # 사용자 로그인 기능 추가

   현재 myapp은 익명 사용자만 지원한다. 사용자별 데이터를 저장하고
   불러올 수 있도록 로그인 기능을 추가하고 싶다.

   - 이메일/비밀번호 로그인
   - Google OAuth 로그인 (선택)
   - 세션 유지 24시간

   기존 데이터 모델에 user_id를 어떻게 추가할지, 마이그레이션
   전략까지 함께 검토 필요.
   ```

### F. README

7. `README.md` 작성 — 사용자 관점의 운영 문서. 다음 섹션 포함:

   **개요** — `planning.md` §1~§2 1문단 요약 + 다이어그램 발췌 (단순화).

   **요구사항** — `gh` CLI (인증 완료), `git`, `jq`, `yq`. macOS 기준 설치 명령어.

   **새 타겟 등록 절차** — 4단계:
   1. `targets/<name>.yaml` 작성 (스키마 = `targets/myapp.yaml` 참고).
   2. `cp .env.example .env` 후 토큰/webhook 채우기.
   3. `scripts/bootstrap-labels.sh <name>` 실행 → 12개 라벨 생성.
   4. `inputs/<name>/` 디렉토리에 아이디어 markdown 추가.

   **cron 등록 예시** (`planning.md` §5.4 주기):
   ```
   */10 * * * * cd /path/to/llm-team && scheduler/run-po.sh myapp >> workdir/myapp/logs/po-cron.log 2>&1
   */5  * * * * cd /path/to/llm-team && scheduler/run-pm.sh myapp >> workdir/myapp/logs/pm-cron.log 2>&1
   */2  * * * * cd /path/to/llm-team && scheduler/run-dev.sh myapp >> workdir/myapp/logs/dev-cron.log 2>&1
   */2  * * * * cd /path/to/llm-team && scheduler/run-qa.sh myapp >> workdir/myapp/logs/qa-cron.log 2>&1
   ```
   다중 타겟이면 각 타겟별로 4줄 추가. 또는 `lib/config.sh`의 `list_active_targets`를 순회하는 wrapper 권장.

   **사람 승인 게이트 안내** — `needs-human-review:*` 라벨이 붙으면 GitHub web에서 본문 검토 후 다음 라벨로 수동 교체:
   - `needs-human-review:milestone` → `needs-scenarios`
   - `needs-human-review:scenario` → `needs-dev`
   - `needs-human-review:dev-failure` → 수동 처리 (재시작/scope 변경/close)

   **로그 위치** — `workdir/<target>/logs/`.

   **MVP 통과 시나리오** — `planning.md` §10 또는 `sub-e2e-verification.md` 참조 안내.

### G. 검증

8. `git status`로 모든 디렉토리/파일이 추적 가능한지 확인 (`.gitkeep` 누락 없음).
9. `yq '.github.owner' targets/myapp.yaml` 같은 명령으로 yaml 파싱 가능 확인 (yq 설치 전제).
10. README의 cron 예시가 실제로 cron 형식을 충족하는지 시각 검토.

## 완료 체크리스트

- [ ] 8개 디렉토리 생성됨 (`.gitkeep`으로 모두 git 추적 가능)
- [ ] `.gitignore`가 `workdir/`, `.env`, macOS 잡파일 처리
- [ ] `.env.example`이 GH_TOKEN + 적어도 1개 webhook 예시 포함
- [ ] `targets/myapp.yaml`이 `planning.md` §3.2 스키마와 정확히 일치 (모든 키 존재)
- [ ] `targets/myapp.yaml`의 `notifier.channel: none` (MVP 검증을 webhook 없이 가능하게)
- [ ] `targets/myapp.yaml`의 `notifier.webhook_or_id`가 `.env.example`의 키 이름을 ref로 사용
- [ ] `inputs/myapp/auth.md`가 1~2문단 분량 실제처럼 보이는 아이디어
- [ ] `README.md`가 요구사항/등록 절차/cron 예시/사람 승인 게이트/로그 위치 모두 포함
- [ ] README의 cron 예시 4줄이 `planning.md` §5.4 주기(10/5/2/2분)와 일치
- [ ] 모든 산출물이 sub-common-lib과 독립적으로 verify 가능 (yaml 키만 정합 contract)
