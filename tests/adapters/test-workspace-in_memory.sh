#!/usr/bin/env bash
# tests/adapters/test-workspace-in_memory.sh
#
# adapters/workspace/in_memory.sh 단위 검증.
#
# 시나리오:
#   1. registry rebind + verify
#   2. ws_ensure_clone → integration head/base 초기화 + clone 디렉토리
#   3. ws_ensure 두 번 호출 → 같은 경로 (멱등)
#   4. ws_apply_patch → 파일 생성 + content 검증; 잘못된 형식 reject
#   5. 멱등 patch 재적용 → 같은 결과 (overwrite, head sha 동일)
#   6. ws_publish_branch → branch head/base 기록, .published 마커
#   7. ws_get_branch_head/_base → publish 한 sha 반환
#   8. 다른 patch 적용 → re-publish → head sha 변경
#   9. integration head 는 unit publish 영향 받지 않음
#  10. ws_path_of, ws_list, ws_destroy
#  11. 격리: LLM_TEAM_INMEM_WS_DIR swap → 데이터 분리

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# 테스트 격리: 자체 mktemp 루트 사용 + cleanup trap.
TEST_INMEM_WS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ws-inmem-XXXXXX")"
export LLM_TEAM_INMEM_WS_DIR="${TEST_INMEM_WS_ROOT}"
SECOND_INMEM_WS_ROOT=""
AUTO_INMEM_WS_ROOT=""

cleanup() {
  rm -rf "${TEST_INMEM_WS_ROOT}" 2>/dev/null || true
  [ -n "${SECOND_INMEM_WS_ROOT}" ] && rm -rf "${SECOND_INMEM_WS_ROOT}" 2>/dev/null || true
  [ -n "${AUTO_INMEM_WS_ROOT}" ] && rm -rf "${AUTO_INMEM_WS_ROOT}" 2>/dev/null || true
}
trap cleanup EXIT

# common.sh 는 default adapter (git_worktree) 를 로드한다 — 이후 in_memory 로
# 명시적으로 다시 바인딩한다.
# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# Adapter 가 implicit context 로 참조하는 TARGET_NAME 설정.
export TARGET_NAME="ws-inmem-test-$$"
export LLM_TEAM_INTEGRATION_BRANCH="integration"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# (1) Adapter 로드 + port verification
# ----------------------------------------------------------------------------
registry_load_adapter workspace in_memory \
  || fail "registry_load_adapter workspace in_memory failed"
[ "${LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER:-}" = "in_memory" ] \
  || fail "active adapter not switched to in_memory (got: '${LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER:-}')"
registry_verify_port workspace \
  || fail "registry_verify_port workspace failed after rebind"

# ----------------------------------------------------------------------------
# (2) ws_ensure_clone — clone 경로 + integration 초기 sha
# ----------------------------------------------------------------------------
clone_path="$(ws_ensure_clone "${TARGET_NAME}")" \
  || fail "ws_ensure_clone failed"
[ -d "${clone_path}" ] || fail "ws_ensure_clone did not create clone dir (got=${clone_path})"
case "${clone_path}" in
  "${TEST_INMEM_WS_ROOT}/${TARGET_NAME}/repo") ;;
  *) fail "ws_ensure_clone path under wrong root (got=${clone_path})" ;;
esac

integration_head="$(ws_get_branch_head "${TARGET_NAME}" "integration")" \
  || fail "ws_get_branch_head integration failed after ws_ensure_clone"
integration_base="$(ws_get_branch_base "${TARGET_NAME}" "integration")" \
  || fail "ws_get_branch_base integration failed after ws_ensure_clone"
[ -n "${integration_head}" ] || fail "integration head sha empty"
[ "${integration_head}" = "${integration_base}" ] \
  || fail "integration head and base should match at init (head=${integration_head} base=${integration_base})"

# 결정성: 같은 target 으로 다시 init 해도 동일 sha (이미 존재 → no-op).
ws_ensure_clone "${TARGET_NAME}" >/dev/null \
  || fail "ws_ensure_clone idempotent call failed"
integration_head_2="$(ws_get_branch_head "${TARGET_NAME}" "integration")"
[ "${integration_head_2}" = "${integration_head}" ] \
  || fail "integration head should not change on idempotent ws_ensure_clone"

# ----------------------------------------------------------------------------
# (3) ws_ensure 두 번 호출 → 같은 경로 (idempotent)
# ----------------------------------------------------------------------------
unit_id="task-1"
wt_path="$(ws_ensure "${unit_id}")" \
  || fail "ws_ensure ${unit_id} failed"
[ -d "${wt_path}" ] || fail "ws_ensure did not create workspace (got=${wt_path})"
[ -f "${wt_path}/.inmem-meta.json" ] || fail "ws_ensure missed .inmem-meta.json"
meta_branch="$(jq -r '.branch' "${wt_path}/.inmem-meta.json")"
[ "${meta_branch}" = "llm-team/${unit_id}" ] \
  || fail ".inmem-meta.json branch mismatch (got=${meta_branch})"
meta_base_sha="$(jq -r '.base_sha' "${wt_path}/.inmem-meta.json")"
[ "${meta_base_sha}" = "${integration_head}" ] \
  || fail ".inmem-meta.json base_sha should snapshot integration head (got=${meta_base_sha})"

wt_path_2="$(ws_ensure "${unit_id}")" \
  || fail "ws_ensure idempotent call failed"
[ "${wt_path_2}" = "${wt_path}" ] \
  || fail "ws_ensure should be idempotent (got first=${wt_path}, second=${wt_path_2})"

# ----------------------------------------------------------------------------
# (4) ws_apply_patch — 파일 생성 + 잘못된 형식 reject
# ----------------------------------------------------------------------------
patch_v1='[
  {"path": "src/main.sh", "content": "#!/bin/bash\necho hello\n"},
  {"path": "README.md",   "content": "# Hello\n"}
]'
ws_apply_patch "${unit_id}" "${patch_v1}" \
  || fail "ws_apply_patch v1 failed"
[ -f "${wt_path}/src/main.sh" ] \
  || fail "ws_apply_patch did not create src/main.sh"
[ -f "${wt_path}/README.md" ] \
  || fail "ws_apply_patch did not create README.md"
expected_main_file="${TEST_INMEM_WS_ROOT}/expected-main.sh"
printf '%s' $'#!/bin/bash\necho hello\n' >"${expected_main_file}"
cmp -s "${wt_path}/src/main.sh" "${expected_main_file}" \
  || fail "src/main.sh content mismatch (expected to match ${expected_main_file})"

# 잘못된 JSON 구조 → reject
if ws_apply_patch "${unit_id}" 'not-json' 2>/dev/null; then
  fail "ws_apply_patch should reject non-JSON payload"
fi
if ws_apply_patch "${unit_id}" '{"path":"a","content":"b"}' 2>/dev/null; then
  fail "ws_apply_patch should reject non-array JSON"
fi
if ws_apply_patch "${unit_id}" '[{"path":"x"}]' 2>/dev/null; then
  fail "ws_apply_patch should reject entry without content"
fi
# Path traversal 거부
if ws_apply_patch "${unit_id}" '[{"path":"../escape","content":"x"}]' 2>/dev/null; then
  fail "ws_apply_patch should reject parent-traversal path"
fi
if ws_apply_patch "${unit_id}" '[{"path":"/abs","content":"x"}]' 2>/dev/null; then
  fail "ws_apply_patch should reject absolute path"
fi
# 잘못된 entry 가 있을 때 부분 적용도 없어야 함 (I2: 실패 시 롤백).
[ ! -f "${wt_path}/escape" ] || fail "rejected patch should not create files"

# 파일 인자도 지원
patch_file="${TEST_INMEM_WS_ROOT}/patch-from-file.json"
printf '%s' "${patch_v1}" >"${patch_file}"
ws_apply_patch "${unit_id}" "${patch_file}" \
  || fail "ws_apply_patch from file failed"

# ----------------------------------------------------------------------------
# (5) 멱등성: 같은 patch 두 번 → 같은 head sha
# ----------------------------------------------------------------------------
sha_after_v1="$(ws_publish_branch "${unit_id}" >/dev/null && \
  ws_get_branch_head "${TARGET_NAME}" "llm-team/${unit_id}")" \
  || fail "ws_publish_branch failed"
ws_apply_patch "${unit_id}" "${patch_v1}" \
  || fail "ws_apply_patch second time failed"
ws_publish_branch "${unit_id}" >/dev/null \
  || fail "ws_publish_branch second time failed"
sha_after_v1_again="$(ws_get_branch_head "${TARGET_NAME}" "llm-team/${unit_id}")"
[ "${sha_after_v1}" = "${sha_after_v1_again}" ] \
  || fail "head sha should be identical for identical patches (got first=${sha_after_v1}, second=${sha_after_v1_again})"

# ----------------------------------------------------------------------------
# (6) ws_publish_branch — .published 마커, head/base 기록
# ----------------------------------------------------------------------------
[ -f "${wt_path}/.published" ] || fail "ws_publish_branch did not write .published marker"
published_branch="$(head -n 1 "${wt_path}/.published")"
[ "${published_branch}" = "llm-team/${unit_id}" ] \
  || fail ".published branch mismatch (got=${published_branch})"

published_base="$(ws_get_branch_base "${TARGET_NAME}" "llm-team/${unit_id}")" \
  || fail "ws_get_branch_base for published branch failed"
[ "${published_base}" = "${integration_head}" ] \
  || fail "published base_sha should equal integration head at ensure time (got=${published_base})"

# ----------------------------------------------------------------------------
# (7) 다른 patch → re-publish → head sha 변경
# ----------------------------------------------------------------------------
patch_v2='[
  {"path": "src/main.sh", "content": "#!/bin/bash\necho world\n"},
  {"path": "README.md",   "content": "# Hello v2\n"}
]'
ws_apply_patch "${unit_id}" "${patch_v2}" \
  || fail "ws_apply_patch v2 failed"
ws_publish_branch "${unit_id}" >/dev/null \
  || fail "ws_publish_branch after v2 failed"
sha_after_v2="$(ws_get_branch_head "${TARGET_NAME}" "llm-team/${unit_id}")"
[ "${sha_after_v2}" != "${sha_after_v1}" ] \
  || fail "head sha should change after content change (still=${sha_after_v2})"
# base_sha 는 그대로 (분기 base 는 ws_ensure 시점에 고정).
published_base_2="$(ws_get_branch_base "${TARGET_NAME}" "llm-team/${unit_id}")"
[ "${published_base_2}" = "${integration_head}" ] \
  || fail "published base_sha should remain stable across re-publish (got=${published_base_2})"

# ----------------------------------------------------------------------------
# (8) integration head 는 unit publish 영향 없음
# ----------------------------------------------------------------------------
integration_head_after="$(ws_get_branch_head "${TARGET_NAME}" "integration")"
[ "${integration_head_after}" = "${integration_head}" ] \
  || fail "integration head should not change due to unit publish (was=${integration_head}, now=${integration_head_after})"

# ----------------------------------------------------------------------------
# (9) ws_path_of, ws_list, ws_destroy
# ----------------------------------------------------------------------------
[ "$(ws_path_of "${unit_id}")" = "${wt_path}" ] \
  || fail "ws_path_of mismatch for existing unit"
[ -z "$(ws_path_of "nonexistent-unit")" ] \
  || fail "ws_path_of should be empty for missing unit"

# 두 번째 unit 추가 → list 정렬 확인
unit_id_2="task-2"
ws_ensure "${unit_id_2}" >/dev/null || fail "ws_ensure ${unit_id_2} failed"
listed="$(ws_list "${TARGET_NAME}" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
[ "${listed}" = "${unit_id} ${unit_id_2}" ] \
  || fail "ws_list output mismatch (got='${listed}')"

ws_destroy "${unit_id_2}" || fail "ws_destroy failed"
[ -z "$(ws_path_of "${unit_id_2}")" ] \
  || fail "ws_path_of should be empty after ws_destroy"
ws_destroy "never-existed" || fail "ws_destroy should be 0 for missing unit (best-effort)"

# ----------------------------------------------------------------------------
# (10) ws_get_branch_head/base — 모르는 branch 는 비0
# ----------------------------------------------------------------------------
if ws_get_branch_head "${TARGET_NAME}" "branch-never-published" 2>/dev/null; then
  fail "ws_get_branch_head should fail for unknown branch"
fi
if ws_get_branch_base "${TARGET_NAME}" "branch-never-published" 2>/dev/null; then
  fail "ws_get_branch_base should fail for unknown branch"
fi
# 인자 검증
if ws_get_branch_head "" "x" 2>/dev/null; then
  fail "ws_get_branch_head should fail with empty repo"
fi
if ws_get_branch_head "x" "" 2>/dev/null; then
  fail "ws_get_branch_head should fail with empty branch"
fi

# ----------------------------------------------------------------------------
# (11) 격리 — 두 번째 in-memory root 로 swap → 같은 unit 이 보이지 않아야 함
# ----------------------------------------------------------------------------
SECOND_INMEM_WS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ws-inmem2-XXXXXX")"
export LLM_TEAM_INMEM_WS_DIR="${SECOND_INMEM_WS_ROOT}"
got_other="$(ws_list "${TARGET_NAME}" | tr '\n' ' ' | sed 's/ $//')"
[ -z "${got_other}" ] \
  || fail "second inmem ws root should be empty (got='${got_other}')"

# 첫 번째 root 로 복귀 → 데이터 잔존
export LLM_TEAM_INMEM_WS_DIR="${TEST_INMEM_WS_ROOT}"
got_back="$(ws_path_of "${unit_id}")"
[ "${got_back}" = "${wt_path}" ] \
  || fail "after rebinding root, unit should still be visible (got='${got_back}')"

# 어떤 단계에서도 ${LLM_TEAM_ROOT}/workdir 을 오염시키지 않아야 함.
if [ -e "${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/wt" ]; then
  fail "in_memory adapter leaked into ${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/wt"
fi

# ----------------------------------------------------------------------------
# (12) Auto-create — LLM_TEAM_INMEM_WS_DIR 미설정 시 source 시점에 mktemp -d.
# ----------------------------------------------------------------------------
auto_root="$(env -u LLM_TEAM_INMEM_WS_DIR \
  bash -c '
    export LLM_TEAM_ROOT='"'${LLM_TEAM_ROOT}'"'
    export TARGET_NAME=auto-target
    . "${LLM_TEAM_ROOT}/lib/common.sh" >/dev/null 2>&1
    registry_load_adapter workspace in_memory >/dev/null 2>&1
    ws_ensure_clone "${TARGET_NAME}" >/dev/null 2>&1 || exit 7
    printf "%s" "${LLM_TEAM_INMEM_WS_DIR:-UNSET}"
  ')" || fail "auto-create subshell exited non-zero"
case "${auto_root}" in
  /*)
    [ -d "${auto_root}" ] \
      || fail "auto-created LLM_TEAM_INMEM_WS_DIR does not exist (got=${auto_root})"
    [ -d "${auto_root}/auto-target/repo" ] \
      || fail "ws_ensure_clone did not create clone dir under auto-created root"
    AUTO_INMEM_WS_ROOT="${auto_root}"
    ;;
  *)
    fail "LLM_TEAM_INMEM_WS_DIR not auto-created (got='${auto_root}')"
    ;;
esac


# ----------------------------------------------------------------------------

# ----------------------------------------------------------------------------
# ws_ensure_ro_tree + ws_ro_tree_revision_pin
# ----------------------------------------------------------------------------
# canonical clone 필요 — ws_ensure_clone 호출 (멱등이므로 안전)
ws_ensure_clone "${TARGET_NAME}" >/dev/null 2>&1 || true

RO_PATH="$(ws_ensure_ro_tree "" 2>/dev/null)" || \
  fail "ws_ensure_ro_tree failed (empty target, should use TARGET_NAME)"
[ -n "${RO_PATH}" ] || fail "ws_ensure_ro_tree returned empty path"
[ -d "${RO_PATH}" ] || fail "RO tree dir missing at ${RO_PATH}"

RO_PIN="$(ws_ro_tree_revision_pin "" 2>/dev/null)" || \
  fail "ws_ro_tree_revision_pin failed"
[ -n "${RO_PIN}" ] || fail "ws_ro_tree_revision_pin returned empty SHA"

# idempotence: 두 번째 호출 시 동일 pin 반환
ws_ensure_ro_tree "" >/dev/null 2>&1 || true
RO_PIN_2="$(ws_ro_tree_revision_pin "" 2>/dev/null)" || true
if [ "${RO_PIN}" != "${RO_PIN_2}" ]; then
  fail "RO tree idempotence failed: ${RO_PIN} vs ${RO_PIN_2}"
fi
# ----------------------------------------------------------------------------
# ----------------------------------------------------------------------------
if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} in_memory workspace check(s) failed" >&2
  exit 1
fi

echo "PASS: workspace in_memory adapter (ensure + patch + publish + branch sha + isolation)"
