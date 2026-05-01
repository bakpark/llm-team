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
