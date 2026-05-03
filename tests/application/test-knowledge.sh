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
# Test 3: knowledge_snapshot_spec round-trip + last-write-wins
# ----------------------------------------------------------------------------
SPEC_DIR="${KNOWLEDGE_ROOT}/spec-snapshots"
knowledge_snapshot_spec "${TEST_TARGET}" "42" "spec body v1" \
  || fail "spec snapshot v1 write failed"
SPEC_PATH="${SPEC_DIR}/42.json"
[ -f "${SPEC_PATH}" ] || fail "spec-snapshot file not created"
[ "$(jq -r '.body' "${SPEC_PATH}")" = "spec body v1" ] \
  || fail "spec body mismatch"
[ "$(jq -r '.milestone_id' "${SPEC_PATH}")" = "42" ] \
  || fail "spec milestone_id mismatch"
[ -n "$(jq -r '.saved_at' "${SPEC_PATH}")" ] \
  || fail "spec saved_at not populated"

# Re-write must overwrite (spec evolves during PO/PM gate iteration).
knowledge_snapshot_spec "${TEST_TARGET}" "42" "spec body v2" \
  || fail "spec snapshot v2 write failed"
[ "$(jq -r '.body' "${SPEC_PATH}")" = "spec body v2" ] \
  || fail "spec body did not update on re-write"

# Empty body is no-op.
knowledge_snapshot_spec "${TEST_TARGET}" "44" "" \
  || fail "empty spec body call should return 0"
[ ! -f "${SPEC_DIR}/44.json" ] \
  || fail "empty spec body should not create a file"

# ----------------------------------------------------------------------------
# Test 4: knowledge_latest_prior_summary picks newest, supports exclusion
# ----------------------------------------------------------------------------
# Existing summary for milestone 42 is "first summary". Add another for 50.
knowledge_snapshot_context_summary "${TEST_TARGET}" "50" "summary for 50" \
  || fail "second context_summary write failed"
# Force mtime ordering: 50 newer than 42.
touch "${KNOWLEDGE_ROOT}/context-summaries/50.json"

row="$(knowledge_latest_prior_summary "${TEST_TARGET}")" \
  || fail "knowledge_latest_prior_summary should find a summary"
got_id="$(printf '%s' "${row}" | awk -F'\t' '{print $1}')"
got_path="$(printf '%s' "${row}" | awk -F'\t' '{print $2}')"
got_pin="$(printf '%s' "${row}" | awk -F'\t' '{print $3}')"
[ "${got_id}" = "50" ] \
  || fail "latest_prior_summary expected id=50, got '${got_id}'"
[ -f "${got_path}" ] \
  || fail "latest_prior_summary path '${got_path}' is not a file"
case "${got_pin}" in
  summary-*) ;;
  *) fail "latest_prior_summary pin must start with 'summary-' (got '${got_pin}')" ;;
esac

# Exclusion: when current milestone is 50, latest_prior must fall back to 42.
row2="$(knowledge_latest_prior_summary "${TEST_TARGET}" "50")" \
  || fail "latest_prior_summary with exclude should still find 42"
got_id2="$(printf '%s' "${row2}" | awk -F'\t' '{print $1}')"
[ "${got_id2}" = "42" ] \
  || fail "with exclude=50, expected id=42, got '${got_id2}'"

# Empty target → return 1 (no false positives).
TMP_TARGET="empty-knowledge-$$"
if knowledge_latest_prior_summary "${TMP_TARGET}" 2>/dev/null; then
  fail "latest_prior_summary on empty target should return non-zero"
fi

# ----------------------------------------------------------------------------
if [ "${failures}" -gt 0 ]; then
  echo "${failures} failure(s)" >&2
  exit 1
fi
echo "ok: tests/application/test-knowledge.sh"
