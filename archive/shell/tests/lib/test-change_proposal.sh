#!/usr/bin/env bash
# tests/lib/test-change_proposal.sh
#
# 검증:
#   1. change_proposal_create → CP_DRAFT 발행 + 파일 존재.
#   2. change_proposal_load → JSON body 출력 + 잘못된 path 비0.
#   3. change_proposal_get_state → 현재 state 반환.
#   4. change_proposal_set_state:
#        a) 정상 전이 (no old_state) → state 변경 + updated_at 추가.
#        b) old_state 일치 시 전이 성공.
#        c) old_state 불일치 시 비0 반환 + state 미변경.
#        d) 동일 new_state 멱등 (no-op + 0).
#        e) 잘못된 state 거부.
#   5. change_proposal_set_pr_link → .pr_number 필드 set, 멱등.
#   6. change_proposal_load 가 set_state / set_pr_link 결과를 그대로 반영.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# Use a unique target so the test does not collide with workdir/<other>.
target="cp-test-$$"
cp_dir="$(change_proposal_dir "${target}")"

cleanup() {
  rm -rf "${LLM_TEAM_ROOT}/workdir/${target}" 2>/dev/null || true
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
# (1) create
# ----------------------------------------------------------------------------
cp_path="$(change_proposal_create "${target}" Code coder Implement T-1 "branch:llm-team/T-1")" \
  || fail "change_proposal_create failed"
[ -f "${cp_path}" ] || fail "change_proposal_create did not produce file"

state="$(change_proposal_get_state "${cp_path}")" \
  || fail "change_proposal_get_state failed for fresh CP"
[ "${state}" = "CP_DRAFT" ] || fail "fresh CP state expected CP_DRAFT, got '${state}'"

# ----------------------------------------------------------------------------
# (2) load
# ----------------------------------------------------------------------------
loaded="$(change_proposal_load "${cp_path}")" || fail "change_proposal_load failed"
[ "$(printf '%s' "${loaded}" | jq -r '.cp_kind')" = "Code" ] \
  || fail "loaded CP cp_kind != 'Code'"
[ "$(printf '%s' "${loaded}" | jq -r '.target_id')" = "T-1" ] \
  || fail "loaded CP target_id != 'T-1'"

if change_proposal_load "${cp_dir}/does-not-exist.json" 2>/dev/null; then
  fail "change_proposal_load should fail for missing file"
fi

# ----------------------------------------------------------------------------
# (3) set_state — 정상 전이 (no old_state)
# ----------------------------------------------------------------------------
change_proposal_set_state "${cp_path}" CP_READY_FOR_REVIEW \
  || fail "set_state CP_DRAFT → CP_READY_FOR_REVIEW failed"
[ "$(change_proposal_get_state "${cp_path}")" = "CP_READY_FOR_REVIEW" ] \
  || fail "state not updated to CP_READY_FOR_REVIEW"
[ "$(jq -r '.updated_at // empty' "${cp_path}")" != "" ] \
  || fail "updated_at not set after set_state"

# ----------------------------------------------------------------------------
# (4) set_state — old_state 일치
# ----------------------------------------------------------------------------
change_proposal_set_state "${cp_path}" CP_REQUEST_CHANGES CP_READY_FOR_REVIEW \
  || fail "set_state with matching old_state failed"
[ "$(change_proposal_get_state "${cp_path}")" = "CP_REQUEST_CHANGES" ] \
  || fail "state not updated to CP_REQUEST_CHANGES"

# ----------------------------------------------------------------------------
# (5) set_state — old_state 불일치 거부
# ----------------------------------------------------------------------------
if change_proposal_set_state "${cp_path}" CP_CLOSED CP_DRAFT 2>/dev/null; then
  fail "set_state should reject mismatching old_state"
fi
# state must remain CP_REQUEST_CHANGES
[ "$(change_proposal_get_state "${cp_path}")" = "CP_REQUEST_CHANGES" ] \
  || fail "state should not change on mismatching old_state"

# ----------------------------------------------------------------------------
# (6) set_state — 멱등 (동일 new_state, no-op)
# ----------------------------------------------------------------------------
change_proposal_set_state "${cp_path}" CP_REQUEST_CHANGES \
  || fail "set_state same-state should be no-op (rc=0)"
# Even with mismatching old_state, idempotent path returns 0 if already at new_state.
change_proposal_set_state "${cp_path}" CP_REQUEST_CHANGES CP_DRAFT \
  || fail "set_state idempotent with mismatching old_state should still succeed"

# ----------------------------------------------------------------------------
# (7) set_state — 잘못된 state 거부
# ----------------------------------------------------------------------------
if change_proposal_set_state "${cp_path}" NOT_A_STATE 2>/dev/null; then
  fail "set_state should reject invalid CP state"
fi
if change_proposal_set_state "${cp_path}" TASK_READY 2>/dev/null; then
  fail "set_state should reject non-CP state ('TASK_READY')"
fi

# ----------------------------------------------------------------------------
# (8) set_pr_link
# ----------------------------------------------------------------------------
change_proposal_set_pr_link "${cp_path}" 42 || fail "set_pr_link failed"
[ "$(jq -r '.pr_number' "${cp_path}")" = "42" ] || fail "pr_number not set to 42"
# Idempotent re-set
change_proposal_set_pr_link "${cp_path}" 42 || fail "set_pr_link re-apply failed"
[ "$(jq -r '.pr_number' "${cp_path}")" = "42" ] || fail "pr_number changed on re-apply"

# ----------------------------------------------------------------------------
# (9) load reflects set_state + set_pr_link results
# ----------------------------------------------------------------------------
final="$(change_proposal_load "${cp_path}")" || fail "final load failed"
[ "$(printf '%s' "${final}" | jq -r '.state')" = "CP_REQUEST_CHANGES" ] \
  || fail "final loaded state != CP_REQUEST_CHANGES"
[ "$(printf '%s' "${final}" | jq -r '.pr_number')" = "42" ] \
  || fail "final loaded pr_number != 42"

# ----------------------------------------------------------------------------
# (10) get_state on missing path
# ----------------------------------------------------------------------------
if change_proposal_get_state "${cp_dir}/missing.json" 2>/dev/null; then
  fail "get_state should fail for missing file"
fi

# ----------------------------------------------------------------------------
# (11) Empty/missing-state JSON: get_state returns non-zero with empty stdout
# ----------------------------------------------------------------------------
empty_path="${cp_dir}/empty.json"
mkdir -p "${cp_dir}"
echo '{"change_proposal_id":"x"}' >"${empty_path}"
if change_proposal_get_state "${empty_path}" >/dev/null 2>&1; then
  fail "get_state should fail when state field absent"
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} change_proposal check(s) failed" >&2
  exit 1
fi

echo "PASS: change_proposal lifecycle (create → load → get_state → set_state → set_pr_link)"
