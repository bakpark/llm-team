#!/usr/bin/env bash
# tests/application/test-feature-request.sh
#
# Phase 3 — application/feature_request.sh 단위 테스트.
#
# 검증:
#   1. feature-request 라벨 issue 가 2건 시드되어 있을 때, feature_request_promote
#      는 oldest-first 로 1건만 처리한다 (number 비교).
#   2. 처리 결과: milestone 이 PO_DRAFT 로 생성되고, issue 가 milestone 에 링크되며,
#      라벨이 feature-request:accepted 로 전이된다.
#   3. 두 번째 호출은 두 번째 issue 를 처리한다.
#   4. 세 번째 호출은 비0 (남은 미처리 issue 없음).
#   5. 멱등성: 이미 promote 된 issue 가 다시 list 에 등장할 일이 없도록
#      (--no-milestone 으로 거름) — 추가 호출 시 부작용 없음을 재확인.
#
# Adapter: in_memory issue_tracker (worker-3 의 #5 산출물).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# 격리: 자체 in_memory issue_tracker 디렉토리.
INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-feat-req-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${INMEM_IT_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER="in_memory"
export TARGET_NAME="feature-request-test"
export TARGET_LABEL_PREFIX=""

cleanup() { rm -rf "${INMEM_IT_DIR}" 2>/dev/null || true; }
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/feature_request.sh
. "${LLM_TEAM_ROOT}/application/feature_request.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

REPO="feature-request-test/repo"

# ----------------------------------------------------------------------------
# Seed: 2 issues with feature-request label, no milestone, plus 1 unrelated.
# ----------------------------------------------------------------------------
issue_a="$(it_issue_create "${REPO}" \
  --title "feat A" --body "feature A details" \
  --labels "${LABEL_FEATURE_REQUEST}" 2>/dev/null)" \
  || fail "seed: it_issue_create A failed"
sleep 1   # ensure created_at differs (in_memory 은 1초 단위)
issue_b="$(it_issue_create "${REPO}" \
  --title "feat B" --body "feature B details" \
  --labels "${LABEL_FEATURE_REQUEST}" 2>/dev/null)" \
  || fail "seed: it_issue_create B failed"

# unrelated: no feature-request label — 처리 대상에 들어가면 안 된다.
issue_c="$(it_issue_create "${REPO}" \
  --title "unrelated" --body "no fr label" \
  --labels "task:pending" 2>/dev/null)" \
  || fail "seed: it_issue_create C failed"

[ "${issue_a}" != "${issue_b}" ] && [ "${issue_b}" != "${issue_c}" ] \
  || fail "seed: distinct issue numbers required"

# ----------------------------------------------------------------------------
# (1) First promote — oldest-first picks issue_a.
# ----------------------------------------------------------------------------
out1="$(feature_request_promote "${REPO}")" \
  || fail "first feature_request_promote failed (rc=$?)"
read -r picked_issue1 picked_ms1 <<<"${out1}"
[ "${picked_issue1}" = "${issue_a}" ] \
  || fail "first promote should pick oldest issue (expected '${issue_a}', got '${picked_issue1}')"
[ -n "${picked_ms1}" ] \
  || fail "first promote did not emit milestone number"

# milestone state must be PO_DRAFT
ms_state1="$(it_milestone_get_state "${REPO}" "${picked_ms1}")" \
  || fail "it_milestone_get_state failed for ms #${picked_ms1}"
[ "${ms_state1}" = "PO_DRAFT" ] \
  || fail "milestone #${picked_ms1} state expected PO_DRAFT, got '${ms_state1}'"

# milestone link
got_link1="$(it_issue_get_milestone "${REPO}" "${picked_issue1}")"
[ "${got_link1}" = "${picked_ms1}" ] \
  || fail "issue #${picked_issue1} milestone expected '${picked_ms1}', got '${got_link1}'"

# label transition: accepted added, feature-request removed
labels_a="$(jq -r '.labels[]?' "${INMEM_IT_DIR}/issues/${picked_issue1}.json")"
echo "${labels_a}" | grep -Fxq "${LABEL_FEATURE_REQUEST_ACCEPTED}" \
  || fail "issue #${picked_issue1} should have label '${LABEL_FEATURE_REQUEST_ACCEPTED}'"
if echo "${labels_a}" | grep -Fxq "${LABEL_FEATURE_REQUEST}"; then
  fail "issue #${picked_issue1} should no longer have raw '${LABEL_FEATURE_REQUEST}' label"
fi

# ----------------------------------------------------------------------------
# (2) Second promote — picks issue_b.
# ----------------------------------------------------------------------------
out2="$(feature_request_promote "${REPO}")" \
  || fail "second feature_request_promote failed (rc=$?)"
read -r picked_issue2 picked_ms2 <<<"${out2}"
[ "${picked_issue2}" = "${issue_b}" ] \
  || fail "second promote should pick '${issue_b}', got '${picked_issue2}'"
[ "${picked_ms2}" != "${picked_ms1}" ] \
  || fail "second promote must create a distinct milestone"

# ----------------------------------------------------------------------------
# (3) Third promote — no remaining feature-request issues without milestone.
# ----------------------------------------------------------------------------
set +e
out3="$(feature_request_promote "${REPO}" 2>/dev/null)"
rc3=$?
set -e
[ "${rc3}" -ne 0 ] \
  || fail "third promote should return non-zero (no remaining issues)"
[ -z "${out3}" ] \
  || fail "third promote should produce empty stdout, got '${out3}'"

# ----------------------------------------------------------------------------
# (4) Idempotency: re-running does not affect already-promoted issues.
# ----------------------------------------------------------------------------
ms_state_recheck="$(it_milestone_get_state "${REPO}" "${picked_ms1}")"
[ "${ms_state_recheck}" = "PO_DRAFT" ] \
  || fail "milestone state unstable after extra promote calls"
got_link_recheck="$(it_issue_get_milestone "${REPO}" "${picked_issue1}")"
[ "${got_link_recheck}" = "${picked_ms1}" ] \
  || fail "issue→milestone link unstable after extra promote calls"

# ----------------------------------------------------------------------------
# (5) Unrelated issue (issue_c) was not touched.
# ----------------------------------------------------------------------------
got_c_link="$(it_issue_get_milestone "${REPO}" "${issue_c}" || true)"
[ -z "${got_c_link}" ] \
  || fail "unrelated issue #${issue_c} should not be linked to a milestone (got '${got_c_link}')"

# ----------------------------------------------------------------------------
# (6) Empty repo argument → return non-zero (rc=2).
# ----------------------------------------------------------------------------
set +e
feature_request_promote "" >/dev/null 2>&1
rc_empty=$?
set -e
[ "${rc_empty}" -ne 0 ] \
  || fail "feature_request_promote with empty repo should fail"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} feature_request_promote check(s) failed" >&2
  exit 1
fi

echo "PASS: feature_request_promote (oldest-first; PO_DRAFT milestone; label transition; idempotent)"
