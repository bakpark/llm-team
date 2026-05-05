#!/usr/bin/env bash
# tests/application/test-caller-dispatch-idempotency-retry.sh
#
# RGC-FAILURE: a prior failed transition (result=error|stale|invalid) MUST NOT
# burn its idempotency_key. Only successfully *applied* transitions (and their
# duplicate echoes) should short-circuit subsequent attempts in
# caller_apply_output.
#
# This guards against the live-pipeline failure where a transient adapter
# error produced an "error" ledger row, after which the runner's next
# scheduled attempt — using the same input revision and therefore the same
# idem_key — was incorrectly treated as a no-op duplicate, leaving the
# milestone permanently stuck.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="caller-idem-retry-test-$$"
export TARGET_NAME
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}"

cleanup() { rm -rf "${TARGET_WORKDIR}" 2>/dev/null || true; }
trap cleanup EXIT

. "${LLM_TEAM_ROOT}/lib/common.sh"
. "${LLM_TEAM_ROOT}/application/caller_dispatch.sh"

mkdir -p "${TARGET_WORKDIR}"

fail() { echo "FAIL: $*" >&2; exit 1; }

ledger_path="$(transition_ledger_path "${TARGET_NAME}")"
mkdir -p "$(dirname "${ledger_path}")"

key='po:milestone:1:rev-A'

# 1. Empty ledger → has_key MUST be false.
: >"${ledger_path}"
if _caller_ledger_has_key "${TARGET_NAME}" "${key}"; then
  fail "empty ledger should report has_key=false"
fi

# 2. Ledger with only failure rows (error / stale / invalid) → has_key false.
for r in error stale invalid; do
  jq -nc --arg k "${key}" --arg r "${r}" \
    '{transition_id:"t",object_kind:"milestone",object_id:"1",
      from_state:"PO_DRAFT",to_state:"PO_DRAFT",operation:"Compose-PO",
      caller_id:"x",idempotency_key:$k,manifest_id:"m",timestamp:"2026-05-02T00:00:00Z",
      result:$r,duplicate:false}' >>"${ledger_path}"
done
if _caller_ledger_has_key "${TARGET_NAME}" "${key}"; then
  fail "failure-only ledger should report has_key=false (RGC-FAILURE retryable)"
fi

# 3. Ledger contains an applied row → has_key MUST be true.
jq -nc --arg k "${key}" \
  '{transition_id:"t2",object_kind:"milestone",object_id:"1",
    from_state:"PO_DRAFT",to_state:"PO_GATE",operation:"Compose-PO",
    caller_id:"x",idempotency_key:$k,manifest_id:"m",timestamp:"2026-05-02T00:01:00Z",
    result:"applied",duplicate:false}' >>"${ledger_path}"
if ! _caller_ledger_has_key "${TARGET_NAME}" "${key}"; then
  fail "applied row should set has_key=true"
fi

# 4. A duplicate echo row alone (without the original applied row) is also a
#    successful idempotent reuse — it should also set has_key=true.
ledger2="${TARGET_WORKDIR}/ledger2.jsonl"
jq -nc --arg k "${key}" \
  '{transition_id:"t3",object_kind:"milestone",object_id:"1",
    from_state:"(duplicate)",to_state:"(duplicate)",operation:"Compose-PO",
    caller_id:"x",idempotency_key:$k,manifest_id:"m",timestamp:"2026-05-02T00:02:00Z",
    result:"duplicate",duplicate:true}' >"${ledger2}"
mv "${ledger2}" "${ledger_path}"
if ! _caller_ledger_has_key "${TARGET_NAME}" "${key}"; then
  fail "duplicate-only ledger should set has_key=true"
fi

echo "PASS: _caller_ledger_has_key only matches applied/duplicate rows"
