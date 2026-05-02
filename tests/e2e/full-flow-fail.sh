#!/usr/bin/env bash
# tests/e2e/full-flow-fail.sh
#
# Phase 9 — End-to-end failure paths.
#
# Two scenarios (each in its own isolated TARGET_NAME):
#   A) QA FAIL — milestone reaches VALIDATE_READY then QA returns failing_tasks;
#      caller_dispatch routes to FAIL branch:
#        - Milestone CP → CP_REQUEST_CHANGES → CP_CLOSED
#        - PR closed
#        - Failing task issue rolled back TASK_INTEGRATED → TASK_READY
#        - Milestone state VALIDATE_IN_PROGRESS → IMPLEMENTING
#   B) Reject signal — milestone in PO_GATE receives reject signal:
#        - Milestone state PO_GATE → PO_DRAFT (rolled back)
#
# Adapter 환경: in_memory + fake LLM (재사용 patterns from full-flow.sh).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
ok() { echo "  ok: $*"; }

# ============================================================================
# Helper: run a fully isolated scenario
# ============================================================================
run_scenario_qa_fail() {
  local target="qa-fail-$$"
  local it_dir ws_dir ps_dir fx_dir target_yaml workdir
  it_dir="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-fail-it-XXXXXX")"
  ws_dir="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-fail-ws-XXXXXX")"
  ps_dir="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-fail-ps-XXXXXX")"
  fx_dir="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-fail-fx-XXXXXX")"
  target_yaml="${LLM_TEAM_ROOT}/targets/${target}.yaml"
  workdir="${LLM_TEAM_ROOT}/workdir/${target}"

  trap "rm -rf '${it_dir}' '${ws_dir}' '${ps_dir}' '${fx_dir}' '${workdir}' 2>/dev/null || true; rm -f '${target_yaml}' 2>/dev/null || true" RETURN

  cat >"${target_yaml}" <<EOF
name: ${target}
github: { owner: e2e-fail, repo: ${target}, default_branch: main }
local: { clone_path: ${ws_dir} }
inputs_dir: inputs/${target}
labels: { prefix: "" }
notifier: { channel: none, webhook_or_id: "" }
dev_concurrency: 1
stale_threshold_minutes: 60
verification: { commands: ["true"] }
enabled: true
EOF
  mkdir -p "${workdir}/manifests"

  TARGET_NAME="${target}" \
  LLM_TEAM_INMEM_IT_DIR="${it_dir}" \
  LLM_TEAM_INMEM_WS_DIR="${ws_dir}" \
  LLM_TEAM_INMEM_PS_DIR="${ps_dir}" \
  LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory \
  LLM_TEAM_ADAPTER_WORKSPACE=in_memory \
  LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory \
  _qa_fail_inner "${target}" "${it_dir}" "${fx_dir}" "${workdir}"
  return $?
}

_qa_fail_inner() {
  local target="$1" it_dir="$2" fx_dir="$3" workdir="$4"
  local repo="e2e-fail/${target}"

  # Re-source within the env-var-set subshell context.
  export TARGET_NAME="${target}" \
    LLM_TEAM_INMEM_IT_DIR="${it_dir}" \
    LLM_TEAM_INMEM_WS_DIR="${LLM_TEAM_INMEM_WS_DIR}" \
    LLM_TEAM_INMEM_PS_DIR="${LLM_TEAM_INMEM_PS_DIR}" \
    LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory \
    LLM_TEAM_ADAPTER_WORKSPACE=in_memory \
    LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory \
    LLM_TEAM_ADAPTER_LLM_RUNNER=fake \
    LLM_TEAM_FAKE_FIXTURE_DIR="${fx_dir}" \
    LLM_TEAM_INMEM_IT_ACTOR="alice" \
    LLM_TEAM_INTEGRATION_BRANCH="integration"

  # Reload adapters with new env (registry was already loaded once with default
  # adapters; force rebind by re-sourcing registry's load).
  unset LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER
  unset LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER
  unset LLM_TEAM_ACTIVE_PERSISTENT_STORE_ADAPTER
  unset LLM_TEAM_ACTIVE_LLM_RUNNER_ADAPTER
  registry_load_default >/dev/null 2>&1 || true

  # shellcheck source=../../application/caller_dispatch.sh
  . "${LLM_TEAM_ROOT}/application/caller_dispatch.sh"

  # Seed: milestone in VALIDATE_IN_PROGRESS with one TASK_INTEGRATED child.
  local ms_num task_num
  ms_num="$(it_milestone_create "${repo}" "ms-qa-fail" "body")" || return 1
  it_milestone_set_state "${repo}" "${ms_num}" VALIDATE_IN_PROGRESS \
    || return 1
  task_num="$(it_issue_create "${repo}" \
    --title "feat" --body "body" --milestone "${ms_num}")" || return 1
  it_issue_set_state "${repo}" "${task_num}" TASK_INTEGRATED \
    || return 1

  # Open a Milestone PR (so QA FAIL has something to close).
  local pr_num
  pr_num="$(it_pr_create "${repo}" --head "milestone/${ms_num}" --base integration \
    --title "QA milestone PR" --body "body")" || return 1

  # Create a Milestone CP in CP_READY_FOR_VERIFICATION (matching the QA flow).
  local cp_path
  cp_path="$(change_proposal_create "${target}" Milestone QA Validate "${ms_num}" \
    "milestone-${ms_num}")" || return 1
  change_proposal_set_state "${cp_path}" CP_READY_FOR_VERIFICATION CP_DRAFT || return 1

  # Construct QA FAIL envelope (manifest_id is a fresh manifest).
  local mf
  mf="$(context_manifest_create "${target}" Validate milestone "${ms_num}")" || return 1
  context_manifest_add_entry "${mf}" milestone "${ms_num}" metadata \
    "$(it_revision_pin_get "${repo}" milestone "${ms_num}")" true "qa input"
  local mid; mid="$(context_manifest_id "${mf}")"

  local env_path; env_path="$(mktemp -t qa-fail-env.XXXXXX)"
  jq -n \
    --arg ms "${ms_num}" \
    --arg task "${task_num}" \
    --arg mid "${mid}" \
    --arg cp "${cp_path}" \
    --arg pr "${pr_num}" \
    --arg pin "$(it_revision_pin_get "${repo}" milestone "${ms_num}")" \
    '{
      output_kind: "milestone_package",
      agent_role: "QA",
      operation: "Validate",
      object_id: $ms,
      manifest_id: $mid,
      input_revision_pins: [
        { object_kind: "milestone", object_id: $ms, revision_pin: $pin }
      ],
      idempotency_key: ("qa-fail-" + $ms),
      summary: "QA found failures",
      artifacts: {
        outcome: "FAIL",
        cp_kind: "Milestone",
        cp_path: $cp,
        pr_number: ($pr | tonumber),
        failing_tasks: [($task | tonumber)]
      }
    }' >"${env_path}"

  # Apply.
  caller_apply_output "${repo}" QA "${env_path}" "${mf}" \
    || { rm -f "${env_path}"; return 1; }
  rm -f "${env_path}"

  # Verify outcomes.
  local ms_state task_state
  ms_state="$(it_milestone_get_state "${repo}" "${ms_num}")"
  task_state="$(it_issue_get_state "${repo}" "${task_num}")"
  [ "${ms_state}" = "IMPLEMENTING" ] \
    || { fail "qa-fail: milestone state expected IMPLEMENTING got '${ms_state}'"; return 1; }
  [ "${task_state}" = "TASK_READY" ] \
    || { fail "qa-fail: failing task expected TASK_READY got '${task_state}'"; return 1; }
  local cp_state
  cp_state="$(change_proposal_get_state "${cp_path}")"
  [ "${cp_state}" = "CP_CLOSED" ] \
    || { fail "qa-fail: CP expected CP_CLOSED got '${cp_state}'"; return 1; }
  local pr_state
  pr_state="$(jq -r '.state' "${it_dir}/prs/${pr_num}.json")"
  [ "${pr_state}" = "closed" ] \
    || { fail "qa-fail: PR expected closed got '${pr_state}'"; return 1; }
  ok "QA FAIL: milestone IMPLEMENTING + task TASK_READY + CP_CLOSED + PR closed"
}

# ============================================================================
# Scenario B: Reject signal on PO_GATE → milestone PO_DRAFT
# ============================================================================
run_scenario_reject() {
  local target="reject-$$"
  local it_dir ps_dir target_yaml workdir
  it_dir="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-rej-it-XXXXXX")"
  ps_dir="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-rej-ps-XXXXXX")"
  target_yaml="${LLM_TEAM_ROOT}/targets/${target}.yaml"
  workdir="${LLM_TEAM_ROOT}/workdir/${target}"

  trap "rm -rf '${it_dir}' '${ps_dir}' '${workdir}' 2>/dev/null || true; rm -f '${target_yaml}' 2>/dev/null || true" RETURN

  cat >"${target_yaml}" <<EOF
name: ${target}
github: { owner: e2e-rej, repo: ${target}, default_branch: main }
local: { clone_path: /tmp/none }
inputs_dir: inputs/${target}
labels: { prefix: "" }
notifier: { channel: none, webhook_or_id: "" }
dev_concurrency: 1
stale_threshold_minutes: 60
verification: { commands: ["true"] }
enabled: true
EOF
  mkdir -p "${workdir}/manifests"

  TARGET_NAME="${target}" \
  LLM_TEAM_INMEM_IT_DIR="${it_dir}" \
  LLM_TEAM_INMEM_PS_DIR="${ps_dir}" \
  LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory \
  LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory \
  _reject_inner "${target}" "${it_dir}"
  return $?
}

_reject_inner() {
  local target="$1" it_dir="$2"
  local repo="e2e-rej/${target}"

  export TARGET_NAME="${target}" \
    LLM_TEAM_INMEM_IT_DIR="${it_dir}" \
    LLM_TEAM_INMEM_PS_DIR="${LLM_TEAM_INMEM_PS_DIR}" \
    LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory \
    LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory \
    LLM_TEAM_INMEM_IT_ACTOR="alice"
  unset LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER
  unset LLM_TEAM_ACTIVE_PERSISTENT_STORE_ADAPTER
  registry_load_default >/dev/null 2>&1 || true

  # shellcheck source=../../application/human_signal.sh
  . "${LLM_TEAM_ROOT}/application/human_signal.sh"

  local ms_num
  ms_num="$(it_milestone_create "${repo}" "po-gate-target" "body")" || return 1
  it_milestone_set_state "${repo}" "${ms_num}" PO_GATE \
    || return 1

  # Inject reject signal.
  local body marker
  body="$(jq -nc \
    --arg sid "sig-reject-${ms_num}-$$" \
    --arg type "reject" \
    --arg ms "${ms_num}" \
    '{signal_id:$sid, signal_type:$type, target_kind:"milestone",
      target_id:$ms, target_revision_pin:"", actor:"alice",
      created_at:"2026-01-01T00:00:00Z"}')"
  marker="$(printf '<!-- llm-team:human-signal %s -->' "${body}")"
  it_comment_post "${repo}" milestone "${ms_num}" "${marker}" || return 1

  human_signal_drain "${repo}" >/dev/null

  local ms_state
  ms_state="$(it_milestone_get_state "${repo}" "${ms_num}")"
  [ "${ms_state}" = "PO_DRAFT" ] \
    || { fail "reject: milestone expected PO_DRAFT got '${ms_state}'"; return 1; }
  ok "Reject signal: milestone PO_GATE → PO_DRAFT"
}

# ============================================================================
# Run scenarios
# ============================================================================
run_scenario_qa_fail || true
run_scenario_reject  || true

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} scenario(s) failed in full-flow-fail" >&2
  exit 1
fi
echo "PASS: tests/e2e/full-flow-fail.sh"
