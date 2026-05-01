#!/usr/bin/env bash
# tests/lib/test-bootstrap-dry-run.sh — verify bootstrap-labels.sh --dry-run
# prints all 12 framework labels.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

OUTPUT="$(bash "${LLM_TEAM_ROOT}/scripts/bootstrap-labels.sh" myapp --dry-run 2>&1)"
echo "${OUTPUT}"

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
for label in "${EXPECTED[@]}"; do
  # Use a regex anchored on word/symbol boundaries so e.g. "needs-dev" and
  # "needs-dev-failure" are not accidentally cross-matched. We only care that
  # a line begins with the label (allowing optional prefix-free lookups).
  if ! printf '%s\n' "${OUTPUT}" | grep -E "(^|[[:space:]])${label}([[:space:]]|$)" >/dev/null; then
    echo "FAIL: dry-run output missing label: ${label}" >&2
    failures=$((failures+1))
  fi
done

# Confirm the summary line declares 12 labels.
if ! printf '%s\n' "${OUTPUT}" | grep -Eq 'Dry run: 12 labels'; then
  echo "FAIL: summary line did not report 12 labels" >&2
  failures=$((failures+1))
fi

if [ "${failures}" -gt 0 ]; then
  exit 1
fi
echo "PASS: bootstrap-labels --dry-run output contains 12 labels"
