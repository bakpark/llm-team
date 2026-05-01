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
