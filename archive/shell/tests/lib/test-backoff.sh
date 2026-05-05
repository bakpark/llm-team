#!/usr/bin/env bash
# tests/lib/test-backoff.sh
#
# lib/backoff.sh 검증.
#
# Coverage:
#   1. attempt 가 클수록 지연이 단조 증가 (max cap 도달 전까지).
#   2. max cap 적용: 큰 attempt 도 max + jitter(<= 30%) 를 넘지 않음.
#   3. 잘못된 인자 → return 2.
#   4. base=1, max=1 이면 항상 1초 (jitter 가 1초 미만이라 ceil 후 1).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../lib/backoff.sh
. "${LLM_TEAM_ROOT}/lib/backoff.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# Helper: time backoff_sleep <attempt> <base> <max>, return elapsed seconds (rounded up).
measure() {
  local attempt="$1" base="$2" max="$3"
  local start end
  start="$(date +%s)"
  backoff_sleep "${attempt}" "${base}" "${max}"
  end="$(date +%s)"
  echo $(( end - start ))
}

# (3) 잘못된 인자
if backoff_sleep abc 1 5 2>/dev/null; then
  fail "(3) non-integer attempt should return non-zero"
fi
if backoff_sleep 0 -1 5 2>/dev/null; then
  fail "(3) negative base should return non-zero"
fi

# (4) base=1, max=1 → ~1s (정확히 1, jitter 가 1초 미만이라 ceil 후 1)
elapsed="$(measure 0 1 1)"
[ "${elapsed}" -ge 1 ] && [ "${elapsed}" -le 2 ] \
  || fail "(4) base=1 max=1 expected 1-2s, got ${elapsed}s"

# (1) 단조 증가: attempt=0 vs attempt=2 (base=1 max=8 → 1s vs 4s 기대치)
e0="$(measure 0 1 8)"
e2="$(measure 2 1 8)"
[ "${e2}" -ge "${e0}" ] \
  || fail "(1) expected attempt=2 (${e2}s) >= attempt=0 (${e0}s)"

# (2) max cap: attempt=10 (base=1 → naive 1024s) but capped at max=2 → 2~3s 정도
elapsed="$(measure 10 1 2)"
[ "${elapsed}" -ge 2 ] && [ "${elapsed}" -le 4 ] \
  || fail "(2) max=2 cap expected 2-4s, got ${elapsed}s"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} backoff check(s) failed" >&2
  exit 1
fi

echo "PASS: lib/backoff.sh (monotonic + cap + arg validation)"
