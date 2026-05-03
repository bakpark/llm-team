#!/usr/bin/env bash
# tests/application/test-workspace-prune.sh
#
# application/workspace_prune.sh unit checks:
#   1. workspace_prune_unit removes an existing unit workspace.
#   2. Missing unit cleanup is idempotent.
#   3. workspace_prune_units attempts every unit.
#   4. Empty required inputs fail.
#   5. Missing ws_destroy binding is treated as a best-effort noop.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-wp-ws-XXXXXX")"
INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-wp-ps-XXXXXX")"
export LLM_TEAM_INMEM_WS_DIR="${INMEM_WS_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_WORKSPACE="in_memory"
export LLM_TEAM_ADAPTER_PERSISTENT_STORE="in_memory"
export TARGET_NAME="workspace-prune-test"

cleanup() {
  rm -rf "${INMEM_WS_DIR}" "${INMEM_PS_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/workspace_prune.sh
. "${LLM_TEAM_ROOT}/application/workspace_prune.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

ws_ensure_clone "${TARGET_NAME}" >/dev/null 2>&1 \
  || { echo "FAIL: ws_ensure_clone failed" >&2; exit 1; }

# ----------------------------------------------------------------------------
# 1. Single-unit prune removes an existing workspace.
# ----------------------------------------------------------------------------
unit_id="task-10"
unit_path="$(ws_ensure "${unit_id}" 2>/dev/null)" \
  || { echo "FAIL: ws_ensure ${unit_id} failed" >&2; exit 1; }
[ -d "${unit_path}" ] || fail "expected workspace directory before prune: ${unit_path}"

if workspace_prune_unit "${TARGET_NAME}" "${unit_id}"; then
  [ ! -d "${unit_path}" ] || fail "workspace_prune_unit did not remove ${unit_path}"
  pass "workspace_prune_unit removes ${unit_id}"
else
  fail "workspace_prune_unit returned non-zero for ${unit_id}"
fi

# Missing unit cleanup remains successful.
if workspace_prune_unit "${TARGET_NAME}" "${unit_id}"; then
  pass "workspace_prune_unit is idempotent for missing ${unit_id}"
else
  fail "workspace_prune_unit missing ${unit_id}: expected zero"
fi

# ----------------------------------------------------------------------------
# 2. Multi-unit prune attempts all units.
# ----------------------------------------------------------------------------
unit_a="task-11"
unit_b="task-12"
path_a="$(ws_ensure "${unit_a}" 2>/dev/null)" \
  || { echo "FAIL: ws_ensure ${unit_a} failed" >&2; exit 1; }
path_b="$(ws_ensure "${unit_b}" 2>/dev/null)" \
  || { echo "FAIL: ws_ensure ${unit_b} failed" >&2; exit 1; }

if workspace_prune_units "${TARGET_NAME}" "${unit_a}" "${unit_b}"; then
  [ ! -d "${path_a}" ] || fail "workspace_prune_units did not remove ${path_a}"
  [ ! -d "${path_b}" ] || fail "workspace_prune_units did not remove ${path_b}"
  pass "workspace_prune_units removes all requested units"
else
  fail "workspace_prune_units returned non-zero"
fi

# ----------------------------------------------------------------------------
# 3. Input validation.
# ----------------------------------------------------------------------------
if workspace_prune_unit "" "${unit_a}" >/dev/null 2>&1; then
  fail "workspace_prune_unit empty target: expected non-zero"
else
  pass "workspace_prune_unit empty target -> non-zero"
fi

if workspace_prune_unit "${TARGET_NAME}" "" >/dev/null 2>&1; then
  fail "workspace_prune_unit empty unit_id: expected non-zero"
else
  pass "workspace_prune_unit empty unit_id -> non-zero"
fi

if workspace_prune_units "${TARGET_NAME}" >/dev/null 2>&1; then
  fail "workspace_prune_units without units: expected non-zero"
else
  pass "workspace_prune_units without units -> non-zero"
fi

# ----------------------------------------------------------------------------
# 4. Missing ws_destroy binding is a best-effort noop.
# ----------------------------------------------------------------------------
unset -f ws_destroy
if workspace_prune_unit "${TARGET_NAME}" "task-no-binding" >/dev/null 2>&1; then
  pass "missing ws_destroy binding -> noop success"
else
  fail "missing ws_destroy binding: expected zero"
fi

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} assertion(s) failed in test-workspace-prune" >&2
  exit 1
fi
echo "PASS: tests/application/test-workspace-prune.sh"
