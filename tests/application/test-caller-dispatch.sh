#!/usr/bin/env bash
# tests/application/test-caller-dispatch.sh
#
# Integration test for application/caller_dispatch.sh — exercises every branch
# of the 13-way output_kind table against the in_memory issue_tracker adapter.
#
# Validation per branch:
#   • CP file is created/transitioned to the SOC-states the spec mandates.
#   • PR / Issue / Milestone state transitions match SOC.
#   • RGC-LEDGER row is written with required fields.
# Plus:
#   • Dependency cycle in task_plan → rejected (non-zero rc).
#   • SOC-MERGE-POLICY: stale base_sha → CP_STALE branch.
#   • SOC-IDEMPOTENCY: same idempotency_key twice → ledger duplicate, no extra
#     side effects.
#   • caller_advance_milestone_after_task_integrated: all-integrated → advance,
#     mixed → no-op.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="caller-dispatch-test-$$"
export TARGET_NAME
TEST_INMEM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-it-cd-XXXXXX")"
TEST_INMEM_WS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ws-cd-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${TEST_INMEM_ROOT}"
export LLM_TEAM_INMEM_WS_DIR="${TEST_INMEM_WS_ROOT}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
export LLM_TEAM_ADAPTER_WORKSPACE=in_memory
export LLM_TEAM_INMEM_IT_ACTOR="alice"
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}"

cleanup() {
  rm -rf "${TEST_INMEM_ROOT}" "${TEST_INMEM_WS_ROOT}" "${TARGET_WORKDIR}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/caller_dispatch.sh
. "${LLM_TEAM_ROOT}/application/caller_dispatch.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

repo="acme/widgets"
mkdir -p "${TARGET_WORKDIR}/manifests"

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
make_manifest() {
  local op="$1" kind="$2" id="$3"
  local mf
  mf="$(context_manifest_create "${TARGET_NAME}" "${op}" "${kind}" "${id}")"
  context_manifest_add_entry "${mf}" "${kind}" "${id}" body "rev-${id}" true "primary"
  printf '%s' "${mf}"
}

# Write an envelope to a temp file. Caller passes a jq build-program.
write_envelope() {
  local jq_program="$1"
  local f
  f="$(mktemp -t cd-envelope.XXXXXX)"
  jq -n "${jq_program}" >"${f}"
  printf '%s' "${f}"
}

ledger_count_with_key() {
  local key="$1"
  local path
  path="$(transition_ledger_path "${TARGET_NAME}")"
  [ -f "${path}" ] || { printf '0'; return; }
  jq --arg k "${key}" -r 'select(.idempotency_key == $k) | "x"' "${path}" | wc -l | tr -d ' '
}

# --------------------------------------------------------------------------
# Branch 1: spec_proposal (PO)
# --------------------------------------------------------------------------
ms_po="$(it_milestone_create "${repo}" "Auth" "")"
it_milestone_set_state "${repo}" "${ms_po}" PO_DRAFT
mf_po="$(make_manifest Compose-PO milestone "${ms_po}")"
mid_po="$(context_manifest_id "${mf_po}")"
env_po="$(write_envelope "{
  output_kind: \"spec_proposal\", agent_role: \"PO\", operation: \"Compose-PO\",
  target_id: \"${ms_po}\", manifest_id: \"${mid_po}\",
  input_revision_pins: [], idempotency_key: \"po:${ms_po}:r1\",
  summary: \"PO spec\",
  artifacts: { milestone_body: \"# Auth (proposed body)\", cp_artifact_ref: \"po-${ms_po}\" }
}")"
caller_apply_output "${repo}" po "${env_po}" "${mf_po}" \
  || fail "spec_proposal PO branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_po}")" = "PO_GATE" ] \
  || fail "spec_proposal PO: milestone should be PO_GATE"
po_cp_count="$(ls "${TARGET_WORKDIR}/change-proposals" 2>/dev/null | grep -c 'cp-Spec-' || true)"
[ "${po_cp_count}" -ge 1 ] || fail "spec_proposal PO: expected a Spec CP file"
[ "$(ledger_count_with_key "po:${ms_po}:r1")" = "1" ] \
  || fail "spec_proposal PO: ledger row missing"

# --------------------------------------------------------------------------
# Branch 2: spec_proposal (PM)
# --------------------------------------------------------------------------
ms_pm="$(it_milestone_create "${repo}" "Logging" "")"
it_milestone_set_state "${repo}" "${ms_pm}" PM_DRAFT
mf_pm="$(make_manifest Compose-PM milestone "${ms_pm}")"
mid_pm="$(context_manifest_id "${mf_pm}")"
env_pm="$(write_envelope "{
  output_kind: \"spec_proposal\", agent_role: \"PM\", operation: \"Compose-PM\",
  target_id: \"${ms_pm}\", manifest_id: \"${mid_pm}\",
  input_revision_pins: [], idempotency_key: \"pm:${ms_pm}:r1\",
  summary: \"PM spec\", artifacts: {}
}")"
caller_apply_output "${repo}" pm "${env_pm}" "${mf_pm}" \
  || fail "spec_proposal PM branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_pm}")" = "PM_GATE" ] \
  || fail "spec_proposal PM: milestone should be PM_GATE"

# --------------------------------------------------------------------------
# Branch 3: task_plan (Planner) — happy path + dependency cycle
# --------------------------------------------------------------------------
ms_plan="$(it_milestone_create "${repo}" "Plan A" "")"
it_milestone_set_state "${repo}" "${ms_plan}" DECOMPOSE_IN_PROGRESS
mf_plan="$(make_manifest Decompose milestone "${ms_plan}")"
mid_plan="$(context_manifest_id "${mf_plan}")"
env_plan="$(write_envelope "{
  output_kind: \"task_plan\", agent_role: \"Planner\", operation: \"Decompose\",
  target_id: \"${ms_plan}\", manifest_id: \"${mid_plan}\",
  input_revision_pins: [], idempotency_key: \"plan:${ms_plan}:r1\",
  summary: \"plan\",
  artifacts: {
    tasks: [
      { slug: \"login\",  title: \"Login\",  body: \"login body\" },
      { slug: \"logout\", title: \"Logout\", body: \"logout body\" }
    ],
    dependency_graph: { login: [], logout: [\"login\"] },
    integration_branch: { name: \"feat/integration-${ms_plan}\", base: \"main\" }
  }
}")"
caller_apply_output "${repo}" planner "${env_plan}" "${mf_plan}" \
  || fail "task_plan branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_plan}")" = "IMPLEMENTING" ] \
  || fail "task_plan: milestone should be IMPLEMENTING"
ready_after_plan="$(it_issue_list_in_state "${repo}" TASK_READY)"
pending_after_plan="$(it_issue_list_in_state "${repo}" TASK_PENDING)"
case ",$(echo ${ready_after_plan} | tr ' ' ','),"  in *,*,*) ;; esac
case " ${ready_after_plan} " in *" "*) ;; esac
[ -n "${ready_after_plan}" ] || fail "task_plan: expected at least one TASK_READY issue"
[ -n "${pending_after_plan}" ] || fail "task_plan: expected at least one TASK_PENDING issue"

# Cycle case
ms_cycle="$(it_milestone_create "${repo}" "Cycle" "")"
it_milestone_set_state "${repo}" "${ms_cycle}" DECOMPOSE_IN_PROGRESS
mf_cycle="$(make_manifest Decompose milestone "${ms_cycle}")"
mid_cycle="$(context_manifest_id "${mf_cycle}")"
env_cycle="$(write_envelope "{
  output_kind: \"task_plan\", agent_role: \"Planner\", operation: \"Decompose\",
  target_id: \"${ms_cycle}\", manifest_id: \"${mid_cycle}\",
  input_revision_pins: [], idempotency_key: \"plan:${ms_cycle}:r1\",
  summary: \"cycle\",
  artifacts: {
    tasks: [{slug:\"a\",title:\"A\",body:\"\"}, {slug:\"b\",title:\"B\",body:\"\"}],
    dependency_graph: { a: [\"b\"], b: [\"a\"] }
  }
}")"
if caller_apply_output "${repo}" planner "${env_cycle}" "${mf_cycle}" 2>/dev/null; then
  fail "task_plan with dependency cycle should be rejected"
fi
# Milestone state should NOT have advanced when cycle was rejected.
[ "$(it_milestone_get_state "${repo}" "${ms_cycle}")" = "DECOMPOSE_IN_PROGRESS" ] \
  || fail "task_plan cycle: milestone should remain DECOMPOSE_IN_PROGRESS"

# --------------------------------------------------------------------------
# Branch 4: patch (Coder)
# --------------------------------------------------------------------------
# Stub ws_apply_patch / ws_publish_branch — runner.sh would normally have set
# the workspace up; here we focus on caller_dispatch routing logic.
ws_apply_patch()    { :; }
ws_publish_branch() { :; }

# Use the first task created in branch 3 as our task issue (it's TASK_READY).
task_issue="$(printf '%s' "${ready_after_plan}" | head -n 1 | awk '{print $1}')"
it_issue_set_state "${repo}" "${task_issue}" TASK_IN_PROGRESS TASK_READY
mf_coder="$(make_manifest Implement task "${task_issue}")"
mid_coder="$(context_manifest_id "${mf_coder}")"
env_coder="$(write_envelope "{
  output_kind: \"patch\", agent_role: \"Coder\", operation: \"Implement\",
  target_id: \"${task_issue}\", manifest_id: \"${mid_coder}\",
  input_revision_pins: [], idempotency_key: \"coder:${task_issue}:r1\",
  summary: \"impl\",
  artifacts: {
    patch_diff: \"diff --git a/src/x.ts b/src/x.ts\\n--- a/src/x.ts\\n+++ b/src/x.ts\\n@@\\n+ok\\n\",
    task_branch: \"llm-team/task-${task_issue}\"
  }
}")"
caller_apply_output "${repo}" coder "${env_coder}" "${mf_coder}" \
  || fail "patch branch failed"
[ "$(it_issue_get_state "${repo}" "${task_issue}")" = "TASK_REVIEW_READY" ] \
  || fail "patch: task issue should be TASK_REVIEW_READY"
# Find the new PR (in_memory increments pr_next).
pr_for_task="$(jq -r --arg b "llm-team/task-${task_issue}" '
  select(.head.ref == $b) | .number
' "${LLM_TEAM_INMEM_IT_DIR}/prs/"*.json | head -n 1)"
[ -n "${pr_for_task}" ] || fail "patch: PR for task #${task_issue} not found"
[ "$(it_pr_get_cp_state "${repo}" "${pr_for_task}")" = "CP_READY_FOR_REVIEW" ] \
  || fail "patch: PR cp-state should be CP_READY_FOR_REVIEW"

# Code CP path for use in verdict branches.
code_cp_path="$(ls "${TARGET_WORKDIR}/change-proposals/cp-Code-${task_issue}-"*.json 2>/dev/null | head -n 1)"
[ -n "${code_cp_path}" ] || fail "patch: Code CP file not found"
[ "$(jq -r '.state' "${code_cp_path}")" = "CP_READY_FOR_REVIEW" ] \
  || fail "patch: Code CP state should be CP_READY_FOR_REVIEW"

# --------------------------------------------------------------------------
# Branch 5: verdict approve (clean — base_sha == integration head)
# --------------------------------------------------------------------------
# Force ws_get_branch_head to return the same value as the PR's base sha so the
# clean-merge path is taken. We override the function in this shell.
target_pr_base_sha="$(it_pr_get_base_sha "${repo}" "${pr_for_task}")"
ws_get_branch_head() { printf '%s\n' "${target_pr_base_sha}"; }

it_issue_set_state "${repo}" "${task_issue}" TASK_REVIEW_IN_PROGRESS TASK_REVIEW_READY
mf_rev="$(make_manifest Review task "${task_issue}")"
mid_rev="$(context_manifest_id "${mf_rev}")"
env_approve="$(write_envelope "{
  output_kind: \"verdict\", agent_role: \"Reviewer\", operation: \"Review\",
  target_id: \"${task_issue}\", manifest_id: \"${mid_rev}\",
  input_revision_pins: [], idempotency_key: \"review:${task_issue}:approve\",
  summary: \"approve\",
  artifacts: {
    verdict: \"approve\", pr_number: \"${pr_for_task}\", cp_path: \"${code_cp_path}\"
  }
}")"
caller_apply_output "${repo}" reviewer "${env_approve}" "${mf_rev}" \
  || fail "verdict approve branch failed"
[ "$(it_issue_get_state "${repo}" "${task_issue}")" = "TASK_INTEGRATED" ] \
  || fail "verdict approve: task should be TASK_INTEGRATED"
[ "$(jq -r '.state' "${code_cp_path}")" = "CP_MERGED" ] \
  || fail "verdict approve: CP should be CP_MERGED"
[ "$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr_for_task}.json")" = "merged" ] \
  || fail "verdict approve: PR should be merged"

# --------------------------------------------------------------------------
# Branch 6: verdict request-changes
# --------------------------------------------------------------------------
# New task to reject.
task_issue2="$(it_issue_create "${repo}" --title "ToReject" --body "" --milestone "${ms_plan}")"
it_issue_set_state "${repo}" "${task_issue2}" TASK_IN_PROGRESS
pr_reject="$(it_pr_create "${repo}" --head "feature/reject" --base integration --title "reject" --body "")"
it_pr_set_cp_state "${repo}" "${pr_reject}" CP_READY_FOR_REVIEW
code_cp_reject="$(change_proposal_create "${TARGET_NAME}" Code Coder Implement "${task_issue2}" "branch:feature/reject")"
change_proposal_set_state "${code_cp_reject}" CP_READY_FOR_REVIEW CP_DRAFT
it_issue_set_state "${repo}" "${task_issue2}" TASK_REVIEW_IN_PROGRESS TASK_IN_PROGRESS
mf_rej="$(make_manifest Review task "${task_issue2}")"
mid_rej="$(context_manifest_id "${mf_rej}")"
env_reject="$(write_envelope "{
  output_kind: \"verdict\", agent_role: \"Reviewer\", operation: \"Review\",
  target_id: \"${task_issue2}\", manifest_id: \"${mid_rej}\",
  input_revision_pins: [], idempotency_key: \"review:${task_issue2}:reject\",
  summary: \"reject\",
  artifacts: {
    verdict: \"request-changes\", pr_number: \"${pr_reject}\", cp_path: \"${code_cp_reject}\",
    reason: \"add tests\"
  }
}")"
caller_apply_output "${repo}" reviewer "${env_reject}" "${mf_rej}" \
  || fail "verdict request-changes branch failed"
[ "$(it_issue_get_state "${repo}" "${task_issue2}")" = "TASK_READY" ] \
  || fail "verdict request-changes: task should be TASK_READY"
[ "$(jq -r '.state' "${code_cp_reject}")" = "CP_CLOSED" ] \
  || fail "verdict request-changes: CP should be CP_CLOSED"
[ "$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr_reject}.json")" = "closed" ] \
  || fail "verdict request-changes: PR should be closed"

# --------------------------------------------------------------------------
# Branch 5b: verdict approve STALE (base_sha != integration head)
# --------------------------------------------------------------------------
task_stale="$(it_issue_create "${repo}" --title "Stale" --body "" --milestone "${ms_plan}")"
pr_stale="$(it_pr_create "${repo}" --head "feature/stale" --base integration --title "stale" --body "")"
it_pr_set_cp_state "${repo}" "${pr_stale}" CP_READY_FOR_REVIEW
cp_stale="$(change_proposal_create "${TARGET_NAME}" Code Coder Implement "${task_stale}" "branch:feature/stale")"
change_proposal_set_state "${cp_stale}" CP_READY_FOR_REVIEW CP_DRAFT
it_issue_set_state "${repo}" "${task_stale}" TASK_IN_PROGRESS
it_issue_set_state "${repo}" "${task_stale}" TASK_REVIEW_IN_PROGRESS TASK_IN_PROGRESS

# Override ws_get_branch_head to return a *different* sha → triggers STALE branch.
ws_get_branch_head() { printf '%s\n' "sha-different-from-base"; }

mf_stale="$(make_manifest Review task "${task_stale}")"
mid_stale="$(context_manifest_id "${mf_stale}")"
env_stale="$(write_envelope "{
  output_kind: \"verdict\", agent_role: \"Reviewer\", operation: \"Review\",
  target_id: \"${task_stale}\", manifest_id: \"${mid_stale}\",
  input_revision_pins: [], idempotency_key: \"review:${task_stale}:stale\",
  summary: \"stale approve\",
  artifacts: { verdict: \"approve\", pr_number: \"${pr_stale}\", cp_path: \"${cp_stale}\" }
}")"
caller_apply_output "${repo}" reviewer "${env_stale}" "${mf_stale}" \
  || fail "verdict approve(stale) branch failed"
[ "$(jq -r '.state' "${cp_stale}")" = "CP_STALE" ] \
  || fail "verdict approve(stale): CP should be CP_STALE"
[ "$(it_issue_get_state "${repo}" "${task_stale}")" = "TASK_READY" ] \
  || fail "verdict approve(stale): task should be TASK_READY"
[ "$(it_pr_get_cp_state "${repo}" "${pr_stale}")" = "CP_STALE" ] \
  || fail "verdict approve(stale): PR cp-state should be CP_STALE"

# Restore matching ws_get_branch_head for subsequent branches.
unset -f ws_get_branch_head 2>/dev/null || true

# --------------------------------------------------------------------------
# Branch 7: milestone_package Integrator NO-OP
# --------------------------------------------------------------------------
ms_int_noop="$(it_milestone_create "${repo}" "IntNoOp" "")"
it_milestone_set_state "${repo}" "${ms_int_noop}" REFACTOR_IN_PROGRESS
mf_int_noop="$(make_manifest Refactor milestone "${ms_int_noop}")"
mid_int_noop="$(context_manifest_id "${mf_int_noop}")"
env_int_noop="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"Integrator\", operation: \"Refactor\",
  target_id: \"${ms_int_noop}\", manifest_id: \"${mid_int_noop}\",
  input_revision_pins: [], idempotency_key: \"int:${ms_int_noop}:noop\",
  summary: \"noop\",
  artifacts: { outcome: \"NO-OP\", cp_kind: \"Integration\" }
}")"
caller_apply_output "${repo}" integrator "${env_int_noop}" "${mf_int_noop}" \
  || fail "Integrator NO-OP branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_int_noop}")" = "VALIDATE_READY" ] \
  || fail "Integrator NO-OP: milestone should be VALIDATE_READY"

# --------------------------------------------------------------------------
# Branch 8: milestone_package Integrator PASS (with new CP + PR merge)
# --------------------------------------------------------------------------
ms_int_pass="$(it_milestone_create "${repo}" "IntPass" "")"
it_milestone_set_state "${repo}" "${ms_int_pass}" REFACTOR_IN_PROGRESS
pr_int="$(it_pr_create "${repo}" --head "integration/m${ms_int_pass}" --base main --title "int" --body "")"
mf_int_pass="$(make_manifest Refactor milestone "${ms_int_pass}")"
mid_int_pass="$(context_manifest_id "${mf_int_pass}")"
env_int_pass="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"Integrator\", operation: \"Refactor\",
  target_id: \"${ms_int_pass}\", manifest_id: \"${mid_int_pass}\",
  input_revision_pins: [], idempotency_key: \"int:${ms_int_pass}:pass\",
  summary: \"pass\",
  artifacts: { outcome: \"PASS\", cp_kind: \"Integration\", cp_artifact_ref: \"int-${ms_int_pass}\", pr_number: \"${pr_int}\" }
}")"
caller_apply_output "${repo}" integrator "${env_int_pass}" "${mf_int_pass}" \
  || fail "Integrator PASS branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_int_pass}")" = "VALIDATE_READY" ] \
  || fail "Integrator PASS: milestone should be VALIDATE_READY"
int_cp_path="$(ls "${TARGET_WORKDIR}/change-proposals/cp-Integration-${ms_int_pass}-"*.json 2>/dev/null | head -n 1)"
[ -n "${int_cp_path}" ] || fail "Integrator PASS: Integration CP not created"
[ "$(jq -r '.state' "${int_cp_path}")" = "CP_MERGED" ] \
  || fail "Integrator PASS: CP should be CP_MERGED"
[ "$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr_int}.json")" = "merged" ] \
  || fail "Integrator PASS: integration PR should be merged"

# --------------------------------------------------------------------------
# Branch 9: milestone_package Integrator FAIL (within retry budget)
# --------------------------------------------------------------------------
ms_int_fail="$(it_milestone_create "${repo}" "IntFail" "")"
it_milestone_set_state "${repo}" "${ms_int_fail}" REFACTOR_IN_PROGRESS
pr_int_fail="$(it_pr_create "${repo}" --head "integration/m${ms_int_fail}" --base main --title "int-fail" --body "")"
cp_int_fail="$(change_proposal_create "${TARGET_NAME}" Integration Integrator Refactor "${ms_int_fail}" "int-${ms_int_fail}")"
change_proposal_set_state "${cp_int_fail}" CP_READY_FOR_VERIFICATION CP_DRAFT
mf_int_fail="$(make_manifest Refactor milestone "${ms_int_fail}")"
mid_int_fail="$(context_manifest_id "${mf_int_fail}")"
env_int_fail="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"Integrator\", operation: \"Refactor\",
  target_id: \"${ms_int_fail}\", manifest_id: \"${mid_int_fail}\",
  input_revision_pins: [], idempotency_key: \"int:${ms_int_fail}:fail1\",
  summary: \"fail\",
  artifacts: { outcome: \"FAIL\", cp_kind: \"Integration\", cp_path: \"${cp_int_fail}\", pr_number: \"${pr_int_fail}\", integrator_attempt: 1 }
}")"
caller_apply_output "${repo}" integrator "${env_int_fail}" "${mf_int_fail}" \
  || fail "Integrator FAIL branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_int_fail}")" = "REFACTOR_READY" ] \
  || fail "Integrator FAIL: milestone should be REFACTOR_READY"
[ "$(jq -r '.state' "${cp_int_fail}")" = "CP_CLOSED" ] \
  || fail "Integrator FAIL: CP should be CP_CLOSED"
[ "$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr_int_fail}.json")" = "closed" ] \
  || fail "Integrator FAIL: PR should be closed"

# Integrator FAIL — escalation (attempt >= max).
ms_int_esc="$(it_milestone_create "${repo}" "IntEsc" "")"
it_milestone_set_state "${repo}" "${ms_int_esc}" REFACTOR_IN_PROGRESS
mf_int_esc="$(make_manifest Refactor milestone "${ms_int_esc}")"
mid_int_esc="$(context_manifest_id "${mf_int_esc}")"
env_int_esc="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"Integrator\", operation: \"Refactor\",
  target_id: \"${ms_int_esc}\", manifest_id: \"${mid_int_esc}\",
  input_revision_pins: [], idempotency_key: \"int:${ms_int_esc}:fail-final\",
  summary: \"esc\",
  artifacts: { outcome: \"FAIL\", cp_kind: \"Integration\", integrator_attempt: 99 }
}")"
LLM_TEAM_INTEGRATOR_MAX_ATTEMPTS=3 \
  caller_apply_output "${repo}" integrator "${env_int_esc}" "${mf_int_esc}" \
  || fail "Integrator FAIL escalation branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_int_esc}")" = "ESCALATED" ] \
  || fail "Integrator FAIL escalation: milestone should be ESCALATED"

# --------------------------------------------------------------------------
# Branch 10: milestone_package Integrator STALE
# --------------------------------------------------------------------------
ms_int_stale="$(it_milestone_create "${repo}" "IntStale" "")"
it_milestone_set_state "${repo}" "${ms_int_stale}" REFACTOR_IN_PROGRESS
cp_int_stale="$(change_proposal_create "${TARGET_NAME}" Integration Integrator Refactor "${ms_int_stale}" "int-${ms_int_stale}")"
change_proposal_set_state "${cp_int_stale}" CP_READY_FOR_VERIFICATION CP_DRAFT
mf_int_stale="$(make_manifest Refactor milestone "${ms_int_stale}")"
mid_int_stale="$(context_manifest_id "${mf_int_stale}")"
env_int_stale="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"Integrator\", operation: \"Refactor\",
  target_id: \"${ms_int_stale}\", manifest_id: \"${mid_int_stale}\",
  input_revision_pins: [], idempotency_key: \"int:${ms_int_stale}:stale\",
  summary: \"stale\",
  artifacts: { outcome: \"STALE\", cp_kind: \"Integration\", cp_path: \"${cp_int_stale}\" }
}")"
caller_apply_output "${repo}" integrator "${env_int_stale}" "${mf_int_stale}" \
  || fail "Integrator STALE branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_int_stale}")" = "REFACTOR_READY" ] \
  || fail "Integrator STALE: milestone should be REFACTOR_READY"
[ "$(jq -r '.state' "${cp_int_stale}")" = "CP_STALE" ] \
  || fail "Integrator STALE: CP should be CP_STALE"

# --------------------------------------------------------------------------
# Branch 11: milestone_package QA PASS
# --------------------------------------------------------------------------
ms_qa_pass="$(it_milestone_create "${repo}" "QAPass" "")"
it_milestone_set_state "${repo}" "${ms_qa_pass}" VALIDATE_IN_PROGRESS
issue_qa1="$(it_issue_create "${repo}" --title "qa-task-1" --body "" --milestone "${ms_qa_pass}")"
it_issue_set_state "${repo}" "${issue_qa1}" TASK_INTEGRATED
pr_qa="$(it_pr_create "${repo}" --head "milestone/m${ms_qa_pass}" --base main --title "qa" --body "")"
mf_qa_pass="$(make_manifest Validate milestone "${ms_qa_pass}")"
mid_qa_pass="$(context_manifest_id "${mf_qa_pass}")"
env_qa_pass="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"QA\", operation: \"Validate\",
  target_id: \"${ms_qa_pass}\", manifest_id: \"${mid_qa_pass}\",
  input_revision_pins: [], idempotency_key: \"qa:${ms_qa_pass}:pass\",
  summary: \"qa pass\",
  artifacts: { outcome: \"PASS\", cp_kind: \"Milestone\", cp_artifact_ref: \"qa-${ms_qa_pass}\", pr_number: \"${pr_qa}\" }
}")"
caller_apply_output "${repo}" qa "${env_qa_pass}" "${mf_qa_pass}" \
  || fail "QA PASS branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_qa_pass}")" = "DONE" ] \
  || fail "QA PASS: milestone should be DONE"
[ "$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/milestones/${ms_qa_pass}.json")" = "closed" ] \
  || fail "QA PASS: milestone should be closed"
[ "$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/issues/${issue_qa1}.json")" = "closed" ] \
  || fail "QA PASS: child task should be closed"
ms_cp_path="$(ls "${TARGET_WORKDIR}/change-proposals/cp-Milestone-${ms_qa_pass}-"*.json 2>/dev/null | head -n 1)"
[ -n "${ms_cp_path}" ] || fail "QA PASS: Milestone CP not created"
[ "$(jq -r '.state' "${ms_cp_path}")" = "CP_MERGED" ] \
  || fail "QA PASS: Milestone CP should be CP_MERGED"

# --------------------------------------------------------------------------
# Branch 12: milestone_package QA FAIL
# --------------------------------------------------------------------------
ms_qa_fail="$(it_milestone_create "${repo}" "QAFail" "")"
it_milestone_set_state "${repo}" "${ms_qa_fail}" VALIDATE_IN_PROGRESS
issue_qa_fail="$(it_issue_create "${repo}" --title "qa-fail-task" --body "" --milestone "${ms_qa_fail}")"
it_issue_set_state "${repo}" "${issue_qa_fail}" TASK_INTEGRATED
pr_qa_fail="$(it_pr_create "${repo}" --head "milestone/qa-fail" --base main --title "qa-fail" --body "")"
cp_qa_fail="$(change_proposal_create "${TARGET_NAME}" Milestone QA Validate "${ms_qa_fail}" "qa-${ms_qa_fail}")"
change_proposal_set_state "${cp_qa_fail}" CP_READY_FOR_VERIFICATION CP_DRAFT
mf_qa_fail="$(make_manifest Validate milestone "${ms_qa_fail}")"
mid_qa_fail="$(context_manifest_id "${mf_qa_fail}")"
env_qa_fail="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"QA\", operation: \"Validate\",
  target_id: \"${ms_qa_fail}\", manifest_id: \"${mid_qa_fail}\",
  input_revision_pins: [], idempotency_key: \"qa:${ms_qa_fail}:fail\",
  summary: \"qa fail\",
  artifacts: { outcome: \"FAIL\", cp_kind: \"Milestone\", cp_path: \"${cp_qa_fail}\", pr_number: \"${pr_qa_fail}\",
               failing_tasks: [\"${issue_qa_fail}\"] }
}")"
caller_apply_output "${repo}" qa "${env_qa_fail}" "${mf_qa_fail}" \
  || fail "QA FAIL branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_qa_fail}")" = "IMPLEMENTING" ] \
  || fail "QA FAIL: milestone should be IMPLEMENTING"
[ "$(it_issue_get_state "${repo}" "${issue_qa_fail}")" = "TASK_READY" ] \
  || fail "QA FAIL: failing task should be reset to TASK_READY"
[ "$(jq -r '.state' "${cp_qa_fail}")" = "CP_CLOSED" ] \
  || fail "QA FAIL: CP should be CP_CLOSED"

# --------------------------------------------------------------------------
# Branch 13: milestone_package QA STALE
# --------------------------------------------------------------------------
ms_qa_stale="$(it_milestone_create "${repo}" "QAStale" "")"
it_milestone_set_state "${repo}" "${ms_qa_stale}" VALIDATE_IN_PROGRESS
cp_qa_stale="$(change_proposal_create "${TARGET_NAME}" Milestone QA Validate "${ms_qa_stale}" "qa-${ms_qa_stale}")"
change_proposal_set_state "${cp_qa_stale}" CP_READY_FOR_VERIFICATION CP_DRAFT
mf_qa_stale="$(make_manifest Validate milestone "${ms_qa_stale}")"
mid_qa_stale="$(context_manifest_id "${mf_qa_stale}")"
env_qa_stale="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"QA\", operation: \"Validate\",
  target_id: \"${ms_qa_stale}\", manifest_id: \"${mid_qa_stale}\",
  input_revision_pins: [], idempotency_key: \"qa:${ms_qa_stale}:stale\",
  summary: \"qa stale\",
  artifacts: { outcome: \"STALE\", cp_kind: \"Milestone\", cp_path: \"${cp_qa_stale}\" }
}")"
caller_apply_output "${repo}" qa "${env_qa_stale}" "${mf_qa_stale}" \
  || fail "QA STALE branch failed"
[ "$(it_milestone_get_state "${repo}" "${ms_qa_stale}")" = "VALIDATE_READY" ] \
  || fail "QA STALE: milestone should be VALIDATE_READY"
[ "$(jq -r '.state' "${cp_qa_stale}")" = "CP_STALE" ] \
  || fail "QA STALE: CP should be CP_STALE"

# --------------------------------------------------------------------------
# SOC-IDEMPOTENCY: re-apply same envelope twice → ledger duplicate, no double effect
# --------------------------------------------------------------------------
ms_dup="$(it_milestone_create "${repo}" "Dup" "")"
it_milestone_set_state "${repo}" "${ms_dup}" REFACTOR_IN_PROGRESS
mf_dup="$(make_manifest Refactor milestone "${ms_dup}")"
mid_dup="$(context_manifest_id "${mf_dup}")"
env_dup="$(write_envelope "{
  output_kind: \"milestone_package\", agent_role: \"Integrator\", operation: \"Refactor\",
  target_id: \"${ms_dup}\", manifest_id: \"${mid_dup}\",
  input_revision_pins: [], idempotency_key: \"dup:${ms_dup}:noop\",
  summary: \"dup test\",
  artifacts: { outcome: \"NO-OP\", cp_kind: \"Integration\" }
}")"
caller_apply_output "${repo}" integrator "${env_dup}" "${mf_dup}" \
  || fail "idempotency: first apply should succeed"
state_after_first="$(it_milestone_get_state "${repo}" "${ms_dup}")"
[ "${state_after_first}" = "VALIDATE_READY" ] \
  || fail "idempotency: state after first apply should be VALIDATE_READY"
caller_apply_output "${repo}" integrator "${env_dup}" "${mf_dup}" \
  || fail "idempotency: second apply should also succeed (no-op)"
state_after_second="$(it_milestone_get_state "${repo}" "${ms_dup}")"
[ "${state_after_second}" = "${state_after_first}" ] \
  || fail "idempotency: state should not change on duplicate"
dup_count="$(ledger_count_with_key "dup:${ms_dup}:noop")"
[ "${dup_count}" = "2" ] \
  || fail "idempotency: expected 2 ledger rows (1 applied + 1 duplicate), got ${dup_count}"

# --------------------------------------------------------------------------
# caller_advance_milestone_after_task_integrated
# --------------------------------------------------------------------------
ms_sweep="$(it_milestone_create "${repo}" "Sweep" "")"
it_milestone_set_state "${repo}" "${ms_sweep}" IMPLEMENTING
sweep_a="$(it_issue_create "${repo}" --title "sa" --body "" --milestone "${ms_sweep}")"
sweep_b="$(it_issue_create "${repo}" --title "sb" --body "" --milestone "${ms_sweep}")"
it_issue_set_state "${repo}" "${sweep_a}" TASK_INTEGRATED
it_issue_set_state "${repo}" "${sweep_b}" TASK_REVIEW_READY
caller_advance_milestone_after_task_integrated "${repo}" "${ms_sweep}" \
  || fail "sweeper failed (mixed-state case)"
[ "$(it_milestone_get_state "${repo}" "${ms_sweep}")" = "IMPLEMENTING" ] \
  || fail "sweeper: should NOT advance when a child is still TASK_REVIEW_READY"
# Now flip the second child to integrated → sweeper advances.
it_issue_set_state "${repo}" "${sweep_b}" TASK_INTEGRATED TASK_REVIEW_READY
caller_advance_milestone_after_task_integrated "${repo}" "${ms_sweep}" \
  || fail "sweeper failed (all-integrated case)"
[ "$(it_milestone_get_state "${repo}" "${ms_sweep}")" = "REFACTOR_READY" ] \
  || fail "sweeper: should advance to REFACTOR_READY when all children integrated"

# --------------------------------------------------------------------------
# AGC-CALL-BOUNDARY: caller_dispatch.sh should not call gh/git/curl/claude directly
# --------------------------------------------------------------------------
boundary_calls="$(grep -nE '(^|[ |&;{(])(gh|git|curl|claude) [^[:space:]]' \
  "${LLM_TEAM_ROOT}/application/caller_dispatch.sh" \
  | grep -vE '^[^:]+:\s*#' \
  | grep -vE '#.*(gh|git|curl|claude) ' \
  || true)"
if [ -n "${boundary_calls}" ]; then
  fail "caller_dispatch.sh should not invoke gh/git/curl/claude directly:"
  printf '%s\n' "${boundary_calls}" >&2
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} caller_dispatch check(s) failed" >&2
  exit 1
fi

echo "PASS: application/caller_dispatch.sh (13 branches + cycle + merge-policy + idempotency + sweeper)"
