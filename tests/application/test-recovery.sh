#!/usr/bin/env bash
# tests/application/test-recovery.sh
#
# Phase 8 — application/recovery.sh 단위 테스트.
#
# 검증:
#   1. 만료 lease (Decompose) → milestone DECOMPOSE_IN_PROGRESS → DECOMPOSE_READY,
#      lease 파일 삭제, ledger 'recovered' 행 1건.
#   2. 만료 lease (Implement) → issue TASK_IN_PROGRESS → TASK_READY.
#   3. 만료 lease (Compose-PO) → 상태 변경 없이 lease 파일만 삭제 + ledger row.
#   4. 미만료 lease → 영향 없음 (lease 파일 그대로, 상태 그대로).
#   5. lib/stale.sh.run_stale_recovery 가 recovery_scan 으로 위임됨.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="recovery-test-$$"
export TARGET_NAME
TEST_INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rec-it-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${TEST_INMEM_IT_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}"

cleanup() {
  rm -rf "${TEST_INMEM_IT_DIR}" "${TARGET_WORKDIR}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/recovery.sh
. "${LLM_TEAM_ROOT}/application/recovery.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

REPO="acme/widgets"
LEDGER_PATH="$(transition_ledger_path "${TARGET_NAME}")"

ledger_count_with_result() {
  local r="$1"
  [ -f "${LEDGER_PATH}" ] || { printf '0'; return; }
  jq -c --arg r "${r}" 'select(.result == $r)' "${LEDGER_PATH}" 2>/dev/null \
    | wc -l | tr -d ' '
}

# Build a lease file directly (skipping lease_claim) so we can control expiry.
write_lease_file() {
  local target="$1" object_id="$2" operation="$3" expires_epoch="$4"
  local dir; dir="$(lease_dir "${target}")"
  mkdir -p "${dir}"
  jq -n \
    --arg lease_id "test-${object_id}-${operation}" \
    --arg object_id "${object_id}" \
    --arg operation "${operation}" \
    --arg worker_id "test-worker" \
    --arg claimed_at "2026-01-01T00:00:00Z" \
    --arg expires_at "2026-01-01T00:00:00Z" \
    --argjson expires_epoch "${expires_epoch}" \
    '{
       lease_id: $lease_id, object_id: $object_id, operation: $operation,
       worker_id: $worker_id, claimed_at: $claimed_at,
       expires_at: $expires_at, expires_epoch: $expires_epoch,
       input_revision_pins: []
     }' >"${dir}/${object_id}.json"
}

# ----------------------------------------------------------------------------
# Scenario 1: Decompose lease expired → milestone DECOMPOSE_IN_PROGRESS → READY
# ----------------------------------------------------------------------------
ms1="$(it_milestone_create "${REPO}" 'recover decompose' 'body' 2>/dev/null)" \
  || fail "seed1: milestone_create failed"
it_milestone_set_state "${REPO}" "${ms1}" DECOMPOSE_IN_PROGRESS \
  || fail "seed1: set_state DECOMPOSE_IN_PROGRESS failed"
write_lease_file "${TARGET_NAME}" "${ms1}" "Decompose" "1"   # epoch=1 → expired

before="$(ledger_count_with_result recovered)"
recovery_scan "${TARGET_NAME}" "${REPO}" || fail "scenario1: recovery_scan returned nonzero"
state="$(it_milestone_get_state "${REPO}" "${ms1}")"
[ "${state}" = "DECOMPOSE_READY" ] \
  || fail "scenario1: state expected DECOMPOSE_READY, got '${state}'"
[ ! -f "$(lease_dir "${TARGET_NAME}")/${ms1}.json" ] \
  || fail "scenario1: lease file not removed"
after="$(ledger_count_with_result recovered)"
[ "${after}" -gt "${before}" ] \
  || fail "scenario1: ledger 'recovered' row not written"
pass "scenario1: Decompose lease → milestone rolled back to DECOMPOSE_READY"

# ----------------------------------------------------------------------------
# Scenario 2: Implement lease expired → issue TASK_IN_PROGRESS → TASK_READY
# ----------------------------------------------------------------------------
issue1="$(it_issue_create "${REPO}" --title 'task' --body 'body' --labels '' 2>/dev/null)" \
  || fail "seed2: issue_create failed"
it_issue_set_state "${REPO}" "${issue1}" TASK_IN_PROGRESS \
  || fail "seed2: set_state TASK_IN_PROGRESS failed"
write_lease_file "${TARGET_NAME}" "${issue1}" "Implement" "1"

before="$(ledger_count_with_result recovered)"
recovery_scan "${TARGET_NAME}" "${REPO}" || fail "scenario2: recovery_scan returned nonzero"
istate="$(it_issue_get_state "${REPO}" "${issue1}" 2>/dev/null)"
[ "${istate}" = "TASK_READY" ] \
  || fail "scenario2: issue state expected TASK_READY, got '${istate}'"
after="$(ledger_count_with_result recovered)"
[ "${after}" -gt "${before}" ] || fail "scenario2: ledger 'recovered' row not written"
pass "scenario2: Implement lease → issue rolled back to TASK_READY"

# ----------------------------------------------------------------------------
# Scenario 3: Compose-PO lease expired → no state rollback, but lease removed.
# ----------------------------------------------------------------------------
ms_po="$(it_milestone_create "${REPO}" 'po draft' 'body' 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms_po}" PO_DRAFT
write_lease_file "${TARGET_NAME}" "${ms_po}" "Compose-PO" "1"

before="$(ledger_count_with_result recovered)"
recovery_scan "${TARGET_NAME}" "${REPO}" || fail "scenario3: recovery_scan returned nonzero"
po_state="$(it_milestone_get_state "${REPO}" "${ms_po}")"
[ "${po_state}" = "PO_DRAFT" ] \
  || fail "scenario3: PO_DRAFT preserved (got '${po_state}')"
[ ! -f "$(lease_dir "${TARGET_NAME}")/${ms_po}.json" ] \
  || fail "scenario3: lease file not removed"
after="$(ledger_count_with_result recovered)"
[ "${after}" -gt "${before}" ] || fail "scenario3: ledger 'recovered' row not written"
pass "scenario3: Compose-PO lease → released without state rollback"

# ----------------------------------------------------------------------------
# Scenario 4: non-expired lease → no-op
# ----------------------------------------------------------------------------
ms2="$(it_milestone_create "${REPO}" 'still active' 'body' 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms2}" REFACTOR_IN_PROGRESS
future="$(($(date -u +%s) + 3600))"
write_lease_file "${TARGET_NAME}" "${ms2}" "Refactor" "${future}"

before="$(ledger_count_with_result recovered)"
recovery_scan "${TARGET_NAME}" "${REPO}" || fail "scenario4: recovery_scan returned nonzero"
fstate="$(it_milestone_get_state "${REPO}" "${ms2}")"
[ "${fstate}" = "REFACTOR_IN_PROGRESS" ] \
  || fail "scenario4: state should remain REFACTOR_IN_PROGRESS (got '${fstate}')"
[ -f "$(lease_dir "${TARGET_NAME}")/${ms2}.json" ] \
  || fail "scenario4: lease file should remain (not expired)"
after="$(ledger_count_with_result recovered)"
[ "${after}" -eq "${before}" ] \
  || fail "scenario4: ledger row should not be added for unexpired lease"
pass "scenario4: non-expired lease → no-op"

# ----------------------------------------------------------------------------
# Scenario 5: run_stale_recovery delegates to recovery_scan
# ----------------------------------------------------------------------------
ms3="$(it_milestone_create "${REPO}" 'stale validate' 'body' 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms3}" VALIDATE_IN_PROGRESS
write_lease_file "${TARGET_NAME}" "${ms3}" "Validate" "1"

before="$(ledger_count_with_result recovered)"
run_stale_recovery "${TARGET_NAME}" "${REPO}" \
  || fail "scenario5: run_stale_recovery returned nonzero"
vstate="$(it_milestone_get_state "${REPO}" "${ms3}")"
[ "${vstate}" = "VALIDATE_READY" ] \
  || fail "scenario5: state expected VALIDATE_READY, got '${vstate}'"
after="$(ledger_count_with_result recovered)"
[ "${after}" -gt "${before}" ] \
  || fail "scenario5: run_stale_recovery did not record ledger row"
pass "scenario5: run_stale_recovery delegates to recovery_scan"

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} scenario(s) failed in test-recovery" >&2
  exit 1
fi
echo "PASS: tests/application/test-recovery.sh"
