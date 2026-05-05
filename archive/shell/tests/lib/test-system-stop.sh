#!/usr/bin/env bash
# tests/lib/test-system-stop.sh
#
# P1-17 / RGC-SIGNALS: `stop` signal at system scope.
#
# Verifies:
#   1. control_state_set accepts STOPPED (lib/signals.sh).
#   2. control_state_blocks_new_leases is true under STOPPED and PAUSED, false
#      under RUNNING.
#   3. lease_claim refuses while STOPPED (defense in depth).
#   4. _human_signal_apply_stop on system kind sets control state to STOPPED
#      without erroring on absence of milestone/issue.
#   5. resume signal flow via control_state_set RUNNING re-opens claims.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/human_signal.sh
. "${LLM_TEAM_ROOT}/application/human_signal.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# Snapshot pre-existing control state so this test does not pollute the global
# workdir/control-state for the rest of the suite.
ORIG_CONTROL_STATE_FILE="${LLM_TEAM_ROOT}/workdir/control-state"
ORIG_CONTROL_STATE_BACKUP=""
if [ -f "${ORIG_CONTROL_STATE_FILE}" ]; then
  ORIG_CONTROL_STATE_BACKUP="$(mktemp)"
  cp "${ORIG_CONTROL_STATE_FILE}" "${ORIG_CONTROL_STATE_BACKUP}"
fi
restore_control() {
  if [ -n "${ORIG_CONTROL_STATE_BACKUP}" ] && [ -f "${ORIG_CONTROL_STATE_BACKUP}" ]; then
    mv "${ORIG_CONTROL_STATE_BACKUP}" "${ORIG_CONTROL_STATE_FILE}" 2>/dev/null || true
  else
    rm -f "${ORIG_CONTROL_STATE_FILE}" 2>/dev/null || true
  fi
}
trap restore_control EXIT

# ── (1)/(2) Control state vocabulary ──────────────────────────────────────
control_state_set RUNNING || fail "control_state_set RUNNING failed"
[ "$(control_state_get)" = "RUNNING" ] || fail "control_state_get RUNNING mismatch"
if control_state_blocks_new_leases; then
  fail "RUNNING: blocks_new_leases must be false"
fi

control_state_set PAUSED || fail "control_state_set PAUSED failed"
control_state_blocks_new_leases || fail "PAUSED: blocks_new_leases must be true"

control_state_set STOPPED || fail "control_state_set STOPPED failed (P1-17)"
control_state_blocks_new_leases || fail "STOPPED: blocks_new_leases must be true"

if control_state_set INVALID_STATE 2>/dev/null; then
  fail "control_state_set must reject unknown state"
fi

# ── (3) lease_claim refuses while STOPPED ─────────────────────────────────
TEST_TARGET="system-stop-test-$$-${RANDOM}"
cleanup_target() { rm -rf "${LLM_TEAM_ROOT}/workdir/${TEST_TARGET}" 2>/dev/null || true; }
trap 'cleanup_target; restore_control' EXIT

control_state_set STOPPED || fail "STOPPED setup failed"
if lease_claim "${TEST_TARGET}" T-stop-1 Implement worker-1 60 '[]' 2>/dev/null; then
  fail "lease_claim must refuse while control state is STOPPED (P1-17)"
fi

control_state_set RUNNING || fail "RUNNING reset failed"
lease_claim "${TEST_TARGET}" T-stop-1 Implement worker-1 60 '[]' >/dev/null 2>&1 \
  || fail "lease_claim must succeed once control state is RUNNING again"

# ── (4) _human_signal_apply_stop system-scope ─────────────────────────────
control_state_set RUNNING
_human_signal_apply_stop "irrelevant/repo" system "irrelevant" \
  || fail "stop@system should succeed and only flip control state"
[ "$(control_state_get)" = "STOPPED" ] \
  || fail "stop@system must set control_state to STOPPED (got '$(control_state_get)')"

# ── (5) Recovery via resume / RUNNING ─────────────────────────────────────
control_state_set RUNNING
[ "$(control_state_get)" = "RUNNING" ] || fail "resume to RUNNING failed"
control_state_blocks_new_leases && fail "after resume, claims must be unblocked"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} system-stop check(s) failed" >&2
  exit 1
fi
echo "PASS: system-stop signal + control_state STOPPED + lease gate"
