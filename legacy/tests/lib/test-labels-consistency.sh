#!/usr/bin/env bash
# tests/lib/test-labels-consistency.sh — verify the 12 label constants in
# lib/labels.sh exactly match memory/state-machine.md §1, and that the
# aggregate arrays have the right cardinality (5 + 7 = 12).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

LABELS_FILE="${LLM_TEAM_ROOT}/lib/labels.sh"
SM_FILE="${LLM_TEAM_ROOT}/.plan/26050116-architecture/memory/state-machine.md"

EXPECTED=(
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

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures+1)); }

# 1) Each expected label string appears verbatim in lib/labels.sh and in the
#    state-machine memory document.
for label in "${EXPECTED[@]}"; do
  if ! grep -Fq "\"${label}\"" "${LABELS_FILE}"; then
    fail "label '${label}' missing in lib/labels.sh"
  fi
  if ! grep -Fq "${label}" "${SM_FILE}"; then
    fail "label '${label}' missing in memory/state-machine.md"
  fi
done

# 2) Exactly 12 LABEL_* constants are declared.
declared="$(grep -cE '^LABEL_[A-Z_]+="[^"]+"' "${LABELS_FILE}" || true)"
if [ "${declared}" != "12" ]; then
  fail "expected 12 LABEL_* constants in lib/labels.sh, got ${declared}"
fi

# 3) Aggregate arrays have correct sizes.
ml_count="${#ALL_MILESTONE_LABELS[@]}"
il_count="${#ALL_ISSUE_LABELS[@]}"
if [ "${ml_count}" -ne 5 ]; then
  fail "ALL_MILESTONE_LABELS has ${ml_count} elements, expected 5"
fi
if [ "${il_count}" -ne 7 ]; then
  fail "ALL_ISSUE_LABELS has ${il_count} elements, expected 7"
fi

# 4) Each runtime constant resolves to the documented string.
verify_const() {
  local var="$1" expected="$2"
  if [ "${!var}" != "${expected}" ]; then
    fail "${var}='${!var}', expected '${expected}'"
  fi
}
verify_const LABEL_PO_IN_PROGRESS        "po:in-progress"
verify_const LABEL_PO_REVIEW             "needs-human-review:milestone"
verify_const LABEL_NEEDS_SCENARIOS       "needs-scenarios"
verify_const LABEL_PM_IN_PROGRESS        "pm:in-progress"
verify_const LABEL_PM_DONE               "pm:done"
verify_const LABEL_SCENARIO_REVIEW       "needs-human-review:scenario"
verify_const LABEL_NEEDS_DEV             "needs-dev"
verify_const LABEL_DEV_IN_PROGRESS       "dev:in-progress"
verify_const LABEL_NEEDS_QA              "needs-qa"
verify_const LABEL_QA_IN_PROGRESS        "qa:in-progress"
verify_const LABEL_QA_CHANGES_REQUESTED  "qa:changes-requested"
verify_const LABEL_DEV_FAILURE           "needs-human-review:dev-failure"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} consistency check(s) failed" >&2
  exit 1
fi
echo "PASS: 12 label constants match memory/state-machine.md §1"
