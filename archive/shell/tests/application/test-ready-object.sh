#!/usr/bin/env bash
# tests/application/test-ready-object.sh
#
# application/ready_object.sh 단위 검증.
#
# 검증 항목:
#   1. PO: feature-request issue (milestone 미연결) > PO_DRAFT milestone 우선순위.
#   2. PM/Planner/Integrator/QA: 각 단일 milestone state 픽업.
#   3. Coder: TASK_READY 2건. blocker 가 미충족인 첫 번째는 skip,
#      blocker 가 모두 TASK_INTEGRATED 인 두 번째 픽업.
#   4. Coder oldest-first: 두 건 모두 충족 가능한 경우 oldest 가 픽업.
#   5. Reviewer: TASK_REVIEW_READY oldest 픽업.
#   6. 후보 없음: 모든 시드가 비어있는 상태에서 비0 반환 + stdout 빈값.
#   7. 출력 포맷: `<object_kind>\t<object_id>` 단일 라인.
#   8. 잘못된 role → 비0 (return 2).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# 격리 in_memory 백엔드.
INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ro-it-XXXXXX")"
INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ro-ps-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${INMEM_IT_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER="in_memory"
export LLM_TEAM_ADAPTER_PERSISTENT_STORE="in_memory"
export TARGET_NAME="ready-object-test"
export TARGET_LABEL_PREFIX=""

cleanup() {
  rm -rf "${INMEM_IT_DIR}" "${INMEM_PS_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/ready_object.sh
. "${LLM_TEAM_ROOT}/application/ready_object.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

REPO="ready-object-test/repo"

# Helper: assert pick result; arg1=role, arg2=expected_kind, arg3=expected_id.
assert_pick_eq() {
  local role="$1" exp_kind="$2" exp_id="$3"
  local out
  out="$(ready_object_pick "${role}" "${REPO}" 2>/dev/null)" \
    || { fail "ready_object_pick(${role}) returned non-zero (expected '${exp_kind}\t${exp_id}')"; return; }
  local got_kind got_id
  got_kind="$(printf '%s' "${out}" | awk -F'\t' '{print $1}')"
  got_id="$(printf '%s' "${out}" | awk -F'\t' '{print $2}' | tr -d '\n')"
  [ "${got_kind}" = "${exp_kind}" ] && [ "${got_id}" = "${exp_id}" ] \
    || fail "ready_object_pick(${role}): expected '${exp_kind}\t${exp_id}', got '${got_kind}\t${got_id}'"
}

# Helper: assert pick returns no candidate (non-zero, empty stdout).
assert_pick_none() {
  local role="$1"
  local out rc
  out="$(ready_object_pick "${role}" "${REPO}" 2>/dev/null)"; rc=$?
  [ "${rc}" -ne 0 ] || fail "ready_object_pick(${role}): expected non-zero when no candidate"
  [ -z "${out}" ] || fail "ready_object_pick(${role}): expected empty stdout when no candidate, got '${out}'"
}

# ----------------------------------------------------------------------------
# (8) Argument / role validation: invalid role → return 2 (non-zero)
# ----------------------------------------------------------------------------
if ready_object_pick BadRole "${REPO}" 2>/dev/null; then
  fail "ready_object_pick: invalid role should return non-zero"
fi
if ready_object_pick PO "" 2>/dev/null; then
  fail "ready_object_pick: empty repo should return non-zero"
fi

# ----------------------------------------------------------------------------
# (6) 빈 시드 — 모든 role 에 대해 후보 없음
# ----------------------------------------------------------------------------
for role in PO PM Planner Coder Reviewer Integrator QA; do
  assert_pick_none "${role}"
done

# ----------------------------------------------------------------------------
# Seed common state.
# ----------------------------------------------------------------------------

# (PO) feature-request issue without milestone — created first to ensure
# oldest-first deterministically picks it over later items.
fr_issue="$(it_issue_create "${REPO}" \
  --title "feat-x" --body "" \
  --labels "feature-request" \
  2>/dev/null)"
[ -n "${fr_issue}" ] || fail "seed: feature-request issue create"

# (PO) Also seed a PO_DRAFT milestone — fr_issue must take precedence.
po_ms="$(it_milestone_create "${REPO}" "po-ms" "po milestone body" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${po_ms}" PO_DRAFT >/dev/null

# (PM/Planner/Integrator/QA) one milestone each in target state.
pm_ms="$(it_milestone_create "${REPO}" "pm-ms" "pm body" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${pm_ms}" PM_DRAFT >/dev/null

planner_ms="$(it_milestone_create "${REPO}" "planner-ms" "planner body" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${planner_ms}" DECOMPOSE_READY >/dev/null

integ_ms="$(it_milestone_create "${REPO}" "integ-ms" "integ body" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${integ_ms}" REFACTOR_READY >/dev/null

qa_ms="$(it_milestone_create "${REPO}" "qa-ms" "qa body" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${qa_ms}" VALIDATE_READY >/dev/null

# (Reviewer) one TASK_REVIEW_READY issue.
review_issue="$(it_issue_create "${REPO}" --title "rev-task" --body "" 2>/dev/null)"
it_issue_set_state "${REPO}" "${review_issue}" TASK_REVIEW_READY >/dev/null

# (Coder) Two TASK_READY issues:
#   coder_a: blocker = TASK_PENDING issue (not yet integrated) → must skip.
#   coder_b: blocker = TASK_INTEGRATED issue → must pick.
blocker_pending="$(it_issue_create "${REPO}" --title "blocker-pending" --body "" 2>/dev/null)"
it_issue_set_state "${REPO}" "${blocker_pending}" TASK_PENDING >/dev/null

blocker_integrated="$(it_issue_create "${REPO}" --title "blocker-integrated" --body "" 2>/dev/null)"
it_issue_set_state "${REPO}" "${blocker_integrated}" TASK_INTEGRATED >/dev/null

coder_a="$(it_issue_create "${REPO}" --title "coder-a" --body "" 2>/dev/null)"
it_issue_set_state "${REPO}" "${coder_a}" TASK_READY >/dev/null
it_issue_set_blocked_by "${REPO}" "${coder_a}" "${blocker_pending}" >/dev/null

coder_b="$(it_issue_create "${REPO}" --title "coder-b" --body "" 2>/dev/null)"
it_issue_set_state "${REPO}" "${coder_b}" TASK_READY >/dev/null
it_issue_set_blocked_by "${REPO}" "${coder_b}" "${blocker_integrated}" >/dev/null

# ----------------------------------------------------------------------------
# (1) PO: PO_DRAFT milestone 만 픽업한다. feature_request_issue 는 promote 단
#     계 책임이며, _caller_apply_spec_proposal 가 milestone target 만 적용
#     가능하므로 raw issue 를 픽업하면 항상 apply 실패였다 — 픽업 단계에서 차단.
# ----------------------------------------------------------------------------
assert_pick_eq PO milestone "${po_ms}"

# feature-request issue 가 promote 되어 milestone 에 링크되어도 동일하게 PO_DRAFT
# milestone 이 픽업된다 (intake 단계 자체가 picker 책임이 아님).
it_issue_link_to_milestone "${REPO}" "${fr_issue}" "${po_ms}" >/dev/null
assert_pick_eq PO milestone "${po_ms}"

# ----------------------------------------------------------------------------
# (2) PM / Planner / Integrator / QA single-milestone pickup.
# ----------------------------------------------------------------------------
assert_pick_eq PM         milestone "${pm_ms}"
assert_pick_eq Planner    milestone "${planner_ms}"
assert_pick_eq Integrator milestone "${integ_ms}"
assert_pick_eq QA         milestone "${qa_ms}"

# ----------------------------------------------------------------------------
# (3) Coder: blocker 미충족 issue 는 skip, 충족된 두 번째 issue 가 픽업.
# ----------------------------------------------------------------------------
assert_pick_eq Coder issue "${coder_b}"

# (4) oldest-first: blocker 충족된 issue 가 두 개일 때, 더 오래된 것이 픽업.
#   blocker_pending 을 TASK_INTEGRATED 로 전이시켜 coder_a 도 충족 → coder_a (oldest).
it_issue_set_state "${REPO}" "${blocker_pending}" TASK_INTEGRATED TASK_PENDING >/dev/null
assert_pick_eq Coder issue "${coder_a}"

# ----------------------------------------------------------------------------
# (5) Reviewer: TASK_REVIEW_READY issue 픽업.
# ----------------------------------------------------------------------------
assert_pick_eq Reviewer issue "${review_issue}"

# ----------------------------------------------------------------------------
# (7) Output format: 출력은 정확히 한 줄 + 탭 구분 2 필드.
# ----------------------------------------------------------------------------
out="$(ready_object_pick PM "${REPO}" 2>/dev/null)"
# command substitution 은 trailing \n 을 제거하므로, 캡처된 결과는 임베드된
# 개행이 없는 단일 라인이어야 한다.
case "${out}" in
  *$'\n'*) fail "output must be a single line (no embedded newline), got '${out}'" ;;
esac
field_count="$(printf '%s' "${out}" | awk -F'\t' '{print NF}')"
[ "${field_count}" = "2" ] \
  || fail "output should be tab-separated 2 fields (got NF=${field_count})"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} ready_object check(s) failed" >&2
  exit 1
fi

echo "PASS: application/ready_object.sh (PO/PM/Planner/Coder/Reviewer/Integrator/QA pickup + oldest-first + dependency check)"
