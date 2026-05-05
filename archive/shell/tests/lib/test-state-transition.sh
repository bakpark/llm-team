#!/usr/bin/env bash
# tests/lib/test-state-transition.sh
#
# Verifies state_transition_allowed against #SOC-STATES + #SOC-DISPATCH-MATRIX
# (docs/contracts/state-and-operation-contract.md).
#
# Coverage:
#   1. Sample of allowed transitions (milestone/task/CP) → 0.
#   2. Sample of disallowed transitions (skip steps, terminal re-entry,
#      cross-kind leakage, invalid kind) → 1.
#   3. cp alias for change_proposal works.
#   4. change_proposal_set_state rejects matrix-violating transitions even
#      when only new_state is provided (no old_state).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

assert_allowed() {
  local kind="$1" from="$2" to="$3"
  if ! state_transition_allowed "${kind}" "${from}" "${to}"; then
    fail "expected allowed: ${kind} ${from} → ${to}"
  fi
}

assert_disallowed() {
  local kind="$1" from="$2" to="$3"
  if state_transition_allowed "${kind}" "${from}" "${to}"; then
    fail "expected disallowed: ${kind} ${from} → ${to}"
  fi
}

# ── (1) Allowed transitions ────────────────────────────────────────────────
# Milestone happy path
assert_allowed milestone PO_DRAFT PO_GATE
assert_allowed milestone PO_GATE PM_DRAFT
assert_allowed milestone PM_GATE DECOMPOSE_READY
assert_allowed milestone DECOMPOSE_READY DECOMPOSE_IN_PROGRESS
assert_allowed milestone DECOMPOSE_IN_PROGRESS IMPLEMENTING
assert_allowed milestone IMPLEMENTING REFACTOR_READY
assert_allowed milestone REFACTOR_IN_PROGRESS VALIDATE_READY
assert_allowed milestone VALIDATE_IN_PROGRESS DONE
# Milestone recovery + reject paths
assert_allowed milestone PO_GATE PO_DRAFT
assert_allowed milestone PM_GATE PM_DRAFT
assert_allowed milestone REFACTOR_IN_PROGRESS REFACTOR_READY
assert_allowed milestone VALIDATE_IN_PROGRESS IMPLEMENTING
assert_allowed milestone DECOMPOSE_IN_PROGRESS ESCALATED

# Task happy path
assert_allowed task TASK_PENDING TASK_READY
assert_allowed task TASK_READY TASK_IN_PROGRESS
assert_allowed task TASK_IN_PROGRESS TASK_REVIEW_READY
assert_allowed task TASK_REVIEW_READY TASK_REVIEW_IN_PROGRESS
assert_allowed task TASK_REVIEW_IN_PROGRESS TASK_INTEGRATED
assert_allowed task TASK_REVIEW_IN_PROGRESS TASK_READY
assert_allowed task TASK_REJECTED TASK_READY
assert_allowed task ESCALATED TASK_READY

# CP happy paths (Spec / Code / Integration)
assert_allowed change_proposal CP_DRAFT CP_READY_FOR_HUMAN_GATE
assert_allowed change_proposal CP_READY_FOR_HUMAN_GATE CP_HUMAN_APPROVED
assert_allowed change_proposal CP_HUMAN_APPROVED CP_MERGED
assert_allowed change_proposal CP_DRAFT CP_READY_FOR_REVIEW
assert_allowed change_proposal CP_READY_FOR_REVIEW CP_APPROVED
assert_allowed change_proposal CP_READY_FOR_REVIEW CP_REQUEST_CHANGES
assert_allowed change_proposal CP_READY_FOR_REVIEW CP_STALE
assert_allowed change_proposal CP_DRAFT CP_READY_FOR_VERIFICATION
assert_allowed change_proposal CP_READY_FOR_VERIFICATION CP_APPROVED
assert_allowed change_proposal CP_APPROVED CP_MERGED
assert_allowed change_proposal CP_REQUEST_CHANGES CP_CLOSED

# (3) cp alias
assert_allowed cp CP_DRAFT CP_READY_FOR_REVIEW
assert_allowed cp CP_APPROVED CP_MERGED

# ── (2) Disallowed transitions ─────────────────────────────────────────────
# Skip steps
assert_disallowed milestone PO_DRAFT DONE
assert_disallowed milestone PM_DRAFT IMPLEMENTING
assert_disallowed task TASK_READY TASK_INTEGRATED
assert_disallowed change_proposal CP_DRAFT CP_MERGED
assert_disallowed change_proposal CP_DRAFT CP_APPROVED

# Terminal re-entry / reverse jumps
assert_disallowed milestone DONE PO_DRAFT
assert_disallowed task TASK_INTEGRATED TASK_READY
assert_disallowed change_proposal CP_MERGED CP_DRAFT
assert_disallowed change_proposal CP_CLOSED CP_DRAFT
assert_disallowed change_proposal CP_CLOSED CP_READY_FOR_REVIEW

# Cross-kind leakage
assert_disallowed milestone TASK_READY TASK_IN_PROGRESS
assert_disallowed task PO_DRAFT PO_GATE
assert_disallowed change_proposal TASK_READY TASK_IN_PROGRESS

# Invalid kind
assert_disallowed bogus PO_DRAFT PO_GATE

# Approve-from-VALIDATE_READY-to-DONE was a P1-16 contract drift (removed).
# Validate driven (VALIDATE_IN_PROGRESS → DONE) is the only DONE path.
assert_disallowed milestone VALIDATE_READY DONE

# ── (4) change_proposal_set_state enforces matrix without old_state ────────
target="state-trans-test-$$"
cp_dir="$(change_proposal_dir "${target}")"
cleanup() { rm -rf "${LLM_TEAM_ROOT}/workdir/${target}" 2>/dev/null || true; }
trap cleanup EXIT

cp_path="$(change_proposal_create "${target}" Code coder Implement T-1 "branch:llm-team/T-1")" \
  || fail "create CP failed"

# CP_DRAFT → CP_MERGED should be rejected by matrix (skip step), even with no old_state.
if change_proposal_set_state "${cp_path}" CP_MERGED 2>/dev/null; then
  fail "set_state should reject CP_DRAFT → CP_MERGED (matrix violation)"
fi
state="$(change_proposal_get_state "${cp_path}")"
[ "${state}" = "CP_DRAFT" ] \
  || fail "state should remain CP_DRAFT after rejected transition (got '${state}')"

# CP_DRAFT → CP_READY_FOR_REVIEW is allowed.
change_proposal_set_state "${cp_path}" CP_READY_FOR_REVIEW \
  || fail "set_state CP_DRAFT → CP_READY_FOR_REVIEW (matrix-allowed) failed"

# CP_READY_FOR_REVIEW → CP_HUMAN_APPROVED crosses the Spec/Code path boundary; reject.
if change_proposal_set_state "${cp_path}" CP_HUMAN_APPROVED 2>/dev/null; then
  fail "set_state should reject CP_READY_FOR_REVIEW → CP_HUMAN_APPROVED (cross-path)"
fi

# CP_READY_FOR_REVIEW → CP_APPROVED → CP_MERGED is the proper Code CP path.
change_proposal_set_state "${cp_path}" CP_APPROVED \
  || fail "set_state CP_READY_FOR_REVIEW → CP_APPROVED failed"
change_proposal_set_state "${cp_path}" CP_MERGED \
  || fail "set_state CP_APPROVED → CP_MERGED failed"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} state transition check(s) failed" >&2
  exit 1
fi

echo "PASS: state transition matrix"
