#!/usr/bin/env bash
# tests/lib/test-ledger.sh
#
# lib/ledger.sh 검증.
#
# Coverage:
#   1. ledger_count_recent_errors: 같은 (kind,id,op) error 가 연속 N회면 N 반환.
#   2. 중간에 비-error 같은 (kind,id,op) 가 있으면 카운트 리셋 (그 이후 연속만).
#   3. 다른 object/op row 는 무시 (skip, 카운트에 영향 없음).
#   4. ledger 파일 없으면 0 반환.
#   5. 인자 부족 → return 2.
#   6. window 범위 (tail N) 안에서만 검사.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET="ledger-test"
LEDGER_DIR="${LLM_TEAM_ROOT}/workdir/${TARGET}/ledger"
LEDGER_PATH="${LEDGER_DIR}/transitions.jsonl"

cleanup() {
  rm -rf "${LLM_TEAM_ROOT}/workdir/${TARGET}" 2>/dev/null || true
}
trap cleanup EXIT
cleanup

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../lib/ledger.sh
. "${LLM_TEAM_ROOT}/lib/ledger.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# Helper: append a synthetic ledger row (skips full validator schema).
# Sufficient for count_recent_errors which only reads object_kind/id/operation/result.
append_row() {
  local kind="$1" id="$2" op="$3" result="$4"
  mkdir -p "${LEDGER_DIR}"
  jq -nc \
    --arg k "${kind}" --arg i "${id}" --arg o "${op}" --arg r "${result}" \
    '{object_kind:$k, object_id:$i, operation:$o, result:$r}' \
    >>"${LEDGER_PATH}"
}

# (4) 파일 없을 때 0
got="$(ledger_count_recent_errors "${TARGET}" issue 24 Implement 50)"
[ "${got}" = "0" ] || fail "no-file expected 0, got '${got}'"

# (5) 인자 부족
if ledger_count_recent_errors "${TARGET}" issue 24 "" 50 2>/dev/null; then
  fail "missing operation should return non-zero"
fi

# (1) 연속 3회 error
append_row issue 24 Implement error
append_row issue 24 Implement error
append_row issue 24 Implement error
got="$(ledger_count_recent_errors "${TARGET}" issue 24 Implement 50)"
[ "${got}" = "3" ] || fail "(1) expected 3, got '${got}'"

# (3) 다른 object/op row 가 끼어도 영향 없음 (skip)
append_row milestone 7 Compose-PM applied
append_row issue 30 Implement error
got="$(ledger_count_recent_errors "${TARGET}" issue 24 Implement 50)"
[ "${got}" = "3" ] || fail "(3) unrelated rows should be skipped, expected 3 still, got '${got}'"

# (2) 같은 (kind,id,op) 의 비-error 가 끼면 카운트 리셋, 그 후 연속만 카운트
append_row issue 24 Implement applied
got="$(ledger_count_recent_errors "${TARGET}" issue 24 Implement 50)"
[ "${got}" = "0" ] || fail "(2) applied resets counter, expected 0, got '${got}'"

append_row issue 24 Implement error
append_row issue 24 Implement error
got="$(ledger_count_recent_errors "${TARGET}" issue 24 Implement 50)"
[ "${got}" = "2" ] || fail "(2) after reset, expected 2 errors, got '${got}'"

# (6) window=2: 마지막 2 row 안에서만 검사 → 마지막 2건이 모두 issue 24 error 이지만
#     (마지막 row 가 issue 24 Implement error, 직전 row 도 issue 24 Implement error) 2 회
got="$(ledger_count_recent_errors "${TARGET}" issue 24 Implement 2)"
[ "${got}" = "2" ] || fail "(6) window=2 expected 2, got '${got}'"

# (6 cont) window=1: 마지막 1 row 만 → 1
got="$(ledger_count_recent_errors "${TARGET}" issue 24 Implement 1)"
[ "${got}" = "1" ] || fail "(6) window=1 expected 1, got '${got}'"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} ledger check(s) failed" >&2
  exit 1
fi

echo "PASS: lib/ledger.sh (ledger_count_recent_errors)"
