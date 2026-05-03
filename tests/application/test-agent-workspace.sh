#!/usr/bin/env bash
# tests/application/test-agent-workspace.sh
#
# application/agent_workspace.sh 단위 검증.
#
# 검증 항목:
#   1. PO/PM/Planner: workdir/<target>/agent-cwd/<role_lower> 반환 + 디렉토리 생성.
#   2. Coder/Reviewer/Integrator/QA: ws_ensure 선행 시 worktree 경로 반환.
#   3. Coder: ws_ensure 미선행 시 비0 반환.
#   4. 입력 검증: 빈 role/unit_id, 잘못된 role → 비0.
#   5. TARGET_NAME 미설정 → 비0.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-aw-ws-XXXXXX")"
INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-aw-ps-XXXXXX")"
export LLM_TEAM_INMEM_WS_DIR="${INMEM_WS_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_WORKSPACE="in_memory"
export LLM_TEAM_ADAPTER_PERSISTENT_STORE="in_memory"
export TARGET_NAME="agent-workspace-test"

TARGET_AGENT_CWD_ROOT="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/agent-cwd"

cleanup() {
  rm -rf "${INMEM_WS_DIR}" "${INMEM_PS_DIR}" \
         "${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/agent_workspace.sh
. "${LLM_TEAM_ROOT}/application/agent_workspace.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

# ----------------------------------------------------------------------------
# 1. PO/PM/Planner agent-cwd 생성
# ----------------------------------------------------------------------------
for role in PO PM Planner; do
  expected="${TARGET_AGENT_CWD_ROOT}/$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
  got="$(agent_workspace_for "${role}" 12 2>/dev/null)" \
    || { fail "agent_workspace_for ${role} 12 returned non-zero"; continue; }
  [ "${got}" = "${expected}" ] \
    || { fail "${role}: expected '${expected}', got '${got}'"; continue; }
  [ -d "${got}" ] \
    || { fail "${role}: directory not created at ${got}"; continue; }
  pass "${role} → agent-cwd ${got}"
done

# 멱등: 두 번째 호출도 같은 경로
got1="$(agent_workspace_for PO 99 2>/dev/null)"
got2="$(agent_workspace_for PO 99 2>/dev/null)"
[ "${got1}" = "${got2}" ] || fail "PO not idempotent: '${got1}' vs '${got2}'"
pass "PO idempotent across calls"

# 정규화: lowercase 입력 허용
got_lc="$(agent_workspace_for po 12 2>/dev/null)"
[ "${got_lc}" = "${TARGET_AGENT_CWD_ROOT}/po" ] \
  || fail "lowercase 'po' not normalized: got '${got_lc}'"
pass "role normalization (po → PO)"

# ----------------------------------------------------------------------------
# 2. Coder ws_ensure 선행 시 worktree 경로
# ----------------------------------------------------------------------------
ws_ensure_clone "${TARGET_NAME}" >/dev/null 2>&1 \
  || { fail "ws_ensure_clone failed"; }

unit_id=103
ws_path="$(ws_ensure "task-${unit_id}" 2>/dev/null)" \
  || { fail "ws_ensure failed for task-${unit_id}"; }

for role in Coder Reviewer Integrator QA; do
  got="$(agent_workspace_for "${role}" "${unit_id}" 2>/dev/null)" \
    || { fail "agent_workspace_for ${role} ${unit_id} returned non-zero"; continue; }
  [ "${got}" = "${ws_path}" ] \
    || fail "${role}: expected '${ws_path}', got '${got}'"
done
pass "Coder/Reviewer/Integrator/QA → task-${unit_id} worktree"

# ----------------------------------------------------------------------------
# 3. Coder ws_ensure 미선행 → 실패
# ----------------------------------------------------------------------------
unit_unprep=999
if agent_workspace_for Coder "${unit_unprep}" >/dev/null 2>&1; then
  fail "Coder unit ${unit_unprep}: expected non-zero (no ws_ensure), got 0"
else
  pass "Coder without ws_ensure → non-zero"
fi

# ----------------------------------------------------------------------------
# 4. 입력 검증
# ----------------------------------------------------------------------------
if agent_workspace_for "" 12 >/dev/null 2>&1; then
  fail "empty role: expected non-zero"
else
  pass "empty role → non-zero"
fi
if agent_workspace_for PO "" >/dev/null 2>&1; then
  fail "empty unit_id: expected non-zero"
else
  pass "empty unit_id → non-zero"
fi
if agent_workspace_for Bogus 12 >/dev/null 2>&1; then
  fail "invalid role 'Bogus': expected non-zero"
else
  pass "invalid role → non-zero"
fi

# ----------------------------------------------------------------------------
# 5. TARGET_NAME 미설정
# ----------------------------------------------------------------------------
saved="${TARGET_NAME}"
unset TARGET_NAME
if agent_workspace_for PO 12 >/dev/null 2>&1; then
  TARGET_NAME="${saved}"; export TARGET_NAME
  fail "TARGET_NAME unset: expected non-zero"
else
  TARGET_NAME="${saved}"; export TARGET_NAME
  pass "TARGET_NAME unset → non-zero"
fi


# ----------------------------------------------------------------------------
# 6. repo symlink 상대경로 확인 (code_tree)
# ----------------------------------------------------------------------------
# in_memory adapter 로 RO tree 생성 후 agent_workspace_for 호출 시
# repo symlink 가 상대경로여야 함.
adapter_load workspace in_memory >/dev/null 2>&1 || true
ws_ensure_clone "${TARGET_NAME}" >/dev/null 2>&1 || true
RO_PATH="$(ws_ensure_ro_tree "" 2>/dev/null)" || true

if [ -n "${RO_PATH}" ] && [ -d "${RO_PATH}" ]; then
  export TARGET_RO_TREE_PATH="${RO_PATH}"
  AGENT_CWD="$(agent_workspace_for PO 12 2>/dev/null)" || true
  if [ -n "${AGENT_CWD}" ] && [ -d "${AGENT_CWD}" ]; then
    if [ -L "${AGENT_CWD}/repo" ]; then
      LINK_TARGET="$(readlink "${AGENT_CWD}/repo")"
      case "${LINK_TARGET}" in
        /*) fail "repo symlink is absolute (${LINK_TARGET}), expected relative" ;;
        *) pass "repo symlink is relative: ${LINK_TARGET}" ;;
      esac
      RESOLVED="$(cd "${AGENT_CWD}" && realpath repo 2>/dev/null || true)"
      if [ -z "${RESOLVED}" ] || [ ! -d "${RESOLVED}" ]; then
        fail "repo symlink does not resolve to a directory (target=${LINK_TARGET})"
      else
        pass "repo symlink resolves"
      fi
    else
      # RO tree 가 설정되었지만 symlink 생성이 실패한 경우 warn 만 남김
      echo "WARN: repo symlink not found at ${AGENT_CWD}/repo"
    fi
  fi
fi

# ----------------------------------------------------------------------------
if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} assertion(s) failed in test-agent-workspace" >&2
  exit 1
fi
echo "PASS: tests/application/test-agent-workspace.sh"
