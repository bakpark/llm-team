#!/usr/bin/env bash
# tests/application/test-knowledge.sh
#
# application/knowledge.sh 단위 검증.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/knowledge.sh
. "${LLM_TEAM_ROOT}/application/knowledge.sh"

TEST_TARGET="knowledge-test-$$-${RANDOM}"
KNOWLEDGE_ROOT="${LLM_TEAM_ROOT}/workdir/${TEST_TARGET}/knowledge"

cleanup() {
  rm -rf "${LLM_TEAM_ROOT}/workdir/${TEST_TARGET}" 2>/dev/null || true
}
trap cleanup EXIT

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# Test 1: decision_log append-only
# ----------------------------------------------------------------------------
DECISION1='{"decision_id":"d1","decision":"a","rationale":"because"}'
knowledge_record_decision "${TEST_TARGET}" "${DECISION1}" \
  || fail "knowledge_record_decision failed"
LOG="${KNOWLEDGE_ROOT}/decision-log.jsonl"
[ -f "${LOG}" ] || fail "decision log file not created"
[ "$(wc -l <"${LOG}")" -eq 1 ] || fail "expected 1 line, got $(wc -l <"${LOG}")"
# decided_at must be auto-filled.
ts1="$(jq -r '.decided_at' "${LOG}")"
[ -n "${ts1}" ] || fail "decided_at not auto-filled"
# decision_id round-trips.
[ "$(jq -r '.decision_id' "${LOG}")" = "d1" ] || fail "decision_id mismatch"

# Second append.
DECISION2='{"decision_id":"d2","decision":"b","decided_at":"2026-01-01T00:00:00Z"}'
knowledge_record_decision "${TEST_TARGET}" "${DECISION2}" \
  || fail "second decision append failed"
[ "$(wc -l <"${LOG}")" -eq 2 ] || fail "expected 2 lines after second append"
# Existing decided_at preserved.
ts2="$(tail -n 1 "${LOG}" | jq -r '.decided_at')"
[ "${ts2}" = "2026-01-01T00:00:00Z" ] || fail "decided_at overwritten when already set"

# ----------------------------------------------------------------------------
# Test 2: context_summary idempotent (write-once per milestone)
# ----------------------------------------------------------------------------
knowledge_snapshot_context_summary "${TEST_TARGET}" "42" "first summary" \
  || fail "context_summary write failed"
SUM_PATH="${KNOWLEDGE_ROOT}/context-summaries/42.json"
[ -f "${SUM_PATH}" ] || fail "context-summary file not created"
[ "$(jq -r '.summary' "${SUM_PATH}")" = "first summary" ] \
  || fail "summary content mismatch"

# Second call must NOT overwrite (idempotent — first summary wins).
knowledge_snapshot_context_summary "${TEST_TARGET}" "42" "different summary" \
  || fail "second context_summary call must succeed (idempotent)"
[ "$(jq -r '.summary' "${SUM_PATH}")" = "first summary" ] \
  || fail "context-summary unexpectedly overwritten"

# Empty inputs are best-effort: should not fail, should not create files.
knowledge_snapshot_context_summary "${TEST_TARGET}" "43" "" \
  || fail "empty summary call should return 0"
[ ! -f "${KNOWLEDGE_ROOT}/context-summaries/43.json" ] \
  || fail "empty summary should not create a file"

# ----------------------------------------------------------------------------
if [ "${failures}" -gt 0 ]; then
  echo "${failures} failure(s)" >&2
  exit 1
fi
echo "ok: tests/application/test-knowledge.sh"
