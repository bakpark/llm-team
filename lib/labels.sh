#!/usr/bin/env bash
# lib/labels.sh - GitHub label names for the contract-state adapter.
#
# Labels are adapter encoding, not the authoritative state model. The
# authoritative state names live in docs/contracts/state-and-operation-contract.md.

# Task states are represented as Issue labels.
LABEL_TASK_PENDING="task:pending"
LABEL_TASK_READY="task:ready"
LABEL_TASK_IN_PROGRESS="task:in-progress"
LABEL_TASK_REVIEW_READY="task:review-ready"
LABEL_TASK_REVIEW_IN_PROGRESS="task:review-in-progress"
LABEL_TASK_INTEGRATED="task:integrated"
LABEL_TASK_REJECTED="task:rejected"
LABEL_TASK_ESCALATED="task:escalated"

ALL_TASK_LABELS=(
  "${LABEL_TASK_PENDING}"
  "${LABEL_TASK_READY}"
  "${LABEL_TASK_IN_PROGRESS}"
  "${LABEL_TASK_REVIEW_READY}"
  "${LABEL_TASK_REVIEW_IN_PROGRESS}"
  "${LABEL_TASK_INTEGRATED}"
  "${LABEL_TASK_REJECTED}"
  "${LABEL_TASK_ESCALATED}"
)

# Change Proposal labels are optional; PR/body markers remain authoritative for
# CP state, but labels make GitHub queues easier to inspect.
LABEL_CP_READY_FOR_HUMAN_GATE="cp:ready-for-human-gate"
LABEL_CP_READY_FOR_REVIEW="cp:ready-for-review"
LABEL_CP_READY_FOR_VERIFICATION="cp:ready-for-verification"
LABEL_CP_STALE="cp:stale"

ALL_CP_LABELS=(
  "${LABEL_CP_READY_FOR_HUMAN_GATE}"
  "${LABEL_CP_READY_FOR_REVIEW}"
  "${LABEL_CP_READY_FOR_VERIFICATION}"
  "${LABEL_CP_STALE}"
)

ALL_ISSUE_LABELS=("${ALL_TASK_LABELS[@]}" "${ALL_CP_LABELS[@]}")

# Legacy aliases are read-only migration aids. New code must not use them as
# queue labels.
LEGACY_LABELS=(
  "po:in-progress"
  "needs-human-review:milestone"
  "needs-scenarios"
  "pm:in-progress"
  "pm:done"
  "needs-human-review:scenario"
  "needs-dev"
  "dev:in-progress"
  "needs-qa"
  "qa:in-progress"
  "qa:changes-requested"
  "needs-human-review:dev-failure"
)

label_with_prefix() {
  local prefix="$1"
  local label="$2"
  if [ -n "${prefix}" ]; then
    printf '%s%s' "${prefix}" "${label}"
  else
    printf '%s' "${label}"
  fi
}

label_is_legacy() {
  local candidate="$1"
  local label
  for label in "${LEGACY_LABELS[@]}"; do
    [ "${candidate}" = "${label}" ] && return 0
  done
  return 1
}

# task_state_to_label <state>
# Map a TASK_* / ESCALATED state name to the corresponding label string.
# Returns 1 (and prints nothing) if the state is not a task state.
task_state_to_label() {
  case "$1" in
    TASK_PENDING)             printf '%s' "${LABEL_TASK_PENDING}" ;;
    TASK_READY)               printf '%s' "${LABEL_TASK_READY}" ;;
    TASK_IN_PROGRESS)         printf '%s' "${LABEL_TASK_IN_PROGRESS}" ;;
    TASK_REVIEW_READY)        printf '%s' "${LABEL_TASK_REVIEW_READY}" ;;
    TASK_REVIEW_IN_PROGRESS)  printf '%s' "${LABEL_TASK_REVIEW_IN_PROGRESS}" ;;
    TASK_INTEGRATED)          printf '%s' "${LABEL_TASK_INTEGRATED}" ;;
    TASK_REJECTED)            printf '%s' "${LABEL_TASK_REJECTED}" ;;
    ESCALATED)                printf '%s' "${LABEL_TASK_ESCALATED}" ;;
    *) return 1 ;;
  esac
}

# label_to_task_state <label>
# Inverse of task_state_to_label. Returns 1 for unknown labels.
label_to_task_state() {
  case "$1" in
    "${LABEL_TASK_PENDING}")            printf 'TASK_PENDING' ;;
    "${LABEL_TASK_READY}")              printf 'TASK_READY' ;;
    "${LABEL_TASK_IN_PROGRESS}")        printf 'TASK_IN_PROGRESS' ;;
    "${LABEL_TASK_REVIEW_READY}")       printf 'TASK_REVIEW_READY' ;;
    "${LABEL_TASK_REVIEW_IN_PROGRESS}") printf 'TASK_REVIEW_IN_PROGRESS' ;;
    "${LABEL_TASK_INTEGRATED}")         printf 'TASK_INTEGRATED' ;;
    "${LABEL_TASK_REJECTED}")           printf 'TASK_REJECTED' ;;
    "${LABEL_TASK_ESCALATED}")          printf 'ESCALATED' ;;
    *) return 1 ;;
  esac
}

# cp_state_to_label <state>
# Map CP_* state to label (only the queue labels — CP_DRAFT/CP_MERGED have no label).
cp_state_to_label() {
  case "$1" in
    CP_READY_FOR_HUMAN_GATE)   printf '%s' "${LABEL_CP_READY_FOR_HUMAN_GATE}" ;;
    CP_READY_FOR_REVIEW)       printf '%s' "${LABEL_CP_READY_FOR_REVIEW}" ;;
    CP_READY_FOR_VERIFICATION) printf '%s' "${LABEL_CP_READY_FOR_VERIFICATION}" ;;
    CP_STALE)                  printf '%s' "${LABEL_CP_STALE}" ;;
    *) return 1 ;;
  esac
}
