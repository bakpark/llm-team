#!/usr/bin/env bash
# lib/labels.sh — 12 label string constants and helpers.
#
# These constants MUST exactly match memory/state-machine.md §1. They are
# treated as a stable contract by every agent (PO/PM/DEV/QA) and the
# bootstrap-labels CLI. Changing any string here requires a synchronized
# update of state-machine.md and a re-run of test-labels-consistency.sh.
#
# Public API:
#   ALL_MILESTONE_LABELS — array of 5 milestone-state labels (in transition order).
#   ALL_ISSUE_LABELS     — array of 7 issue-state labels (in transition order).
#   label_with_prefix <prefix> <label> — apply optional yaml `labels.prefix`.

# --- Milestone labels (5) ----------------------------------------------------
LABEL_PO_IN_PROGRESS="po:in-progress"
LABEL_PO_REVIEW="needs-human-review:milestone"
LABEL_NEEDS_SCENARIOS="needs-scenarios"
LABEL_PM_IN_PROGRESS="pm:in-progress"
LABEL_PM_DONE="pm:done"

# --- Issue labels (7) --------------------------------------------------------
LABEL_SCENARIO_REVIEW="needs-human-review:scenario"
LABEL_NEEDS_DEV="needs-dev"
LABEL_DEV_IN_PROGRESS="dev:in-progress"
LABEL_NEEDS_QA="needs-qa"
LABEL_QA_IN_PROGRESS="qa:in-progress"
LABEL_QA_CHANGES_REQUESTED="qa:changes-requested"
LABEL_DEV_FAILURE="needs-human-review:dev-failure"

# Aggregate arrays (transition order).
ALL_MILESTONE_LABELS=(
  "${LABEL_PO_IN_PROGRESS}"
  "${LABEL_PO_REVIEW}"
  "${LABEL_NEEDS_SCENARIOS}"
  "${LABEL_PM_IN_PROGRESS}"
  "${LABEL_PM_DONE}"
)

ALL_ISSUE_LABELS=(
  "${LABEL_SCENARIO_REVIEW}"
  "${LABEL_NEEDS_DEV}"
  "${LABEL_DEV_IN_PROGRESS}"
  "${LABEL_NEEDS_QA}"
  "${LABEL_QA_IN_PROGRESS}"
  "${LABEL_QA_CHANGES_REQUESTED}"
  "${LABEL_DEV_FAILURE}"
)

# label_with_prefix <prefix> <label>
# Produce the full label string with the optional yaml `labels.prefix` applied.
# Empty prefix yields the bare label unchanged.
label_with_prefix() {
  local prefix="$1"
  local label="$2"
  if [ -n "${prefix}" ]; then
    printf '%s%s' "${prefix}" "${label}"
  else
    printf '%s' "${label}"
  fi
}
