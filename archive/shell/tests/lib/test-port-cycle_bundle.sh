#!/usr/bin/env bash
# 두 어댑터(in_memory, filesystem) 가 같은 invariants 를 만족하는지 검증.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"
. "${LLM_TEAM_ROOT}/lib/ports/cycle_bundle.sh"

run_scenario() {
  local label="$1"
  echo "--- ${label} ---"
  # I1: idempotent open
  local h1 h2
  h1="$(cb_open "S-task-1-aaaaaaaaaaaa" "tgt" "Coder" "m:1" "")"
  h2="$(cb_open "S-task-1-aaaaaaaaaaaa" "tgt" "Coder" "m:1" "")"
  [ "${h1}" = "${h2}" ] || { echo "FAIL[${label}]: I1"; return 1; }
  # I2: disabled
  local h3
  LLM_TEAM_CYCLE_BUNDLE_DISABLED=1
  h3="$(cb_open "S-task-2-bbbbbbbbbbbb" "tgt" "Coder" "m:2" "")"
  LLM_TEAM_CYCLE_BUNDLE_DISABLED=0
  [ -z "${h3}" ] || { echo "FAIL[${label}]: I2"; return 1; }
  unset LLM_TEAM_CYCLE_BUNDLE_DISABLED
  # I3: idempotent re-capture
  cb_capture_blob_text "${h1}" "x" "v1"; cb_capture_blob_text "${h1}" "x" "v2"
  [ "$(cat "${h1}/x")" = "v2" ] || { echo "FAIL[${label}]: I3"; return 1; }
  # I5/I6: promote additive + preserve on ok
  echo 'D' > "${h1}/diagnostics.txt"
  cb_promote_to_full "${h1}" "r1"
  cb_promote_to_full "${h1}" "r2"
  cb_finalize "${h1}" "ok" '{}'
  [ -f "${h1}/diagnostics.txt" ] || { echo "FAIL[${label}]: I6"; return 1; }
  [ "$(jq '.failure_reasons | length' "${h1}/summary.json")" = "2" ] || { echo "FAIL[${label}]: I5"; return 1; }
  # I7: finalize-once
  cb_finalize "${h1}" "error" '{}' 2>/dev/null
  [ "$(jq -r .result "${h1}/summary.json")" = "ok" ] || { echo "FAIL[${label}]: I7"; return 1; }
  echo "OK[${label}]"
}

# in_memory.
INMEM="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-conf-inmem-XXXXXX")"
export LLM_TEAM_INMEM_CB_DIR="${INMEM}"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/in_memory.sh"
run_scenario "in_memory" || { rm -rf "${INMEM}"; exit 1; }

# filesystem (override root).
FSROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-conf-fs-XXXXXX")"
export LLM_TEAM_ROOT_FS_OVERRIDE="${FSROOT}"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/filesystem.sh"
run_scenario "filesystem" || { rm -rf "${INMEM}" "${FSROOT}"; exit 1; }

rm -rf "${INMEM}" "${FSROOT}"
echo "PASS: cycle_bundle conformance (in_memory + filesystem)"
