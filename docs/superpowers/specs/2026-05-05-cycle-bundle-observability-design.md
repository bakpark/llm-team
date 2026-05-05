# Spec rev2: RW 역할 cycle 영속 관찰성 레이어

**개정 사유 (rev1 → rev2)**: gpt5.5·qwen3.6 외부 리뷰 반영. 핵심 변경은 (a) timeout 은
신규 도입이 아니라 PR #56 이 도입한 경로의 기본값/정책 조정, (b) cycle_bundle 을
registry 의 6번째 정식 port 로 등록, (c) diff 산출물을 6단계로 분리 캡처, (d) cb cleanup
trap 을 cb_open 직후로 끌어올려 모든 early-exit 에서 finalize 보장, (e) abandoned 자동
판정에 pid+lease TTL 사용, (f) ledger row 에 optional `cycle_bundle_ref` 추가, (g) capture
API 를 _text/_file/_stdin 3종으로 분리, (h) cycle_id 의 short8 을 SHA-256 12자 해시로,
(i) umask 077 + 파일 권한 테스트.

**대상 파일 사후 이동**: 본 plan 승인 직후 동일 내용을
`docs/superpowers/specs/2026-05-05-cycle-bundle-observability-design.md` 로 복제·커밋한다.

**기준 트리**: `chore/arch-cross-doc-drift` (PR #56) 가 머지된 상태를 가정. PR #56 이
머지 전이면 본 plan 의 timeout 절은 그 변경을 흡수하는 전제가 된다.

---

## Context

`scheduler/runner.sh` 의 RW 4 역할(Coder, Reviewer, Integrator, QA)이 비대화형 Claude
CLI 를 호출해 task/milestone 작업을 수행하는데, **Coder cycle 단계가 자주 실패한다**는
운영 보고가 있다. 그러나 현재 root-cause 진단 자료는 manifest + ledger row + (debug
플래그 시) stale envelope 만 보존되고, prompt / 정상 envelope / Claude stderr / worktree
상태 / lr 타이밍은 mktemp 로 떴다가 즉시 삭제된다.

또한 PR #56 으로 lr_call 이 `LR_TIMEOUT_SEC` 파라미터를 받게 되었지만, runner 의 기본값이
0 이라 운영에서 timeout 이 꺼진 채로 동작한다. 그래서 `claude -p` hang 시 어떤 cycle
흔적도 남지 않는다.

본 spec 은 **RW 4 역할 모든 cycle 의 진단 자료를 영속 보존**하고, **timeout 기본값을
양수로 전환**해 hang 케이스도 ledger·번들에 잡히도록 한다.

---

## Goals / Non-goals

**Goals**
1. RW 4 역할의 모든 cycle 마다 prompt + envelope + lr_meta + 6개 diff 산출물 + summary 를
   영속 보존.
2. 실패(non-ok ledger row) cycle 은 추가로 diagnostics + worktree-pre 상태까지 풀 보존.
3. ledger ↔ bundle 양방향 추적 (ledger row 에 `cycle_bundle_ref` 필드 추가).
4. `claude -p` hang 을 timeout 으로 강제 종료. 본 spec 은 PR #56 의 기존 timeout 경로의
   **기본값 정책만** 바꾼다 (신규 wrap 도입 아님).
5. 부수 기능이라 cycle 본 흐름은 절대 깨뜨리지 않는다 (graceful degrade + escape hatch).
6. 신규 cycle_bundle port 를 registry 에 정식 등록 (issue_tracker 등과 동일한 1급 시민).

**Non-goals (이번 plan 범위 외)**
- secret/PII redaction. 별도 plan.
- 자동 prune. 별도 CLI plan.
- PO/PM/Planner cycle bundle. 같은 인터페이스로 추후 확장 가능하게만 설계.
- envelope.patch_diff vs worktree 의 진실원 일원화. 본 plan 은 부정합을 **관찰**할 수
  있도록 데이터 6종을 남기는 것까지만 한다 (관찰 결과로 후속 fix plan 도출).

---

## §1. 아키텍처 / 컴포넌트 경계

```
lib/ports/cycle_bundle.sh                 (NEW)
adapters/cycle_bundle/filesystem.sh       (NEW — 운영)
adapters/cycle_bundle/in_memory.sh        (NEW — 테스트)
lib/registry.sh                           (EXTEND — 6번째 port 등록)

lib/ports/workspace.sh                    (EXTEND — ws_diff_head, ws_head_sha,
                                                   ws_diff_range 추가)
adapters/workspace/git_worktree.sh        (EXTEND — 위 3 함수 구현)
adapters/workspace/in_memory.sh           (EXTEND — stub 3 함수)

scheduler/runner.sh                       (HOOKS — cb_open 직후 cleanup trap 설치
                                                   + 4-5 군데 cb_* 호출
                                                   + LR_TIMEOUT_SEC 기본값 변경)
application/caller_dispatch.sh            (EXTEND — applied row 에 cycle_bundle_ref)
scheduler/runner.sh _runner_ledger_write  (EXTEND — cycle_bundle_ref 필드 수용)
```

**timeout 관련**: `adapters/llm_runner/claude_code.sh` 와 `lib/ports/llm_runner.sh` 는
PR #56 변경 그대로 사용. 본 plan 은 **runner.sh 의 LR_TIMEOUT_SEC 기본값 0 → 600** 만
바꾼다 (`LLM_TEAM_LR_TIMEOUT_SEC` env 로 override 유지). macOS 호환은 PR #56 의
fail-fast 정책에 따라 `timeout` 부재 시 exit 66 (adapter_unavailable) → 운영자에게 명시적
경고. macOS 운영자는 `brew install coreutils` 후 `timeout` 이 PATH 에 있어야 함을 README
온보딩 항목에 추가.

### 디렉토리 레이아웃 (filesystem 어댑터)

```
${LLM_TEAM_ROOT}/workdir/<target>/cycles/
    <Role>-<object_id>-<manifest_hash12>/        # mode 0700, umask 077
        pidfile.json            # cb_open 즉시 작성 (pid, hostname,
                                #   started_at, lease_token)
        prompt.txt              # 모든 cycle
        envelope.json           # lr 응답이 있던 경우 (마지막 attempt 승격본)
        lr_meta.json            # 모든 cycle
        diff/
            pre.head            # cb_open 직후 git rev-parse HEAD
            pre.dirty.diff      # cb_open 직후 git diff HEAD (워크스페이스 dirty 여부)
            after-lr.dirty.diff # lr_call 종료 직후 git diff HEAD (Claude 직접 편집)
            applied.diff        # caller_apply_output 후 git diff <pre.head> HEAD
            post.head           # finalize 시 git rev-parse HEAD
            post.dirty.diff     # finalize 시 git diff HEAD (정상이면 빈 파일)
        summary.json            # finalize 시 1회 작성
        # 실패(non-ok) 또는 promote 호출 시 추가:
        diagnostics.txt         # 마지막 attempt 의 Claude stderr
        attempts/               # lr_call B-3 retry 가 1회 이상이었을 때만
            1/envelope.json
            1/diagnostics.txt
            1/lr_meta.json
            2/...
```

**naming 규약**
- `manifest_hash12` = `printf '%s' "${manifest_id}" | shasum -a 256 | cut -c1-12`
  (기존 `scheduler/runner.sh:611`, `application/knowledge.sh:139` 와 동일 컨벤션 — macOS 기본
  + Linux 호환). short8 의
  생일문제(birthday collision: 8 hex = 4 byte ⇒ 약 2^16 cycle 에서 50% 충돌) 를 회피.
  12 hex = 6 byte ⇒ 충돌 확률 <2^-24/cycle.
- `<Role>-<object_id>-<manifest_hash12>` 는 같은 manifest 의 reopen 에서 idempotent.
- 동일 dir 에 다른 manifest_id 가 매핑되는 (12자 충돌) 경우 cb_open 이 pidfile 의
  manifest_id 와 비교해 불일치 감지 → 이름에 `-c2`, `-c3` 카운터 suffix 부여.

---

## §2. 포트 계약 + 데이터 흐름

### 2.1 `lib/ports/cycle_bundle.sh` 필수 함수 + invariants

```
cb_open <cycle_id> <target> <role> <manifest_id> <lease_token>
   stdout: bundle_handle (어댑터별; filesystem 은 절대경로)
   I1 (idempotent open): 같은 cycle_id 에 같은 handle 반환. pidfile.json 의 manifest_id
       와 인자가 다르면 카운터 suffix 부여 후 새 dir 사용.
   I2 (no-op when disabled): LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 이거나 cb_open 의 mkdir
       실패 시 빈 handle 반환 → 이후 cb_* 모두 즉시 return 0.

cb_capture_blob_text <handle> <name> <text>      # 짧은 텍스트
cb_capture_blob_file <handle> <name> <path>      # 파일 복사 (cp -p 보존)
cb_capture_blob_stdin <handle> <name>            # stdin 스트림 (대용량 diff)
   I3 (idempotent re-capture): 같은 name 재호출은 덮어쓰기.
   I4 (atomic write): 임시 파일 → rename. 부분 쓰기로 인한 truncated blob 방지.

cb_capture_attempt <handle> <attempt_idx> <envelope_ref> <diagnostics_ref> <lr_meta_json>
   attempts/<idx>/{envelope.json,diagnostics.txt,lr_meta.json} 작성.

cb_promote_to_full <handle> <reason>
   I5 (additive promote): summary.json 의 failure_reasons[] 에 append. 두 번째 이상
       호출도 idempotent (배열에 누적).
   I6 (preserve once promoted): promote 한 번이라도 호출됐으면 finalize(result=ok)
       이어도 diagnostics/worktree-pre 보존.

cb_finalize <handle> <result> <summary_extra_json>
   result ∈ {ok, error, invalid, stale, abandoned}
   동작:
     1. diff/post.head, diff/post.dirty.diff 캡처 (workspace 어댑터로 위임).
     2. summary.json 작성 (atomic).
     3. result == "ok" 이고 promote 이력 없음 → diagnostics.txt 와 attempts/ 가
        있으면 attempts/ 는 보존 (lr 재시도 분석용)이지만 diagnostics.txt 는 삭제.
        # 이유: 성공 cycle 의 diagnostics 는 보통 빈 파일이거나 noise.
     4. result != "ok" → 필요 시 promote 자동 호출 (I5 확장).
     5. pidfile.json 삭제 (cycle 마감 표식).
   I7 (finalize-once): 같은 handle 에 finalize 두 번 호출 시 두 번째는 no-op (warn).

cb_get_path <handle>            # 테스트/디버깅용
cb_collect_abandoned <target>   # 운영용: pidfile 살아있고 lease 만료된 dir 을
                                # abandoned 로 stamp. 별도 daemon 또는 prune CLI.
```

**abandoned 자동 판정 (rev1 → rev2 변경)**:
- cb_open 시 다른 cycle dir 이 보이면, 그 dir 의 pidfile.json 을 읽어:
  - pid 가 살아있고 (`kill -0 <pid> 2>/dev/null`) lease_token 이 lease 모듈에 등록돼
    있으면 → **건드리지 않음** (concurrent active cycle).
  - pid 가 죽었거나 lease 만료(또는 token 미등록) → summary.json 없으면 abandoned
    stamp.
- **cb_open 자체는 다른 cycle dir 을 절대 수정하지 않는다 — 별도 `cb_collect_abandoned`
  호출자만 수정**. cb_open 이 부수효과로 다른 cycle 에 손대면 race 위험. 일관성 유지.

### 2.2 `lib/ports/workspace.sh` 확장 (3개 함수)

```
ws_diff_head <unit_id>
   stdout: `git diff HEAD` 결과
   rc:     0 (워크스페이스 미존재/git 에러도 빈 stdout + rc 0)

ws_head_sha <unit_id>
   stdout: `git rev-parse HEAD`
   rc:     0 (실패 시 빈 stdout + rc 0)

ws_diff_range <unit_id> <from_sha> [<to_sha=HEAD>]
   stdout: `git diff <from_sha> <to_sha>`
   rc:     0 (실패 시 빈 stdout + rc 0)
```

in_memory 어댑터: 셋 다 빈 출력 stub.

### 2.3 timeout 정책 (PR #56 경로 사용, 기본값만 변경)

- runner.sh:587 의 `LR_TIMEOUT_SEC="${LLM_TEAM_LR_TIMEOUT_SEC:-0}"` 를 **`:-600`** 으로 변경.
- 모든 RW 역할 + plan 역할에 동일 적용 (`LR_TIMEOUT_SEC` 은 cycle context 변수라 역할별
  조정은 차후 확장).
- README 의 운영 가정 섹션에 macOS 의 `timeout` 의존성 명시 (`brew install coreutils`).
- `LLM_TEAM_LR_TIMEOUT_SEC=0` 으로 override 가능 (e.g. 디버깅·로컬). 단 CI 는 양수 강제.

### 2.4 단일 RW 역할 cycle 데이터 흐름 (runner.sh 변경 위치)

```
 STEP                           위치 (origin/main+PR56 기준 라인 근처)
─────────────────────────────────────────────────────────────────────
 ★ A. cycle_id 산출 + cb_open    runner.sh:415 (manifest_validate 직후, ws_ensure 직전)
       cycle_id = "${ROLE}-${TARGET_OBJECT_ID}-$(printf '%s' "${manifest_id}" \
                   | shasum -a 256 | cut -c1-12)"
       handle = "$(cb_open "${cycle_id}" "${TARGET}" "${ROLE}" \
                   "${manifest_id}" "${LEASE_TOKEN:-}")"
 ★ B. cleanup trap 합성          A 직후
       _runner_cycle_cleanup() {
         # 모든 early-exit 에서 호출 보장. result 는 _runner_cycle_result 글로벌 사용.
         cb_finalize "${handle}" "${_runner_cycle_result:-error}" "${_runner_cycle_extra:-{} }"
       }
       trap '_runner_cycle_cleanup; _runner_full_cleanup' EXIT
       # 기존 _runner_full_cleanup (envelope/prompt/lease 정리) 은 그대로 두고
       # 단일 trap 으로 두 함수를 chain. cb_finalize 가 항상 _runner_full_cleanup
       # 보다 먼저 실행돼야 함 (envelope_ref 가 정리되기 전에 attempt 캡처를
       # 보장하기 위함). bash trap 은 같은 신호에 새 핸들러를 설치할 때 기존
       # 핸들러를 자동으로 결합하지 않으므로, 본 plan 은 cb_open 시점에 단일
       # 결합 trap 을 명시적으로 설치한다 (기존 envelope-시점 trap 설치 코드는
       # 제거).
   C. (RW 역할만) pre-snapshot   ws_ensure/ws_refresh 직후
       ws_head_sha "task-${TARGET_OBJECT_ID}" \
         | cb_capture_blob_stdin "${handle}" "diff/pre.head"
       ws_diff_head "task-${TARGET_OBJECT_ID}" \
         | cb_capture_blob_stdin "${handle}" "diff/pre.dirty.diff"
   D. prompt capture             prompt_ref 작성 직후
       cb_capture_blob_file "${handle}" "prompt.txt" "${PROMPT_REF}"
   E. lr_call 루프               기존 retry loop, 각 attempt 마다
       cb_capture_attempt "${handle}" "${LR_ATTEMPT}" \
         "${LR_ENVELOPE_REF}" "${LR_DIAGNOSTICS_REF}" "${LR_META}"
       # LR_EXIT_STATUS != ok 면 promote
       [ "${LR_EXIT_STATUS}" != "ok" ] && cb_promote_to_full "${handle}" \
         "lr:${LR_EXIT_STATUS}:${LR_ERROR_REASON}"
   F. lr 종료 직후 dirty diff    (RW 역할)
       ws_diff_head "task-${TARGET_OBJECT_ID}" \
         | cb_capture_blob_stdin "${handle}" "diff/after-lr.dirty.diff"
   G. caller_apply_output 직후   (RW 역할 + result == ok 인 cycle)
       post_head="$(ws_head_sha "task-${TARGET_OBJECT_ID}")"
       printf '%s' "${post_head}" \
         | cb_capture_blob_stdin "${handle}" "diff/post.head"
       pre_head="$(cat "${handle}/diff/pre.head" 2>/dev/null)"
       if [ -n "${pre_head}" ] && [ -n "${post_head}" ]; then
         ws_diff_range "task-${TARGET_OBJECT_ID}" "${pre_head}" "${post_head}" \
           | cb_capture_blob_stdin "${handle}" "diff/applied.diff"
       fi
   H. 모든 실패 분기              각 ledger error/invalid/stale 작성 직전
       _runner_cycle_result="<해당값>"
       cb_promote_to_full "${handle}" "<reason>"
   I. EXIT trap (B 가 설치)        finalize 자동 호출
       cb_finalize 가 post.dirty.diff 캡처 + summary.json 작성.
```

### 2.5 ledger ↔ bundle 링크 (rev1 → rev2 변경)

- `_runner_ledger_write` 시그니처에 optional 매개변수 `cycle_bundle_ref` 추가 (마지막
  자리; default 빈값).
- ledger row JSON 에 `cycle_bundle_ref` 필드 추가 (값 = bundle dir 의 절대경로 또는
  workdir-상대경로). 빈값이면 필드 자체를 null 로.
- `application/caller_dispatch.sh` 의 applied row 작성 경로도 같은 필드 통과시킴.
- 마이그레이션: ledger 는 JSONL 이라 추가 필드 발행은 backward compat. 기존 row 는
  필드 부재 → 분석 도구가 null 처리.

---

## §3. 에러 / 엣지 케이스 (rev2)

| 상황 | 처리 |
|---|---|
| cb_open mkdir 실패 (디스크/권한) | log_warn + 빈 handle. 이후 cb_* 모두 no-op. cycle 본흐름 정상. |
| 같은 cycle_id 재진입 (lease 회복 / lr 재시도) | 같은 dir 재사용, attempts/ 적층. |
| manifest_hash12 충돌 (다른 manifest_id 가 같은 12자) | pidfile.json manifest_id 비교 → 다르면 카운터 suffix(`-c2`) 부여한 새 dir. |
| **다른 active cycle 의 dir 발견** | pid 살아있고 lease 미만료면 absolute no-touch. 죽었으면 abandoned stamp 는 별도 `cb_collect_abandoned` 가 처리 (cb_open 부수효과 금지). |
| cb_finalize 미호출 (SIGKILL/패닉) | 다음 `cb_collect_abandoned` 실행 시 pidfile.json 의 pid·lease 검증 후 abandoned stamp. |
| cb_promote_to_full 두 번 호출 | summary.json failure_reasons[] 에 append. |
| `timeout` 바이너리 부재 + `LR_TIMEOUT_SEC>0` | PR #56 정책: exit 66 (adapter_unavailable) fail-fast. cycle 은 즉시 실패하지만 bundle 은 prompt + lr_meta + diagnostics(부재 사유) 를 남김. |
| ws_diff_head/ws_head_sha/ws_diff_range 실패 | 빈 stdout + rc 0. bundle 의 해당 파일이 빈 파일이거나 미존재. |
| `LLM_TEAM_CYCLE_BUNDLE_DISABLED=1` | cb_open 빈 handle. cycles/ 미생성. 기존 동작과 100% 동일. |
| prompt/envelope 안의 비밀값 | redaction 미수행 (out-of-scope). 대신 **cycles/ 디렉토리 모두 mode 0700**, **bundle 안 파일 mode 0600**, umask 077. workdir/ 는 이미 .gitignore. README 에 운영 경고. 권한 테스트 케이스 추가. |
| 디스크 무한 증가 | auto-prune 미수행. 후속 plan: `bin/cycle_bundle_prune --older-than Nd`. cb_open 시 cycles/ 의 dir 수가 `LLM_TEAM_CYCLE_BUNDLE_WARN_THRESHOLD:-1000` 초과면 log_warn (안전망). |
| PO/PM/Planner | cb_open 호출 자체 안 함. |
| `date +%s%N` 미지원 (macOS bash 3.x) | `date +%s` fallback. lr_meta.wall_ms=0 허용. |
| ledger row `cycle_bundle_ref` 분석 도구가 부재 인식 | 신규 필드 미존재 = null 로 정상 처리. |

---

## §4. 테스팅 전략 (rev2 — 통합 테스트 케이스 강화)

| 테스트 파일 | 목적 |
|---|---|
| `tests/lib/test-port-cycle_bundle.sh` (NEW) | invariants I1–I7. filesystem + in_memory 어댑터 모두 같은 케이스 통과. **추가 케이스**: (a) abandoned 자동 stamp 가 alive pid 를 보호, (b) manifest_hash12 충돌 시 카운터 suffix, (c) capture_blob_stdin 의 대용량(예: 1MB) 스트림 정상 기록, (d) atomic write — 도중 kill 후 부분 파일 미생성. |
| `tests/adapters/test-cycle_bundle-filesystem.sh` (NEW) | 디렉토리 레이아웃 일치. **권한 테스트**: cycles/<id>/ mode 0700, 파일 mode 0600. mkdir 실패 시 빈 handle. attempts/ 승격. pidfile.json 형식 검증. |
| `tests/adapters/test-cycle_bundle-in_memory.sh` (NEW) | RAM 백엔드 동등 동작 + atomic write 동일 보장. |
| `tests/adapters/test-workspace-git_worktree.sh` (EXTEND) | ws_diff_head / ws_head_sha / ws_diff_range 각 3 케이스 (정상 / dirty / 부재). |
| `tests/lib/test-registry.sh` (EXTEND) | cycle_bundle 이 `registry_load_default` 의 6번째 port 로 로드되고 `LLM_TEAM_ADAPTER_CYCLE_BUNDLE` env 로 override 가능. 누락 함수 시 verify 실패. |
| `tests/scheduler/test-runner-cycle-bundle.sh` (NEW) | **6 통합 케이스**: (1) 성공 슬림 — RW 4 역할 각각 성공 cycle 후 6개 diff 파일 + summary.json 존재, diagnostics.txt 부재. (2) invalid envelope — diagnostics + worktree-pre 풀 보존, summary.failure_reasons 비어있지 않음. (3) **lr retry 적층** — fake adapter 가 attempt 1 fail → attempt 2 ok 시 attempts/1, attempts/2 둘 다 존재 + 최상위 envelope.json = attempt 2. (4) **EXIT trap finalize** — 강제 SIGTERM 시뮬레이션 후 다음 cycle 의 cb_collect_abandoned 가 abandoned stamp. (5) **applied.diff vs envelope.patch_diff 부정합 관찰** — Coder 가 envelope 와 다른 추가 편집을 했을 때 after-lr.dirty.diff 와 envelope.patch_diff 의 차이가 bundle 에 캡처. (6) DISABLED=1 → cycles/ 미생성. |
| `tests/scheduler/test-runner-ledger-bundle-ref.sh` (NEW) | applied / error / invalid / stale row 모두에 cycle_bundle_ref 필드 존재 + 경로 유효. |
| 기존 회귀 | `test-runner-cwd`, `test-runner-pipeline`, `test-agent-workspace`, `test-port-conformance`, `tests/e2e/full-flow.sh`, `tests/lib/test-registry.sh` 모두 통과 (기존 + 신규 케이스). |

---

## 검증 (수동 end-to-end)

1. PR #56 머지 가정 후 `LLM_TEAM_LR_TIMEOUT_SEC=600` 으로 1 cycle 실행 →
   `workdir/llm-team/cycles/Coder-<id>-<hash12>/` 에 prompt + envelope + lr_meta + diff/* 6종 + summary 존재. mode 0700 / 0600 확인.
2. envelope 강제 invalid (fake adapter) → 같은 dir 에 diagnostics.txt + diff/pre.dirty.diff 보존, summary.failure_reasons 길이 ≥ 1.
3. `LLM_TEAM_CLAUDE_CMD='bash -c "sleep 999"' LLM_TEAM_LR_TIMEOUT_SEC=2` →
   2초 후 exit 124 → ledger row `result=error reason=timeout` + `cycle_bundle_ref` 필드 존재 + bundle 의 lr_meta.json `exit_status=timeout`.
4. `LLM_TEAM_CYCLE_BUNDLE_DISABLED=1` 1 사이클 → `cycles/` 미생성.
5. ledger ↔ bundle join: `jq '.cycle_bundle_ref' workdir/llm-team/ledger/*.jsonl | sort -u` 로 모든 bundle 경로 enumerable.
6. `bin/cycle_bundle_prune --older-than 14d --dry-run` (후속 plan) 으로 abandoned + 정상 cycle 분류.

---

## 주요 변경 파일

수정:
- `scheduler/runner.sh` — A·B·C·D·E·F·G·H 단계 hook + LR_TIMEOUT_SEC 기본 600 + _runner_ledger_write 시그니처 확장.
- `application/caller_dispatch.sh` — applied row 에 cycle_bundle_ref 통과.
- `lib/ports/workspace.sh` — ws_diff_head / ws_head_sha / ws_diff_range 등록.
- `adapters/workspace/git_worktree.sh` — 3 함수 구현.
- `adapters/workspace/in_memory.sh` — stub.
- `lib/registry.sh` — cycle_bundle 6번째 port 로 등록.

신규:
- `lib/ports/cycle_bundle.sh`
- `adapters/cycle_bundle/filesystem.sh`
- `adapters/cycle_bundle/in_memory.sh`
- `tests/lib/test-port-cycle_bundle.sh`
- `tests/adapters/test-cycle_bundle-filesystem.sh`
- `tests/adapters/test-cycle_bundle-in_memory.sh`
- `tests/scheduler/test-runner-cycle-bundle.sh`
- `tests/scheduler/test-runner-ledger-bundle-ref.sh`
- `docs/superpowers/specs/2026-05-05-cycle-bundle-observability-design.md` (본 문서 복제)

총량 추정: 신규 코드 ~700 라인 + 테스트 ~600 라인 + 문서 1건 (rev1 대비 +200 라인,
주로 통합 테스트 케이스와 abandoned/registry/diff 6종 처리 때문).

---

## 다음 단계

1. ExitPlanMode 로 본 spec 승인.
2. 같은 내용을 `docs/superpowers/specs/2026-05-05-cycle-bundle-observability-design.md` 에 복제·커밋.
3. `superpowers:writing-plans` 로 단계별 구현 plan 산출.
4. 구현 순서: 포트 계약 테스트 → in_memory 어댑터 → filesystem 어댑터 → workspace 확장 → registry 등록 → runner LR_TIMEOUT 기본값 변경 → runner cb_* 훅 → ledger cycle_bundle_ref → 통합 테스트 → e2e.
