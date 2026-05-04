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
    --arg repo "${REPO}" \
    '{
       output_kind: "spec_proposal",
       agent_role: "PO",
       operation: "Compose-PO",
       object_id: $ms,
       manifest_id: "__MANIFEST_ID__",
       input_revision_pins: [
         { object_kind: "milestone", object_id: $ms, revision_pin: $pin },
         { object_kind: "code_tree", object_id: $repo, revision_pin: ("__PIN_" + $repo + "__") }
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

# ============================================================================
# Scenario 6 (B-2): Retry guard escalation
#   같은 (object, operation) 의 ledger row 가 result="error" 로 N (default 3) 회
#   연속 쌓이면, 다음 cycle 시작 시 retry guard hook 이 격상 발동: ESCALATED
#   상태로 전이 시도 + ledger 에 result="escalated" row 추가 + cycle exit 0
#   (lr_call/외부 부수효과 없이).
# ============================================================================
clear_po_draft_residue
ms6="$(seed_po_draft_milestone 'retry-guard')"
pin6="$(milestone_pin "${ms6}")"
write_po_fixture "${ms6}" "${pin6}" "po-retry-${ms6}"

# 미리 같은 (milestone, ms6, Compose-PO) 에 result="error" row 3건 적재.
seed_error_row() {
  local kind="$1" id="$2" op="$3"
  local tmp; tmp="$(mktemp)"
  jq -nc \
    --arg tid "seed-err-${id}-$(date -u +%s%N)-${RANDOM}" \
    --arg target "${TARGET_NAME}" \
    --arg k "${kind}" --arg i "${id}" --arg op "${op}" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg idem "seed-err-${id}-$(date -u +%s%N)-${RANDOM}" \
    '{
      transition_id:$tid, target_id:$target, object_kind:$k, object_id:$i,
      from_state:"X", to_state:"X", operation:$op, caller_id:"test-seed",
      idempotency_key:$idem, timestamp:$ts, lease_token:null, result:"error"
    }' >"${tmp}"
  transition_ledger_write "${TARGET_NAME}" "${tmp}" \
    || fail "scenario6: seed_error_row write failed"
  rm -f "${tmp}"
}
for _ in 1 2 3; do
  seed_error_row milestone "${ms6}" Compose-PO
done

escalated_before="$(ledger_result_count escalated)"
applied_before="$(ledger_result_count applied)"
out6="$(mktemp)"
run_runner "${out6}" || true
escalated_after="$(ledger_result_count escalated)"
applied_after="$(ledger_result_count applied)"

[ "${escalated_after}" -gt "${escalated_before}" ] \
  || { echo "--- runner output (scenario6) ---" >&2; cat "${out6}" >&2; \
       fail "scenario6: retry guard did not write escalated ledger row"; }
[ "${applied_after}" -eq "${applied_before}" ] \
  || fail "scenario6: retry guard should NOT apply envelope (no lr_call)"

# Last escalated row should reference (milestone, ms6, Compose-PO) and reason
# should mention retry_guard.
last_esc="$(jq -c 'select(.result=="escalated")' "${LEDGER_PATH}" | tail -1)"
[ "$(echo "${last_esc}" | jq -r '.object_id')" = "${ms6}" ] \
  || fail "scenario6: escalated row object_id mismatch (got '$(echo "${last_esc}" | jq -r '.object_id')')"
[ "$(echo "${last_esc}" | jq -r '.operation')" = "Compose-PO" ] \
  || fail "scenario6: escalated row operation mismatch"
echo "${last_esc}" | jq -r '.reason // ""' | grep -q "retry_guard" \
  || fail "scenario6: escalated row reason missing 'retry_guard' tag (got '$(echo "${last_esc}" | jq -r '.reason // "")')"

pass "scenario6: retry guard → escalated ledger row + no apply"
rm -f "${out6}"

# ============================================================================
# Scenario 7 (B-2): Retry guard disable env
#   LLM_TEAM_RETRY_GUARD_DISABLE=1 이면 동일 조건에서 격상하지 않고 정상 처리.
# ============================================================================
clear_po_draft_residue
ms7="$(seed_po_draft_milestone 'retry-guard-disabled')"
pin7="$(milestone_pin "${ms7}")"
write_po_fixture "${ms7}" "${pin7}" "po-retry-dis-${ms7}"
for _ in 1 2 3; do
  seed_error_row milestone "${ms7}" Compose-PO
done

escalated_before="$(ledger_result_count escalated)"
applied_before="$(ledger_result_count applied)"
out7="$(mktemp)"
LLM_TEAM_RETRY_GUARD_DISABLE=1 run_runner "${out7}" || true
escalated_after="$(ledger_result_count escalated)"
applied_after="$(ledger_result_count applied)"
[ "${escalated_after}" -eq "${escalated_before}" ] \
  || fail "scenario7: disable=1 should NOT escalate"
[ "${applied_after}" -gt "${applied_before}" ] \
  || { echo "--- runner output (scenario7) ---" >&2; cat "${out7}" >&2; \
       fail "scenario7: disable=1 should proceed and apply"; }
pass "scenario7: retry guard disabled → normal apply path"
rm -f "${out7}"

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} scenario(s) failed in test-runner-pipeline" >&2
  exit 1
fi
echo "PASS: tests/scheduler/test-runner-pipeline.sh"
