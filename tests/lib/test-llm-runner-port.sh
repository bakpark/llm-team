#!/usr/bin/env bash
# tests/lib/test-llm-runner-port.sh
#
# Verifies the agent_runner port boundary (#ARC-PORT-SIGNATURE) realized in
# lib/ports/llm_runner.sh:
#
#   1. lr_classify_exit maps raw codes to #ARC-EXIT-CLASSES enum.
#   2. lr_call accepts a prompt_ref (file), invokes the bound adapter via
#      stdin, and emits a single-line JSON metadata object with
#      exit_status/envelope_ref/diagnostics_ref/consumed_at.
#   3. envelope_ref contains the adapter stdout; diagnostics_ref contains the
#      adapter stderr.
#   4. exit_status is "ok" on success and a non-ok enum on adapter failure
#      (no caller short-circuit needed for classification).
#   5. lr_call refuses to run if prompt_ref is missing.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TEST_INMEM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-lrport-ps-XXXXXX")"
TEST_FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-lrport-fx-XXXXXX")"
export LLM_TEAM_INMEM_PS_DIR="${TEST_INMEM_ROOT}"
export LLM_TEAM_ADAPTER_PERSISTENT_STORE="in_memory"
export LLM_TEAM_ADAPTER_LLM_RUNNER="fake"
export LLM_TEAM_FAKE_FIXTURE_DIR="${TEST_FIXTURE_DIR}"

cleanup() {
  rm -rf "${TEST_INMEM_ROOT}" "${TEST_FIXTURE_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ── (1) lr_classify_exit enum mapping ─────────────────────────────────────
expect_class() {
  local code="$1" want="$2" got
  got="$(lr_classify_exit "${code}")"
  [ "${got}" = "${want}" ] \
    || fail "lr_classify_exit ${code}: expected '${want}', got '${got}'"
}
expect_class 0   ok
expect_class 64  transport_error
expect_class 65  malformed_output
expect_class 66  adapter_unavailable
expect_class 67  malformed_output
expect_class 124 timeout
expect_class 127 adapter_unavailable
expect_class 200 transport_error   # caller fallback (#ARC-FAILURE-MODES)

# ── (2)+(3) lr_call success path ──────────────────────────────────────────
cat >"${TEST_FIXTURE_DIR}/po-Compose-PO.json" <<'EOF'
{"output_kind":"spec_proposal","agent_role":"PO","operation":"Compose-PO","summary":"port-call test"}
EOF
prompt_ref="$(mktemp -t lrport-prompt.XXXXXX)"
printf '%s' $'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-port-1\n\nbody...' \
  >"${prompt_ref}"

meta="$(lr_call "${prompt_ref}" 2>/dev/null)" \
  || fail "lr_call should succeed for valid prompt"
[ -n "${meta}" ] || fail "lr_call should emit JSON metadata to stdout"

exit_status="$(printf '%s' "${meta}" | jq -r '.exit_status // ""')"
envelope_ref="$(printf '%s' "${meta}" | jq -r '.envelope_ref // ""')"
diagnostics_ref="$(printf '%s' "${meta}" | jq -r '.diagnostics_ref // ""')"
consumed_at="$(printf '%s' "${meta}" | jq -r '.consumed_at // ""')"

[ "${exit_status}" = "ok" ] \
  || fail "ok path: exit_status expected 'ok', got '${exit_status}'"
[ -f "${envelope_ref}" ] \
  || fail "ok path: envelope_ref must be a regular file (got '${envelope_ref}')"
[ -f "${diagnostics_ref}" ] \
  || fail "ok path: diagnostics_ref must be a regular file"
case "${consumed_at}" in
  ????-??-??T??:??:??Z) ;;
  *) fail "ok path: consumed_at not ISO8601 UTC: '${consumed_at}'" ;;
esac

grep -q '"output_kind":"spec_proposal"' "${envelope_ref}" \
  || fail "envelope_ref should contain adapter stdout (fixture body)"

rm -f "${envelope_ref}" "${diagnostics_ref}"

# ── (4) lr_call non-ok classification (no fixture) ────────────────────────
prompt_unknown_ref="$(mktemp -t lrport-prompt-uk.XXXXXX)"
printf '%s' $'# Role: planner\n# Operation: Decompose\n# Manifest-id: m-port-2\n' \
  >"${prompt_unknown_ref}"
meta_uk="$(lr_call "${prompt_unknown_ref}" 2>/dev/null)" \
  || fail "lr_call must classify non-ok exit, not propagate error"
exit_uk="$(printf '%s' "${meta_uk}" | jq -r '.exit_status // ""')"
[ "${exit_uk}" != "ok" ] \
  || fail "missing-fixture path: exit_status must NOT be 'ok'"
case "${exit_uk}" in
  malformed_output|transport_error|adapter_unavailable|timeout) ;;
  *) fail "non-ok exit_status must be a #ARC-EXIT-CLASSES enum (got '${exit_uk}')" ;;
esac

# diagnostics_ref of non-ok call should contain adapter's stderr message.
diag_uk="$(printf '%s' "${meta_uk}" | jq -r '.diagnostics_ref // ""')"
[ -f "${diag_uk}" ] && grep -q 'no fixture for' "${diag_uk}" \
  || fail "non-ok path: diagnostics_ref must capture adapter stderr"

env_uk="$(printf '%s' "${meta_uk}" | jq -r '.envelope_ref // ""')"
rm -f "${env_uk}" "${diag_uk}"

# ── (5) lr_call infrastructure failure on missing prompt_ref ──────────────
if lr_call "/nonexistent/path-$$.txt" 2>/dev/null; then
  fail "lr_call should return non-zero on missing prompt_ref"
fi

rm -f "${prompt_ref}" "${prompt_unknown_ref}"

# ── (6) B-3: lr_classify_diagnostic_reason ────────────────────────────────
# transport_error 의 세부 원인 (5xx | 4xx | network | timeout | unknown) 을
# diagnostics 파일에서 첫 매칭으로 분류. retry 정책 결정에 사용.
diag_tmp="$(mktemp -t lrport-diag.XXXXXX)"

printf 'Error: 503 Service Unavailable\n' >"${diag_tmp}"
got="$(lr_classify_diagnostic_reason transport_error "${diag_tmp}")"
[ "${got}" = "5xx" ] || fail "(6) 503 should classify as 5xx, got '${got}'"

printf 'API responded with status 500\n' >"${diag_tmp}"
got="$(lr_classify_diagnostic_reason transport_error "${diag_tmp}")"
[ "${got}" = "5xx" ] || fail "(6) status 500 should classify as 5xx, got '${got}'"

printf 'HTTP 429 Too Many Requests\n' >"${diag_tmp}"
got="$(lr_classify_diagnostic_reason transport_error "${diag_tmp}")"
[ "${got}" = "4xx" ] || fail "(6) 429 should classify as 4xx, got '${got}'"

printf 'curl: (7) Failed to connect: Connection refused\n' >"${diag_tmp}"
got="$(lr_classify_diagnostic_reason transport_error "${diag_tmp}")"
[ "${got}" = "network" ] || fail "(6) connection refused should classify as network, got '${got}'"

printf 'something weird happened\n' >"${diag_tmp}"
got="$(lr_classify_diagnostic_reason transport_error "${diag_tmp}")"
[ "${got}" = "unknown" ] || fail "(6) un-matched stderr should classify as unknown, got '${got}'"

# timeout exit_status 는 diag 내용 무관하게 timeout 으로 분류.
got="$(lr_classify_diagnostic_reason timeout "${diag_tmp}")"
[ "${got}" = "timeout" ] || fail "(6) timeout exit_status should classify as timeout, got '${got}'"

# diag 파일 부재 → unknown (방어).
got="$(lr_classify_diagnostic_reason transport_error "/nonexistent-$$")"
[ "${got}" = "unknown" ] || fail "(6) missing diag file should classify as unknown, got '${got}'"

rm -f "${diag_tmp}"

# ── (7) B-3: lr_call meta.error_reason 필드 ───────────────────────────────
# 성공 시 null, 비-ok 시 enum 값이어야 한다 (port 계약 확장).
prompt_ok_ref="$(mktemp -t lrport-prompt-ok.XXXXXX)"
printf '%s' $'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-port-7\n\nbody' >"${prompt_ok_ref}"
meta_ok="$(lr_call "${prompt_ok_ref}" 2>/dev/null)"
reason_ok="$(printf '%s' "${meta_ok}" | jq -r '.error_reason')"
[ "${reason_ok}" = "null" ] \
  || fail "(7) ok meta.error_reason should be null (json), got '${reason_ok}'"

prompt_uk2_ref="$(mktemp -t lrport-prompt-uk2.XXXXXX)"
printf '%s' $'# Role: planner\n# Operation: Decompose\n# Manifest-id: m-port-7b\n' >"${prompt_uk2_ref}"
meta_uk2="$(lr_call "${prompt_uk2_ref}" 2>/dev/null)"
reason_uk2="$(printf '%s' "${meta_uk2}" | jq -r '.error_reason // "null"')"
case "${reason_uk2}" in
  5xx|4xx|network|timeout|unknown) ;;
  *) fail "(7) non-ok meta.error_reason must be enum value, got '${reason_uk2}'" ;;
esac
env_uk2="$(printf '%s' "${meta_uk2}" | jq -r '.envelope_ref // ""')"
diag_uk2="$(printf '%s' "${meta_uk2}" | jq -r '.diagnostics_ref // ""')"
env_ok="$(printf '%s' "${meta_ok}" | jq -r '.envelope_ref // ""')"
diag_ok="$(printf '%s' "${meta_ok}" | jq -r '.diagnostics_ref // ""')"
rm -f "${env_uk2}" "${diag_uk2}" "${env_ok}" "${diag_ok}" "${prompt_ok_ref}" "${prompt_uk2_ref}"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} llm_runner port check(s) failed" >&2
  exit 1
fi

echo "PASS: lr_classify_exit + lr_call (envelope_ref/diagnostics_ref/consumed_at/exit_status)"
