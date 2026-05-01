#!/usr/bin/env bash
# tests/lib/test-gh-retry.sh — verify gh_with_retry's 3-attempt back-off.
#
# Strategy:
#   • Override GH_RETRY_DELAY_{1,2,3} to small values (1s/2s/3s) so the test
#     finishes quickly while still exercising real `sleep` calls.
#   • Wrap `false` (always exits 1) so the retry loop runs to exhaustion.
#   • Assert: non-zero return, ≥ 3 seconds elapsed, and 3 retry log entries on
#     stderr (one per attempt).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

export GH_RETRY_DELAY_1=1
export GH_RETRY_DELAY_2=2
export GH_RETRY_DELAY_3=3

stderr_log="$(mktemp)"
cleanup() { rm -f "${stderr_log}"; }
trap cleanup EXIT

start=$(date -u +%s)
if gh_with_retry false 2> "${stderr_log}"; then
  echo "FAIL: gh_with_retry should fail when wrapped command always fails" >&2
  cat "${stderr_log}" >&2
  exit 1
fi
end=$(date -u +%s)

elapsed=$(( end - start ))

# Two sleeps (after attempts 1 and 2) → at least 1 + 2 = 3 seconds total.
if [ "${elapsed}" -lt 3 ]; then
  echo "FAIL: gh_with_retry returned in ${elapsed}s; expected ≥3s of back-off" >&2
  cat "${stderr_log}" >&2
  exit 1
fi

retry_count="$(grep -c 'gh_with_retry: attempt' "${stderr_log}" || true)"
if [ "${retry_count}" -lt 3 ]; then
  echo "FAIL: expected 3 'attempt' log entries, got ${retry_count}" >&2
  cat "${stderr_log}" >&2
  exit 1
fi

# Spot-check that the configured delays were logged.
if ! grep -q 'retrying in 1s' "${stderr_log}"; then
  echo "FAIL: expected 'retrying in 1s' on first failure" >&2
  cat "${stderr_log}" >&2
  exit 1
fi
if ! grep -q 'retrying in 2s' "${stderr_log}"; then
  echo "FAIL: expected 'retrying in 2s' on second failure" >&2
  cat "${stderr_log}" >&2
  exit 1
fi

echo "PASS: gh_with_retry retried 3 times with back-off (elapsed=${elapsed}s)"
