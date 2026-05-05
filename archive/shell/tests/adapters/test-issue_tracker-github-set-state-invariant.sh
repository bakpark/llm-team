#!/usr/bin/env bash
# tests/adapters/test-issue_tracker-github-set-state-invariant.sh
#
# Verify state-label transition invariants (BUG-2).
#
# Cases:
#   A. it_issue_set_state: add new → remove old 호출 순서가 유지된다 (partial-fail
#      직후 issue 의 label 집합에 항상 new_label 이 포함됨을 보장하는 invariant).
#   B. it_pr_set_cp_state: add new_label → marker (PR body PATCH) → remove old_label
#      순서가 유지된다. marker write 직후 daemon 종료를 가정하더라도 PR 라벨 집합에
#      new_label 이 이미 들어있어야 함.
#   C. Self-transition dedup: it_issue_set_state new == old → add 만 1회, remove 호출 없음.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

. "${LLM_TEAM_ROOT}/lib/log.sh"
. "${LLM_TEAM_ROOT}/lib/state.sh"
. "${LLM_TEAM_ROOT}/lib/labels.sh"
. "${LLM_TEAM_ROOT}/lib/ports/issue_tracker.sh"
. "${LLM_TEAM_ROOT}/adapters/issue_tracker/github.sh"

export GH_RETRY_DELAY_1=0 GH_RETRY_DELAY_2=0 GH_RETRY_DELAY_3=0

FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-it-gh-inv-XXXXXX")"
CALL_LOG="${FAKE_BIN}/calls.log"
trap 'rm -rf "${FAKE_BIN}"' EXIT

# Fake `gh` that records every API verb+path on a single line of CALL_LOG.
# Returns 200 OK (empty stdout / 0 exit) for all GET/PATCH/POST/DELETE.
# For GET pulls/{n} → returns a body with no existing cp-state marker so the
# replacement step sees a clean slate.
cat >"${FAKE_BIN}/gh" <<'EOF'
#!/usr/bin/env bash
# Build a single-line tag that captures verb + path for ordering assertions.
verb=""
path=""
if [ "$1" = "api" ]; then
  shift
  if [ "$1" = "-X" ]; then
    verb="$2"; shift 2
  else
    verb="GET"
  fi
  path="$1"
  shift
  # GET requests for body lookup may carry --jq filter — output empty body.
  if [ "${verb}" = "GET" ]; then
    case "${path}" in
      */pulls/*|*/issues/*) printf '' ;;
    esac
  fi
fi
printf '%s %s\n' "${verb}" "${path}" >>"$CALL_LOG"
exit 0
EOF
chmod +x "${FAKE_BIN}/gh"
export PATH="${FAKE_BIN}:${PATH}"
export CALL_LOG

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

# ---------- Case A: it_issue_set_state — add precedes remove ----------------
: >"${CALL_LOG}"
it_issue_set_state "owner/repo" 7 TASK_READY TASK_IN_PROGRESS \
  || fail "case-A: it_issue_set_state returned nonzero on happy path"

# Expect exactly: POST /repos/owner/repo/issues/7/labels → DELETE …/labels/…
add_line="$(grep -n 'POST repos/owner/repo/issues/7/labels' "${CALL_LOG}" | head -1 | cut -d: -f1)"
del_line="$(grep -n 'DELETE repos/owner/repo/issues/7/labels/' "${CALL_LOG}" | head -1 | cut -d: -f1)"
if [ -z "${add_line}" ] || [ -z "${del_line}" ]; then
  echo "--- case A call log ---" >&2
  cat "${CALL_LOG}" >&2
  fail "case-A: missing add or remove call (add='${add_line}' del='${del_line}')"
elif [ "${add_line}" -ge "${del_line}" ]; then
  echo "--- case A call log ---" >&2
  cat "${CALL_LOG}" >&2
  fail "case-A: add (line ${add_line}) must precede remove (line ${del_line})"
else
  pass "case-A: it_issue_set_state add precedes remove"
fi

# ---------- Case B: it_pr_set_cp_state — add label → marker → remove --------
: >"${CALL_LOG}"
# Both states must have queue labels for the remove step to fire — pick two
# from {CP_READY_FOR_HUMAN_GATE, CP_READY_FOR_REVIEW, CP_READY_FOR_VERIFICATION, CP_STALE}.
it_pr_set_cp_state "owner/repo" 13 CP_READY_FOR_REVIEW CP_READY_FOR_HUMAN_GATE \
  || fail "case-B: it_pr_set_cp_state returned nonzero on happy path"

add_line="$(grep -n 'POST repos/owner/repo/issues/13/labels' "${CALL_LOG}" | head -1 | cut -d: -f1)"
patch_line="$(grep -n 'PATCH repos/owner/repo/pulls/13' "${CALL_LOG}" | head -1 | cut -d: -f1)"
del_line="$(grep -n 'DELETE repos/owner/repo/issues/13/labels/' "${CALL_LOG}" | head -1 | cut -d: -f1)"
if [ -z "${add_line}" ] || [ -z "${patch_line}" ] || [ -z "${del_line}" ]; then
  echo "--- case B call log ---" >&2
  cat "${CALL_LOG}" >&2
  fail "case-B: missing one of add/patch/delete (add='${add_line}' patch='${patch_line}' del='${del_line}')"
elif [ "${add_line}" -lt "${patch_line}" ] && [ "${patch_line}" -lt "${del_line}" ]; then
  pass "case-B: it_pr_set_cp_state ordering (add → marker → remove)"
else
  echo "--- case B call log ---" >&2
  cat "${CALL_LOG}" >&2
  fail "case-B: ordering violated (add=${add_line} patch=${patch_line} del=${del_line})"
fi

# ---------- Case C: self-transition dedup → add 1, remove 0 ---------------
: >"${CALL_LOG}"
it_issue_set_state "owner/repo" 7 TASK_READY TASK_READY \
  || fail "case-C: it_issue_set_state self-transition returned nonzero"

add_count="$(grep -c 'POST repos/owner/repo/issues/7/labels' "${CALL_LOG}" || true)"
del_count="$(grep -c 'DELETE repos/owner/repo/issues/7/labels/' "${CALL_LOG}" || true)"
if [ "${add_count}" != "1" ]; then
  echo "--- case C call log ---" >&2
  cat "${CALL_LOG}" >&2
  fail "case-C: expected exactly 1 add call on self-transition, got ${add_count}"
elif [ "${del_count}" != "0" ]; then
  echo "--- case C call log ---" >&2
  cat "${CALL_LOG}" >&2
  fail "case-C: expected 0 remove calls on self-transition, got ${del_count}"
else
  pass "case-C: it_issue_set_state self-transition skips remove"
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAILED ${failures} case(s)" >&2
  exit 1
fi
echo "PASS: tests/adapters/test-issue_tracker-github-set-state-invariant.sh"
