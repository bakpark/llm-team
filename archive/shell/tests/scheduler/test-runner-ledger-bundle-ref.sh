#!/usr/bin/env bash
# tests/scheduler/test-runner-ledger-bundle-ref.sh
#
# Integration smoke tests: cycle_bundle_ref field in ledger rows.
#
# Cases exercised (PO role — no git fixture required):
#   A — PO applied row: cycle_bundle_ref field exists and is null.
#       PO is not a RW role (no CB_HANDLE), so CYCLE_BUNDLE_REF="" →
#       _caller_ledger_write emits cycle_bundle_ref: null.
#   B — PO invalid envelope row: cycle_bundle_ref field is present (null).
#       _runner_ledger_write also emits cycle_bundle_ref: null when
#       11th arg (cycle_bundle_ref) is "".
#
# TODO (deferred — requires real git bare-repo/clone/worktree fixtures):
#   C  Coder applied row: cycle_bundle_ref is a non-null filesystem path
#      under workdir/<target>/cycles/<cycle_id>. Requires:
#        • Real git bare repo + clone + ws_* git_worktree adapter.
#        • A Coder-role fake fixture producing a valid patch envelope.
#        • Verify: jq -r '.cycle_bundle_ref' of applied row == CB_HANDLE path.
#   D  Coder error row (lr fail): cycle_bundle_ref is non-null (CB_HANDLE
#      promoted to full). Verify _runner_ledger_write arg 11 == CB_HANDLE.
#   E  Coder invalid envelope row: cycle_bundle_ref non-null (cb_promote_to_full
#      called before _runner_ledger_write in the agent_output_parse failure branch).
#   F  Coder stale row: same pattern as E for revision_pin_revalidate failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="rlbr-test-$$"
TEST_INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rlbr-it-XXXXXX")"
TEST_INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rlbr-ws-XXXXXX")"
TEST_INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rlbr-ps-XXXXXX")"
TEST_FAKE_FIX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rlbr-fx-XXXXXX")"
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

if [ -f "${CONTROL_STATE_FILE}" ]; then
  CONTROL_STATE_BACKUP="$(mktemp)"
  cp "${CONTROL_STATE_FILE}" "${CONTROL_STATE_BACKUP}" 2>/dev/null || true
fi

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

export TARGET_NAME
export LLM_TEAM_INMEM_IT_DIR="${TEST_INMEM_IT_DIR}"
export LLM_TEAM_INMEM_WS_DIR="${TEST_INMEM_WS_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${TEST_INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
export LLM_TEAM_ADAPTER_WORKSPACE=in_memory
export LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory
export LLM_TEAM_ADAPTER_LLM_RUNNER=fake
export LLM_TEAM_ADAPTER_CYCLE_BUNDLE=filesystem
export LLM_TEAM_ROOT_FS_OVERRIDE="${TEST_INMEM_WS_DIR}"
export LLM_TEAM_FAKE_FIXTURE_DIR="${TEST_FAKE_FIX_DIR}"
export LLM_TEAM_INMEM_IT_ACTOR="alice"
export LLM_TEAM_LEASE_TTL=600

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

REPO="test-owner/${TARGET_NAME}"
LEDGER_PATH="$(transition_ledger_path "${TARGET_NAME}")"

# ----------------------------------------------------------------------------
# Helpers (inlined — no shared file extraction).
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
  if [ "${extra_jq}" != "." ]; then
    local tmp; tmp="$(mktemp)"
    jq "${extra_jq}" "${f}" >"${tmp}" && mv "${tmp}" "${f}"
  fi
}

run_runner_po() {
  bash "${LLM_TEAM_ROOT}/scheduler/runner.sh" po "${TARGET_NAME}" >"$1" 2>&1
}

# Returns "has_field" if the last row with given result contains the field
# (even if null), "no_field" if absent, "no_row" if no matching row.
last_ledger_has_field() {
  local result_type="$1" field="$2"
  [ -f "${LEDGER_PATH}" ] || { printf 'no_row'; return; }
  local has
  has="$(jq -r --arg r "${result_type}" --arg f "${field}" \
    'select(.result == $r) | if has($f) then "has_field" else "no_field" end' \
    "${LEDGER_PATH}" 2>/dev/null | tail -1)"
  printf '%s' "${has:-no_row}"
}

# Helper: read the cycle_bundle_ref value from the last ledger row matching
# a result type. Uses has() to avoid jq's // operator treating null as falsy.
# Outputs "null" (string) if field is JSON null, the actual path if non-null,
# or "FIELD_ABSENT" / "MISSING_LEDGER" on errors.
last_ledger_cycle_bundle_ref() {
  local result_type="$1"
  [ -f "${LEDGER_PATH}" ] || { printf 'MISSING_LEDGER'; return; }
  jq -r --arg r "${result_type}" \
    'select(.result == $r) | if has("cycle_bundle_ref") then (.cycle_bundle_ref | if . == null then "null" else . end) else "FIELD_ABSENT" end' \
    "${LEDGER_PATH}" 2>/dev/null | tail -1
}

# ============================================================================
# Case A — applied row: cycle_bundle_ref field present, value is null
# ============================================================================
clear_po_draft_residue
ms_a="$(seed_po_draft_milestone 'ledger-bundle-ref-case-a')" || { fail "case-A: seed failed"; exit 1; }
pin_a="$(it_revision_pin_get "${REPO}" milestone "${ms_a}" 2>/dev/null)"
write_po_fixture "${ms_a}" "${pin_a}" "po-lbr-a-${ms_a}"

out_a="$(mktemp)"
if run_runner_po "${out_a}"; then
  # The applied row is written by _caller_ledger_write which reads CYCLE_BUNDLE_REF.
  # PO sets CYCLE_BUNDLE_REF="" → cycle_bundle_ref: null in the ledger.
  field_presence="$(last_ledger_has_field applied cycle_bundle_ref)"
  field_value="$(last_ledger_cycle_bundle_ref applied)"
  if [ "${field_presence}" = "has_field" ]; then
    if [ "${field_value}" = "null" ]; then
      pass "case-A: applied row has cycle_bundle_ref=null (PO no RW role)"
    else
      fail "case-A: applied row cycle_bundle_ref expected null, got '${field_value}'"
    fi
  else
    fail "case-A: applied ledger row missing cycle_bundle_ref field (field_presence='${field_presence}')"
  fi
else
  echo "--- runner output (case-A) ---" >&2
  cat "${out_a}" >&2
  fail "case-A: runner exited non-zero"
fi
rm -f "${out_a}"

# ============================================================================
# Case B — invalid envelope row: cycle_bundle_ref field present (null)
#   Force invalid envelope by deleting idempotency_key.
#   _runner_ledger_write is called with cycle_bundle_ref="" (11th arg) →
#   jq produces cycle_bundle_ref: null.
# ============================================================================
clear_po_draft_residue
ms_b="$(seed_po_draft_milestone 'ledger-bundle-ref-case-b')" || { fail "case-B: seed failed"; exit 1; }
pin_b="$(it_revision_pin_get "${REPO}" milestone "${ms_b}" 2>/dev/null)"
write_po_fixture "${ms_b}" "${pin_b}" "po-lbr-b-${ms_b}" 'del(.idempotency_key)'

invalid_before=0
[ -f "${LEDGER_PATH}" ] && \
  invalid_before="$(jq -c 'select(.result == "invalid")' "${LEDGER_PATH}" 2>/dev/null | wc -l | tr -d ' ')"

out_b="$(mktemp)"
run_runner_po "${out_b}" || true
invalid_after=0
[ -f "${LEDGER_PATH}" ] && \
  invalid_after="$(jq -c 'select(.result == "invalid")' "${LEDGER_PATH}" 2>/dev/null | wc -l | tr -d ' ')"

if [ "${invalid_after}" -gt "${invalid_before}" ]; then
  field_presence_b="$(last_ledger_has_field invalid cycle_bundle_ref)"
  field_value_b="$(last_ledger_cycle_bundle_ref invalid)"
  if [ "${field_presence_b}" = "has_field" ]; then
    # For PO, CB_HANDLE is always "" → null. Accept null.
    if [ "${field_value_b}" = "null" ]; then
      pass "case-B: invalid row has cycle_bundle_ref=null (PO no RW role, missing idem key)"
    else
      fail "case-B: invalid row cycle_bundle_ref expected null, got '${field_value_b}'"
    fi
  else
    fail "case-B: invalid ledger row missing cycle_bundle_ref field (field_presence='${field_presence_b}')"
  fi
else
  echo "--- runner output (case-B) ---" >&2
  cat "${out_b}" >&2
  fail "case-B: expected invalid ledger row not written (before=${invalid_before} after=${invalid_after})"
fi
rm -f "${out_b}"

# ============================================================================
# Final result
# ============================================================================
if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} case(s) failed in test-runner-ledger-bundle-ref" >&2
  exit 1
fi
echo "PASS: tests/scheduler/test-runner-ledger-bundle-ref.sh"
