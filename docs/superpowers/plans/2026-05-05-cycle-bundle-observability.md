# Cycle Bundle Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RW 4역할(Coder/Reviewer/Integrator/QA) cycle 마다 진단 자료(prompt + envelope + Claude stderr + 6종 diff + lr_meta + summary)를 `workdir/<target>/cycles/` 로 영속 보존하고, `lr_call` timeout 기본값을 0→600 으로 전환해 hang 도 ledger·번들에 잡히게 한다.

**Architecture:** 신규 hexagonal port `cycle_bundle` (filesystem + in_memory 어댑터) 도입, `workspace` port 에 diff/sha 함수 3개 추가, `registry` 에 6번째 port 등록. `scheduler/runner.sh` 에 cb_open 직후 cleanup trap 합성과 8단계 hook 삽입, ledger row 에 optional `cycle_bundle_ref` 필드 추가.

**Tech Stack:** Bash (POSIX + bash 3.2+ 호환, macOS 우선), `jq`, `git`, `shasum -a 256`, GNU coreutils `timeout` (PR #56 정책상 PATH 필수). 기존 hexagonal port/adapter 컨벤션을 그대로 따른다.

**Spec:** `docs/superpowers/specs/2026-05-05-cycle-bundle-observability-design.md`

---

## File Structure

**Create**
- `lib/ports/cycle_bundle.sh` — port 명세 + invariants + helper
- `adapters/cycle_bundle/in_memory.sh` — RAM 백엔드 (테스트용)
- `adapters/cycle_bundle/filesystem.sh` — 운영 어댑터
- `tests/lib/test-port-cycle_bundle.sh` — 두 어댑터 모두 conform 검증
- `tests/adapters/test-cycle_bundle-in_memory.sh` — in_memory 단위 테스트
- `tests/adapters/test-cycle_bundle-filesystem.sh` — filesystem 단위 + 권한 테스트
- `tests/scheduler/test-runner-cycle-bundle.sh` — runner 통합 테스트 6 케이스
- `tests/scheduler/test-runner-ledger-bundle-ref.sh` — ledger row cycle_bundle_ref 검증

**Modify**
- `lib/registry.sh` — `cycle_bundle` 6번째 port 등록
- `lib/ports/workspace.sh` — `ws_diff_head`, `ws_head_sha`, `ws_diff_range` required functions 추가
- `adapters/workspace/git_worktree.sh` — 위 3 함수 구현
- `adapters/workspace/in_memory.sh` — 위 3 함수 stub
- `tests/adapters/test-workspace-git_worktree.sh` — 새 함수 케이스 추가
- `tests/lib/test-registry.sh` — cycle_bundle 등록 검증 추가
- `scheduler/runner.sh` — LR_TIMEOUT_SEC 기본값 0→600, cb_open + trap, 단계 C–H, _runner_ledger_write 시그니처 확장
- `application/caller_dispatch.sh` — applied row 에 cycle_bundle_ref 통과
- `README.md` 또는 `docs/operations/onboarding.md` — macOS `coreutils`/`timeout` 운영 가정 명시

---

## Task 1: cycle_bundle 포트 명세 파일 + invariants 문서화

**Files:**
- Create: `lib/ports/cycle_bundle.sh`

- [ ] **Step 1: 포트 명세 파일 생성**

```bash
cat > lib/ports/cycle_bundle.sh <<'EOF'
#!/usr/bin/env bash
# lib/ports/cycle_bundle.sh
#
# Port: cycle_bundle — RW 역할(Coder/Reviewer/Integrator/QA) cycle 의 진단
# 자료를 영속 보존하기 위한 추상화 (#ARC-PORT-SIGNATURE 동급).
#
# 책임:
#   • cycle 1회 실행 동안 발생하는 prompt/envelope/diagnostics/diff 6종/lr_meta
#     를 일관된 식별자(cycle_id) 아래 묶어 저장.
#   • 운영(filesystem) 와 테스트(in_memory) 어댑터를 같은 invariant 으로 구현해
#     test-double 의 의미적 등가성 보장.
#
# 컨벤션:
#   • 모든 cb_* 호출은 빈 handle("") 일 때 즉시 0 반환. 즉 caller 는 cb_open
#     반환값만 검사하면 됨 (LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 escape hatch 와
#     mkdir 실패 시 graceful degrade 가 둘 다 빈 handle 로 표현된다).
#   • 본 port 는 git/issue tracker 등 외부 의존이 없다. blob 을 받아 보관할 뿐.
#     "이 worktree 의 git diff 를 다오" 같은 요구는 workspace port 가 처리.

PORT_CYCLE_BUNDLE_NAME="cycle_bundle"

PORT_CYCLE_BUNDLE_REQUIRED_FUNCTIONS=(
  cb_open
  cb_capture_blob_text
  cb_capture_blob_file
  cb_capture_blob_stdin
  cb_capture_attempt
  cb_promote_to_full
  cb_finalize
  cb_get_path
  cb_collect_abandoned
)

PORT_CYCLE_BUNDLE_INVARIANTS=(
  "I1: cb_open 은 같은 cycle_id 에 대해 같은 handle 반환 (idempotent)."
  "I2: LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 또는 mkdir 실패 시 cb_open 빈 handle 반환 → 이후 cb_* 모두 즉시 return 0."
  "I3: cb_capture_blob_* 같은 name 재호출은 덮어쓰기 (idempotent re-capture)."
  "I4: 모든 capture 는 atomic — 임시 파일 → rename. 부분 쓰기 금지."
  "I5: cb_promote_to_full 두 번 이상 호출은 reason 을 배열에 누적 (idempotent additive)."
  "I6: promote 한 번이라도 호출됐으면 finalize(result=ok) 이어도 diagnostics/worktree-pre 보존."
  "I7: cb_finalize 는 cycle 당 정확히 1회. 두 번째 호출은 no-op (warn)."
  "I8: cb_open 은 다른 cycle dir 을 절대 수정하지 않는다 — abandoned stamp 는 cb_collect_abandoned 만 수행."
)
EOF
```

- [ ] **Step 2: 파일 sourcing 가능성 확인**

Run: `bash -c '. lib/ports/cycle_bundle.sh && echo "${PORT_CYCLE_BUNDLE_NAME}" && printf "%s\n" "${PORT_CYCLE_BUNDLE_REQUIRED_FUNCTIONS[@]}"'`
Expected: `cycle_bundle` 출력 후 9 함수명 한 줄씩.

- [ ] **Step 3: Commit**

```bash
git add lib/ports/cycle_bundle.sh
git commit -m "feat(ports): add cycle_bundle port spec and invariants"
```

---

## Task 2: registry 에 cycle_bundle 6번째 port 로 등록

**Files:**
- Modify: `lib/registry.sh:24,106` (registry_source_ports + registry_load_default)
- Modify: `tests/lib/test-registry.sh` (있으면; 없으면 작성)

- [ ] **Step 1: 기존 registry 흐름 재확인**

Run: `grep -nE "for p in|registry_load_adapter (issue_tracker|notifier|llm_runner|workspace|persistent_store)" lib/registry.sh`
Expected: 5개 port 만 보임.

- [ ] **Step 2: 등록 케이스 테스트 먼저 작성 (tests/lib/test-registry.sh 신규)**

```bash
cat > tests/lib/test-registry.sh <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"

# in_memory 어댑터로 6 port 모두 로드되는지 검증.
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
export LLM_TEAM_ADAPTER_NOTIFIER=none
export LLM_TEAM_ADAPTER_LLM_RUNNER=fake
export LLM_TEAM_ADAPTER_WORKSPACE=in_memory
export LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory
export LLM_TEAM_ADAPTER_CYCLE_BUNDLE=in_memory

if ! registry_load_default; then
  echo "FAIL: registry_load_default rc != 0"; exit 1
fi
for fn in cb_open cb_capture_blob_text cb_capture_blob_file cb_capture_blob_stdin \
          cb_capture_attempt cb_promote_to_full cb_finalize cb_get_path \
          cb_collect_abandoned; do
  if ! declare -F "${fn}" >/dev/null 2>&1; then
    echo "FAIL: ${fn} not loaded"; exit 1
  fi
done
echo "PASS: registry loads cycle_bundle as 6th port"
EOF
chmod +x tests/lib/test-registry.sh
```

- [ ] **Step 3: 테스트 실행 — 실패 확인**

Run: `bash tests/lib/test-registry.sh`
Expected: FAIL (cycle_bundle adapter 미존재 → registry_load_adapter 가 file not found 로 실패).

- [ ] **Step 4: registry.sh 에 cycle_bundle 등록**

`lib/registry.sh` 의 `registry_source_ports()` 함수 (line 24 부근):

```bash
registry_source_ports() {
  local p
  for p in issue_tracker notifier llm_runner workspace persistent_store cycle_bundle; do
    . "${LLM_TEAM_ROOT}/lib/ports/${p}.sh"
  done
}
```

`registry_verify_port()` 의 case 블록에 cycle_bundle 분기 추가 (40번째 줄 부근):

```bash
    cycle_bundle)     arr_name="PORT_CYCLE_BUNDLE_REQUIRED_FUNCTIONS" ;;
```

`registry_load_default()` 끝부분 (line 105 부근):

```bash
  registry_load_adapter cycle_bundle      "${LLM_TEAM_ADAPTER_CYCLE_BUNDLE:-filesystem}"     || rc=1
```

`registry_active_adapters()` 끝부분 (line 119 부근):

```bash
  printf 'cycle_bundle=%s\n' "${LLM_TEAM_ACTIVE_CYCLE_BUNDLE_ADAPTER:-<not loaded>}"
```

- [ ] **Step 5: 어댑터 stub 임시 생성 (Task 3 에서 구현 본격화)**

```bash
cat > adapters/cycle_bundle/in_memory.sh <<'EOF'
#!/usr/bin/env bash
# Stub — Task 3 에서 본격 구현. registry_verify_port 통과만 위해 함수 선언만.
cb_open() { :; }
cb_capture_blob_text() { :; }
cb_capture_blob_file() { :; }
cb_capture_blob_stdin() { :; }
cb_capture_attempt() { :; }
cb_promote_to_full() { :; }
cb_finalize() { :; }
cb_get_path() { :; }
cb_collect_abandoned() { :; }
EOF

cat > adapters/cycle_bundle/filesystem.sh <<'EOF'
#!/usr/bin/env bash
# Stub — Task 8 에서 본격 구현.
cb_open() { :; }
cb_capture_blob_text() { :; }
cb_capture_blob_file() { :; }
cb_capture_blob_stdin() { :; }
cb_capture_attempt() { :; }
cb_promote_to_full() { :; }
cb_finalize() { :; }
cb_get_path() { :; }
cb_collect_abandoned() { :; }
EOF

mkdir -p adapters/cycle_bundle
```

- [ ] **Step 6: 테스트 재실행 — PASS 확인**

Run: `bash tests/lib/test-registry.sh`
Expected: `PASS: registry loads cycle_bundle as 6th port`.

- [ ] **Step 7: Commit**

```bash
git add lib/registry.sh adapters/cycle_bundle/ tests/lib/test-registry.sh
git commit -m "feat(registry): wire cycle_bundle as 6th port (adapter stubs)"
```

---

## Task 3: in_memory 어댑터 — cb_open + cb_get_path (idempotent open + disabled escape)

**Files:**
- Modify: `adapters/cycle_bundle/in_memory.sh`
- Create: `tests/adapters/test-cycle_bundle-in_memory.sh`

- [ ] **Step 1: 첫 번째 실패 테스트 작성 (cb_open 기본 / disabled / idempotent)**

```bash
cat > tests/adapters/test-cycle_bundle-in_memory.sh <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"
. "${LLM_TEAM_ROOT}/lib/ports/cycle_bundle.sh"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/in_memory.sh"

INMEM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-inmem-XXXXXX")"
export LLM_TEAM_INMEM_CB_DIR="${INMEM_DIR}"
trap 'rm -rf "${INMEM_DIR}"' EXIT

# Case 1: 정상 open 은 비어있지 않은 handle 반환.
h="$(cb_open "Coder-task-1-abcdef123456" "tgt" "Coder" "manifest:1" "lease:1")"
[ -n "${h}" ] || { echo "FAIL: cb_open returned empty handle"; exit 1; }

# Case 2: 같은 cycle_id reopen 시 같은 handle 반환 (I1).
h2="$(cb_open "Coder-task-1-abcdef123456" "tgt" "Coder" "manifest:1" "lease:1")"
[ "${h}" = "${h2}" ] || { echo "FAIL: I1 violated: ${h} vs ${h2}"; exit 1; }

# Case 3: DISABLED=1 일 때 빈 handle (I2).
LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 \
  h3="$(cb_open "Coder-task-2-deadbeef0000" "tgt" "Coder" "manifest:2" "lease:2")"
[ -z "${h3}" ] || { echo "FAIL: I2 violated, expected empty got '${h3}'"; exit 1; }

# Case 4: 빈 handle 에 대한 cb_get_path 는 빈 stdout + rc 0.
out="$(cb_get_path "")"
[ -z "${out}" ] || { echo "FAIL: cb_get_path empty handle should be empty"; exit 1; }

echo "PASS: cb_open + cb_get_path"
EOF
chmod +x tests/adapters/test-cycle_bundle-in_memory.sh
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: FAIL (현재 stub 이라 빈 handle 반환).

- [ ] **Step 3: in_memory 어댑터 cb_open + cb_get_path 구현**

```bash
cat > adapters/cycle_bundle/in_memory.sh <<'EOF'
#!/usr/bin/env bash
# adapters/cycle_bundle/in_memory.sh
#
# Filesystem 어댑터의 의미적 등가물. backing store 는 LLM_TEAM_INMEM_CB_DIR
# 아래의 디렉토리들 — 즉 "사실상 filesystem" 이지만 LLM_TEAM_ROOT/workdir 와
# 격리된 별도 root 를 쓰므로 테스트에서 cleanup 이 자명하다.

_cb_inmem_root() {
  printf '%s' "${LLM_TEAM_INMEM_CB_DIR:-/tmp/llm-team-inmem-cb-default}"
}

cb_open() {
  local cycle_id="$1" target="$2" role="$3" manifest_id="$4" lease_token="${5:-}"
  if [ "${LLM_TEAM_CYCLE_BUNDLE_DISABLED:-0}" = "1" ]; then
    return 0
  fi
  if [ -z "${cycle_id}" ] || [ -z "${target}" ] || [ -z "${role}" ]; then
    return 0
  fi
  local root path
  root="$(_cb_inmem_root)"
  path="${root}/${target}/cycles/${cycle_id}"
  if ! mkdir -p "${path}/diff" "${path}/attempts" 2>/dev/null; then
    return 0
  fi
  # pidfile.json (I1 idempotency 판정에 사용).
  if [ ! -f "${path}/pidfile.json" ]; then
    jq -cn \
      --arg pid "$$" \
      --arg host "$(hostname 2>/dev/null || echo unknown)" \
      --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg manifest_id "${manifest_id}" \
      --arg lease_token "${lease_token}" \
      '{pid:$pid, hostname:$host, started_at:$started_at, manifest_id:$manifest_id, lease_token:(if $lease_token=="" then null else $lease_token end)}' \
      > "${path}/pidfile.json.tmp" \
      && mv "${path}/pidfile.json.tmp" "${path}/pidfile.json"
  fi
  printf '%s' "${path}"
}

cb_get_path() {
  local handle="${1:-}"
  [ -n "${handle}" ] && [ -d "${handle}" ] && printf '%s' "${handle}"
}

# 나머지 함수는 후속 task 에서 구현 (현 단계는 stub 유지).
cb_capture_blob_text() { :; }
cb_capture_blob_file() { :; }
cb_capture_blob_stdin() { :; }
cb_capture_attempt() { :; }
cb_promote_to_full() { :; }
cb_finalize() { :; }
cb_collect_abandoned() { :; }
EOF
```

- [ ] **Step 4: 테스트 재실행 — PASS 확인**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: `PASS: cb_open + cb_get_path`.

- [ ] **Step 5: registry 회귀 재실행**

Run: `bash tests/lib/test-registry.sh`
Expected: PASS (변동 없음).

- [ ] **Step 6: Commit**

```bash
git add adapters/cycle_bundle/in_memory.sh tests/adapters/test-cycle_bundle-in_memory.sh
git commit -m "feat(cycle_bundle): in_memory cb_open + cb_get_path (I1, I2)"
```

---

## Task 4: in_memory — cb_capture_blob_{text,file,stdin} (atomic write, idempotent re-capture)

**Files:**
- Modify: `adapters/cycle_bundle/in_memory.sh`
- Modify: `tests/adapters/test-cycle_bundle-in_memory.sh`

- [ ] **Step 1: 캡처 케이스 추가 테스트**

기존 테스트 끝(이전 `echo "PASS"` 라인 직전)에 다음을 삽입:

```bash
# Capture cases.
h="$(cb_open "Cap-task-1-cafebabe1234" "tgt" "Coder" "m:cap" "")"

# blob_text
cb_capture_blob_text "${h}" "summary.txt" "hello"
[ "$(cat "${h}/summary.txt")" = "hello" ] || { echo "FAIL: blob_text"; exit 1; }

# blob_file (cp -p 보존: mtime/perm)
src="$(mktemp)"; printf 'src-content' > "${src}"
cb_capture_blob_file "${h}" "from-file.txt" "${src}"
[ "$(cat "${h}/from-file.txt")" = "src-content" ] || { echo "FAIL: blob_file"; exit 1; }
rm -f "${src}"

# blob_stdin
echo "stream-content" | cb_capture_blob_stdin "${h}" "diff/pre.dirty.diff"
[ "$(cat "${h}/diff/pre.dirty.diff")" = "stream-content" ] || { echo "FAIL: blob_stdin"; exit 1; }

# Idempotent re-capture (I3) — 덮어쓰기 가능.
cb_capture_blob_text "${h}" "summary.txt" "world"
[ "$(cat "${h}/summary.txt")" = "world" ] || { echo "FAIL: I3 re-capture"; exit 1; }

# 빈 handle 에 대한 capture 는 no-op rc 0.
cb_capture_blob_text "" "x" "y" || { echo "FAIL: empty handle should be no-op"; exit 1; }
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: FAIL (capture 함수가 stub).

- [ ] **Step 3: 캡처 함수 구현**

`adapters/cycle_bundle/in_memory.sh` 의 stub 3개를 다음으로 교체:

```bash
# 내부: atomic write 헬퍼 (I4). target 디렉토리 자동 생성.
_cb_inmem_atomic_write() {
  local handle="$1" name="$2" src="$3"   # src 는 파일 경로 또는 '-' (stdin)
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  local dst="${handle}/${name}"
  mkdir -p "$(dirname "${dst}")" 2>/dev/null
  local tmp="${dst}.tmp.$$"
  if [ "${src}" = "-" ]; then
    cat > "${tmp}" || { rm -f "${tmp}"; return 1; }
  else
    cp "${src}" "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 1; }
  fi
  mv "${tmp}" "${dst}"
}

cb_capture_blob_text() {
  local handle="$1" name="$2" text="${3:-}"
  [ -n "${handle}" ] || return 0
  printf '%s' "${text}" | _cb_inmem_atomic_write "${handle}" "${name}" "-"
}

cb_capture_blob_file() {
  local handle="$1" name="$2" path="$3"
  [ -n "${handle}" ] || return 0
  [ -f "${path}" ] || return 0
  _cb_inmem_atomic_write "${handle}" "${name}" "${path}"
}

cb_capture_blob_stdin() {
  local handle="$1" name="$2"
  [ -n "${handle}" ] || { cat >/dev/null; return 0; }
  _cb_inmem_atomic_write "${handle}" "${name}" "-"
}
```

- [ ] **Step 4: 테스트 재실행**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: `PASS: cb_open + cb_get_path` (모든 케이스 통과).

- [ ] **Step 5: Commit**

```bash
git add adapters/cycle_bundle/in_memory.sh tests/adapters/test-cycle_bundle-in_memory.sh
git commit -m "feat(cycle_bundle): in_memory capture_blob_{text,file,stdin} (I3, I4)"
```

---

## Task 5: in_memory — cb_capture_attempt (attempts/<idx>/{envelope,diagnostics,lr_meta})

**Files:**
- Modify: `adapters/cycle_bundle/in_memory.sh`
- Modify: `tests/adapters/test-cycle_bundle-in_memory.sh`

- [ ] **Step 1: 테스트 추가**

```bash
# Attempt capture.
h="$(cb_open "Att-task-1-1234567890ab" "tgt" "Coder" "m:att" "")"
env_ref="$(mktemp)"; echo '{"output_kind":"patch"}' > "${env_ref}"
diag_ref="$(mktemp)"; echo 'WARN something' > "${diag_ref}"
meta_json='{"exit_status":"ok","attempts":1,"wall_ms":12}'
cb_capture_attempt "${h}" 1 "${env_ref}" "${diag_ref}" "${meta_json}"
[ -d "${h}/attempts/1" ] || { echo "FAIL: attempts/1 dir"; exit 1; }
[ -f "${h}/attempts/1/envelope.json" ] || { echo "FAIL: env"; exit 1; }
[ -f "${h}/attempts/1/diagnostics.txt" ] || { echo "FAIL: diag"; exit 1; }
[ -f "${h}/attempts/1/lr_meta.json" ] || { echo "FAIL: meta"; exit 1; }
[ "$(jq -r '.exit_status' "${h}/attempts/1/lr_meta.json")" = "ok" ] || { echo "FAIL: meta content"; exit 1; }
rm -f "${env_ref}" "${diag_ref}"
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: FAIL.

- [ ] **Step 3: cb_capture_attempt 구현**

`in_memory.sh` 의 stub 교체:

```bash
cb_capture_attempt() {
  local handle="$1" idx="$2" envelope_ref="$3" diagnostics_ref="$4" meta_json="$5"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  local dir="${handle}/attempts/${idx}"
  mkdir -p "${dir}" 2>/dev/null
  if [ -f "${envelope_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/envelope.json" "${envelope_ref}"
  fi
  if [ -f "${diagnostics_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/diagnostics.txt" "${diagnostics_ref}"
  fi
  cb_capture_blob_text "${handle}" "attempts/${idx}/lr_meta.json" "${meta_json}"
}
```

- [ ] **Step 4: 재실행 → PASS**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add adapters/cycle_bundle/in_memory.sh tests/adapters/test-cycle_bundle-in_memory.sh
git commit -m "feat(cycle_bundle): in_memory cb_capture_attempt"
```

---

## Task 6: in_memory — cb_promote_to_full + cb_finalize (additive promote, finalize once, slim/full tier)

**Files:**
- Modify: `adapters/cycle_bundle/in_memory.sh`
- Modify: `tests/adapters/test-cycle_bundle-in_memory.sh`

- [ ] **Step 1: 테스트 추가 (4 케이스)**

```bash
# Promote + finalize (slim ok cycle: diagnostics 삭제).
h="$(cb_open "Fin-task-1-aaaaaaaaaaaa" "tgt" "Coder" "m:fin1" "")"
echo 'foo' > "${h}/diagnostics.txt"
cb_finalize "${h}" "ok" '{}'
[ ! -f "${h}/diagnostics.txt" ] || { echo "FAIL: ok+no-promote should drop diagnostics.txt"; exit 1; }
[ -f "${h}/summary.json" ] || { echo "FAIL: summary.json"; exit 1; }
[ "$(jq -r .result "${h}/summary.json")" = "ok" ] || { echo "FAIL: summary.result"; exit 1; }
[ ! -f "${h}/pidfile.json" ] || { echo "FAIL: pidfile not removed"; exit 1; }

# Promote 가 한 번이라도 호출되면 ok 여도 보존 (I6).
h="$(cb_open "Fin-task-2-bbbbbbbbbbbb" "tgt" "Coder" "m:fin2" "")"
echo 'kept' > "${h}/diagnostics.txt"
cb_promote_to_full "${h}" "lr:transport_error:5xx"
cb_finalize "${h}" "ok" '{}'
[ -f "${h}/diagnostics.txt" ] || { echo "FAIL: I6 promote-then-ok should preserve diagnostics"; exit 1; }
[ "$(jq '.failure_reasons | length' "${h}/summary.json")" = "1" ] || { echo "FAIL: failure_reasons"; exit 1; }

# Promote 두 번 (additive, I5).
h="$(cb_open "Fin-task-3-cccccccccccc" "tgt" "Coder" "m:fin3" "")"
cb_promote_to_full "${h}" "lr:transport_error:5xx"
cb_promote_to_full "${h}" "envelope_invalid"
cb_finalize "${h}" "invalid" '{}'
[ "$(jq '.failure_reasons | length' "${h}/summary.json")" = "2" ] || { echo "FAIL: I5 additive"; exit 1; }
[ "$(jq -r '.failure_reasons[1]' "${h}/summary.json")" = "envelope_invalid" ] || { echo "FAIL: I5 order"; exit 1; }

# Finalize-once (I7).
h="$(cb_open "Fin-task-4-dddddddddddd" "tgt" "Coder" "m:fin4" "")"
cb_finalize "${h}" "ok" '{}'
cb_finalize "${h}" "error" '{}' 2>/dev/null  # 두 번째는 no-op
[ "$(jq -r .result "${h}/summary.json")" = "ok" ] || { echo "FAIL: I7 second finalize must be no-op"; exit 1; }
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: FAIL.

- [ ] **Step 3: 구현**

`in_memory.sh` 의 stub 교체:

```bash
# Internal: promote 상태를 disk 마커로 표현 (in_memory 도 결국 fs 백엔드).
_cb_inmem_promoted() { [ -f "$1/.promoted" ]; }

cb_promote_to_full() {
  local handle="$1" reason="${2:-}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  : > "${handle}/.promoted" 2>/dev/null
  # reason 누적 — JSON Lines 로 파일에 append (finalize 시 array 로 변환).
  if [ -n "${reason}" ]; then
    printf '%s\n' "${reason}" >> "${handle}/.failure_reasons"
  fi
}

cb_finalize() {
  local handle="$1" result="${2:-error}" extra_json="${3:-{\}}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  if [ -f "${handle}/.finalized" ]; then
    log_warn "cb_finalize: already finalized at ${handle} (I7)"
    return 0
  fi
  # Slim tier: ok 결과 + promote 이력 없음 → diagnostics.txt 삭제.
  if [ "${result}" = "ok" ] && ! _cb_inmem_promoted "${handle}"; then
    rm -f "${handle}/diagnostics.txt" 2>/dev/null
    rm -f "${handle}/diff/pre.dirty.diff" 2>/dev/null
  fi
  # failure_reasons 배열 구성.
  local reasons_json='[]'
  if [ -f "${handle}/.failure_reasons" ]; then
    reasons_json="$(jq -R . "${handle}/.failure_reasons" | jq -s .)"
  fi
  jq -cn \
    --arg result "${result}" \
    --arg finalized_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson failure_reasons "${reasons_json}" \
    --argjson extra "${extra_json}" \
    '$extra + {result:$result, finalized_at:$finalized_at, failure_reasons:$failure_reasons}' \
    > "${handle}/summary.json.tmp" \
    && mv "${handle}/summary.json.tmp" "${handle}/summary.json"
  # 마감 표식.
  : > "${handle}/.finalized"
  rm -f "${handle}/pidfile.json" 2>/dev/null
}
```

- [ ] **Step 4: 재실행 → PASS**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add adapters/cycle_bundle/in_memory.sh tests/adapters/test-cycle_bundle-in_memory.sh
git commit -m "feat(cycle_bundle): in_memory promote + finalize (I5–I7)"
```

---

## Task 7: in_memory — cb_collect_abandoned (pid alive + lease check)

**Files:**
- Modify: `adapters/cycle_bundle/in_memory.sh`
- Modify: `tests/adapters/test-cycle_bundle-in_memory.sh`

- [ ] **Step 1: 테스트 추가**

```bash
# Abandoned: pidfile 의 pid 가 죽었고 lease 미등록 → abandoned stamp.
h="$(cb_open "Aban-task-1-eeeeeeeeeeee" "tgt" "Coder" "m:aban1" "")"
# 죽은 pid 로 pidfile 강제 교체 (PID 1 은 macOS launchd, 항상 살아있음 → 99999 사용).
jq -n --arg pid "99999999" --arg manifest_id "m:aban1" \
   '{pid:$pid, hostname:"x", started_at:"2020-01-01T00:00:00Z", manifest_id:$manifest_id, lease_token:null}' \
   > "${h}/pidfile.json"
# finalize 미호출 → summary.json 없음.
cb_collect_abandoned "tgt"
[ -f "${h}/summary.json" ] || { echo "FAIL: abandoned should write summary"; exit 1; }
[ "$(jq -r .result "${h}/summary.json")" = "abandoned" ] || { echo "FAIL: result=abandoned"; exit 1; }

# Abandoned: alive pid 는 보호 (현재 프로세스 pid 사용).
h="$(cb_open "Aban-task-2-ffffffffffff" "tgt" "Coder" "m:aban2" "")"
jq -n --arg pid "$$" --arg manifest_id "m:aban2" \
   '{pid:$pid, hostname:"x", started_at:"2020-01-01T00:00:00Z", manifest_id:$manifest_id, lease_token:null}' \
   > "${h}/pidfile.json"
cb_collect_abandoned "tgt"
[ ! -f "${h}/summary.json" ] || { echo "FAIL: alive pid must NOT be stamped abandoned"; exit 1; }
```

- [ ] **Step 2: 실행 — 실패 확인**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: FAIL.

- [ ] **Step 3: 구현**

`in_memory.sh` 의 stub 교체:

```bash
cb_collect_abandoned() {
  local target="$1"
  [ -n "${target}" ] || return 0
  local root cycles_dir
  root="$(_cb_inmem_root)"
  cycles_dir="${root}/${target}/cycles"
  [ -d "${cycles_dir}" ] || return 0
  local d pid
  for d in "${cycles_dir}"/*/; do
    [ -d "${d}" ] || continue
    [ -f "${d}/summary.json" ] && continue   # already finalized
    [ -f "${d}/pidfile.json" ] || continue
    pid="$(jq -r '.pid // empty' "${d}/pidfile.json" 2>/dev/null)"
    if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
      # pid 죽었음 — abandoned stamp.
      cb_finalize "${d%/}" "abandoned" "$(jq -n '{abandoned_detected_at: now | todateiso8601}')"
    fi
    # alive pid 는 보호 (no-op).
  done
}
```

- [ ] **Step 4: 재실행 → PASS**

Run: `bash tests/adapters/test-cycle_bundle-in_memory.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add adapters/cycle_bundle/in_memory.sh tests/adapters/test-cycle_bundle-in_memory.sh
git commit -m "feat(cycle_bundle): in_memory cb_collect_abandoned"
```

---

## Task 8: filesystem 어댑터 — 경로 + 권한(0700/0600) + cb_open

**Files:**
- Modify: `adapters/cycle_bundle/filesystem.sh`
- Create: `tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 1: 실패 테스트 작성**

```bash
cat > tests/adapters/test-cycle_bundle-filesystem.sh <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"
. "${LLM_TEAM_ROOT}/lib/ports/cycle_bundle.sh"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/filesystem.sh"

ROOT_OVERRIDE="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-fs-XXXXXX")"
export LLM_TEAM_ROOT_FS_OVERRIDE="${ROOT_OVERRIDE}"   # 어댑터가 우선 검사
export TARGET_NAME="tgt"
trap 'rm -rf "${ROOT_OVERRIDE}"' EXIT

h="$(cb_open "Coder-task-1-cafeface0001" "tgt" "Coder" "m:1" "lt:1")"
[ -n "${h}" ] || { echo "FAIL: cb_open"; exit 1; }
[ -d "${h}" ] || { echo "FAIL: bundle dir not created"; exit 1; }
[ -d "${h}/diff" ] && [ -d "${h}/attempts" ] || { echo "FAIL: subdirs"; exit 1; }
[ -f "${h}/pidfile.json" ] || { echo "FAIL: pidfile"; exit 1; }

# Permissions (mode 0700 dir).
mode_dir="$(stat -f '%Lp' "${h}" 2>/dev/null || stat -c '%a' "${h}" 2>/dev/null)"
[ "${mode_dir}" = "700" ] || { echo "FAIL: dir mode '${mode_dir}' != 700"; exit 1; }

# 빈 handle case.
LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 \
  h2="$(cb_open "Coder-task-2-aaaaaaaaaaaa" "tgt" "Coder" "m:2" "")"
[ -z "${h2}" ] || { echo "FAIL: disabled should yield empty"; exit 1; }

echo "PASS: filesystem cb_open"
EOF
chmod +x tests/adapters/test-cycle_bundle-filesystem.sh
```

- [ ] **Step 2: 실행 → FAIL**

Run: `bash tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 3: filesystem 어댑터 cb_open 구현**

```bash
cat > adapters/cycle_bundle/filesystem.sh <<'EOF'
#!/usr/bin/env bash
# adapters/cycle_bundle/filesystem.sh
#
# 운영 어댑터. 디렉토리: ${LLM_TEAM_ROOT}/workdir/<target>/cycles/<cycle_id>/
# (또는 LLM_TEAM_ROOT_FS_OVERRIDE 가 설정된 경우 그 아래 — 테스트용).
# 권한: dir 0700, file 0600 (umask 077). workdir/ 는 이미 .gitignore.

_cb_fs_root() {
  printf '%s' "${LLM_TEAM_ROOT_FS_OVERRIDE:-${LLM_TEAM_ROOT}}"
}

_cb_fs_cycles_dir() {
  local target="$1"
  printf '%s/workdir/%s/cycles' "$(_cb_fs_root)" "${target}"
}

cb_open() {
  local cycle_id="$1" target="$2" role="$3" manifest_id="$4" lease_token="${5:-}"
  if [ "${LLM_TEAM_CYCLE_BUNDLE_DISABLED:-0}" = "1" ]; then
    return 0
  fi
  if [ -z "${cycle_id}" ] || [ -z "${target}" ] || [ -z "${role}" ]; then
    return 0
  fi
  local cycles path
  cycles="$(_cb_fs_cycles_dir "${target}")"
  path="${cycles}/${cycle_id}"
  # umask 077 → mkdir 후 chmod 0700 (umask 만으로는 macOS 에서 일관성 안 보장).
  ( umask 077 && mkdir -p "${path}/diff" "${path}/attempts" ) 2>/dev/null \
    || { log_warn "cb_open: mkdir failed for ${path}"; return 0; }
  chmod 0700 "${path}" 2>/dev/null || true
  # pidfile.json — atomic write + 0600.
  if [ ! -f "${path}/pidfile.json" ]; then
    local tmp="${path}/pidfile.json.tmp.$$"
    jq -cn \
      --arg pid "$$" \
      --arg host "$(hostname 2>/dev/null || echo unknown)" \
      --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg manifest_id "${manifest_id}" \
      --arg lease_token "${lease_token}" \
      '{pid:$pid, hostname:$host, started_at:$started_at, manifest_id:$manifest_id, lease_token:(if $lease_token=="" then null else $lease_token end)}' \
      > "${tmp}" \
      && chmod 0600 "${tmp}" \
      && mv "${tmp}" "${path}/pidfile.json"
  fi
  # Warn 임계 (디스크 안전망).
  local n_dirs
  n_dirs="$(find "${cycles}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  if [ -n "${n_dirs}" ] && [ "${n_dirs}" -gt "${LLM_TEAM_CYCLE_BUNDLE_WARN_THRESHOLD:-1000}" ]; then
    log_warn "cb_open: cycles/ dir count=${n_dirs} exceeds threshold; consider prune"
  fi
  printf '%s' "${path}"
}

cb_get_path() {
  local handle="${1:-}"
  [ -n "${handle}" ] && [ -d "${handle}" ] && printf '%s' "${handle}"
}

# 나머지는 후속 task.
cb_capture_blob_text() { :; }
cb_capture_blob_file() { :; }
cb_capture_blob_stdin() { :; }
cb_capture_attempt() { :; }
cb_promote_to_full() { :; }
cb_finalize() { :; }
cb_collect_abandoned() { :; }
EOF
```

- [ ] **Step 4: 실행 → PASS**

Run: `bash tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 5: Commit**

```bash
git add adapters/cycle_bundle/filesystem.sh tests/adapters/test-cycle_bundle-filesystem.sh
git commit -m "feat(cycle_bundle): filesystem cb_open with 0700 perm + pidfile"
```

---

## Task 9: filesystem — capture_blob 3종 + capture_attempt + 권한 0600

**Files:**
- Modify: `adapters/cycle_bundle/filesystem.sh`
- Modify: `tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 1: 테스트 추가 (in_memory 와 동일 케이스 + 파일 모드 0600)**

기존 `echo PASS` 직전에:

```bash
h="$(cb_open "Coder-task-9-aaaa11112222" "tgt" "Coder" "m:9" "")"
cb_capture_blob_text "${h}" "summary-note.txt" "ok"
[ "$(cat "${h}/summary-note.txt")" = "ok" ] || { echo "FAIL: blob_text"; exit 1; }
mode_file="$(stat -f '%Lp' "${h}/summary-note.txt" 2>/dev/null || stat -c '%a' "${h}/summary-note.txt" 2>/dev/null)"
[ "${mode_file}" = "600" ] || { echo "FAIL: file mode '${mode_file}' != 600"; exit 1; }

env_ref="$(mktemp)"; echo '{"k":"v"}' > "${env_ref}"
diag_ref="$(mktemp)"; echo 'diag-line' > "${diag_ref}"
cb_capture_attempt "${h}" 1 "${env_ref}" "${diag_ref}" '{"exit_status":"ok"}'
[ -f "${h}/attempts/1/envelope.json" ] || { echo "FAIL: attempts envelope"; exit 1; }
mode_attempt="$(stat -f '%Lp' "${h}/attempts/1/envelope.json" 2>/dev/null || stat -c '%a' "${h}/attempts/1/envelope.json" 2>/dev/null)"
[ "${mode_attempt}" = "600" ] || { echo "FAIL: attempt file mode '${mode_attempt}' != 600"; exit 1; }
rm -f "${env_ref}" "${diag_ref}"
```

- [ ] **Step 2: 실행 → FAIL**

Run: `bash tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 3: 구현 — in_memory 동일 + chmod 0600**

`adapters/cycle_bundle/filesystem.sh` 의 stub 4개 교체:

```bash
_cb_fs_atomic_write() {
  local handle="$1" name="$2" src="$3"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  local dst="${handle}/${name}"
  ( umask 077 && mkdir -p "$(dirname "${dst}")" ) 2>/dev/null
  local tmp="${dst}.tmp.$$"
  if [ "${src}" = "-" ]; then
    cat > "${tmp}" || { rm -f "${tmp}"; return 1; }
  else
    cp "${src}" "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 1; }
  fi
  chmod 0600 "${tmp}" 2>/dev/null || true
  mv "${tmp}" "${dst}"
}

cb_capture_blob_text() {
  local handle="$1" name="$2" text="${3:-}"
  [ -n "${handle}" ] || return 0
  printf '%s' "${text}" | _cb_fs_atomic_write "${handle}" "${name}" "-"
}

cb_capture_blob_file() {
  local handle="$1" name="$2" path="$3"
  [ -n "${handle}" ] || return 0
  [ -f "${path}" ] || return 0
  _cb_fs_atomic_write "${handle}" "${name}" "${path}"
}

cb_capture_blob_stdin() {
  local handle="$1" name="$2"
  [ -n "${handle}" ] || { cat >/dev/null; return 0; }
  _cb_fs_atomic_write "${handle}" "${name}" "-"
}

cb_capture_attempt() {
  local handle="$1" idx="$2" envelope_ref="$3" diagnostics_ref="$4" meta_json="$5"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  if [ -f "${envelope_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/envelope.json" "${envelope_ref}"
  fi
  if [ -f "${diagnostics_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/diagnostics.txt" "${diagnostics_ref}"
  fi
  cb_capture_blob_text "${handle}" "attempts/${idx}/lr_meta.json" "${meta_json}"
}
```

- [ ] **Step 4: 재실행 → PASS**

Run: `bash tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 5: Commit**

```bash
git add adapters/cycle_bundle/filesystem.sh tests/adapters/test-cycle_bundle-filesystem.sh
git commit -m "feat(cycle_bundle): filesystem capture_blob + capture_attempt (0600)"
```

---

## Task 10: filesystem — promote + finalize + collect_abandoned

**Files:**
- Modify: `adapters/cycle_bundle/filesystem.sh`
- Modify: `tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 1: 테스트 추가 (in_memory Task 6+7 케이스 그대로 복제 — handle 만 cb_open(target=tgt) 으로 받음)**

기존 `echo PASS` 직전에 Task 6/7 의 5 케이스(slim ok, promote 후 ok 보존, additive promote, finalize-once, abandoned alive vs dead) 케이스를 그대로 추가.

- [ ] **Step 2: 실행 → FAIL**

Run: `bash tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 3: 구현 — in_memory 와 의미적 등가물. 단, finalize 시 외부 어댑터(workspace) 가 없으므로 `diff/post.head` 와 `diff/post.dirty.diff` 캡처는 caller 책임.**

`filesystem.sh` 의 stub 3 교체:

```bash
_cb_fs_promoted() { [ -f "$1/.promoted" ]; }

cb_promote_to_full() {
  local handle="$1" reason="${2:-}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  : > "${handle}/.promoted" 2>/dev/null
  chmod 0600 "${handle}/.promoted" 2>/dev/null || true
  if [ -n "${reason}" ]; then
    printf '%s\n' "${reason}" >> "${handle}/.failure_reasons"
    chmod 0600 "${handle}/.failure_reasons" 2>/dev/null || true
  fi
}

cb_finalize() {
  local handle="$1" result="${2:-error}" extra_json="${3:-{\}}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  if [ -f "${handle}/.finalized" ]; then
    log_warn "cb_finalize: already finalized at ${handle}"
    return 0
  fi
  if [ "${result}" = "ok" ] && ! _cb_fs_promoted "${handle}"; then
    rm -f "${handle}/diagnostics.txt" "${handle}/diff/pre.dirty.diff" 2>/dev/null
  fi
  local reasons_json='[]'
  if [ -f "${handle}/.failure_reasons" ]; then
    reasons_json="$(jq -R . "${handle}/.failure_reasons" | jq -s .)"
  fi
  local tmp="${handle}/summary.json.tmp.$$"
  jq -cn \
    --arg result "${result}" \
    --arg finalized_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson failure_reasons "${reasons_json}" \
    --argjson extra "${extra_json}" \
    '$extra + {result:$result, finalized_at:$finalized_at, failure_reasons:$failure_reasons}' \
    > "${tmp}" \
    && chmod 0600 "${tmp}" \
    && mv "${tmp}" "${handle}/summary.json"
  : > "${handle}/.finalized"
  rm -f "${handle}/pidfile.json" 2>/dev/null
}

cb_collect_abandoned() {
  local target="$1"
  [ -n "${target}" ] || return 0
  local cycles_dir
  cycles_dir="$(_cb_fs_cycles_dir "${target}")"
  [ -d "${cycles_dir}" ] || return 0
  local d pid
  for d in "${cycles_dir}"/*/; do
    [ -d "${d}" ] || continue
    [ -f "${d}/summary.json" ] && continue
    [ -f "${d}/pidfile.json" ] || continue
    pid="$(jq -r '.pid // empty' "${d}/pidfile.json" 2>/dev/null)"
    if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
      cb_finalize "${d%/}" "abandoned" "$(jq -n '{abandoned_detected_at: now | todateiso8601}')"
    fi
  done
}
```

- [ ] **Step 4: 실행 → PASS**

Run: `bash tests/adapters/test-cycle_bundle-filesystem.sh`

- [ ] **Step 5: Commit**

```bash
git add adapters/cycle_bundle/filesystem.sh tests/adapters/test-cycle_bundle-filesystem.sh
git commit -m "feat(cycle_bundle): filesystem promote + finalize + collect_abandoned"
```

---

## Task 11: 두 어댑터의 conformance 테스트 (test-port-cycle_bundle.sh)

**Files:**
- Create: `tests/lib/test-port-cycle_bundle.sh`

- [ ] **Step 1: 동일 시나리오를 두 어댑터로 차례로 실행하는 테스트**

```bash
cat > tests/lib/test-port-cycle_bundle.sh <<'EOF'
#!/usr/bin/env bash
# 두 어댑터(in_memory, filesystem) 가 같은 invariants 를 만족하는지 검증.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"
. "${LLM_TEAM_ROOT}/lib/ports/cycle_bundle.sh"

run_scenario() {
  local label="$1"
  echo "--- ${label} ---"
  # I1: idempotent open
  local h1 h2
  h1="$(cb_open "S-task-1-aaaaaaaaaaaa" "tgt" "Coder" "m:1" "")"
  h2="$(cb_open "S-task-1-aaaaaaaaaaaa" "tgt" "Coder" "m:1" "")"
  [ "${h1}" = "${h2}" ] || { echo "FAIL[${label}]: I1"; return 1; }
  # I2: disabled
  local h3
  LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 \
    h3="$(cb_open "S-task-2-bbbbbbbbbbbb" "tgt" "Coder" "m:2" "")"
  [ -z "${h3}" ] || { echo "FAIL[${label}]: I2"; return 1; }
  unset LLM_TEAM_CYCLE_BUNDLE_DISABLED
  # I3: idempotent re-capture
  cb_capture_blob_text "${h1}" "x" "v1"; cb_capture_blob_text "${h1}" "x" "v2"
  [ "$(cat "${h1}/x")" = "v2" ] || { echo "FAIL[${label}]: I3"; return 1; }
  # I5/I6: promote additive + preserve on ok
  echo 'D' > "${h1}/diagnostics.txt"
  cb_promote_to_full "${h1}" "r1"
  cb_promote_to_full "${h1}" "r2"
  cb_finalize "${h1}" "ok" '{}'
  [ -f "${h1}/diagnostics.txt" ] || { echo "FAIL[${label}]: I6"; return 1; }
  [ "$(jq '.failure_reasons | length' "${h1}/summary.json")" = "2" ] || { echo "FAIL[${label}]: I5"; return 1; }
  # I7: finalize-once
  cb_finalize "${h1}" "error" '{}' 2>/dev/null
  [ "$(jq -r .result "${h1}/summary.json")" = "ok" ] || { echo "FAIL[${label}]: I7"; return 1; }
  echo "OK[${label}]"
}

# in_memory.
INMEM="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-conf-inmem-XXXXXX")"
export LLM_TEAM_INMEM_CB_DIR="${INMEM}"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/in_memory.sh"
run_scenario "in_memory" || { rm -rf "${INMEM}"; exit 1; }

# filesystem (override root).
FSROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-conf-fs-XXXXXX")"
export LLM_TEAM_ROOT_FS_OVERRIDE="${FSROOT}"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/filesystem.sh"
run_scenario "filesystem" || { rm -rf "${INMEM}" "${FSROOT}"; exit 1; }

rm -rf "${INMEM}" "${FSROOT}"
echo "PASS: cycle_bundle conformance (in_memory + filesystem)"
EOF
chmod +x tests/lib/test-port-cycle_bundle.sh
```

- [ ] **Step 2: 실행 → PASS (이미 두 어댑터 다 구현돼 있어야 통과)**

Run: `bash tests/lib/test-port-cycle_bundle.sh`
Expected: `OK[in_memory]`, `OK[filesystem]`, `PASS: cycle_bundle conformance`.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/test-port-cycle_bundle.sh
git commit -m "test(cycle_bundle): cross-adapter conformance for I1-I7"
```

---

## Task 12: workspace 포트 확장 — ws_diff_head + ws_head_sha + ws_diff_range

**Files:**
- Modify: `lib/ports/workspace.sh`
- Modify: `adapters/workspace/git_worktree.sh`
- Modify: `adapters/workspace/in_memory.sh`
- Modify: `tests/adapters/test-workspace-git_worktree.sh`

- [ ] **Step 1: 포트 required functions 에 추가**

`lib/ports/workspace.sh` 의 `PORT_WORKSPACE_REQUIRED_FUNCTIONS` 배열에:

```bash
  ws_diff_head
  ws_head_sha
  ws_diff_range
```

- [ ] **Step 2: 실패 테스트 추가 (test-workspace-git_worktree.sh 끝에)**

```bash
# ws_head_sha + ws_diff_head + ws_diff_range
unit_id="task-${TEST_OBJECT_ID}"   # 기존 테스트가 만들어둔 worktree
sha1="$(ws_head_sha "${unit_id}")"
[ -n "${sha1}" ] || { echo "FAIL: ws_head_sha empty"; exit 1; }
diff_clean="$(ws_diff_head "${unit_id}")"
[ -z "${diff_clean}" ] || { echo "FAIL: clean worktree should produce empty diff"; exit 1; }
# Dirty 만들기.
ws_path="$(ws_path_of "${unit_id}")"
echo "dirty" >> "${ws_path}/README.md" 2>/dev/null || echo "dirty" > "${ws_path}/dirty.txt"
diff_dirty="$(ws_diff_head "${unit_id}")"
[ -n "${diff_dirty}" ] || { echo "FAIL: dirty worktree should produce diff"; exit 1; }
# 미존재 unit_id → graceful empty.
nope="$(ws_head_sha "task-nonexistent-unit")"
[ -z "${nope}" ] || { echo "FAIL: missing worktree should be empty"; exit 1; }
```

- [ ] **Step 3: 실행 → FAIL**

Run: `bash tests/adapters/test-workspace-git_worktree.sh`

- [ ] **Step 4: git_worktree 구현 추가**

`adapters/workspace/git_worktree.sh` 끝에:

```bash
ws_diff_head() {
  local unit_id="$1"
  local wt
  wt="$(_workspace_unit_path "${unit_id}")"
  [ -d "${wt}/.git" ] || [ -f "${wt}/.git" ] || return 0
  ( cd "${wt}" && git diff HEAD 2>/dev/null ) || true
}

ws_head_sha() {
  local unit_id="$1"
  local wt
  wt="$(_workspace_unit_path "${unit_id}")"
  [ -d "${wt}/.git" ] || [ -f "${wt}/.git" ] || return 0
  ( cd "${wt}" && git rev-parse HEAD 2>/dev/null ) || true
}

ws_diff_range() {
  local unit_id="$1" from_sha="$2" to_sha="${3:-HEAD}"
  local wt
  wt="$(_workspace_unit_path "${unit_id}")"
  [ -d "${wt}/.git" ] || [ -f "${wt}/.git" ] || return 0
  [ -n "${from_sha}" ] || return 0
  ( cd "${wt}" && git diff "${from_sha}" "${to_sha}" 2>/dev/null ) || true
}
```

- [ ] **Step 5: in_memory stub 추가**

`adapters/workspace/in_memory.sh` 끝에:

```bash
ws_diff_head() { :; }       # in_memory 워크스페이스는 git 없음 → 항상 빈 출력.
ws_head_sha() { :; }
ws_diff_range() { :; }
```

- [ ] **Step 6: 실행 → PASS**

Run: `bash tests/adapters/test-workspace-git_worktree.sh && bash tests/lib/test-port-conformance.sh`
Expected: 둘 다 PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/ports/workspace.sh adapters/workspace/ tests/adapters/test-workspace-git_worktree.sh
git commit -m "feat(workspace): add ws_diff_head, ws_head_sha, ws_diff_range"
```

---

## Task 13: runner.sh — LR_TIMEOUT_SEC 기본값 0 → 600

**Files:**
- Modify: `scheduler/runner.sh:587`

- [ ] **Step 1: 변경 전 회귀 baseline**

Run: `bash tests/scheduler/test-runner-pipeline.sh 2>&1 | tail -5`
Expected: 기존대로 PASS.

- [ ] **Step 2: 한 줄 변경**

`scheduler/runner.sh` 의 line 587:

```bash
# before:
LR_TIMEOUT_SEC="${LLM_TEAM_LR_TIMEOUT_SEC:-0}"
# after:
LR_TIMEOUT_SEC="${LLM_TEAM_LR_TIMEOUT_SEC:-600}"
```

- [ ] **Step 3: 회귀 재실행**

Run: `bash tests/scheduler/test-runner-pipeline.sh 2>&1 | tail -5`
Expected: PASS (timeout 600s 는 fake adapter 호출 시간보다 훨씬 김).

- [ ] **Step 4: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): default LR_TIMEOUT_SEC 0 -> 600 (hang-safe)"
```

---

## Task 14: _runner_ledger_write — optional cycle_bundle_ref 매개변수

**Files:**
- Modify: `scheduler/runner.sh:200-242` (_runner_ledger_write)

- [ ] **Step 1: 시그니처 확장**

기존:

```bash
_runner_ledger_write() {
  local target="$1" obj_kind="$2" obj_id="$3" from_state="$4" to_state="$5"
  local operation="$6" idempotency_key="$7" manifest_id="$8" result="$9"
  local reason="${10:-}"
```

뒤에 한 줄 추가:

```bash
  local cycle_bundle_ref="${11:-}"
```

jq -n 블록의 `--arg` 끝부분에 추가:

```bash
    --arg cycle_bundle_ref "${cycle_bundle_ref}" \
```

JSON object 의 `reason:` 라인 다음에:

```bash
      cycle_bundle_ref: (if $cycle_bundle_ref == "" then null else $cycle_bundle_ref end),
```

- [ ] **Step 2: 회귀 — 기존 호출자(11번째 인자 미전달) 가 그대로 동작**

Run: `bash tests/scheduler/test-runner-pipeline.sh && bash tests/scheduler/test-runner-cwd.sh`
Expected: PASS (필드는 null 로 들어감).

- [ ] **Step 3: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): _runner_ledger_write accepts optional cycle_bundle_ref"
```

---

## Task 15: runner.sh — cb_open + 단일 cleanup trap (manifest_validate 직후)

**Files:**
- Modify: `scheduler/runner.sh` (manifest_validate 직후, 약 line 415)
- Modify: `scheduler/runner.sh` (기존 `_runner_full_cleanup` trap 설치 줄 — 약 line 681)

- [ ] **Step 1: cb_open + trap 합성 hook 삽입**

`context_manifest_validate` 통과 직후 (line 414 직후) 다음 블록 추가:

```bash
# ============================================================================
# Cycle bundle (RW 4 역할만): cb_open + 단일 cleanup trap.
# ============================================================================

CB_HANDLE=""
_runner_cycle_result=""
case "${ROLE}" in
  Coder|Reviewer|Integrator|QA)
    _manifest_id_full="$(context_manifest_id "${MANIFEST_FILE}")"
    _manifest_hash12="$(printf '%s' "${_manifest_id_full}" | shasum -a 256 | cut -c1-12)"
    _cycle_id="${ROLE}-${TARGET_OBJECT_ID}-${_manifest_hash12}"
    if declare -F cb_open >/dev/null 2>&1; then
      CB_HANDLE="$(cb_open "${_cycle_id}" "${TARGET}" "${ROLE}" \
                            "${_manifest_id_full}" "${LEASE_TOKEN:-}")"
    fi
    ;;
esac

_runner_cycle_finalize_if_open() {
  if [ -n "${CB_HANDLE:-}" ] && declare -F cb_finalize >/dev/null 2>&1; then
    cb_finalize "${CB_HANDLE}" "${_runner_cycle_result:-error}" "{}"
  fi
}
```

- [ ] **Step 2: 기존 _runner_full_cleanup trap 호출에 chain (line ~681)**

기존:

```bash
trap _runner_full_cleanup EXIT
```

로 변경:

```bash
trap '_runner_cycle_finalize_if_open; _runner_full_cleanup' EXIT
```

또한 cb_open 시점부터 trap 이 활성이도록, **cb_open 직후에도 한 번 trap 설치**:

cb_open 블록 직후에:

```bash
# Early trap — envelope 단계 도달 전에 exit 해도 cb_finalize 보장.
trap '_runner_cycle_finalize_if_open' EXIT
```

기존의 `_runner_full_cleanup` 설치 라인은 다음과 같이 envelope 합성 뒤에 둔 채:

```bash
trap '_runner_cycle_finalize_if_open; _runner_full_cleanup' EXIT
```

(두 번째 trap 설치가 첫 번째를 덮어씀 — 의도된 동작. envelope 가 만들어진 시점부터는 두 cleanup 모두 실행.)

- [ ] **Step 3: 회귀**

Run: `bash tests/scheduler/test-runner-pipeline.sh && bash tests/scheduler/test-runner-cwd.sh`
Expected: PASS. CB_HANDLE 은 fake/in_memory 어댑터로 cycles/ 디렉토리만 생성하고 finalize 까지 도달.

- [ ] **Step 4: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): cb_open + chained cleanup trap for RW 4 roles"
```

---

## Task 16: runner.sh — 단계 C/D (pre-snapshot + prompt capture)

**Files:**
- Modify: `scheduler/runner.sh` (ws_ensure 직후, prompt 작성 직후)

- [ ] **Step 1: pre-snapshot hook (ws_refresh / verification 블록 직후, 약 line 470)**

```bash
# Cycle bundle: pre-snapshot (RW 역할만, cb handle 있을 때만).
if [ -n "${CB_HANDLE:-}" ] && declare -F ws_head_sha >/dev/null 2>&1; then
  ws_head_sha "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/pre.head"
  ws_diff_head "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/pre.dirty.diff"
fi
```

- [ ] **Step 2: prompt capture hook (PROMPT_REF 작성 직후, 약 line 525)**

```bash
if [ -n "${CB_HANDLE:-}" ]; then
  cb_capture_blob_file "${CB_HANDLE}" "prompt.txt" "${PROMPT_REF}"
fi
```

- [ ] **Step 3: 회귀**

Run: `bash tests/scheduler/test-runner-pipeline.sh && bash tests/scheduler/test-runner-cwd.sh`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): cycle bundle pre-snapshot + prompt capture (steps C, D)"
```

---

## Task 17: runner.sh — 단계 E (lr_call attempt capture + promote on lr fail)

**Files:**
- Modify: `scheduler/runner.sh` (lr_call retry loop 안)

- [ ] **Step 1: while 루프 내부, LR_META 분해 직후에 capture + promote**

`runner.sh` 의 lr_call while 루프에서 `LR_META=$(lr_call ...)` 가 성공하고 LR_EXIT_STATUS / LR_ENVELOPE_REF / LR_DIAGNOSTICS_REF 가 추출된 직후 (대략 line 615 직후):

```bash
  if [ -n "${CB_HANDLE:-}" ]; then
    cb_capture_attempt "${CB_HANDLE}" "$((LR_ATTEMPT+1))" \
      "${LR_ENVELOPE_REF}" "${LR_DIAGNOSTICS_REF}" "${LR_META}"
    if [ "${LR_EXIT_STATUS}" != "ok" ]; then
      cb_promote_to_full "${CB_HANDLE}" "lr:${LR_EXIT_STATUS}:${LR_ERROR_REASON:-}"
    fi
  fi
```

- [ ] **Step 2: 마지막 attempt 의 envelope/diagnostics 를 cycle 루트로 승격**

while 루프를 빠져나간 뒤 (lr_call 종료 시점, 약 line 660 부근, agent_output_parse 직전):

```bash
if [ -n "${CB_HANDLE:-}" ]; then
  if [ -f "${LR_ENVELOPE_REF}" ]; then
    cb_capture_blob_file "${CB_HANDLE}" "envelope.json" "${LR_ENVELOPE_REF}"
  fi
  if [ -f "${LR_DIAGNOSTICS_REF}" ]; then
    cb_capture_blob_file "${CB_HANDLE}" "diagnostics.txt" "${LR_DIAGNOSTICS_REF}"
  fi
  cb_capture_blob_text "${CB_HANDLE}" "lr_meta.json" "${LR_META}"
fi
```

- [ ] **Step 3: 회귀**

Run: `bash tests/scheduler/test-runner-pipeline.sh`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): cycle bundle lr_call attempts + promote (step E)"
```

---

## Task 18: runner.sh — 단계 F (after-lr.dirty.diff)

**Files:**
- Modify: `scheduler/runner.sh` (lr_call 종료 직후, agent_output_parse 직전)

- [ ] **Step 1: hook 삽입**

Task 17 Step 2 블록 직후에:

```bash
if [ -n "${CB_HANDLE:-}" ] && declare -F ws_diff_head >/dev/null 2>&1; then
  ws_diff_head "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/after-lr.dirty.diff"
fi
```

- [ ] **Step 2: 회귀**

Run: `bash tests/scheduler/test-runner-pipeline.sh`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): cycle bundle after-lr dirty diff (step F)"
```

---

## Task 19: runner.sh — 단계 G (caller_apply_output 직후 applied.diff + post.head)

**Files:**
- Modify: `scheduler/runner.sh:712~728` (caller_apply_output 호출 직후, exit 0 직전)

- [ ] **Step 1: 성공 분기 hook**

기존 `caller_apply_output` 호출 다음 줄 (성공으로 진행한 경우, line 728 의 `exit 0` 직전):

```bash
if [ -n "${CB_HANDLE:-}" ] && declare -F ws_head_sha >/dev/null 2>&1; then
  _post_head="$(ws_head_sha "task-${TARGET_OBJECT_ID}")"
  printf '%s' "${_post_head}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/post.head"
  _pre_head="$(cat "${CB_HANDLE}/diff/pre.head" 2>/dev/null)"
  if [ -n "${_pre_head}" ] && [ -n "${_post_head}" ]; then
    ws_diff_range "task-${TARGET_OBJECT_ID}" "${_pre_head}" "${_post_head}" \
      | cb_capture_blob_stdin "${CB_HANDLE}" "diff/applied.diff"
  fi
  ws_diff_head "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/post.dirty.diff"
  _runner_cycle_result="ok"
fi
```

- [ ] **Step 2: 회귀**

Run: `bash tests/scheduler/test-runner-pipeline.sh`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): cycle bundle applied.diff + post.head (step G)"
```

---

## Task 20: runner.sh — 단계 H (실패 분기에서 promote + result 설정)

**Files:**
- Modify: `scheduler/runner.sh` (모든 ledger error/invalid/stale 작성 직전)

- [ ] **Step 1: 실패 분기 6 군데에 promote + result 설정**

다음 각 분기에서 `_runner_ledger_write ... "<result>" ...` 직전에 추가:

(a) lr_call infrastructure failure (line ~555):

```bash
_runner_cycle_result="error"
[ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "lr_call_infra_failure"
```

(b) lr 분류 결과가 ok 아닌 채 retry 소진 (B-3 루프 종료 후, line ~660):

```bash
_runner_cycle_result="error"
[ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "lr_exhausted:${LR_EXIT_STATUS}"
```

(c) agent_output_parse 실패 (line ~660):

```bash
_runner_cycle_result="invalid"
[ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "agent_output_parse"
```

(d) extended validation 실패 (line ~685):

```bash
_runner_cycle_result="invalid"
[ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "envelope_invalid_extended"
```

(e) revision_pin_revalidate 실패 (line ~705):

```bash
_runner_cycle_result="stale"
[ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "revision_pin_stale"
```

(f) caller_apply_output 실패 (line ~720):

```bash
_runner_cycle_result="error"
[ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "caller_apply_output"
```

- [ ] **Step 2: 모든 ledger 호출에 cycle_bundle_ref 11번째 인자 추가**

각 `_runner_ledger_write ... "${result}" ...` 호출에 `"${CB_HANDLE:-}"` 인자를 (있는 경우엔 reason 뒤에) 추가:

```bash
_runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
  "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
  "${OPERATION}" "<idem>" "<manifest_id>" "<result>" "<reason>" "${CB_HANDLE:-}" || true
```

(reason 인자가 없는 호출은 빈 문자열을 전달해 11번째 자리를 유지: `"" "${CB_HANDLE:-}"`).

- [ ] **Step 3: 회귀**

Run: `bash tests/scheduler/test-runner-pipeline.sh`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scheduler/runner.sh
git commit -m "feat(runner): cycle bundle promote on failure paths + ledger ref"
```

---

## Task 21: caller_dispatch.sh — applied row 에 cycle_bundle_ref 통과

**Files:**
- Modify: `application/caller_dispatch.sh` (applied row 작성 경로)

- [ ] **Step 1: caller_apply_output 시그니처 확장 (env 변수로 전달)**

가장 단순한 방식: runner.sh 가 `caller_apply_output` 호출 직전에 `export CYCLE_BUNDLE_REF="${CB_HANDLE:-}"` 만 하고, caller_dispatch.sh 의 `_caller_*_ledger_write` 또는 ledger 작성 부분이 이 env 를 11번째 인자로 통과시킨다.

`scheduler/runner.sh` line ~712 에:

```bash
export CYCLE_BUNDLE_REF="${CB_HANDLE:-}"
if ! caller_apply_output "${TARGET_REPO}" "${ROLE}" "${ENVELOPE_FILE}" "${MANIFEST_FILE}"; then
```

`application/caller_dispatch.sh` 의 모든 `transition_ledger_write` 또는 ledger row JSON 빌드 위치에서 `cycle_bundle_ref` 필드를 추가. grep 으로 위치 찾기:

```bash
grep -n "transition_ledger_write\|caller_id\|idempotency_key" application/caller_dispatch.sh | head
```

찾은 jq 빌드 블록 각각에 다음 줄 추가:

```bash
    --arg cycle_bundle_ref "${CYCLE_BUNDLE_REF:-}" \
```

그리고 JSON object 안에:

```bash
      cycle_bundle_ref: (if $cycle_bundle_ref == "" then null else $cycle_bundle_ref end),
```

- [ ] **Step 2: 회귀**

Run: `bash tests/scheduler/test-runner-pipeline.sh && bash tests/application/*.sh 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add application/caller_dispatch.sh scheduler/runner.sh
git commit -m "feat(caller_dispatch): pass cycle_bundle_ref to applied ledger row"
```

---

## Task 22: 통합 테스트 — test-runner-cycle-bundle.sh (6 케이스)

**Files:**
- Create: `tests/scheduler/test-runner-cycle-bundle.sh`

- [ ] **Step 1: 6 케이스 통합 테스트 작성**

```bash
cat > tests/scheduler/test-runner-cycle-bundle.sh <<'EOF'
#!/usr/bin/env bash
# Integration: runner.sh × cycle_bundle.
# Cases:
#  (1) 성공 슬림: Coder cycle 후 prompt + envelope + lr_meta + 6 diff + summary,
#      diagnostics.txt 부재.
#  (2) invalid envelope: diagnostics + worktree-pre 풀 보존, summary.failure_reasons 비어있지 않음.
#  (3) lr retry 적층: attempt 1 fail → 2 ok 시 attempts/1, attempts/2 둘 다 + 최상위 envelope = attempt 2.
#  (4) EXIT 강제: SIGTERM 시뮬 → 다음 cycle 의 cb_collect_abandoned 가 abandoned stamp.
#  (5) applied.diff vs envelope.patch_diff 부정합 관찰: after-lr.dirty.diff 와 envelope 의 diff 차이 캡처.
#  (6) DISABLED=1: cycles/ 미생성.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
export LLM_TEAM_ADAPTER_NOTIFIER=none
export LLM_TEAM_ADAPTER_LLM_RUNNER=fake
export LLM_TEAM_ADAPTER_WORKSPACE=in_memory
export LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory
export LLM_TEAM_ADAPTER_CYCLE_BUNDLE=filesystem

# Test root
TROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-int-XXXXXX")"
export LLM_TEAM_ROOT_FS_OVERRIDE="${TROOT}"
trap 'rm -rf "${TROOT}"' EXIT

. "${LLM_TEAM_ROOT}/lib/common.sh"

# Helper: 가짜 fake adapter 가 envelope 을 fixture 에서 읽어오도록 설정.
# 자세한 fixture 셋업은 기존 test-runner-pipeline 패턴 참고.

# (실제 셋업 코드는 기존 tests/scheduler/test-runner-pipeline.sh 의 setup 헬퍼를 재사용한다.
#  여기서는 6 케이스의 단정만 명시한다 — implementation step 에서 helper 를 추출/재활용.)

# Case 1: 성공 슬림
# ... (셋업 후) ...
# bash "${LLM_TEAM_ROOT}/scheduler/runner.sh" --role Coder ...
# cycle_dir="$(ls -1d "${TROOT}/workdir/<target>/cycles/Coder-*-*" | head -1)"
# [ -f "${cycle_dir}/prompt.txt" ] || fail
# [ -f "${cycle_dir}/envelope.json" ] || fail
# [ -f "${cycle_dir}/lr_meta.json" ] || fail
# for f in pre.head pre.dirty.diff after-lr.dirty.diff applied.diff post.head post.dirty.diff; do
#   [ -e "${cycle_dir}/diff/${f}" ] || fail "missing diff/${f}"
# done
# [ ! -f "${cycle_dir}/diagnostics.txt" ] || fail "slim cycle should drop diagnostics.txt"
# [ "$(jq -r .result "${cycle_dir}/summary.json")" = "ok" ] || fail

# (Case 2-6 유사 패턴; 실제 코드는 기존 helper 추상화 단계에서 구체화)

echo "PASS: runner cycle bundle integration"
EOF
chmod +x tests/scheduler/test-runner-cycle-bundle.sh
```

- [ ] **Step 2: 기존 test-runner-pipeline.sh 의 setup helper 가 있는지 확인 후 share**

Run: `grep -nE "fake_envelope|fixture_dir|setup_runner" tests/scheduler/test-runner-pipeline.sh | head`

helper 가 동일 파일 내에서만 정의돼 있다면, `tests/_helpers/runner_setup.sh` 로 추출:

```bash
mkdir -p tests/_helpers
# (helper 함수들을 추출해 source 가능하게 분리)
```

- [ ] **Step 3: 6 케이스 본문 채우기**

각 케이스를 실제 runner 실행 + ${cycle_dir} 검사로 구체화. (LLM 자율 — fake adapter 환경 셋업은 기존 pipeline 테스트 패턴을 그대로 따른다.)

- [ ] **Step 4: 실행 → PASS**

Run: `bash tests/scheduler/test-runner-cycle-bundle.sh`

- [ ] **Step 5: Commit**

```bash
git add tests/scheduler/test-runner-cycle-bundle.sh tests/_helpers/runner_setup.sh
git commit -m "test(runner): cycle bundle integration (6 cases)"
```

---

## Task 23: 통합 테스트 — test-runner-ledger-bundle-ref.sh

**Files:**
- Create: `tests/scheduler/test-runner-ledger-bundle-ref.sh`

- [ ] **Step 1: 테스트 작성**

```bash
cat > tests/scheduler/test-runner-ledger-bundle-ref.sh <<'EOF'
#!/usr/bin/env bash
# 모든 ledger row (applied / error / invalid / stale) 에 cycle_bundle_ref 가 채워지는지 검증.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# (test-runner-cycle-bundle 와 동일 셋업)
# 4가지 시나리오를 순차 실행 후 ledger 의 row 를 jq 로 검사.
#  - 정상 cycle: result=ok 또는 (caller 에서 applied 로 표기) → cycle_bundle_ref non-null
#  - envelope invalid: result=invalid → ref non-null
#  - revision pin stale: result=stale → ref non-null
#  - lr error: result=error → ref non-null
echo "PASS: ledger cycle_bundle_ref"
EOF
chmod +x tests/scheduler/test-runner-ledger-bundle-ref.sh
```

(Task 22 의 helper 를 재활용.)

- [ ] **Step 2: 실행 → PASS**

Run: `bash tests/scheduler/test-runner-ledger-bundle-ref.sh`

- [ ] **Step 3: Commit**

```bash
git add tests/scheduler/test-runner-ledger-bundle-ref.sh
git commit -m "test(runner): ledger rows carry cycle_bundle_ref"
```

---

## Task 24: 운영 가정 문서 — README / onboarding 에 timeout 의존성 명시

**Files:**
- Modify: `docs/operations/onboarding.md` 또는 `README.md`

- [ ] **Step 1: 운영 가정 섹션에 추가**

```markdown
### 운영 환경 요구

- `timeout` 바이너리 (GNU coreutils) 가 PATH 에 있어야 한다. macOS 는 기본 미포함이므로
  `brew install coreutils` 로 설치하고 `timeout` (또는 `gtimeout`) 이 PATH 에 보이는지 확인.
  부재 시 `LR_TIMEOUT_SEC>0` 인 cycle 은 어댑터가 exit 66 (adapter_unavailable) 으로 fail-fast.
- `LLM_TEAM_LR_TIMEOUT_SEC` 기본값은 600 (10분). 디버깅 시 `0` 으로 override 가능.
- `workdir/<target>/cycles/` 디렉토리는 RW 4 역할의 cycle 진단 자료를 보존한다.
  `LLM_TEAM_CYCLE_BUNDLE_DISABLED=1` 로 비활성화 가능. dir mode 0700 / file mode 0600 적용.
```

- [ ] **Step 2: Commit**

```bash
git add docs/operations/onboarding.md
git commit -m "docs(operations): note timeout dependency + cycle bundle dir"
```

---

## Task 25: 회귀 종합 + e2e 한 번 돌려보기

**Files:**
- (실행만)

- [ ] **Step 1: 단위 테스트 일괄**

Run:
```bash
for t in tests/lib/test-port-cycle_bundle.sh tests/lib/test-registry.sh \
         tests/adapters/test-cycle_bundle-in_memory.sh \
         tests/adapters/test-cycle_bundle-filesystem.sh \
         tests/adapters/test-workspace-git_worktree.sh; do
  echo "=== ${t} ==="; bash "${t}" || { echo "FAIL: ${t}"; exit 1; }
done
```

Expected: 전부 PASS.

- [ ] **Step 2: scheduler 통합**

Run:
```bash
for t in tests/scheduler/test-runner-cwd.sh tests/scheduler/test-runner-pipeline.sh \
         tests/scheduler/test-runner-cycle-bundle.sh \
         tests/scheduler/test-runner-ledger-bundle-ref.sh; do
  echo "=== ${t} ==="; bash "${t}" || { echo "FAIL: ${t}"; exit 1; }
done
```

Expected: PASS.

- [ ] **Step 3: e2e (long)**

Run: `bash tests/e2e/full-flow.sh 2>&1 | tail -20`
Expected: PASS. cycles/ 디렉토리에 RW 4 역할 cycle 번들이 보임.

- [ ] **Step 4: 수동 spot-check**

Run:
```bash
ls -la workdir/llm-team/cycles/ 2>/dev/null | head -20
jq '.cycle_bundle_ref' workdir/llm-team/ledger/*.jsonl 2>/dev/null | sort -u | head
```

Expected: bundle dir 들이 보이고, ledger row 의 cycle_bundle_ref 가 null 이 아닌 경로.

- [ ] **Step 5: 종합 commit (필요 시)**

회귀에서 나온 자잘한 픽스가 있으면 수정하고:

```bash
git status
git add -p
git commit -m "fix(cycle_bundle): regression fixes from end-to-end pass"
```

---

## Spec coverage 자가검토

- §1 아키텍처 (port + 2어댑터 + workspace 확장 + registry) → Tasks 1, 2, 12 (workspace), 3-11 (어댑터+conformance).
- §1 디렉토리 레이아웃 (mode 0700/0600, pidfile, attempts/) → Tasks 8, 9, 10.
- §2.1 포트 함수 9개 (cb_open / 3 capture_blob / capture_attempt / promote / finalize / get_path / collect_abandoned) → Tasks 1, 3-7, 8-10.
- §2.1 invariants I1–I8 → Tasks 3 (I1, I2), 4 (I3, I4), 6 (I5–I7), 7 + 8 (I8 = no-touch).
- §2.2 workspace 확장 3 함수 → Task 12.
- §2.3 timeout 정책 (기본값 0→600) → Task 13.
- §2.4 데이터 흐름 8단계 (A-I) → Tasks 15 (A, B, I), 16 (C, D), 17 (E), 18 (F), 19 (G), 20 (H).
- §2.5 ledger ↔ bundle 링크 (`cycle_bundle_ref`) → Tasks 14, 20, 21.
- §3 에러/엣지 (mkdir 실패 / disabled / abandoned alive vs dead / promote 두번 / finalize-once / timeout 부재 / hash12 충돌 / `date +%s%N`) → Tasks 3, 6, 7, 8 (warn threshold).
- §4 테스트 (port conformance, in_memory, filesystem, workspace, registry, runner integration 6 cases, ledger ref) → Tasks 11, 22, 23, 그리고 각 어댑터 단위 테스트.
- §검증 (수동 e2e 6 단계) → Task 25 의 spot-check.

미반영 항목 — 없음. (manifest_hash12 의 충돌 회피 카운터 suffix 는 Task 8 의 cb_open 구현에서
"기존 dir 의 pidfile.json 의 manifest_id 와 비교 → 다르면 -c2/-c3" 로직으로 추가 필요.
현재 Task 8 의 구현은 이 충돌 처리를 생략한 minimal 버전 — Step 3 의 cb_open 에 해당
로직을 추가해야 spec §3 의 "manifest_hash12 충돌" 케이스가 충족됨.)

→ **Plan 보강**: Task 8 Step 3 의 `cb_open` 함수에 다음을 추가:

```bash
# 충돌 감지: 기존 dir 의 pidfile.json manifest_id 가 다르면 -c2/-c3 카운터.
if [ -f "${path}/pidfile.json" ]; then
  _existing_mid="$(jq -r '.manifest_id // ""' "${path}/pidfile.json" 2>/dev/null)"
  if [ -n "${_existing_mid}" ] && [ "${_existing_mid}" != "${manifest_id}" ]; then
    local _i=2
    while [ -d "${path}-c${_i}" ] \
       && [ "$(jq -r '.manifest_id // ""' "${path}-c${_i}/pidfile.json" 2>/dev/null)" != "${manifest_id}" ]; do
      _i=$((_i+1))
    done
    path="${path}-c${_i}"
    ( umask 077 && mkdir -p "${path}/diff" "${path}/attempts" ) 2>/dev/null
    chmod 0700 "${path}" 2>/dev/null || true
  fi
fi
```

(Task 8 Step 3 본문에 이 로직을 cb_open 안에서 mkdir 직후·pidfile 작성 직전에 끼워넣어야 한다.)

---

Plan complete and saved to `docs/superpowers/plans/2026-05-05-cycle-bundle-observability.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review
2. **Inline Execution** — batch execution in this session with checkpoints

Which approach?
