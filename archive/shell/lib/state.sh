#!/usr/bin/env bash
# lib/state.sh - authoritative contract state names and adapter markers.

MILESTONE_STATES=(
  PO_DRAFT PO_GATE PM_DRAFT PM_GATE
  DECOMPOSE_READY DECOMPOSE_IN_PROGRESS
  IMPLEMENTING
  REFACTOR_READY REFACTOR_IN_PROGRESS
  VALIDATE_READY VALIDATE_IN_PROGRESS
  DONE ESCALATED
)

TASK_STATES=(
  TASK_PENDING TASK_READY TASK_IN_PROGRESS
  TASK_REVIEW_READY TASK_REVIEW_IN_PROGRESS
  TASK_INTEGRATED TASK_REJECTED ESCALATED
)

CP_STATES=(
  CP_DRAFT CP_READY_FOR_HUMAN_GATE CP_HUMAN_APPROVED
  CP_READY_FOR_REVIEW CP_READY_FOR_VERIFICATION
  CP_APPROVED CP_MERGED CP_REQUEST_CHANGES CP_CLOSED CP_STALE
)

state_is_valid() {
  local kind="$1" state="$2" item
  case "${kind}" in
    milestone) for item in "${MILESTONE_STATES[@]}"; do [ "${state}" = "${item}" ] && return 0; done ;;
    task) for item in "${TASK_STATES[@]}"; do [ "${state}" = "${item}" ] && return 0; done ;;
    change_proposal|cp) for item in "${CP_STATES[@]}"; do [ "${state}" = "${item}" ] && return 0; done ;;
    *) return 1 ;;
  esac
  return 1
}

state_marker() {
  local kind="$1" state="$2"
  state_is_valid "${kind}" "${state}" || {
    log_error "state_marker: invalid ${kind} state '${state}'"
    return 1
  }
  case "${kind}" in
    milestone) printf '<!-- llm-team:milestone-state:%s -->' "${state}" ;;
    task) printf '<!-- llm-team:task-state:%s -->' "${state}" ;;
    change_proposal|cp) printf '<!-- llm-team:cp-state:%s -->' "${state}" ;;
  esac
}

legacy_label_to_state() {
  case "$1" in
    needs-code|needs-dev) printf 'TASK_READY' ;;
    code:in-progress|dev:in-progress) printf 'TASK_IN_PROGRESS' ;;
    code:in-review|needs-qa) printf 'TASK_REVIEW_READY' ;;
    code:rework-needed|qa:changes-requested) printf 'TASK_READY' ;;
    merged-to-release) printf 'TASK_INTEGRATED' ;;
    needs-human-review:engineer-failure|needs-human-review:dev-failure) printf 'ESCALATED' ;;
    *) return 1 ;;
  esac
}

# state_transition_allowed <kind> <from> <to>
# Authoritative transition matrix from docs/contracts/state-and-operation-contract.md
# (#SOC-STATES + #SOC-DISPATCH-MATRIX). Returns 0 when the transition is allowed,
# 1 otherwise. Same-state (idempotent) is allowed by callers, not by this matrix.
state_transition_allowed() {
  local kind="$1" from="$2" to="$3"
  case "${kind}" in
    cp) kind=change_proposal ;;
  esac
  case "${kind}-${from}-${to}" in
    # ── Milestone (SOC-STATES, lines 45-50) ────────────────────────────────
    milestone-PO_DRAFT-PO_GATE) return 0 ;;
    milestone-PO_GATE-PM_DRAFT) return 0 ;;
    milestone-PO_GATE-PO_DRAFT) return 0 ;;
    milestone-PM_DRAFT-PM_GATE) return 0 ;;
    milestone-PM_DRAFT-PO_DRAFT) return 0 ;;
    milestone-PM_GATE-DECOMPOSE_READY) return 0 ;;
    milestone-PM_GATE-PM_DRAFT) return 0 ;;
    milestone-PM_GATE-PO_DRAFT) return 0 ;;
    milestone-DECOMPOSE_READY-DECOMPOSE_IN_PROGRESS) return 0 ;;
    milestone-DECOMPOSE_READY-PM_DRAFT) return 0 ;;
    milestone-DECOMPOSE_IN_PROGRESS-IMPLEMENTING) return 0 ;;
    milestone-DECOMPOSE_IN_PROGRESS-DECOMPOSE_READY) return 0 ;;
    milestone-DECOMPOSE_IN_PROGRESS-ESCALATED) return 0 ;;
    milestone-IMPLEMENTING-REFACTOR_READY) return 0 ;;
    milestone-IMPLEMENTING-DECOMPOSE_READY) return 0 ;;
    milestone-REFACTOR_READY-REFACTOR_IN_PROGRESS) return 0 ;;
    milestone-REFACTOR_READY-DECOMPOSE_READY) return 0 ;;
    milestone-REFACTOR_IN_PROGRESS-VALIDATE_READY) return 0 ;;
    milestone-REFACTOR_IN_PROGRESS-REFACTOR_READY) return 0 ;;
    milestone-REFACTOR_IN_PROGRESS-ESCALATED) return 0 ;;
    milestone-VALIDATE_READY-VALIDATE_IN_PROGRESS) return 0 ;;
    milestone-VALIDATE_READY-REFACTOR_READY) return 0 ;;
    milestone-VALIDATE_IN_PROGRESS-DONE) return 0 ;;
    milestone-VALIDATE_IN_PROGRESS-IMPLEMENTING) return 0 ;;
    milestone-VALIDATE_IN_PROGRESS-VALIDATE_READY) return 0 ;;
    milestone-VALIDATE_IN_PROGRESS-ESCALATED) return 0 ;;

    # ── Task (SOC-STATES, lines 58-61) ─────────────────────────────────────
    task-TASK_PENDING-TASK_READY) return 0 ;;
    task-TASK_READY-TASK_IN_PROGRESS) return 0 ;;
    task-TASK_IN_PROGRESS-TASK_REVIEW_READY) return 0 ;;
    task-TASK_IN_PROGRESS-TASK_READY) return 0 ;;
    task-TASK_IN_PROGRESS-ESCALATED) return 0 ;;
    task-TASK_REVIEW_READY-TASK_REVIEW_IN_PROGRESS) return 0 ;;
    task-TASK_REVIEW_READY-TASK_READY) return 0 ;;
    task-TASK_REVIEW_IN_PROGRESS-TASK_INTEGRATED) return 0 ;;
    task-TASK_REVIEW_IN_PROGRESS-TASK_READY) return 0 ;;
    task-TASK_REVIEW_IN_PROGRESS-TASK_REJECTED) return 0 ;;
    task-TASK_REVIEW_IN_PROGRESS-ESCALATED) return 0 ;;
    task-TASK_REJECTED-TASK_READY) return 0 ;;
    task-ESCALATED-TASK_READY) return 0 ;;

    # ── Change Proposal (SOC-STATES, lines 69-83) ──────────────────────────
    change_proposal-CP_DRAFT-CP_READY_FOR_HUMAN_GATE) return 0 ;;
    change_proposal-CP_DRAFT-CP_READY_FOR_REVIEW) return 0 ;;
    change_proposal-CP_DRAFT-CP_READY_FOR_VERIFICATION) return 0 ;;
    change_proposal-CP_READY_FOR_HUMAN_GATE-CP_HUMAN_APPROVED) return 0 ;;
    change_proposal-CP_READY_FOR_HUMAN_GATE-CP_REQUEST_CHANGES) return 0 ;;
    change_proposal-CP_HUMAN_APPROVED-CP_MERGED) return 0 ;;
    change_proposal-CP_READY_FOR_REVIEW-CP_APPROVED) return 0 ;;
    change_proposal-CP_READY_FOR_REVIEW-CP_REQUEST_CHANGES) return 0 ;;
    change_proposal-CP_READY_FOR_REVIEW-CP_STALE) return 0 ;;
    change_proposal-CP_READY_FOR_VERIFICATION-CP_APPROVED) return 0 ;;
    change_proposal-CP_READY_FOR_VERIFICATION-CP_REQUEST_CHANGES) return 0 ;;
    change_proposal-CP_READY_FOR_VERIFICATION-CP_STALE) return 0 ;;
    change_proposal-CP_APPROVED-CP_MERGED) return 0 ;;
    change_proposal-CP_REQUEST_CHANGES-CP_CLOSED) return 0 ;;
  esac
  return 1
}
