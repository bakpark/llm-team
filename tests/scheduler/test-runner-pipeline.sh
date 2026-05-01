#!/usr/bin/env bash
# tests/scheduler/test-runner-pipeline.sh
#
# Phase 5 — scheduler/runner.sh full pipeline integration test (5 scenarios).
#
# 검증:
#   1. Happy path PO: milestone PO_DRAFT → PO_GATE, ledger 1 applied 행, lease release.
#   2. PAUSED: control_state=PAUSED → 즉시 exit 0, lease 미점유, 상태 변동 없음.
#   3. Invalid envelope: 필수 필드 누락 → ledger result=invalid, claim_rollback 적용
#      (PO 의 경우 claim transition 자체가 없어 상태 변동 없음).
#   4. Stale revision: envelope 의 revision_pin 이 현재값과 다르면 ledger result=stale.
#   5. Idempotency: 동일 idempotency_key 두 번 실행 → 두 번째는 duplicate 행만 기록,
#      추가 CP/state 변경 없음.
#
# Adapter 환경: in_memory issue_tracker / workspace / persistent_store + fake
# llm_runner. fixture 디렉토리는 mktemp 로 격리.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="runner-pipeline-test-$$"
TEST_INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rp-it-XXXXXX")"
TEST_INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rp-ws-XXXXXX")"
TEST_INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rp-ps-XXXXXX")"
TEST_FAKE_FIX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rp-fx-XXXXXX")"
TEST_TARGET_YAML="${LLM_TEAM_ROOT}/targets/${TARGET_NAME}.yaml"
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}"
CONTROL_STATE_FILE="${LLM_TEAM_ROOT}/workdir/control-state"
CONTROL_STATE_BACKUP=""

cleanup() {
  rm -rf "${TEST_INMEM_IT_DIR}" "${TEST_INMEM_WS_DIR}" "${TEST_INMEM_PS_DIR}" \
         "${TEST_FAKE_FIX_DIR}" "${TARGET_WORKDIR}" 2>/dev/null || true
  rm -f "${TEST_TARGET_YAML}" 2>/dev/null || true
  if [ -n "${CONTROL_STATE_BACKUP}" ] && [ -f "${CONTROL_STATE_BACKUP}" ]; then
    mv "${CONTROL_STATE_BACKUP}" "${CONTROL_STATE_FILE}" 2>/dev/null || true
  else
    rm -f "${CONTROL_STATE_FILE}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Backup existing control-state if present (so test PAUSED doesn't pollute).
if [ -f "${CONTROL_STATE_FILE}" ]; then
  CONTROL_STATE_BACKUP="$(mktemp)"
  cp "${CONTROL_STATE_FILE}" "${CONTROL_STATE_BACKUP}" 2>/dev/null || true
fi

# Write a minimal target yaml (uses in_memory adapters via env).
cat >"${TEST_TARGET_YAML}" <<EOF
name: ${TARGET_NAME}
github:
  owner: test-owner
  repo: ${TARGET_NAME}
  default_branch: main
local:
  clone_path: ${TEST_INMEM_WS_DIR}
inputs_dir: inputs/${TARGET_NAME}
labels:
  prefix: ""
notifier:
  channel: none
  webhook_or_id: ""
dev_concurrency: 1
stale_threshold_minutes: 60
verification:
  commands: ["true"]
enabled: true
EOF

mkdir -p "${TARGET_WORKDIR}/manifests"

# Adapter env vars (subprocesses inherit).
export TARGET_NAME
export LLM_TEAM_INMEM_IT_DIR="${TEST_INMEM_IT_DIR}"
export LLM_TEAM_INMEM_WS_DIR="${TEST_INMEM_WS_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${TEST_INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
export LLM_TEAM_ADAPTER_WORKSPACE=in_memory
export LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory
export LLM_TEAM_ADAPTER_LLM_RUNNER=fake
export LLM_TEAM_FAKE_FIXTURE_DIR="${TEST_FAKE_FIX_DIR}"
export LLM_TEAM_INMEM_IT_ACTOR="alice"
# Short lease to keep tests snappy.
export LLM_TEAM_LEASE_TTL=600

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

REPO="test-owner/${TARGET_NAME}"
LEDGER_PATH="$(transition_ledger_path "${TARGET_NAME}")"

# ----------------------------------------------------------------------------
# Helper: seed a milestone in PO_DRAFT state and return its number.
# Uses in_memory it adapter (already loaded by common.sh).
# ----------------------------------------------------------------------------
seed_po_draft_milestone() {
  local title="$1"
  local num
  num="$(it_milestone_create "${REPO}" "${title}" "seeded body" 2>/dev/null)" \
    || { fail "seed: it_milestone_create failed"; return 1; }
  it_milestone_set_state "${REPO}" "${num}" PO_DRAFT 2>/dev/null \
    || { fail "seed: set_state PO_DRAFT failed"; return 1; }
  printf '%s' "${num}"
}

# Returns current revision_pin (updated_at) for a milestone.
milestone_pin() {
  it_revision_pin_get "${REPO}" milestone "$1" 2>/dev/null
}

# Returns current state for a milestone.
milestone_state() {
  it_milestone_get_state "${REPO}" "$1" 2>/dev/null
}

# Move any leftover PO_DRAFT milestones out of the picking queue so the next
# scenario's ready_object_pick picks the milestone we just seeded (oldest-first).
clear_po_draft_residue() {
  local nums n
  nums="$(it_milestone_list_in_state "${REPO}" PO_DRAFT 2>/dev/null)"
  [ -z "${nums}" ] && return 0
  while IFS= read -r n; do
    [ -n "${n}" ] || continue
    it_milestone_set_state "${REPO}" "${n}" ESCALATED PO_DRAFT 2>/dev/null || true
  done <<<"${nums}"
}

write_po_fixture() {
  local ms_num="$1" pin="$2" idem_key="$3" extra_jq="${4:-.}"
  local f="${TEST_FAKE_FIX_DIR}/po-Compose-PO.json"
  jq -n \
    --arg ms "${ms_num}" \
    --arg pin "${pin}" \
    --arg idem "${idem_key}" \
    '{
       output_kind: "spec_proposal",
       agent_role: "PO",
       operation: "Compose-PO",
       target_id: $ms,
       manifest_id: "__MANIFEST_ID__",
       input_revision_pins: [
         { object_kind: "milestone", object_id: $ms, revision_pin: $pin }
       ],
       idempotency_key: $idem,
       summary: "PO compose result",
       artifacts: {
         milestone_body: "Updated body from PO",
         cp_artifact_ref: "spec/po-1.md"
       }
     }' >"${f}"
  # Apply extra_jq (e.g. delete a field for invalid scenarios).
  if [ "${extra_jq}" != "." ]; then
    local tmp; tmp="$(mktemp)"
    jq "${extra_jq}" "${f}" >"${tmp}" && mv "${tmp}" "${f}"
  fi
}

run_runner() {
  bash "${LLM_TEAM_ROOT}/scheduler/runner.sh" po "${TARGET_NAME}" >"$1" 2>&1
}

ledger_result_count() {
  local result="$1"
  [ -f "${LEDGER_PATH}" ] || { printf '0'; return; }
  jq -c --arg r "${result}" 'select(.result == $r)' "${LEDGER_PATH}" 2>/dev/null \
    | wc -l | tr -d ' '
}

# ============================================================================
# Scenario 1: Happy path PO
# ============================================================================
clear_po_draft_residue
ms1="$(seed_po_draft_milestone 'happy-path')" || exit 1
pin1="$(milestone_pin "${ms1}")"
write_po_fixture "${ms1}" "${pin1}" "po-happy-${ms1}"

out1="$(mktemp)"
if run_runner "${out1}"; then
  state="$(milestone_state "${ms1}")"
  [ "${state}" = "PO_GATE" ] || fail "scenario1: ms ${ms1} state expected PO_GATE got '${state}'"
  applied_count="$(ledger_result_count applied)"
  [ "${applied_count}" -ge 1 ] || fail "scenario1: ledger applied row missing"
  # No active lease left for this object.
  if declare -F lease_path >/dev/null 2>&1; then
    if lease_path "${TARGET_NAME}" "${ms1}" 2>/dev/null | xargs -I{} test -f {} 2>/dev/null; then
      fail "scenario1: lease not released"
    fi
  fi
  pass "scenario1: happy path PO → PO_GATE + applied ledger"
else
  echo "--- runner output (scenario1) ---" >&2
  cat "${out1}" >&2
  fail "scenario1: runner failed"
fi
rm -f "${out1}"

# ============================================================================
# Scenario 5: Idempotency — re-run with same idempotency_key
# (Run before invalid/stale because it relies on scenario1's milestone state.)
# Must keep same fixture: pin must match current ms1 pin (now updated post-apply).
# ============================================================================
# Re-run runner: ready_object_pick now sees no PO_DRAFT milestone (ms1 is PO_GATE).
# But ledger duplicate semantics live in caller_apply_output, which is only
# entered when ready_object_pick succeeds. So we instead seed a NEW PO_DRAFT
# milestone and reuse the same idempotency key — second run should record
# duplicate without state-transitioning.
clear_po_draft_residue
ms_dup="$(seed_po_draft_milestone 'idem-dup')"
pin_dup="$(milestone_pin "${ms_dup}")"
write_po_fixture "${ms_dup}" "${pin_dup}" "po-shared-idem"

out_a="$(mktemp)"
out_b="$(mktemp)"
applied_before="$(ledger_result_count applied)"
duplicate_before="$(ledger_result_count duplicate)"

run_runner "${out_a}" || true
applied_mid="$(ledger_result_count applied)"
[ "${applied_mid}" -gt "${applied_before}" ] \
  || fail "scenario5: first run did not record applied"

# Seed second milestone with same idem key — second run sees duplicate idempotency_key.
clear_po_draft_residue
ms_dup2="$(seed_po_draft_milestone 'idem-dup-2')"
pin_dup2="$(milestone_pin "${ms_dup2}")"
write_po_fixture "${ms_dup2}" "${pin_dup2}" "po-shared-idem"

run_runner "${out_b}" || true
applied_after="$(ledger_result_count applied)"
duplicate_after="$(ledger_result_count duplicate)"

[ "${applied_after}" -eq "${applied_mid}" ] \
  || fail "scenario5: second run added applied row (expected duplicate, applied=${applied_mid}→${applied_after})"
[ "${duplicate_after}" -gt "${duplicate_before}" ] \
  || fail "scenario5: second run did not record duplicate"

# Second milestone should remain PO_DRAFT (no state transition for duplicates).
state2="$(milestone_state "${ms_dup2}")"
[ "${state2}" = "PO_DRAFT" ] \
  || fail "scenario5: second milestone state changed to '${state2}' (expected PO_DRAFT)"

pass "scenario5: duplicate idempotency_key → duplicate row, no state change"
rm -f "${out_a}" "${out_b}"

# ============================================================================
# Scenario 2: PAUSED control state
# ============================================================================
control_state_set PAUSED
clear_po_draft_residue
ms2="$(seed_po_draft_milestone 'paused')"
pin2="$(milestone_pin "${ms2}")"
write_po_fixture "${ms2}" "${pin2}" "po-paused-${ms2}"

applied_before="$(ledger_result_count applied)"
out2="$(mktemp)"
run_runner "${out2}" || fail "scenario2: PAUSED runner exited non-zero"
state="$(milestone_state "${ms2}")"
[ "${state}" = "PO_DRAFT" ] \
  || fail "scenario2: PAUSED runner mutated milestone state ('${state}')"
applied_after="$(ledger_result_count applied)"
[ "${applied_after}" -eq "${applied_before}" ] \
  || fail "scenario2: PAUSED runner wrote applied ledger row"
pass "scenario2: PAUSED → no claim, no state change, no applied ledger"
rm -f "${out2}"
control_state_set RUNNING

# ============================================================================
# Scenario 3: Invalid envelope (missing idempotency_key)
# ============================================================================
clear_po_draft_residue
ms3="$(seed_po_draft_milestone 'invalid-env')"
pin3="$(milestone_pin "${ms3}")"
write_po_fixture "${ms3}" "${pin3}" "po-invalid-${ms3}" 'del(.idempotency_key)'

invalid_before="$(ledger_result_count invalid)"
applied_before="$(ledger_result_count applied)"
out3="$(mktemp)"
run_runner "${out3}" || true
state="$(milestone_state "${ms3}")"
[ "${state}" = "PO_DRAFT" ] || fail "scenario3: ms state changed on invalid envelope ('${state}')"
invalid_after="$(ledger_result_count invalid)"
applied_after="$(ledger_result_count applied)"
[ "${invalid_after}" -gt "${invalid_before}" ] \
  || fail "scenario3: invalid envelope did not record ledger invalid row"
[ "${applied_after}" -eq "${applied_before}" ] \
  || fail "scenario3: invalid envelope wrote applied ledger row"
pass "scenario3: invalid envelope → invalid ledger row, state preserved"
rm -f "${out3}"

# ============================================================================
# Scenario 4: Stale revision
# ============================================================================
clear_po_draft_residue
ms4="$(seed_po_draft_milestone 'stale-pin')"
write_po_fixture "${ms4}" "stale-pin-not-real" "po-stale-${ms4}"

stale_before="$(ledger_result_count stale)"
applied_before="$(ledger_result_count applied)"
out4="$(mktemp)"
run_runner "${out4}" || true
state="$(milestone_state "${ms4}")"
[ "${state}" = "PO_DRAFT" ] || fail "scenario4: ms state changed on stale revision ('${state}')"
stale_after="$(ledger_result_count stale)"
applied_after="$(ledger_result_count applied)"
[ "${stale_after}" -gt "${stale_before}" ] \
  || fail "scenario4: stale revision did not record ledger stale row"
[ "${applied_after}" -eq "${applied_before}" ] \
  || fail "scenario4: stale revision wrote applied ledger row"
pass "scenario4: stale revision → stale ledger row, state preserved"
rm -f "${out4}"

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} scenario(s) failed in test-runner-pipeline" >&2
  exit 1
fi
echo "PASS: tests/scheduler/test-runner-pipeline.sh"
