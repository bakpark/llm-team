#!/usr/bin/env bash
# tests/adapters/test-issue_tracker-github-list.sh
#
# Verify it_milestone_list_in_state correctly handles multi-line milestone
# descriptions (the real GitHub case where description contains newlines and
# the state marker is on a non-first line).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

. "${LLM_TEAM_ROOT}/lib/log.sh"
. "${LLM_TEAM_ROOT}/lib/state.sh"
. "${LLM_TEAM_ROOT}/lib/ports/issue_tracker.sh"
. "${LLM_TEAM_ROOT}/adapters/issue_tracker/github.sh"

FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-it-gh-list-XXXXXX")"
FAKE_FIXTURE="${FAKE_BIN}/milestones.json"
trap 'rm -rf "${FAKE_BIN}"' EXIT

# Fake `gh`: when called as `gh api repos/.../milestones?...`, return canned
# JSON. Else fail.
cat >"${FAKE_BIN}/gh" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [[ "\$2" == repos/*/milestones* ]]; then
  shift 2
  jq_args=()
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --jq) jq_args=(-r "\$2"); shift 2 ;;
      *) shift ;;
    esac
  done
  if [ "\${#jq_args[@]}" -gt 0 ]; then
    jq "\${jq_args[@]}" "${FAKE_FIXTURE}"
  else
    cat "${FAKE_FIXTURE}"
  fi
  exit 0
fi
echo "fake gh: unsupported call: \$*" >&2
exit 1
EOF
chmod +x "${FAKE_BIN}/gh"
export PATH="${FAKE_BIN}:${PATH}"

# Fixture: 3 milestones with multi-line descriptions matching the real format
# observed from GitHub (state marker on the 4th line).
cat >"${FAKE_FIXTURE}" <<'JSON'
[
  {
    "number": 1,
    "state": "open",
    "description": "Promoted from feature-request issue #2.\n\nSource: bakpark/llm-team issue #2.\n<!-- llm-team:milestone-state:PO_DRAFT -->"
  },
  {
    "number": 2,
    "state": "open",
    "description": "Promoted from feature-request issue #5.\n\nSource: bakpark/llm-team issue #5.\n<!-- llm-team:milestone-state:PO_DRAFT -->"
  },
  {
    "number": 3,
    "state": "open",
    "description": "Already past PO.\n<!-- llm-team:milestone-state:PM_DRAFT -->"
  }
]
JSON

fail() { echo "FAIL: $*" >&2; exit 1; }

result="$(it_milestone_list_in_state 'owner/repo' PO_DRAFT | tr '\n' ' ')"
[ "${result}" = "1 2 " ] || fail "PO_DRAFT expected '1 2', got '${result}'"

result="$(it_milestone_list_in_state 'owner/repo' PM_DRAFT | tr '\n' ' ')"
[ "${result}" = "3 " ] || fail "PM_DRAFT expected '3', got '${result}'"

result="$(it_milestone_list_in_state 'owner/repo' DECOMPOSE_READY | tr '\n' ' ')"
[ "${result}" = "" ] || fail "DECOMPOSE_READY expected empty, got '${result}'"

echo "PASS: it_milestone_list_in_state handles multi-line descriptions"
