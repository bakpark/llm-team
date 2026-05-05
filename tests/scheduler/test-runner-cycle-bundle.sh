#!/usr/bin/env bash
# tests/scheduler/test-runner-cycle-bundle.sh
#
# Integration smoke tests: runner.sh × cycle_bundle wiring.
#
# Cases exercised:
#   A — DISABLED escape hatch: LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 set while
#       running as PO. Verifies graceful (exit 0) behavior and no cycles/ dir.
#   B — PO role does NOT create cycle bundle (RW-only invariant): PO is not in
#       {Coder, Reviewer, Integrator, QA}; cycles/ must not be created.
#   C — adapter registered + loadable: cb_open declared after sourcing
#       lib/common.sh in the same environment used by Cases A/B.
#
# TODO (deferred — requires real git bare-repo/clone/worktree fixtures):
#   D  slim-ok cycle: Coder applied, confirm cb_finalize(ok) + summary.json
#      result=="ok", slim tier (diagnostics deleted, applied.diff present).
#   E  lr-retry within cycle: transport_error causes backoff-retry; confirm
#      attempts/1/ and attempts/2/ captured; cb_promote_to_full called with
#      "lr:transport_error:..." reason; cycle NOT finalized ok.
#   F  EXIT-trap-finalize: SIGTERM/early exit while CB_HANDLE open; confirm
#      _runner_cycle_finalize_if_open fires → summary.json present.
#   G  applied-vs-envelope mismatch: cb_capture diff/applied.diff shows actual
#      patch bytes match envelope patch_diff field (structural integrity).
#   H  ESCALATED / retry-guard path: confirm cb_promote_to_full is NOT called
#      (cycle bundle unused for escalated paths, no RW role context).
#
# Each deferred case needs:
#   • A real git bare repo (git init --bare) + clone + worktree setup.
#   • A Coder-role fake fixture that produces a valid patch envelope.
#   • The ws_* port to resolve to a real git_worktree adapter (not in_memory).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="rcb-test-$$"
TEST_INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rcb-it-XXXXXX")"
TEST_INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rcb-ws-XXXXXX")"
TEST_INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rcb-ps-XXXXXX")"
TEST_FAKE_FIX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rcb-fx-XXXXXX")"
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
# LLM_TEAM_ROOT_FS_OVERRIDE: redirect cycles/ to TEST_INMEM_WS_DIR so the
# filesystem adapter's workdir/<target>/cycles/ lands in the temp area and is
# cleaned up automatically by trap. PO cycles/ would be at:
#   ${TEST_INMEM_WS_DIR}/workdir/${TARGET_NAME}/cycles/
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
CYCLES_DIR="${TEST_INMEM_WS_DIR}/workdir/${TARGET_NAME}/cycles"

# ----------------------------------------------------------------------------
# Helpers (inlined from test-runner-pipeline.sh — no shared file extraction).
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

# ============================================================================
# Case C — adapter registered + loadable
# (Checked first: if cb_open is not declared the other cases mean nothing.)
# ============================================================================
if declare -F cb_open >/dev/null 2>&1; then
  pass "case-C: cb_open declared after registry_load_default (filesystem adapter)"
else
  fail "case-C: cb_open NOT declared — filesystem adapter not loaded"
fi

# ============================================================================
# Case A — DISABLED escape hatch
#   LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 set. Runner runs as PO (no RW role).
#   Confirm: exit 0, no cycles/ directory created.
# ============================================================================
clear_po_draft_residue
ms_a="$(seed_po_draft_milestone 'cb-disabled-case-a')" || { fail "case-A: seed failed"; exit 1; }
pin_a="$(it_revision_pin_get "${REPO}" milestone "${ms_a}" 2>/dev/null)"
write_po_fixture "${ms_a}" "${pin_a}" "po-cb-disabled-${ms_a}"

out_a="$(mktemp)"
if LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 run_runner_po "${out_a}"; then
  # PO never creates cycles/ — structurally guaranteed — but with DISABLED=1
  # cb_open returns "" and no mkdir is attempted. Either way cycles/ must not exist.
  if [ -d "${CYCLES_DIR}" ]; then
    fail "case-A: cycles/ dir was created despite DISABLED=1 and PO role"
  else
    pass "case-A: DISABLED=1 + PO → no cycles/ dir, runner exited 0"
  fi
else
  echo "--- runner output (case-A) ---" >&2
  cat "${out_a}" >&2
  fail "case-A: runner exited non-zero with DISABLED=1"
fi
rm -f "${out_a}"

# ============================================================================
# Case B — PO role does NOT create cycle bundle (RW-only invariant)
#   LLM_TEAM_CYCLE_BUNDLE_DISABLED unset (defaults to 0). Runner as PO.
#   PO is not in {Coder, Reviewer, Integrator, QA}; the cb_open branch in
#   runner.sh is gated on ROLE ∈ that set. Verify cycles/ never appears.
# ============================================================================
clear_po_draft_residue
ms_b="$(seed_po_draft_milestone 'cb-po-rw-invariant-case-b')" || { fail "case-B: seed failed"; exit 1; }
pin_b="$(it_revision_pin_get "${REPO}" milestone "${ms_b}" 2>/dev/null)"
write_po_fixture "${ms_b}" "${pin_b}" "po-cb-po-${ms_b}"

out_b="$(mktemp)"
if unset LLM_TEAM_CYCLE_BUNDLE_DISABLED && run_runner_po "${out_b}"; then
  if [ -d "${CYCLES_DIR}" ]; then
    fail "case-B: cycles/ dir was created for PO role (RW-only invariant violated)"
  else
    pass "case-B: PO role + DISABLED unset → no cycles/ dir (RW-only invariant holds)"
  fi
else
  echo "--- runner output (case-B) ---" >&2
  cat "${out_b}" >&2
  fail "case-B: runner exited non-zero for PO happy path"
fi
rm -f "${out_b}"

# ============================================================================
# Final result
# ============================================================================
if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} case(s) failed in test-runner-cycle-bundle" >&2
  exit 1
fi
echo "PASS: tests/scheduler/test-runner-cycle-bundle.sh"
