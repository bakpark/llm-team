#!/usr/bin/env bash
# tests/adapters/test-persistent_store-in_memory.sh
#
# adapters/persistent_store/in_memory.sh 단위 검증.
#
# 검증 항목:
#   1. registry_load_adapter 가 in_memory adapter 를 정상 source + verify.
#   2. ps_namespace_init / ps_put / ps_get / ps_exists / ps_list_ids /
#      ps_delete round-trip.
#   3. ps_append_log / ps_read_log JSON-only 검증 + 라인 수.
#   4. ps_lock_acquire 두 번 → 두 번째 contended; release 후 재 acquire OK.
#   5. 데이터가 LLM_TEAM_INMEM_PS_DIR 아래에만 기록되어 ${LLM_TEAM_ROOT}/workdir
#      을 오염시키지 않음을 확인 (격리 시나리오).
#   6. LLM_TEAM_INMEM_PS_DIR 미설정 상태에서 첫 호출 시 mktemp -d 후 export
#      되는지 확인.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# 테스트 격리: 이 테스트만의 in-memory 루트를 미리 mktemp 로 만들고,
# trap 으로 정리한다.
TEST_INMEM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ps-inmem-XXXXXX")"
export LLM_TEAM_INMEM_PS_DIR="${TEST_INMEM_ROOT}"

cleanup() {
  rm -rf "${TEST_INMEM_ROOT}" 2>/dev/null || true
  if [ -n "${SECOND_INMEM_ROOT:-}" ]; then
    rm -rf "${SECOND_INMEM_ROOT}" 2>/dev/null || true
  fi
  if [ -n "${AUTO_INMEM_ROOT:-}" ]; then
    rm -rf "${AUTO_INMEM_ROOT}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# common.sh 는 default adapter (filesystem) 를 로드한다 — 이후 in_memory 로
# 명시적으로 다시 바인딩한다.
# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# (1) Adapter 로드 + port verification
# ----------------------------------------------------------------------------
registry_load_adapter persistent_store in_memory \
  || fail "registry_load_adapter persistent_store in_memory failed"
[ "${LLM_TEAM_ACTIVE_PERSISTENT_STORE_ADAPTER:-}" = "in_memory" ] \
  || fail "active adapter not switched to in_memory (got: '${LLM_TEAM_ACTIVE_PERSISTENT_STORE_ADAPTER:-}')"
registry_verify_port persistent_store \
  || fail "registry_verify_port persistent_store failed after rebind"

# ----------------------------------------------------------------------------
# (2) put/get/exists/list_ids/delete round-trip
# ----------------------------------------------------------------------------
ns="ps-inmem-test-$$"
ps_namespace_init "${ns}" || fail "ps_namespace_init failed"

ps_put "${ns}" obj-1 '{"k":"v1"}' || fail "ps_put obj-1 failed"
ps_put "${ns}" obj-2 '{"k":"v2"}' || fail "ps_put obj-2 failed"
ps_put "${ns}" obj-3 '{"k":"v3"}' || fail "ps_put obj-3 failed"

got="$(ps_get "${ns}" obj-2 || echo MISSING)"
[ "$(printf '%s' "${got}" | jq -r '.k')" = "v2" ] \
  || fail "ps_get round-trip mismatch (got=${got})"

ps_exists "${ns}" obj-1 || fail "ps_exists should be 0 for present id"
if ps_exists "${ns}" obj-missing 2>/dev/null; then
  fail "ps_exists should be non-zero for missing id"
fi

# ps_get 부재 케이스: 비0, stdout 비어있음
got_missing="$(ps_get "${ns}" obj-missing 2>/dev/null || true)"
[ -z "${got_missing}" ] || fail "ps_get for missing should produce empty stdout (got=${got_missing})"

# list_ids: 3개, 생성 순(mtime 오름차순) 정렬
ids="$(ps_list_ids "${ns}" | tr '\n' ' ' | sed 's/ $//')"
[ "${ids}" = "obj-1 obj-2 obj-3" ] \
  || fail "ps_list_ids order mismatch (got='${ids}', expected 'obj-1 obj-2 obj-3')"

# 멱등 put → 같은 결과
ps_put "${ns}" obj-1 '{"k":"v1-updated"}' || fail "ps_put overwrite failed"
got="$(ps_get "${ns}" obj-1 || echo MISSING)"
[ "$(printf '%s' "${got}" | jq -r '.k')" = "v1-updated" ] \
  || fail "ps_put overwrite did not take effect (got=${got})"

# delete + 재확인
ps_delete "${ns}" obj-2 || fail "ps_delete obj-2 failed"
if ps_exists "${ns}" obj-2 2>/dev/null; then
  fail "ps_exists should be non-zero after delete"
fi
# delete 부재 id → 0 (best-effort)
ps_delete "${ns}" obj-never-existed || fail "ps_delete for missing id should be 0 (best-effort)"

# 잘못된 JSON → 비0
if ps_put "${ns}" obj-bad 'not-json' 2>/dev/null; then
  fail "ps_put should reject non-JSON payload"
fi

# ----------------------------------------------------------------------------
# (3) append_log / read_log
# ----------------------------------------------------------------------------
log_ns="${ns}/events"
ps_append_log "${log_ns}" '{"event":"a"}' || fail "ps_append_log a failed"
ps_append_log "${log_ns}" '{"event":"b"}' || fail "ps_append_log b failed"
ps_append_log "${log_ns}" '{"event":"c"}' || fail "ps_append_log c failed"
lines="$(ps_read_log "${log_ns}" | wc -l | tr -d ' ')"
[ "${lines}" = "3" ] || fail "ps_read_log expected 3 lines, got ${lines}"
first_event="$(ps_read_log "${log_ns}" | head -n 1 | jq -r '.event')"
[ "${first_event}" = "a" ] || fail "ps_read_log first line event mismatch (got=${first_event})"

# 잘못된 JSON line → 비0
if ps_append_log "${log_ns}" 'still-not-json' 2>/dev/null; then
  fail "ps_append_log should reject non-JSON line"
fi

# ----------------------------------------------------------------------------
# (4) lock_acquire / lock_release
# ----------------------------------------------------------------------------
lock_ns="${ns}/locks"
ps_lock_acquire "${lock_ns}" task-1 || fail "ps_lock_acquire first call should succeed"
if ps_lock_acquire "${lock_ns}" task-1 2>/dev/null; then
  fail "ps_lock_acquire second call should be contended"
fi
# 다른 id 는 영향 없음
ps_lock_acquire "${lock_ns}" task-2 || fail "ps_lock_acquire on different id should succeed"
ps_lock_release "${lock_ns}" task-2 || fail "ps_lock_release task-2 failed"

ps_lock_release "${lock_ns}" task-1 || fail "ps_lock_release task-1 failed"
ps_lock_acquire "${lock_ns}" task-1 \
  || fail "ps_lock_acquire after release should succeed"
ps_lock_release "${lock_ns}" task-1 || fail "ps_lock_release task-1 (2) failed"

# ----------------------------------------------------------------------------
# (5) 격리 검증 — 모든 데이터는 LLM_TEAM_INMEM_PS_DIR 아래에만 기록.
# ----------------------------------------------------------------------------
[ -f "${LLM_TEAM_INMEM_PS_DIR}/${ns}/obj-1.json" ] \
  || fail "ps_put did not write to LLM_TEAM_INMEM_PS_DIR (expected ${LLM_TEAM_INMEM_PS_DIR}/${ns}/obj-1.json)"
[ -f "${LLM_TEAM_INMEM_PS_DIR}/${log_ns}.jsonl" ] \
  || fail "ps_append_log did not write to LLM_TEAM_INMEM_PS_DIR (expected ${LLM_TEAM_INMEM_PS_DIR}/${log_ns}.jsonl)"
# ${LLM_TEAM_ROOT}/workdir 은 오염되지 않아야 한다.
if [ -e "${LLM_TEAM_ROOT}/workdir/${ns}" ]; then
  fail "in_memory adapter leaked into ${LLM_TEAM_ROOT}/workdir/${ns}"
fi

# 두 번째 in-memory root 로 swap → 같은 ns 가 비어있는지 확인 (격리 입증).
SECOND_INMEM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ps-inmem2-XXXXXX")"
export LLM_TEAM_INMEM_PS_DIR="${SECOND_INMEM_ROOT}"
got_other="$(ps_list_ids "${ns}" | tr '\n' ' ' | sed 's/ $//')"
[ -z "${got_other}" ] \
  || fail "second inmem root should be empty for ns=${ns} (got='${got_other}')"

# 첫 번째 root 로 복귀 → 데이터가 그대로 살아있어야 한다.
export LLM_TEAM_INMEM_PS_DIR="${TEST_INMEM_ROOT}"
got_back="$(ps_get "${ns}" obj-1 | jq -r '.k')"
[ "${got_back}" = "v1-updated" ] \
  || fail "after rebinding LLM_TEAM_INMEM_PS_DIR back, data should persist (got='${got_back}')"

# ----------------------------------------------------------------------------
# (6) LLM_TEAM_INMEM_PS_DIR auto-create — 미설정 상태에서 adapter 를 source
# 하면 mktemp -d 로 root 가 생성·export 된다. 별도 subshell 에서 검증한다
# (현재 셸의 LLM_TEAM_INMEM_PS_DIR 을 보존하기 위함).
# ----------------------------------------------------------------------------
auto_root="$(env -u LLM_TEAM_INMEM_PS_DIR \
  bash -c '
    export LLM_TEAM_ROOT='"'${LLM_TEAM_ROOT}'"'
    . "${LLM_TEAM_ROOT}/lib/common.sh" >/dev/null 2>&1
    registry_load_adapter persistent_store in_memory >/dev/null 2>&1
    ps_namespace_init "auto-create-ns-$$" >/dev/null 2>&1 || exit 7
    printf "%s" "${LLM_TEAM_INMEM_PS_DIR:-UNSET}"
  ')" || fail "auto-create subshell exited non-zero"
case "${auto_root}" in
  /*)
    [ -d "${auto_root}" ] \
      || fail "auto-created LLM_TEAM_INMEM_PS_DIR does not exist (got=${auto_root})"
    AUTO_INMEM_ROOT="${auto_root}"
    ;;
  *)
    fail "LLM_TEAM_INMEM_PS_DIR not auto-created (got='${auto_root}')"
    ;;
esac

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} in_memory persistent_store check(s) failed" >&2
  exit 1
fi

echo "PASS: persistent_store in_memory adapter (round-trip + log + lock + isolation)"
