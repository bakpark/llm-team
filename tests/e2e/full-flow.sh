#!/usr/bin/env bash
# tests/e2e/full-flow.sh
#
# Phase 9 — End-to-end happy path.
#
# feature-request → PO → signal approve → PM → signal approve →
# Planner (1 task) → Coder → Reviewer (approve) → Integrator (no-op PASS) →
# QA (PASS + release_tag) → DONE + release published.
#
# Adapter 환경:
#   - issue_tracker / workspace / persistent_store: in_memory
#   - llm_runner: fake (fixture per role rewritten in-place between steps)
#
# 검증 포인트 (전 단계에서 누적):
#   • milestone state: PO_DRAFT → PO_GATE → PM_DRAFT → PM_GATE →
#     DECOMPOSE_READY → IMPLEMENTING → REFACTOR_READY → VALIDATE_READY → DONE
#   • feature-request issue 가 milestone 에 link 되고 라벨이 accepted 로 전이
#   • Task issue: TASK_READY → TASK_IN_PROGRESS → TASK_REVIEW_READY →
#     TASK_REVIEW_IN_PROGRESS → TASK_INTEGRATED
#   • Release: it_release_create 결과물(in_memory releases/<tag>.json) 존재
#   • Ledger: 각 단계별 RGC-LEDGER 행 누적

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="full-flow-$$"
TEST_INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-it-XXXXXX")"
TEST_INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-ws-XXXXXX")"
TEST_INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-ps-XXXXXX")"
TEST_FAKE_FIX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ff-fx-XXXXXX")"
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
  owner: e2e-owner
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
export LLM_TEAM_FAKE_FIXTURE_DIR="${TEST_FAKE_FIX_DIR}"
export LLM_TEAM_INMEM_IT_ACTOR="alice"
export LLM_TEAM_INTEGRATION_BRANCH="integration"

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
step() { echo "STEP: $*"; }
ok()   { echo "  ok: $*"; }

REPO="e2e-owner/${TARGET_NAME}"

# Read live milestone updated_at (revision_pin).
ms_pin() { it_revision_pin_get "${REPO}" milestone "$1"; }
ms_state() { it_milestone_get_state "${REPO}" "$1"; }
issue_pin() { it_revision_pin_get "${REPO}" issue "$1"; }
issue_state() { it_issue_get_state "${REPO}" "$1"; }
pr_pin() { it_revision_pin_get "${REPO}" pr "$1"; }

run_runner() {
  local role="$1"
  local out
  out="$(mktemp)"
  if ! bash "${LLM_TEAM_ROOT}/scheduler/runner.sh" "${role}" "${TARGET_NAME}" >"${out}" 2>&1; then
    echo "--- runner ${role} FAILED ---" >&2
    cat "${out}" >&2
    rm -f "${out}"
    return 1
  fi
  rm -f "${out}"
}

# Inject a governance signal as a comment on the milestone (in_memory uses
# milestone creator login as actor, milestone num as comment_id).
inject_signal() {
  local kind="$1" num="$2" signal_type="$3" target_kind="$4" target_id="$5"
  # Pin is intentionally omitted: it_comment_post on a milestone mutates the
  # target's updated_at, so any pin we capture pre-post is immediately stale
  # at drain time. Empty pin makes _human_signal_check_pin a no-op (RGC-SIGNALS
  # treats target_revision_pin as optional — pin tracking happens via lease).
  local body
  body="$(jq -nc \
    --arg sid "sig-${signal_type}-${target_id}-${RANDOM}-$$" \
    --arg type "${signal_type}" \
    --arg tk "${target_kind}" \
    --arg tid "${target_id}" \
    --arg actor "alice" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
       signal_id: $sid,
       signal_type: $type,
       target_kind: $tk,
       target_id: $tid,
       target_revision_pin: "",
       actor: $actor,
       created_at: $ts
     }')"
  local marker
  marker="$(printf '<!-- llm-team:human-signal %s -->' "${body}")"
  it_comment_post "${REPO}" "${kind}" "${num}" "${marker}"
}

# Rewrite the role's fixture file (single fixture per role, overwritten each
# step). agent_role uses canonical form (PO/PM/...). manifest_id placeholder
# is substituted at lr_invoke time by fake adapter.
write_fixture() {
  local role="$1" op="$2" object_id="$3" idem_key="$4" pins_json="$5"
  local artifacts_json="${6:-}"
  [ -n "${artifacts_json}" ] || artifacts_json='{}'
  local f="${TEST_FAKE_FIX_DIR}/${role}-${op}.json"
  jq -n \
    --arg role "${role}" \
    --arg op "${op}" \
    --arg object_id "${object_id}" \
    --arg idem "${idem_key}" \
    --arg kind "$(role_output_kind "${role}")" \
    --argjson pins "${pins_json}" \
    --argjson artifacts "${artifacts_json}" \
    '{
       output_kind: $kind,
       agent_role: $role,
       operation: $op,
       object_id: $object_id,
       manifest_id: "__MANIFEST_ID__",
       input_revision_pins: $pins,
       idempotency_key: $idem,
       summary: ($role + " " + $op + " happy"),
       artifacts: $artifacts
     }' >"${f}"
}

# ============================================================================
# Step 0: Seed feature-request issue
# ============================================================================
step "0: seed feature-request issue"
fr_issue="$(it_issue_create "${REPO}" \
  --title "Add login feature" \
  --body "User login feature spec" \
  --labels "${LABEL_FEATURE_REQUEST}")" \
  || { fail "seed: feature-request issue create failed"; exit 1; }
ok "seeded issue #${fr_issue} with feature-request label"

# ============================================================================
# Step 1: PO runner — promotes issue to milestone (PO_DRAFT) then runs Compose-PO.
#         Result: milestone state PO_GATE.
# ============================================================================
step "1: PO runner → milestone PO_GATE"
# feature_request_promote runs inside runner.sh PO branch and creates the
# milestone. We pre-build the fixture for milestone #1 (the in_memory adapter
# uses sequential ids; since the seeded issue is #1 already, the milestone will
# be #1 in its own namespace) — but the pin won't be known until promotion.
# Workaround: promote first (runner promotes, then picks ready), so we run a
# probe to see the pin AFTER promotion. Since lr_invoke happens within runner,
# the fixture must be staged BEFORE the runner runs.
#
# Strategy: write a fixture with a placeholder pin, then runner promotes,
# picks PO_DRAFT milestone, manifest pin = updated_at, fake LLM returns
# fixture envelope. We need envelope.input_revision_pins[].revision_pin to
# match the live pin at revalidation time. Since the runner builds the manifest
# right before calling lr_invoke and revalidates right after, the live pin
# stays stable across that window if no other writer intervenes (and there
# isn't in this test). So we promote manually first, then write fixture with
# the actual pin, then run runner (which sees existing PO_DRAFT and skips
# promotion since it's idempotent on label).
. "${LLM_TEAM_ROOT}/application/feature_request.sh"
feature_request_promote "${REPO}" >/dev/null \
  || { fail "step1: feature_request_promote failed"; exit 1; }
ms_num="$(it_milestone_list_in_state "${REPO}" PO_DRAFT | head -n 1)"
[ -n "${ms_num}" ] || { fail "step1: no PO_DRAFT milestone after promotion"; exit 1; }
ok "milestone #${ms_num} promoted to PO_DRAFT"

pins_json="$(jq -nc --arg ms "${ms_num}" \
  '[{object_kind:"milestone", object_id:$ms, revision_pin:"__PIN__"}]')"
artifacts="$(jq -nc \
  --arg body "PO drafted body for milestone ${ms_num}" \
  '{ milestone_body: $body, cp_artifact_ref: ("spec/po-" + (now|tostring)) }')"
write_fixture PO Compose-PO "${ms_num}" "po-${ms_num}-step1" "${pins_json}" "${artifacts}"
run_runner po || { fail "step1: PO runner failed"; exit 1; }

state="$(ms_state "${ms_num}")"
[ "${state}" = "PO_GATE" ] || { fail "step1: state expected PO_GATE got '${state}'"; exit 1; }
ok "milestone state = PO_GATE"

# ============================================================================
# Step 2: Inject PO approve signal → next runner drains and advances PM_DRAFT.
# ============================================================================
step "2: PO approve signal → milestone PM_DRAFT"
po_pin="$(ms_pin "${ms_num}")"
inject_signal milestone "${ms_num}" approve milestone "${ms_num}" \
  || { fail "step2: signal injection failed"; exit 1; }

# Run human_signal_drain manually (runner.sh drains before pickup).
. "${LLM_TEAM_ROOT}/application/human_signal.sh"
human_signal_drain "${REPO}" >/dev/null \
  || { fail "step2: human_signal_drain failed"; exit 1; }
state="$(ms_state "${ms_num}")"
[ "${state}" = "PM_DRAFT" ] || { fail "step2: state expected PM_DRAFT got '${state}'"; exit 1; }
ok "milestone state = PM_DRAFT after approve signal"

# ============================================================================
# Step 3: PM runner → milestone PM_GATE
# ============================================================================
step "3: PM runner → milestone PM_GATE"
pins_json="$(jq -nc --arg ms "${ms_num}" \
  '[{object_kind:"milestone", object_id:$ms, revision_pin:"__PIN__"}]')"
artifacts="$(jq -nc \
  --arg body "PM drafted scenarios + AC for milestone ${ms_num}" \
  '{ milestone_body: $body, cp_artifact_ref: "spec/pm-1.md" }')"
write_fixture PM Compose-PM "${ms_num}" "pm-${ms_num}-step3" "${pins_json}" "${artifacts}"
run_runner pm || { fail "step3: PM runner failed"; exit 1; }
state="$(ms_state "${ms_num}")"
[ "${state}" = "PM_GATE" ] || { fail "step3: state expected PM_GATE got '${state}'"; exit 1; }
ok "milestone state = PM_GATE"

# ============================================================================
# Step 4: PM approve signal → DECOMPOSE_READY
# ============================================================================
step "4: PM approve signal → milestone DECOMPOSE_READY"
pin="$(ms_pin "${ms_num}")"
inject_signal milestone "${ms_num}" approve milestone "${ms_num}" \
  || { fail "step4: signal injection failed"; exit 1; }
human_signal_drain "${REPO}" >/dev/null \
  || { fail "step4: human_signal_drain failed"; exit 1; }
state="$(ms_state "${ms_num}")"
[ "${state}" = "DECOMPOSE_READY" ] \
  || { fail "step4: state expected DECOMPOSE_READY got '${state}'"; exit 1; }
ok "milestone state = DECOMPOSE_READY"

# ============================================================================
# Step 5: Planner runner → IMPLEMENTING with 1 task
# ============================================================================
step "5: Planner runner → IMPLEMENTING + 1 task"
pins_json="$(jq -nc --arg ms "${ms_num}" \
  '[{object_kind:"milestone", object_id:$ms, revision_pin:"__PIN__"}]')"
artifacts="$(jq -nc \
  '{ tasks: [
       { slug: "t1", title: "implement login", body: "Implement login endpoint" }
     ],
     dependency_graph: { t1: [] },
     integration_branch: { name: "integration" }
   }')"
write_fixture Planner Decompose "${ms_num}" "planner-${ms_num}-step5" "${pins_json}" "${artifacts}"
run_runner planner || { fail "step5: Planner runner failed"; exit 1; }
state="$(ms_state "${ms_num}")"
[ "${state}" = "IMPLEMENTING" ] \
  || { fail "step5: state expected IMPLEMENTING got '${state}'"; exit 1; }
task_num="$(it_issue_list_in_state "${REPO}" TASK_READY | head -n 1)"
[ -n "${task_num}" ] || { fail "step5: no TASK_READY issue created"; exit 1; }
ok "milestone IMPLEMENTING + task #${task_num} TASK_READY"

# ============================================================================
# Step 6: Coder runner → TASK_REVIEW_READY (PR created)
# ============================================================================
step "6: Coder runner → TASK_REVIEW_READY"
pins_json="$(jq -nc --arg id "${task_num}" \
  '[{object_kind:"issue", object_id:$id, revision_pin:"__PIN__"}]')"
# in_memory ws_apply_patch expects JSON array of {path, content}.
patch_diff='[{"path":"login.txt","content":"login impl\n"}]'
artifacts="$(jq -nc --arg diff "${patch_diff}" --arg branch "llm-team/task-${task_num}" \
  '{ patch_diff: $diff, task_branch: $branch, cp_artifact_ref: ("branch:" + $branch) }')"
write_fixture Coder Implement "${task_num}" "coder-${task_num}-step6" "${pins_json}" "${artifacts}"
run_runner coder || { fail "step6: Coder runner failed"; exit 1; }
istate="$(issue_state "${task_num}")"
[ "${istate}" = "TASK_REVIEW_READY" ] \
  || { fail "step6: issue state expected TASK_REVIEW_READY got '${istate}'"; exit 1; }
pr_num="$(ls "${TEST_INMEM_IT_DIR}/prs/" 2>/dev/null | head -n 1 | sed 's/\.json$//')"
[ -n "${pr_num}" ] || { fail "step6: no PR created"; exit 1; }
ok "issue TASK_REVIEW_READY + PR #${pr_num} created"

# ============================================================================
# Step 7: Reviewer runner (approve verdict) → TASK_INTEGRATED
# ============================================================================
step "7: Reviewer (approve) → TASK_INTEGRATED"
pins_json="$(jq -nc --arg id "${task_num}" \
  '[{object_kind:"issue", object_id:$id, revision_pin:"__PIN__"}]')"
# cp_path: locate the CP artifact for this task issue (Code/Coder).
cp_path="$(ls "${TARGET_WORKDIR}/change-proposals/cp-Code-${task_num}-"*.json 2>/dev/null | head -n 1)"
[ -n "${cp_path}" ] || { fail "step7: cannot find Code CP for task ${task_num}"; exit 1; }
artifacts="$(jq -nc --arg verdict "approve" --arg pr "${pr_num}" --arg cp "${cp_path}" \
  '{ verdict: $verdict, pr_number: ($pr|tonumber), cp_path: $cp }')"
write_fixture Reviewer Review "${task_num}" "reviewer-${task_num}-step7" "${pins_json}" "${artifacts}"
run_runner reviewer || { fail "step7: Reviewer runner failed"; exit 1; }
istate="$(issue_state "${task_num}")"
[ "${istate}" = "TASK_INTEGRATED" ] \
  || { fail "step7: issue state expected TASK_INTEGRATED got '${istate}'"; exit 1; }
ok "issue TASK_INTEGRATED (PR merged)"

# ============================================================================
# Step 8: Sweeper advances milestone IMPLEMENTING → REFACTOR_READY (when all
#         tasks integrated). Reviewer's caller_apply_output already calls
#         caller_advance_milestone_after_task_integrated so milestone should
#         already be in REFACTOR_READY.
# ============================================================================
step "8: milestone IMPLEMENTING → REFACTOR_READY (sweeper)"
state="$(ms_state "${ms_num}")"
if [ "${state}" != "REFACTOR_READY" ]; then
  # Manually invoke the sweeper if reviewer didn't trigger it.
  . "${LLM_TEAM_ROOT}/application/caller_dispatch.sh"
  caller_advance_milestone_after_task_integrated "${REPO}" "${ms_num}"
  state="$(ms_state "${ms_num}")"
fi
[ "${state}" = "REFACTOR_READY" ] \
  || { fail "step8: state expected REFACTOR_READY got '${state}'"; exit 1; }
ok "milestone REFACTOR_READY"

# ============================================================================
# Step 9: Integrator runner (PASS no-op) → VALIDATE_READY
# ============================================================================
step "9: Integrator (PASS no-op) → VALIDATE_READY"
pins_json="$(jq -nc --arg ms "${ms_num}" \
  '[{object_kind:"milestone", object_id:$ms, revision_pin:"__PIN__"}]')"
artifacts="$(jq -nc '{ outcome: "NO-OP" }')"
write_fixture Integrator Refactor "${ms_num}" "integrator-${ms_num}-step9" "${pins_json}" "${artifacts}"
run_runner integrator || { fail "step9: Integrator runner failed"; exit 1; }
state="$(ms_state "${ms_num}")"
[ "${state}" = "VALIDATE_READY" ] \
  || { fail "step9: state expected VALIDATE_READY got '${state}'"; exit 1; }
ok "milestone VALIDATE_READY"

# ============================================================================
# Step 10: QA runner (PASS + release_tag) → DONE + Release published
# ============================================================================
step "10: QA (PASS) → DONE + Release published"
pins_json="$(jq -nc --arg ms "${ms_num}" \
  '[{object_kind:"milestone", object_id:$ms, revision_pin:"__PIN__"}]')"
artifacts="$(jq -nc \
  '{ outcome: "PASS",
     cp_kind: "Milestone",
     cp_artifact_ref: "milestone/v0.1.0",
     release_tag: "0.1.0",
     release_target: "main",
     release_notes_md: "# Release v0.1.0\n* login feature"
   }')"
write_fixture QA Validate "${ms_num}" "qa-${ms_num}-step10" "${pins_json}" "${artifacts}"
run_runner qa || { fail "step10: QA runner failed"; exit 1; }
state="$(ms_state "${ms_num}")"
[ "${state}" = "DONE" ] \
  || { fail "step10: state expected DONE got '${state}'"; exit 1; }
ok "milestone state = DONE"

release_path="${TEST_INMEM_IT_DIR}/releases/v0.1.0.json"
[ -f "${release_path}" ] || { fail "step10: release file v0.1.0 missing"; exit 1; }
ok "release v0.1.0 published"

# ============================================================================
# Final: ledger should have transitions across all phases.
# ============================================================================
LEDGER="$(transition_ledger_path "${TARGET_NAME}")"
[ -f "${LEDGER}" ] || { fail "final: ledger file missing"; exit 1; }
applied="$(jq -c 'select(.result == "applied")' "${LEDGER}" | wc -l | tr -d ' ')"
[ "${applied}" -ge 6 ] \
  || { fail "final: expected ≥ 6 applied ledger rows, got ${applied}"; exit 1; }
ok "ledger has ${applied} applied rows"

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} step(s) failed in full-flow E2E" >&2
  exit 1
fi
echo "PASS: tests/e2e/full-flow.sh"
