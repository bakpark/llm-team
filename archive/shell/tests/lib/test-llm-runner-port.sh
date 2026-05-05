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

meta="$(lr_call "po" "Compose-PO" "m-port-1" "${prompt_ref}" "" "0" "idem-port-1" 2>/dev/null)" \
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
meta_uk="$(lr_call "planner" "Decompose" "m-port-2" "${prompt_unknown_ref}" "" "0" "idem-port-2" 2>/dev/null)" \
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
if lr_call "po" "Compose-PO" "m-x" "/nonexistent/path-$$.txt" "" "0" "idem-x" 2>/dev/null; then
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
meta_ok="$(lr_call "po" "Compose-PO" "m-port-7" "${prompt_ok_ref}" "" "0" "idem-port-7" 2>/dev/null)"
reason_ok="$(printf '%s' "${meta_ok}" | jq -r '.error_reason')"
[ "${reason_ok}" = "null" ] \
  || fail "(7) ok meta.error_reason should be null (json), got '${reason_ok}'"

prompt_uk2_ref="$(mktemp -t lrport-prompt-uk2.XXXXXX)"
printf '%s' $'# Role: planner\n# Operation: Decompose\n# Manifest-id: m-port-7b\n' >"${prompt_uk2_ref}"
meta_uk2="$(lr_call "planner" "Decompose" "m-port-7b" "${prompt_uk2_ref}" "" "0" "idem-port-7b" 2>/dev/null)"
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

# ── (8) ARC E2 G5: header/arg mismatch → adapter_unavailable (66 흡수) ────
# wrapper 가 prompt 헤더와 인자가 다르면 어댑터를 호출하지 않고 즉시 분류.
prompt_g5_ref="$(mktemp -t lrport-prompt-g5.XXXXXX)"
printf '%s' $'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-port-g5\n' >"${prompt_g5_ref}"
meta_g5="$(lr_call "planner" "Decompose" "m-port-g5" "${prompt_g5_ref}" "" "0" "idem-g5" 2>/dev/null)" \
  || fail "(8) lr_call header-mismatch must return 0 with classification, not infra failure"
exit_g5="$(printf '%s' "${meta_g5}" | jq -r '.exit_status // ""')"
[ "${exit_g5}" = "adapter_unavailable" ] \
  || fail "(8) header-mismatch should classify as adapter_unavailable, got '${exit_g5}'"
diag_g5="$(printf '%s' "${meta_g5}" | jq -r '.diagnostics_ref // ""')"
[ -f "${diag_g5}" ] && grep -q 'header/arg mismatch' "${diag_g5}" \
  || fail "(8) header-mismatch diagnostics should record reason"
env_g5="$(printf '%s' "${meta_g5}" | jq -r '.envelope_ref // ""')"
rm -f "${env_g5}" "${diag_g5}" "${prompt_g5_ref}"

# ── (9) ARC E2: JSON output schema (4 echo + timeout_enforced) ───────────
prompt_j_ref="$(mktemp -t lrport-prompt-j.XXXXXX)"
printf '%s' $'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-port-9\n\nbody' >"${prompt_j_ref}"
meta_j="$(lr_call "po" "Compose-PO" "m-port-9" "${prompt_j_ref}" "" "0" "idem-port-9" 2>/dev/null)"
for k in role operation manifest_id idempotency_key timeout_enforced; do
  printf '%s' "${meta_j}" | jq -e ". | has(\"${k}\")" >/dev/null \
    || fail "(9) JSON output missing key '${k}'"
done
[ "$(printf '%s' "${meta_j}" | jq -r '.role')"          = "po" ]            || fail "(9) role echo mismatch"
[ "$(printf '%s' "${meta_j}" | jq -r '.operation')"     = "Compose-PO" ]    || fail "(9) operation echo mismatch"
[ "$(printf '%s' "${meta_j}" | jq -r '.manifest_id')"   = "m-port-9" ]      || fail "(9) manifest_id echo mismatch"
[ "$(printf '%s' "${meta_j}" | jq -r '.idempotency_key')" = "idem-port-9" ] || fail "(9) idempotency_key echo mismatch"
# timeout=0 → timeout_enforced=false (boolean type, not string).
te_j="$(printf '%s' "${meta_j}" | jq -r '.timeout_enforced')"
[ "${te_j}" = "false" ] || fail "(9) timeout=0 should set timeout_enforced=false (got '${te_j}')"
te_type="$(printf '%s' "${meta_j}" | jq -r '.timeout_enforced | type')"
[ "${te_type}" = "boolean" ] || fail "(9) timeout_enforced type should be boolean (got '${te_type}')"
env_j="$(printf '%s' "${meta_j}" | jq -r '.envelope_ref // ""')"
diag_j="$(printf '%s' "${meta_j}" | jq -r '.diagnostics_ref // ""')"
rm -f "${env_j}" "${diag_j}" "${prompt_j_ref}"

# ── (10) ARC E2 G3: timeout>0 + cmd 부재 → adapter_unavailable fail-fast ──
# claude_code adapter 가 LR_TIMEOUT_SEC>0 인데 PATH 에 timeout 없으면 66.
# fake adapter 는 LR_TIMEOUT_SEC 무시 (테스트 결정성). 따라서 이 케이스는
# claude_code adapter 로 일시 전환해 검증한다.
# `timeout` 부재를 강제하기 위해 `command` builtin 을 함수로 shadow 한다 —
# PATH 조작 시 jq/sh 등 다른 의존성도 함께 잃어 lr_call 자체가 망가지므로
# 본 테스트에는 부적합. (PATH 제거는 OS-별로도 비결정적)
# 주의: 함수 shadow 는 macOS/bash 에서 동작. POSIX 셸 (`set -o posix`) 또는
# 다른 dash/ash 호환 셸에서는 builtin precedence 가 달라 비결정적일 수 있다.
# 본 테스트는 본 프로젝트의 표준 실행 환경(bash on macOS/Linux) 만 검증한다.
prompt_t_ref="$(mktemp -t lrport-prompt-t.XXXXXX)"
printf '%s' $'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-port-10\n\nbody' >"${prompt_t_ref}"
(
  set +u
  unset -f lr_invoke 2>/dev/null || true
  . "${LLM_TEAM_ROOT}/adapters/llm_runner/claude_code.sh"
  export LLM_TEAM_CLAUDE_CMD="true"
  command() {
    if [ "$1" = "-v" ] && [ "$2" = "timeout" ]; then
      return 1
    fi
    builtin command "$@"
  }
  meta_t="$(lr_call "po" "Compose-PO" "m-port-10" "${prompt_t_ref}" "" "5" "idem-port-10" 2>/dev/null)"
  exit_t="$(printf '%s' "${meta_t}" | jq -r '.exit_status // ""')"
  if [ "${exit_t}" != "adapter_unavailable" ]; then
    echo "FAIL: (10) timeout>0 + 'timeout' cmd absent should fail-fast as adapter_unavailable, got '${exit_t}'" >&2
    exit 1
  fi
  diag_t="$(printf '%s' "${meta_t}" | jq -r '.diagnostics_ref // ""')"
  if ! { [ -f "${diag_t}" ] && grep -q "'timeout' cmd not found" "${diag_t}"; }; then
    echo "FAIL: (10) fail-fast diagnostics missing message" >&2
    exit 1
  fi
  env_t="$(printf '%s' "${meta_t}" | jq -r '.envelope_ref // ""')"
  rm -f "${env_t}" "${diag_t}"
  exit 0
) || failures=$((failures + 1))
rm -f "${prompt_t_ref}"
# Restore the fake adapter for any later cases (binding via env).
. "${LLM_TEAM_ROOT}/adapters/llm_runner/fake.sh"

# ── (10b) ARC E2: LR_TIMEOUT_SEC strict numeric (review feedback) ────────
# 운영자 typo 예: "30s". claude_code adapter 가 silent 0-fallback 하지 않고
# 66 fail-fast — "no silent timeout skip" 정책 일관성.
prompt_tn_ref="$(mktemp -t lrport-prompt-tn.XXXXXX)"
printf '%s' $'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-port-10b\n\nbody' >"${prompt_tn_ref}"
(
  set +u
  unset -f lr_invoke 2>/dev/null || true
  . "${LLM_TEAM_ROOT}/adapters/llm_runner/claude_code.sh"
  export LLM_TEAM_CLAUDE_CMD="true"
  meta_tn="$(lr_call "po" "Compose-PO" "m-port-10b" "${prompt_tn_ref}" "" "30s" "idem-port-10b" 2>/dev/null)"
  exit_tn="$(printf '%s' "${meta_tn}" | jq -r '.exit_status // ""')"
  if [ "${exit_tn}" != "adapter_unavailable" ]; then
    echo "FAIL: (10b) non-numeric LR_TIMEOUT_SEC '30s' should fail-fast as adapter_unavailable, got '${exit_tn}'" >&2
    exit 1
  fi
  diag_tn="$(printf '%s' "${meta_tn}" | jq -r '.diagnostics_ref // ""')"
  if ! { [ -f "${diag_tn}" ] && grep -q "non-negative integer" "${diag_tn}"; }; then
    echo "FAIL: (10b) fail-fast diagnostics missing validation message" >&2
    exit 1
  fi
  env_tn="$(printf '%s' "${meta_tn}" | jq -r '.envelope_ref // ""')"
  rm -f "${env_tn}" "${diag_tn}"
  exit 0
) || failures=$((failures + 1))
rm -f "${prompt_tn_ref}"
. "${LLM_TEAM_ROOT}/adapters/llm_runner/fake.sh"

# ── (11) ARC E2: idempotency_key echo (deterministic by caller) ──────────
# Wrapper 는 caller 가 넘긴 key 를 그대로 echo. 같은 key 두 번 호출 시 같은 key
# 가 메타에 반영됨을 확인 (caller-side determinism 의 wrapper 측 확인).
prompt_i_ref="$(mktemp -t lrport-prompt-i.XXXXXX)"
printf '%s' $'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-port-11\n\nbody' >"${prompt_i_ref}"
meta_i1="$(lr_call "po" "Compose-PO" "m-port-11" "${prompt_i_ref}" "" "0" "idem-fixed" 2>/dev/null)"
meta_i2="$(lr_call "po" "Compose-PO" "m-port-11" "${prompt_i_ref}" "" "0" "idem-fixed" 2>/dev/null)"
key1="$(printf '%s' "${meta_i1}" | jq -r '.idempotency_key')"
key2="$(printf '%s' "${meta_i2}" | jq -r '.idempotency_key')"
[ "${key1}" = "idem-fixed" ] && [ "${key2}" = "idem-fixed" ] \
  || fail "(11) idempotency_key echo not stable: '${key1}' vs '${key2}'"
env_i1="$(printf '%s' "${meta_i1}" | jq -r '.envelope_ref // ""')"
diag_i1="$(printf '%s' "${meta_i1}" | jq -r '.diagnostics_ref // ""')"
env_i2="$(printf '%s' "${meta_i2}" | jq -r '.envelope_ref // ""')"
diag_i2="$(printf '%s' "${meta_i2}" | jq -r '.diagnostics_ref // ""')"
rm -f "${env_i1}" "${diag_i1}" "${env_i2}" "${diag_i2}" "${prompt_i_ref}"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} llm_runner port check(s) failed" >&2
  exit 1
fi

echo "PASS: lr_classify_exit + lr_call (envelope_ref/diagnostics_ref/consumed_at/exit_status)"
