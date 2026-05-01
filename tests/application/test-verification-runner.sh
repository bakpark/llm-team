#!/usr/bin/env bash
# tests/application/test-verification-runner.sh
#
# application/verification_runner.sh 단위 검증.
#
# 검증 항목:
#   1. 단일 성공 명령 (`true`) → return 0, result=PASS, log_ref 비어있지 않음.
#   2. 단일 실패 명령 (`false`) → return 1, result=FAIL, exit_codes[0]!=0.
#   3. 다중 명령 (true, false) → return 1, result=FAIL, commands_or_checks 길이 2,
#      exit_codes=[0, 1].
#   4. ws_path 안에서 실행됨 — 명령은 cwd=${ws_path} 에서 실행되어야 한다.
#   5. log_ref 가 ps_put 으로 영속됨: ps_get 으로 로그 본문 읽기 가능.
#   6. envelope 필드: RGC-VERIFICATION 9 필드 모두 비어있지 않음 (started_at,
#      finished_at, environment_fingerprint 포함).
#   7. verification_attach_to_manifest 호출 후 manifest 에 verification_log
#      entry 가 1개 추가, object_id == verification_run_id 일치.
#   8. 인자 오류: ws_path 부재 / commands_json 잘못된 형식 → 비0 (return 2/3).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# in_memory ps adapter 격리 + 실 워크스페이스 격리.
INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-vrun-ps-XXXXXX")"
TEST_WS="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-vrun-ws-XXXXXX")"
export LLM_TEAM_INMEM_PS_DIR="${INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_PERSISTENT_STORE="in_memory"

TARGET_NAME_TEST="vrun-test-$$"
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME_TEST}"

cleanup() {
  rm -rf "${INMEM_PS_DIR}" "${TEST_WS}" "${TARGET_WORKDIR}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/verification_runner.sh
. "${LLM_TEAM_ROOT}/application/verification_runner.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# (1) 단일 성공: result=PASS, return 0.
# ----------------------------------------------------------------------------
run_path_pass="$(verification_run_for "${TARGET_NAME_TEST}" obj-1 rev-1 "${TEST_WS}" '["true"]' 2>/dev/null)"
rc_pass=$?
[ "${rc_pass}" = "0" ] || fail "(1) expected return 0 for ['true'], got ${rc_pass}"
[ -f "${run_path_pass}" ] || fail "(1) run_path file missing: ${run_path_pass}"
result_pass="$(jq -r '.result' "${run_path_pass}")"
[ "${result_pass}" = "PASS" ] || fail "(1) expected result=PASS, got '${result_pass}'"
log_ref_pass="$(jq -r '.log_ref' "${run_path_pass}")"
[ -n "${log_ref_pass}" ] && [ "${log_ref_pass}" != "null" ] \
  || fail "(1) log_ref should be set (got '${log_ref_pass}')"

# ----------------------------------------------------------------------------
# (2) 단일 실패: result=FAIL, return 1, exit_code != 0.
# ----------------------------------------------------------------------------
run_path_fail=""
set +e
run_path_fail="$(verification_run_for "${TARGET_NAME_TEST}" obj-2 rev-2 "${TEST_WS}" '["false"]' 2>/dev/null)"
rc_fail=$?
set -e 2>/dev/null || true
[ "${rc_fail}" = "1" ] || fail "(2) expected return 1 for ['false'], got ${rc_fail}"
result_fail="$(jq -r '.result' "${run_path_fail}")"
[ "${result_fail}" = "FAIL" ] || fail "(2) expected result=FAIL, got '${result_fail}'"
ec0="$(jq -r '.commands_or_checks[0].exit_code' "${run_path_fail}")"
[ "${ec0}" != "0" ] && [ -n "${ec0}" ] && [ "${ec0}" != "null" ] \
  || fail "(2) expected exit_code != 0 (got '${ec0}')"

# ----------------------------------------------------------------------------
# (3) 다중 명령: [true, false] → result=FAIL, exit_codes=[0,1].
# ----------------------------------------------------------------------------
run_path_mix=""
set +e
run_path_mix="$(verification_run_for "${TARGET_NAME_TEST}" obj-3 rev-3 "${TEST_WS}" '["true","false"]' 2>/dev/null)"
rc_mix=$?
set -e 2>/dev/null || true
[ "${rc_mix}" = "1" ] || fail "(3) expected return 1 for [true,false], got ${rc_mix}"
result_mix="$(jq -r '.result' "${run_path_mix}")"
[ "${result_mix}" = "FAIL" ] || fail "(3) expected result=FAIL, got '${result_mix}'"
len_mix="$(jq -r '.commands_or_checks | length' "${run_path_mix}")"
[ "${len_mix}" = "2" ] || fail "(3) expected commands_or_checks length 2, got '${len_mix}'"
ec_first="$(jq -r '.commands_or_checks[0].exit_code' "${run_path_mix}")"
ec_second="$(jq -r '.commands_or_checks[1].exit_code' "${run_path_mix}")"
[ "${ec_first}" = "0" ] || fail "(3) expected exit_codes[0]=0, got '${ec_first}'"
[ "${ec_second}" != "0" ] && [ -n "${ec_second}" ] && [ "${ec_second}" != "null" ] \
  || fail "(3) expected exit_codes[1]!=0, got '${ec_second}'"

# ----------------------------------------------------------------------------
# (4) ws_path 에서 실행: pwd 가 ws_path 와 일치해야 한다.
# ----------------------------------------------------------------------------
run_path_pwd="$(verification_run_for "${TARGET_NAME_TEST}" obj-4 rev-4 "${TEST_WS}" '["pwd"]' 2>/dev/null)"
log_id_pwd="$(jq -r '.verification_run_id' "${run_path_pwd}")"
log_payload="$(ps_get verification_log "${log_id_pwd}" 2>/dev/null || echo '{}')"
log_text="$(printf '%s' "${log_payload}" | jq -r '.log // ""')"
# macOS 의 /tmp 는 /private/tmp 의 심볼릭 링크라 pwd 가 /private/tmp/... 로 풀릴
# 수 있다. 양쪽 모두 허용하기 위해 basename 으로 비교.
ws_base="$(basename "${TEST_WS}")"
case "${log_text}" in
  *"${ws_base}"*) ;;
  *) fail "(4) command should run in ws_path; expected '${ws_base}' to appear in log, got: ${log_text}" ;;
esac

# ----------------------------------------------------------------------------
# (5) ps_put 영속화: ps_get 으로 로그 가져올 수 있고 본문이 비어있지 않다.
# ----------------------------------------------------------------------------
log_payload_pass="$(ps_get verification_log "$(jq -r '.verification_run_id' "${run_path_pass}")" 2>/dev/null)"
[ -n "${log_payload_pass}" ] || fail "(5) ps_get verification_log returned empty"
log_text_pass="$(printf '%s' "${log_payload_pass}" | jq -r '.log // ""')"
case "${log_text_pass}" in
  *"=== CMD: true"*"=== EXIT: 0"*) ;;
  *) fail "(5) log content should record CMD/EXIT lines, got: ${log_text_pass}" ;;
esac

# ----------------------------------------------------------------------------
# (6) RGC-VERIFICATION 9 필드 모두 채워짐 (PASS run 으로 확인).
# ----------------------------------------------------------------------------
for field in verification_run_id target_id target_revision commands_or_checks \
             environment_fingerprint started_at finished_at result log_ref; do
  v="$(jq -r --arg f "${field}" '.[$f]' "${run_path_pass}")"
  if [ -z "${v}" ] || [ "${v}" = "null" ]; then
    fail "(6) RGC-VERIFICATION field '${field}' is empty/null in run envelope"
  fi
done

# ----------------------------------------------------------------------------
# (7) verification_attach_to_manifest: manifest entry 1개 추가, object_id 일치.
# ----------------------------------------------------------------------------
manifest_path="$(context_manifest_create "${TARGET_NAME_TEST}" Review issue 42)"
[ -f "${manifest_path}" ] || fail "(7) context_manifest_create failed"

before_count="$(jq -r '.entries | length' "${manifest_path}")"

verification_attach_to_manifest "${manifest_path}" "${run_path_pass}" \
  || fail "(7) verification_attach_to_manifest failed"

after_count="$(jq -r '.entries | length' "${manifest_path}")"
[ "$((after_count - before_count))" = "1" ] \
  || fail "(7) expected exactly 1 manifest entry added (before=${before_count} after=${after_count})"

last_kind="$(jq -r '.entries[-1].object_kind' "${manifest_path}")"
last_id="$(jq -r '.entries[-1].object_id' "${manifest_path}")"
[ "${last_kind}" = "verification_log" ] \
  || fail "(7) last entry object_kind should be 'verification_log' (got '${last_kind}')"
expected_run_id="$(jq -r '.verification_run_id' "${run_path_pass}")"
[ "${last_id}" = "${expected_run_id}" ] \
  || fail "(7) entry object_id should match verification_run_id (expected '${expected_run_id}', got '${last_id}')"

# manifest 가 통째로 valid 해야 한다 (context_manifest_validate).
context_manifest_validate "${manifest_path}" \
  || fail "(7) manifest invalid after attach"

# ----------------------------------------------------------------------------
# (8) 인자 오류
# ----------------------------------------------------------------------------
# missing arg
set +e
verification_run_for "" obj-x rev-x "${TEST_WS}" '["true"]' >/dev/null 2>&1; rc8a=$?
verification_run_for "${TARGET_NAME_TEST}" obj-x rev-x "/no/such/dir" '["true"]' >/dev/null 2>&1; rc8b=$?
verification_run_for "${TARGET_NAME_TEST}" obj-x rev-x "${TEST_WS}" 'not-json'    >/dev/null 2>&1; rc8c=$?
verification_attach_to_manifest "" "${run_path_pass}" >/dev/null 2>&1; rc8d=$?
verification_attach_to_manifest "${manifest_path}" "/no/such/run.json" >/dev/null 2>&1; rc8e=$?
set -e 2>/dev/null || true
[ "${rc8a}" -ne 0 ] || fail "(8a) empty target should fail"
[ "${rc8b}" -ne 0 ] || fail "(8b) missing ws_path should fail"
[ "${rc8c}" -ne 0 ] || fail "(8c) invalid commands_json should fail"
[ "${rc8d}" -ne 0 ] || fail "(8d) empty manifest_path should fail"
[ "${rc8e}" -ne 0 ] || fail "(8e) missing run_path should fail"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} verification_runner check(s) failed" >&2
  exit 1
fi

echo "PASS: application/verification_runner.sh (PASS/FAIL/multi/cwd + ps persistence + manifest attach + arg errors)"
