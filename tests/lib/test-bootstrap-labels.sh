#!/usr/bin/env bash
# tests/lib/test-bootstrap-labels.sh
#
# 검증:
#   1. scripts/bootstrap-labels.sh --dry-run 출력에
#      신규 운영 라벨(feature-request*, human-gate:*, paused) 이 모두 포함된다.
#   2. 기존 task:* / cp:* 라벨이 회귀 없이 출력에 남아있다.
#   3. dry-run 종료코드는 0, count 요약 라인이 함께 출력된다.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../_helpers/ephemeral_target.sh
. "${LLM_TEAM_ROOT}/tests/_helpers/ephemeral_target.sh"
TARGET="$(ephemeral_target_create bootstrap-labels-$$)"

stdout_log="$(mktemp)"
stderr_log="$(mktemp)"
cleanup() {
  rm -f "${stdout_log}" "${stderr_log}"
  ephemeral_target_cleanup "${TARGET}"
}
trap cleanup EXIT

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

set +e
bash "${LLM_TEAM_ROOT}/scripts/bootstrap-labels.sh" "${TARGET}" --dry-run \
  >"${stdout_log}" 2>"${stderr_log}"
rc=$?
set -e

if [ "${rc}" -ne 0 ]; then
  echo "FAIL: bootstrap-labels.sh --dry-run exited with rc=${rc}" >&2
  echo "--- stdout ---" >&2; cat "${stdout_log}" >&2
  echo "--- stderr ---" >&2; cat "${stderr_log}" >&2
  exit 1
fi

# (1) Operational labels appear (Phase 1 additions).
for needle in \
    "feature-request " \
    "feature-request:accepted" \
    "feature-request:rejected" \
    "human-gate:po" \
    "human-gate:pm" \
    "human-gate:cp" \
    "paused"; do
  if ! grep -Fq "${needle}" "${stdout_log}"; then
    fail "operational label not found in dry-run output: '${needle}'"
  fi
done

# (2) Existing task:* / cp:* labels survive (regression).
for needle in \
    "task:pending" \
    "task:ready" \
    "task:in-progress" \
    "task:review-ready" \
    "task:review-in-progress" \
    "task:integrated" \
    "task:rejected" \
    "task:escalated" \
    "cp:ready-for-human-gate" \
    "cp:ready-for-review" \
    "cp:ready-for-verification" \
    "cp:stale"; do
  if ! grep -Fq "${needle}" "${stdout_log}"; then
    fail "existing label missing from dry-run output: '${needle}'"
  fi
done

# (3) Each emitted label line carries a hex color marker.
emitted_lines="$(grep -c 'color=#' "${stdout_log}" || true)"
[ "${emitted_lines}" -ge 19 ] \
  || fail "expected at least 19 label lines (8 task + 4 cp + 7 ops); got ${emitted_lines}"

# (4) Summary footer present.
grep -Fq "Dry run:" "${stdout_log}" \
  || fail "dry-run summary line missing"

# (5) Human-gate labels carry the purple color (8957e5) per spec.
for hg in human-gate:po human-gate:pm human-gate:cp; do
  if ! grep -E "^${hg}[[:space:]]+color=#8957e5" "${stdout_log}" >/dev/null; then
    fail "human-gate label '${hg}' should map to color #8957e5"
  fi
done

# (6) paused label uses gray color (cccccc).
if ! grep -E "^paused[[:space:]]+color=#cccccc" "${stdout_log}" >/dev/null; then
  fail "paused label should map to color #cccccc"
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} bootstrap-labels check(s) failed" >&2
  echo "--- stdout ---" >&2; cat "${stdout_log}" >&2
  exit 1
fi

echo "PASS: bootstrap-labels --dry-run includes operational labels and preserves existing ones"
