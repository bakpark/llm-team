#!/usr/bin/env bash
# Static and local-runtime checks for the contract-era implementation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

check_eq() {
  local name="$1" got="$2" expected="$3"
  if [ "${got}" != "${expected}" ]; then
    fail "${name}: got '${got}', expected '${expected}'"
  fi
}

check_eq "PO operation" "$(role_operation po)" "Compose-PO"
check_eq "PM operation" "$(role_operation pm)" "Compose-PM"
check_eq "Planner operation" "$(role_operation planner)" "Decompose"
check_eq "Coder operation" "$(role_operation coder)" "Implement"
check_eq "Reviewer operation" "$(role_operation reviewer)" "Review"
check_eq "Integrator operation" "$(role_operation integrator)" "Refactor"
check_eq "QA operation" "$(role_operation qa)" "Validate"

for legacy in needs-dev needs-qa "qa:in-progress" "dev:in-progress"; do
  for active in "${ALL_ISSUE_LABELS[@]}"; do
    if [ "${legacy}" = "${active}" ]; then
      fail "legacy label leaked into ALL_ISSUE_LABELS: ${legacy}"
    fi
  done
done

state_is_valid milestone PO_DRAFT || fail "PO_DRAFT should be a milestone state"
state_is_valid task TASK_READY || fail "TASK_READY should be a task state"
state_is_valid change_proposal CP_READY_FOR_REVIEW || fail "CP_READY_FOR_REVIEW should be a CP state"
state_is_valid task needs-dev && fail "legacy state should not validate as task state"

for role in po pm planner coder reviewer integrator qa; do
  prompt="$(role_prompt_path "${role}")"
  [ -f "${prompt}" ] || fail "prompt missing for role=${role}: ${prompt}"
done

manifest_file="$(context_manifest_create "contract-test" "Implement" "task" "T-1")"
context_manifest_add_entry "${manifest_file}" "task" "T-1" "body" "rev-1" true "unit test"
context_manifest_validate "${manifest_file}" || fail "context manifest should validate"
manifest_id="$(context_manifest_id "${manifest_file}")"

valid_output="${LLM_TEAM_ROOT}/workdir/contract-test/valid-output.json"
mkdir -p "$(dirname "${valid_output}")"
jq -n \
  --arg manifest_id "${manifest_id}" \
  '{
    output_kind: "patch",
    agent_role: "Coder",
    operation: "Implement",
    object_id: "T-1",
    manifest_id: $manifest_id,
    input_revision_pins: [{object_id: "T-1", revision_pin: "rev-1"}],
    idempotency_key: "T-1:rev-1",
    summary: "Patch proposal",
    artifacts: [{kind: "patch", name: "diff", body: "diff --git a/a b/a"}]
  }' >"${valid_output}"
agent_output_validate "${valid_output}" "coder" "Implement" "${manifest_id}" || fail "valid Coder output should pass"

invalid_output="${LLM_TEAM_ROOT}/workdir/contract-test/invalid-output.json"
jq -n \
  --arg manifest_id "${manifest_id}" \
  '{
    output_kind: "patch",
    agent_role: "Coder",
    operation: "Implement",
    object_id: "T-1",
    manifest_id: $manifest_id,
    input_revision_pins: [{object_id: "T-1", revision_pin: "rev-1"}],
    idempotency_key: "T-1:rev-1",
    summary: "I will run gh pr merge",
    artifacts: []
  }' >"${invalid_output}"
if agent_output_validate "${invalid_output}" "coder" "Implement" "${manifest_id}" >/dev/null 2>&1; then
  fail "invalid output with operational side-effect text should fail"
fi

lease_id="$(lease_claim "contract-test" "T-1" "Implement" "worker-1" 60 '[{"object_id":"T-1","revision_pin":"rev-1"}]')" || fail "first lease claim should pass"
if lease_claim "contract-test" "T-1" "Implement" "worker-2" 60 '[]' >/dev/null 2>&1; then
  fail "second active lease claim should fail"
fi
lease_release "contract-test" "T-1" "${lease_id}" || fail "lease release should pass"

signal_file="${LLM_TEAM_ROOT}/workdir/contract-test/signal.json"
jq -n '{
  signal_id: "sig-1",
  signal_type: "approve",
  target_kind: "milestone",
  target_id: "M-1",
  actor: "human",
  created_at: "2026-05-01T00:00:00Z"
}' >"${signal_file}"
human_signal_validate "${signal_file}" || fail "human signal should validate"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} contract invariant check(s) failed" >&2
  exit 1
fi

echo "PASS: contract invariants"
