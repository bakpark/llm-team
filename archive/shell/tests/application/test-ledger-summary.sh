#!/usr/bin/env bash
# tests/application/test-ledger-summary.sh
#
# Unit test for application/ledger_summary.sh:
#   • ledger_pipeline_summary group-by + last-by-timestamp
#   • ledger_caller_window inclusive lower bound + result counting
#   • ledger_recent line slice
#   • Malformed lines tolerated

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="ledger-summary-test-$$"
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}"

cleanup() { rm -rf "${TARGET_WORKDIR}" 2>/dev/null || true; }
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/ledger_summary.sh
. "${LLM_TEAM_ROOT}/application/ledger_summary.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

mkdir -p "${TARGET_WORKDIR}/ledger"
ledger_path="$(transition_ledger_path "${TARGET_NAME}")"

# Five ledger entries:
#   • milestone#1 has two rows (last wins)
#   • task#10 applied
#   • task#11 duplicate
#   • task#12 invalid (older than 24h cutoff)
ts_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ts_old="$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
          || date -u -v-2d +%Y-%m-%dT%H:%M:%SZ)"
ts_mid="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
          || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"

emit() {
  jq -nc \
    --arg transition_id "$1" \
    --arg object_kind "$2" \
    --arg object_id "$3" \
    --arg from_state "$4" \
    --arg to_state "$5" \
    --arg operation "$6" \
    --arg result "$7" \
    --arg ts "$8" \
    '{
      transition_id: $transition_id,
      object_kind: $object_kind,
      object_id: $object_id,
      from_state: $from_state,
      to_state: $to_state,
      operation: $operation,
      caller_id: "test",
      idempotency_key: $transition_id,
      manifest_id: "m-1",
      timestamp: $ts,
      result: $result,
      duplicate: false
    }'
}

{
  emit tx-1 milestone 1 PO_DRAFT  PO_GATE        spec_proposal applied   "${ts_old}"
  emit tx-2 milestone 1 PO_GATE   PM_DRAFT       spec_proposal applied   "${ts_mid}"
  emit tx-3 task      10 TASK_READY TASK_REVIEW_READY patch        applied   "${ts_now}"
  emit tx-4 task      11 "(duplicate)" "(duplicate)" patch         duplicate "${ts_now}"
  emit tx-5 task      12 TASK_READY  TASK_READY    verdict        invalid   "${ts_old}"
  printf 'this is not json garbage\n'
} >"${ledger_path}"

# ---- ledger_pipeline_summary ------------------------------------------------
summary="$(ledger_pipeline_summary "${TARGET_NAME}")"
group_count="$(printf '%s' "${summary}" | jq 'length')"
[ "${group_count}" = "4" ] || fail "pipeline_summary group count: expected 4, got ${group_count} :: ${summary}"

ms1_to="$(printf '%s' "${summary}" \
  | jq -r '.[] | select(.object_kind=="milestone" and .object_id=="1") | .to_state')"
[ "${ms1_to}" = "PM_DRAFT" ] || fail "pipeline_summary milestone#1 last to_state: expected PM_DRAFT, got ${ms1_to}"

# ---- ledger_caller_window ---------------------------------------------------
since_24h="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)"
window="$(ledger_caller_window "${TARGET_NAME}" "${since_24h}")"
applied="$(printf '%s' "${window}" | jq -r '.applied')"
duplicate="$(printf '%s' "${window}" | jq -r '.duplicate')"
invalid="$(printf '%s' "${window}" | jq -r '.invalid')"
total="$(printf '%s' "${window}" | jq -r '.total')"
# tx-1 (old) and tx-5 (old) are outside the 24h window.
# Inside: tx-2 applied, tx-3 applied, tx-4 duplicate.
[ "${applied}"   = "2" ] || fail "caller_window.applied: expected 2, got ${applied} :: ${window}"
[ "${duplicate}" = "1" ] || fail "caller_window.duplicate: expected 1, got ${duplicate}"
[ "${invalid}"   = "0" ] || fail "caller_window.invalid: expected 0, got ${invalid}"
[ "${total}"     = "3" ] || fail "caller_window.total: expected 3, got ${total}"

# ---- ledger_recent ----------------------------------------------------------
recent="$(ledger_recent "${TARGET_NAME}" 2 | wc -l | tr -d ' ')"
[ "${recent}" = "2" ] || fail "ledger_recent 2: expected 2 lines, got ${recent}"

# ---- empty ledger fallbacks -------------------------------------------------
empty_target="ledger-summary-empty-$$"
empty_summary="$(ledger_pipeline_summary "${empty_target}")"
[ "${empty_summary}" = "[]" ] || fail "pipeline_summary empty: expected [], got ${empty_summary}"

empty_window="$(ledger_caller_window "${empty_target}" "${since_24h}" | jq -r '.total')"
[ "${empty_window}" = "0" ] || fail "caller_window empty.total: expected 0, got ${empty_window}"

if [ "${failures}" -eq 0 ]; then
  printf 'PASS tests/application/test-ledger-summary.sh\n'
  exit 0
fi
printf 'FAIL tests/application/test-ledger-summary.sh (failures=%d)\n' "${failures}" >&2
exit 1
