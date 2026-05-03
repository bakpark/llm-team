#!/usr/bin/env bash
# tests/adapters/test-issue_tracker-in_memory.sh
#
# adapters/issue_tracker/in_memory.sh 단위 검증.
#
# 검증 항목:
#   1. registry_load_adapter 가 in_memory adapter 를 정상 source + verify
#      (Phase 1.5 신규 4개 + collect_signals 신규 포맷 포함).
#   2. milestone create / update / set_state / get_state / list_open /
#      list_in_state / progress / close round-trip.
#   3. issue create / link_to_milestone / set_state / get_state /
#      list_in_state / set_blocked_by / clear_state_labels / close.
#   4. PR create / set_cp_state / get_cp_state / get_head_sha /
#      get_base_branch / get_base_sha / merge / close 멱등 / request_changes.
#   5. release create + duplicate tag 거부.
#   6. comment_post + collect_signals 신규 4-필드 JSONL 포맷 (issue/pr/milestone)
#      + has_marker.
#   7. revision_pin_get.
#   8. 멱등성: set_state 두 번 / pr_close 두 번 / pr_merge 두 번.
#   9. 격리: 데이터가 LLM_TEAM_INMEM_IT_DIR 아래에만 기록.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# 격리: 이 테스트만의 in-memory 루트
TEST_INMEM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-it-inmem-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${TEST_INMEM_ROOT}"
export LLM_TEAM_INMEM_IT_ACTOR="alice"

cleanup() {
  rm -rf "${TEST_INMEM_ROOT}" 2>/dev/null || true
}
trap cleanup EXIT

# Default common.sh 는 github 어댑터를 로드 — 이후 in_memory 로 rebind.
# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# (1) Adapter 로드 + port verification (신규 함수 포함)
# ----------------------------------------------------------------------------
registry_load_adapter issue_tracker in_memory \
  || fail "registry_load_adapter issue_tracker in_memory failed"
[ "${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-}" = "in_memory" ] \
  || fail "active adapter not switched to in_memory"
registry_verify_port issue_tracker \
  || fail "registry_verify_port issue_tracker failed after rebind"
for fn in it_pr_close it_pr_get_head_sha it_pr_get_base_branch it_pr_get_base_sha; do
  declare -F "${fn}" >/dev/null || fail "Phase 1.5 function not declared: ${fn}"
done

repo="acme/widgets"

# ----------------------------------------------------------------------------
# (2) Milestone lifecycle
# ----------------------------------------------------------------------------
ms="$(it_milestone_create "${repo}" "Auth flow" "Implement auth")" \
  || fail "milestone_create failed"
[ "${ms}" = "1" ] || fail "first milestone num expected 1, got '${ms}'"

it_milestone_update "${repo}" "${ms}" --title "Auth flow v2" --body "Updated body" \
  || fail "milestone_update failed"

it_milestone_set_state "${repo}" "${ms}" PO_DRAFT \
  || fail "milestone_set_state PO_DRAFT failed"
got="$(it_milestone_get_state "${repo}" "${ms}")"
[ "${got}" = "PO_DRAFT" ] || fail "milestone_get_state expected PO_DRAFT, got '${got}'"

# Idempotent set_state (same state, no rc=0 error).
it_milestone_set_state "${repo}" "${ms}" PO_DRAFT \
  || fail "milestone_set_state idempotent same-state failed"

# Transition with old_state.
it_milestone_set_state "${repo}" "${ms}" PO_GATE PO_DRAFT \
  || fail "milestone_set_state PO_DRAFT→PO_GATE failed"
got="$(it_milestone_get_state "${repo}" "${ms}")"
[ "${got}" = "PO_GATE" ] || fail "milestone state expected PO_GATE, got '${got}'"

# Invalid state rejected.
if it_milestone_set_state "${repo}" "${ms}" NOT_A_STATE 2>/dev/null; then
  fail "milestone_set_state should reject invalid state"
fi

# list_open / list_in_state
ms2="$(it_milestone_create "${repo}" "Logging" "")"
it_milestone_set_state "${repo}" "${ms2}" PM_DRAFT
open_list="$(it_milestone_list_open "${repo}" | tr '\n' ' ')"
[ "${open_list}" = "1 2 " ] || fail "list_open expected '1 2', got '${open_list}'"
state_list="$(it_milestone_list_in_state "${repo}" PO_GATE)"
[ "${state_list}" = "1" ] || fail "list_in_state PO_GATE expected '1', got '${state_list}'"

# progress (no children yet)
prog="$(it_milestone_get_progress "${repo}" "${ms}")"
[ "${prog}" = "open=0 closed=0" ] || fail "progress empty expected 'open=0 closed=0', got '${prog}'"

# ----------------------------------------------------------------------------
# (3) Issue lifecycle
# ----------------------------------------------------------------------------
issue1="$(it_issue_create "${repo}" --title "Login form" --body "Build it" --milestone "${ms}")"
[ "${issue1}" = "1" ] || fail "first issue num expected 1, got '${issue1}'"
issue2="$(it_issue_create "${repo}" --title "Logout" --body "" --milestone "${ms}" --labels "feature-request,task:pending")"
[ "${issue2}" = "2" ] || fail "second issue num expected 2"

# get_milestone
got="$(it_issue_get_milestone "${repo}" "${issue1}")"
[ "${got}" = "${ms}" ] || fail "issue get_milestone expected ${ms}, got '${got}'"

# set_state / get_state (label encoding)
it_issue_set_state "${repo}" "${issue1}" TASK_READY \
  || fail "issue set_state TASK_READY failed"
got="$(it_issue_get_state "${repo}" "${issue1}")"
[ "${got}" = "TASK_READY" ] || fail "issue get_state expected TASK_READY, got '${got}'"

it_issue_set_state "${repo}" "${issue1}" TASK_IN_PROGRESS TASK_READY \
  || fail "issue set_state TASK_READY→TASK_IN_PROGRESS failed"
got="$(it_issue_get_state "${repo}" "${issue1}")"
[ "${got}" = "TASK_IN_PROGRESS" ] || fail "issue state expected TASK_IN_PROGRESS, got '${got}'"

# list_in_state
list="$(it_issue_list_in_state "${repo}" TASK_IN_PROGRESS)"
[ "${list}" = "${issue1}" ] || fail "issue list_in_state TASK_IN_PROGRESS expected ${issue1}, got '${list}'"

# list_with_label --no-milestone (issue without milestone needed)
issue3="$(it_issue_create "${repo}" --title "Standalone" --body "" --labels "feature-request")"
free_list="$(it_issue_list_with_label "${repo}" feature-request --no-milestone)"
[ "${free_list}" = "${issue3}" ] || fail "list_with_label --no-milestone expected ${issue3}, got '${free_list}'"

# set_blocked_by
it_issue_set_blocked_by "${repo}" "${issue2}" "${issue1}" "${issue3}" \
  || fail "set_blocked_by failed"
blockers="$(jq -r '.blocked_by | join(",")' "${LLM_TEAM_INMEM_IT_DIR}/issues/${issue2}.json")"
[ "${blockers}" = "${issue1},${issue3}" ] || fail "blocked_by expected '${issue1},${issue3}', got '${blockers}'"

# Re-call set_blocked_by with same blocker → idempotent (no duplicates).
it_issue_set_blocked_by "${repo}" "${issue2}" "${issue1}" \
  || fail "set_blocked_by idempotent failed"
blockers="$(jq -r '.blocked_by | length' "${LLM_TEAM_INMEM_IT_DIR}/issues/${issue2}.json")"
[ "${blockers}" = "2" ] || fail "blocked_by length expected 2 (no dupe), got '${blockers}'"

# clear_state_labels (removes task:* labels but leaves feature-request)
it_issue_clear_state_labels "${repo}" "${issue2}" \
  || fail "clear_state_labels failed"
remaining="$(jq -r '.labels | join(",")' "${LLM_TEAM_INMEM_IT_DIR}/issues/${issue2}.json")"
[ "${remaining}" = "feature-request" ] || fail "after clear_state_labels expected only feature-request, got '${remaining}'"

# close_with_note (also stores comment)
it_issue_close_with_note "${repo}" "${issue3}" "duplicate of #${issue1}" \
  || fail "issue close_with_note failed"
state="$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/issues/${issue3}.json")"
[ "${state}" = "closed" ] || fail "issue ${issue3} state expected closed, got '${state}'"

# ----------------------------------------------------------------------------
# (4) PR lifecycle (Phase 1.5 신규 함수 포함)
# ----------------------------------------------------------------------------
pr1="$(it_pr_create "${repo}" --head "feature/x" --base integration --title "Add x" --body "body")"
[ "${pr1}" = "1" ] || fail "first PR num expected 1, got '${pr1}'"

head_sha="$(it_pr_get_head_sha "${repo}" "${pr1}")"
[ "${head_sha}" = "sha-inmem-head-feature/x-1" ] \
  || fail "head_sha unexpected: '${head_sha}'"
base_branch="$(it_pr_get_base_branch "${repo}" "${pr1}")"
[ "${base_branch}" = "integration" ] || fail "base_branch expected integration, got '${base_branch}'"
base_sha="$(it_pr_get_base_sha "${repo}" "${pr1}")"
[ "${base_sha}" = "sha-inmem-base-integration-1" ] || fail "base_sha unexpected: '${base_sha}'"

it_pr_set_cp_state "${repo}" "${pr1}" CP_READY_FOR_REVIEW \
  || fail "pr set_cp_state CP_READY_FOR_REVIEW failed"
got="$(it_pr_get_cp_state "${repo}" "${pr1}")"
[ "${got}" = "CP_READY_FOR_REVIEW" ] || fail "pr cp state expected CP_READY_FOR_REVIEW, got '${got}'"

# Idempotent: same state again (no error)
it_pr_set_cp_state "${repo}" "${pr1}" CP_READY_FOR_REVIEW \
  || fail "pr set_cp_state idempotent same-state failed"
got="$(it_pr_get_cp_state "${repo}" "${pr1}")"
[ "${got}" = "CP_READY_FOR_REVIEW" ] || fail "pr cp state still expected CP_READY_FOR_REVIEW, got '${got}'"

# Label sync: cp:ready-for-review label added
labels="$(jq -r '.labels[]' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr1}.json" | tr '\n' ',' | sed 's/,$//')"
case ",${labels}," in
  *,cp:ready-for-review,*) ;;
  *) fail "PR labels missing cp:ready-for-review (got: '${labels}')" ;;
esac

it_pr_set_cp_state "${repo}" "${pr1}" CP_APPROVED CP_READY_FOR_REVIEW \
  || fail "pr set_cp_state CP_READY_FOR_REVIEW→CP_APPROVED failed"
labels="$(jq -r '.labels | join(",")' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr1}.json")"
case ",${labels}," in
  *,cp:ready-for-review,*) fail "old label cp:ready-for-review should be removed (got: '${labels}')" ;;
esac

# merge
merge_sha="$(it_pr_merge "${repo}" "${pr1}" --squash)"
[ -n "${merge_sha}" ] || fail "pr_merge returned empty sha"
state="$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr1}.json")"
[ "${state}" = "merged" ] || fail "pr state after merge expected merged, got '${state}'"
# Idempotent merge returns same sha.
merge_sha2="$(it_pr_merge "${repo}" "${pr1}" --squash)"
[ "${merge_sha}" = "${merge_sha2}" ] || fail "pr_merge idempotent expected same sha"

# Invalid mode rejected.
pr_bad="$(it_pr_create "${repo}" --head "feature/y" --base integration --title "y")"
if it_pr_merge "${repo}" "${pr_bad}" --bogus 2>/dev/null; then
  fail "pr_merge should reject invalid mode"
fi

# pr_close (request_changes case)
pr2="$(it_pr_create "${repo}" --head "feature/z" --base integration --title "z" --body "")"
it_pr_request_changes "${repo}" "${pr2}" "needs more tests" \
  || fail "pr_request_changes failed"
got="$(it_pr_get_cp_state "${repo}" "${pr2}")"
[ "${got}" = "CP_REQUEST_CHANGES" ] || fail "pr2 cp state expected CP_REQUEST_CHANGES, got '${got}'"

it_pr_close "${repo}" "${pr2}" || fail "pr_close failed"
state="$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/prs/${pr2}.json")"
[ "${state}" = "closed" ] || fail "pr2 state after close expected closed, got '${state}'"

# Idempotent close: already-closed returns 0 without error.
it_pr_close "${repo}" "${pr2}" || fail "pr_close idempotent failed"

# Refuse close on missing PR.
if it_pr_close "${repo}" 9999 2>/dev/null; then
  fail "pr_close should fail for nonexistent PR"
fi

# ----------------------------------------------------------------------------
# (5) Release
# ----------------------------------------------------------------------------
it_release_create "${repo}" "v1.0.0" --target "${merge_sha}" --title "v1.0" --notes "first" \
  || fail "release_create failed"
[ -f "${LLM_TEAM_INMEM_IT_DIR}/releases/v1.0.0.json" ] || fail "release file missing"
if it_release_create "${repo}" "v1.0.0" --target "${merge_sha}" 2>/dev/null; then
  fail "duplicate tag should be rejected"
fi

# ----------------------------------------------------------------------------
# (6) Comments + collect_signals (Phase 1.5 신규 4-필드 JSONL)
# ----------------------------------------------------------------------------
sig_json='{"signal_id":"sig-1","signal_type":"approve","target_kind":"task","target_id":"T-1"}'
it_comment_post "${repo}" issue "${issue1}" \
  "Looks good <!-- llm-team:human-signal ${sig_json} --> ship it" \
  || fail "comment_post issue failed"
it_comment_post "${repo}" issue "${issue1}" "no marker here" \
  || fail "comment_post no-marker failed"

signals="$(it_comment_collect_signals "${repo}" issue "${issue1}")"
line_count="$(printf '%s\n' "${signals}" | grep -c .)"
[ "${line_count}" = "1" ] || fail "collect_signals expected 1 line, got ${line_count}: '${signals}'"
# Verify all 4 fields present + body equals envelope JSON.
parsed_actor="$(printf '%s' "${signals}" | jq -r '.actor')"
parsed_cid="$(printf '%s' "${signals}" | jq -r '.comment_id')"
parsed_body="$(printf '%s' "${signals}" | jq -r '.body')"
parsed_at="$(printf '%s' "${signals}" | jq -r '.posted_at')"
[ "${parsed_actor}" = "alice" ] || fail "signal actor expected alice, got '${parsed_actor}'"
[ -n "${parsed_cid}" ] && [ "${parsed_cid}" != "null" ] \
  || fail "signal comment_id missing"
[ "${parsed_body}" = "${sig_json}" ] || fail "signal body mismatch: got '${parsed_body}'"
[ -n "${parsed_at}" ] || fail "signal posted_at missing"

# PR signal
it_comment_post "${repo}" pr "${pr2}" \
  "<!-- llm-team:human-signal {\"signal_id\":\"s2\",\"signal_type\":\"reject\"} -->" \
  || fail "comment_post pr failed"
pr_sigs="$(it_comment_collect_signals "${repo}" pr "${pr2}")"
[ "$(printf '%s' "${pr_sigs}" | jq -r '.body')" = '{"signal_id":"s2","signal_type":"reject"}' ] \
  || fail "pr signal body mismatch: '${pr_sigs}'"

# Milestone signal (description scan)
it_comment_post "${repo}" milestone "${ms}" \
  '<!-- llm-team:human-signal {"signal_id":"m1","signal_type":"resume"} -->' \
  || fail "comment_post milestone failed"
ms_sigs="$(it_comment_collect_signals "${repo}" milestone "${ms}")"
[ "$(printf '%s' "${ms_sigs}" | jq -r '.body')" = '{"signal_id":"m1","signal_type":"resume"}' ] \
  || fail "milestone signal body mismatch"
[ "$(printf '%s' "${ms_sigs}" | jq -r '.actor')" = "alice" ] \
  || fail "milestone signal actor expected alice (creator), got '$(printf '%s' "${ms_sigs}" | jq -r '.actor')'"
[ "$(printf '%s' "${ms_sigs}" | jq -r '.comment_id')" = "${ms}" ] \
  || fail "milestone signal comment_id should equal milestone num"

# has_marker
it_comment_post "${repo}" issue "${issue1}" \
  "$(marker_notified human-gate:po) test notice" \
  || fail "marker comment failed"
it_comment_has_marker "${repo}" issue "${issue1}" "human-gate:po" \
  || fail "has_marker should detect notified marker"
if it_comment_has_marker "${repo}" issue "${issue1}" "missing-marker" 2>/dev/null; then
  fail "has_marker should not detect absent marker"
fi

# ----------------------------------------------------------------------------
# (7) Revision pin
# ----------------------------------------------------------------------------
pin_iss="$(it_revision_pin_get "${repo}" issue "${issue1}")"
[ -n "${pin_iss}" ] || fail "revision_pin_get issue empty"
pin_pr="$(it_revision_pin_get "${repo}" pr "${pr1}")"
[ -n "${pin_pr}" ] || fail "revision_pin_get pr empty"
pin_ms="$(it_revision_pin_get "${repo}" milestone "${ms}")"
[ -n "${pin_ms}" ] || fail "revision_pin_get milestone empty"
# kind aliases for issue: task / feature_request_issue must resolve identically.
pin_task="$(it_revision_pin_get "${repo}" task "${issue1}")"
[ "${pin_task}" = "${pin_iss}" ] || fail "revision_pin_get task should equal issue pin (got '${pin_task}' vs '${pin_iss}')"
pin_fr="$(it_revision_pin_get "${repo}" feature_request_issue "${issue1}")"
[ "${pin_fr}" = "${pin_iss}" ] || fail "revision_pin_get feature_request_issue should equal issue pin (got '${pin_fr}' vs '${pin_iss}')"

# ----------------------------------------------------------------------------
# (8) Progress with children
# ----------------------------------------------------------------------------
prog="$(it_milestone_get_progress "${repo}" "${ms}")"
# issue1 = open (TASK_IN_PROGRESS labels), issue2 = open, issue3 = closed.
# But issue3 has no milestone. Let me check: only issue1 and issue2 are linked to ms.
case "${prog}" in
  "open=2 closed=0") ;;
  *) fail "progress with children expected 'open=2 closed=0', got '${prog}'" ;;
esac

# ----------------------------------------------------------------------------
# (9) milestone_close
# ----------------------------------------------------------------------------
it_milestone_close "${repo}" "${ms}" || fail "milestone_close failed"
state="$(jq -r '.state' "${LLM_TEAM_INMEM_IT_DIR}/milestones/${ms}.json")"
[ "${state}" = "closed" ] || fail "milestone state after close expected closed, got '${state}'"

# After close, list_open should not include it.
open_after="$(it_milestone_list_open "${repo}" | tr '\n' ' ')"
[ "${open_after}" = "${ms2} " ] || fail "list_open after close expected '${ms2}', got '${open_after}'"

# ----------------------------------------------------------------------------
# (10b) Operational label add/remove (it_issue_add_label / it_issue_remove_label)
# ----------------------------------------------------------------------------
# issue3 starts with one label: "feature-request" (operational, non-state).
op_label_path="${LLM_TEAM_INMEM_IT_DIR}/issues/${issue3}.json"

# (a) Idempotent add: applying the same label twice keeps a single entry.
it_issue_add_label "${repo}" "${issue3}" "human-gate:cp" \
  || fail "it_issue_add_label first call failed"
it_issue_add_label "${repo}" "${issue3}" "human-gate:cp" \
  || fail "it_issue_add_label idempotent re-call failed"
hg_count="$(jq -r '[.labels[]? | select(. == "human-gate:cp")] | length' "${op_label_path}")"
[ "${hg_count}" = "1" ] \
  || fail "human-gate:cp should appear exactly once after duplicate add (got ${hg_count})"

# (b) Coexistence: original feature-request label is preserved.
jq -r '.labels[]? | select(. == "feature-request")' "${op_label_path}" \
  | grep -Fxq "feature-request" \
  || fail "original 'feature-request' label lost after add"

# (c) Add accepted/rejected pair: multiple operational labels can coexist.
it_issue_add_label "${repo}" "${issue3}" "feature-request:accepted" \
  || fail "it_issue_add_label accepted failed"
labels_count_after_add="$(jq -r '.labels | length' "${op_label_path}")"
[ "${labels_count_after_add}" = "3" ] \
  || fail "expected 3 labels after multi-add, got ${labels_count_after_add}"

# (d) Idempotent remove: removing the same label twice is fine.
it_issue_remove_label "${repo}" "${issue3}" "feature-request" \
  || fail "it_issue_remove_label first call failed"
it_issue_remove_label "${repo}" "${issue3}" "feature-request" \
  || fail "it_issue_remove_label idempotent re-call failed"
if jq -r '.labels[]?' "${op_label_path}" | grep -Fxq "feature-request"; then
  fail "feature-request label still present after remove"
fi
# Other labels untouched.
jq -r '.labels[]?' "${op_label_path}" | grep -Fxq "human-gate:cp" \
  || fail "human-gate:cp lost during unrelated remove"
jq -r '.labels[]?' "${op_label_path}" | grep -Fxq "feature-request:accepted" \
  || fail "feature-request:accepted lost during unrelated remove"

# (e) Remove non-existent label is a no-op (still 0).
it_issue_remove_label "${repo}" "${issue3}" "never-applied" \
  || fail "it_issue_remove_label of absent label should be no-op (rc=0)"

# (f) Operational labels must NOT collide with state labels managed by
#     it_issue_set_state. Add a task:* label via set_state and verify the
#     operational labels survive (responsibility-boundary check).
it_issue_set_state "${repo}" "${issue3}" TASK_PENDING \
  || fail "it_issue_set_state TASK_PENDING failed"
jq -r '.labels[]?' "${op_label_path}" | grep -Fxq "task:pending" \
  || fail "task:pending should be added by it_issue_set_state"
jq -r '.labels[]?' "${op_label_path}" | grep -Fxq "human-gate:cp" \
  || fail "operational label human-gate:cp should survive state-label set"

# (g) Argument validation.
if it_issue_add_label "${repo}" "" "feature-request" 2>/dev/null; then
  fail "it_issue_add_label with empty num should fail"
fi
if it_issue_remove_label "${repo}" "${issue3}" "" 2>/dev/null; then
  fail "it_issue_remove_label with empty label should fail"
fi
if it_issue_add_label "${repo}" "999999" "any-label" 2>/dev/null; then
  fail "it_issue_add_label on missing issue should fail"
fi

# ----------------------------------------------------------------------------
# (10) Isolation: nothing leaked into ${LLM_TEAM_ROOT}/workdir/<repo>
# ----------------------------------------------------------------------------
if [ -e "${LLM_TEAM_ROOT}/workdir/${repo}" ]; then
  fail "in_memory adapter should not write to workdir/${repo}"
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} issue_tracker in_memory check(s) failed" >&2
  exit 1
fi

echo "PASS: issue_tracker in_memory adapter (milestone/issue/PR/release/comment/signals/Phase1.5)"
