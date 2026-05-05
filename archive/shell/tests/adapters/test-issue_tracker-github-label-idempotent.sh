#!/usr/bin/env bash
# tests/adapters/test-issue_tracker-github-label-idempotent.sh
#
# Verify _github_issue_remove_label treats HTTP 404 ("label not on issue")
# as success so that it_issue_set_state idempotently re-applies a transition
# even when the old-state label is already absent.
#
# Regression: prior to this fix, a 404 from REST `DELETE /issues/N/labels/L`
# was retried 3× via gh_with_retry and then propagated as failure, breaking
# add-new → remove-old transitions on the second attempt.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

. "${LLM_TEAM_ROOT}/lib/log.sh"
. "${LLM_TEAM_ROOT}/lib/state.sh"
. "${LLM_TEAM_ROOT}/lib/ports/issue_tracker.sh"
. "${LLM_TEAM_ROOT}/adapters/issue_tracker/github.sh"

# Skip retry delays so the fallback path (other failure → gh_with_retry) is
# fast.
export GH_RETRY_DELAY_1=0 GH_RETRY_DELAY_2=0 GH_RETRY_DELAY_3=0

FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-it-gh-label-XXXXXX")"
CALL_LOG="${FAKE_BIN}/calls.log"
MODE_FILE="${FAKE_BIN}/mode"
trap 'rm -rf "${FAKE_BIN}"' EXIT

# Fake `gh` that simulates GitHub's response for DELETE /issues/N/labels/L.
# Behavior is controlled by the file at ${MODE_FILE}:
#   404 — emit GitHub-style "HTTP 404" stderr and exit 1.
#   500 — emit "HTTP 500" stderr and exit 1 (transient — exercises retry).
#   200 — exit 0.
cat >"${FAKE_BIN}/gh" <<'EOF'
#!/usr/bin/env bash
mode="$(cat "$MODE_FILE" 2>/dev/null || echo 200)"
printf '%s\n' "$*" >>"$CALL_LOG"
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "DELETE" ]; then
  case "$mode" in
    404) echo "gh: Resource not protected by branch protection or HTTP 404: Label does not exist (https://api.github.com/...)" >&2; exit 1 ;;
    500) echo "gh: HTTP 500: Internal Server Error" >&2; exit 1 ;;
    200) exit 0 ;;
  esac
fi
echo "fake gh: unsupported call: $*" >&2
exit 1
EOF
chmod +x "${FAKE_BIN}/gh"
export PATH="${FAKE_BIN}:${PATH}"
export CALL_LOG MODE_FILE

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ---------- Case 1: 404 → success (no retry) -------------------------------
: >"${CALL_LOG}"
echo 404 >"${MODE_FILE}"
if ! _github_issue_remove_label "owner/repo" 7 "task:done"; then
  fail "case-404: should return success when label already absent"
fi
calls="$(wc -l <"${CALL_LOG}" | tr -d ' ')"
if [ "${calls}" != "1" ]; then
  fail "case-404: expected 1 gh call (no retry), got ${calls}"
fi

# ---------- Case 2: 200 → success (single call) ---------------------------
: >"${CALL_LOG}"
echo 200 >"${MODE_FILE}"
if ! _github_issue_remove_label "owner/repo" 7 "task:done"; then
  fail "case-200: should return success on normal removal"
fi
calls="$(wc -l <"${CALL_LOG}" | tr -d ' ')"
if [ "${calls}" != "1" ]; then
  fail "case-200: expected 1 gh call, got ${calls}"
fi

# ---------- Case 3: 500 → retry path (3 attempts, then failure) -----------
: >"${CALL_LOG}"
echo 500 >"${MODE_FILE}"
if _github_issue_remove_label "owner/repo" 7 "task:done"; then
  fail "case-500: should fail after retry exhausted"
fi
calls="$(wc -l <"${CALL_LOG}" | tr -d ' ')"
# 1 initial probe + 3 gh_with_retry attempts = 4
if [ "${calls}" != "4" ]; then
  fail "case-500: expected 4 gh calls (1 probe + 3 retry), got ${calls}"
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAILED ${failures} case(s)" >&2
  exit 1
fi
echo "PASS: _github_issue_remove_label idempotent on 404"
