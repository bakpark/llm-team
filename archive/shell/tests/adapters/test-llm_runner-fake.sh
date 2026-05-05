#!/usr/bin/env bash
# tests/adapters/test-llm_runner-fake.sh
#
# adapters/llm_runner/fake.sh 단위 검증.
#
# 검증 항목:
#   1. registry_load_adapter 가 fake adapter 를 정상 source + verify.
#   2. 헤더(Role/Operation/Manifest-id)가 모두 있는 prompt + 매칭 fixture →
#      stdout 에 fixture 콘텐츠 (JSON 이면 ```json fenced wrapping).
#   3. lookup 우선순위:
#        a. <role>-<op>-<manifest>.json 이 존재하면 그것 우선
#        b. 그 다음 <role>-<op>.json
#        c. 마지막 <role>.json
#   4. 헤더 누락 prompt → 비0 + stderr "no role/operation/manifest header".
#   5. fixture 부재 → 비0 + stderr "no fixture for".
#   6. 시퀀스 fixture (디렉토리) → 호출마다 0.json, 1.json, ... 순서로 반환,
#      ps_put 카운터 영속.
#   7. LLM_TEAM_FAKE_WRAP_FENCED=0 → wrapping 안 함 (raw 그대로).
#   8. 빈 prompt → 비0 (port invariant I2).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# ----------------------------------------------------------------------------
# 격리: in_memory persistent_store + 임시 fixture dir.
# ----------------------------------------------------------------------------
TEST_INMEM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-fake-lr-ps-XXXXXX")"
TEST_FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-fake-lr-fx-XXXXXX")"
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

# ----------------------------------------------------------------------------
# (1) Adapter 로드 + port verification
# ----------------------------------------------------------------------------
[ "${LLM_TEAM_ACTIVE_LLM_RUNNER_ADAPTER:-}" = "fake" ] \
  || fail "active llm_runner adapter not 'fake' (got: '${LLM_TEAM_ACTIVE_LLM_RUNNER_ADAPTER:-}')"
registry_verify_port llm_runner \
  || fail "registry_verify_port llm_runner failed after binding fake"
declare -F lr_invoke >/dev/null \
  || fail "lr_invoke not declared after binding fake"

# ----------------------------------------------------------------------------
# (2) 정상 prompt → fixture 콘텐츠 (JSON 자동 fenced wrapping)
# ----------------------------------------------------------------------------
cat >"${TEST_FIXTURE_DIR}/po-Compose-PO.json" <<'EOF'
{"output_kind":"spec_proposal","agent_role":"PO","operation":"Compose-PO","summary":"po default"}
EOF

prompt_po=$'# Role: po\n# Operation: Compose-PO\n# Manifest-id: m-1\n\nbody...'
out_po="$(printf '%s' "${prompt_po}" | lr_invoke 2>/dev/null)" \
  || fail "lr_invoke (po) returned non-zero (out='${out_po}')"
# fenced wrapping 확인
printf '%s' "${out_po}" | grep -q '^```json' \
  || fail "lr_invoke (po) missing fenced json output (out=${out_po})"
printf '%s' "${out_po}" | grep -q '"output_kind":"spec_proposal"' \
  || fail "lr_invoke (po) fixture content missing in output"

# ----------------------------------------------------------------------------
# (3) Lookup 우선순위
#   - manifest 별 정확 매칭이 우선
#   - 그 다음 role-operation 기본
#   - 마지막 role-only fallback
# ----------------------------------------------------------------------------
cat >"${TEST_FIXTURE_DIR}/coder-Implement.json" <<'EOF'
{"output_kind":"patch","agent_role":"Coder","summary":"coder default"}
EOF
cat >"${TEST_FIXTURE_DIR}/coder-Implement-m-special.json" <<'EOF'
{"output_kind":"patch","agent_role":"Coder","summary":"coder special manifest"}
EOF
cat >"${TEST_FIXTURE_DIR}/reviewer.json" <<'EOF'
{"output_kind":"verdict","agent_role":"Reviewer","summary":"reviewer fallback"}
EOF

# (3a) manifest 매칭이 먼저 잡혀야 한다
prompt_coder_special=$'# Role: coder\n# Operation: Implement\n# Manifest-id: m-special\n'
out_coder_special="$(printf '%s' "${prompt_coder_special}" | lr_invoke 2>/dev/null)"
printf '%s' "${out_coder_special}" | grep -q 'coder special manifest' \
  || fail "lookup priority: manifest-specific fixture should win (got='${out_coder_special}')"

# (3b) manifest 매칭 없으면 role-operation 기본
prompt_coder_default=$'# Role: coder\n# Operation: Implement\n# Manifest-id: m-other\n'
out_coder_default="$(printf '%s' "${prompt_coder_default}" | lr_invoke 2>/dev/null)"
printf '%s' "${out_coder_default}" | grep -q 'coder default' \
  || fail "lookup priority: role-operation fixture should fall through (got='${out_coder_default}')"

# (3c) role-operation 도 없으면 role-only
prompt_reviewer=$'# Role: reviewer\n# Operation: Review\n# Manifest-id: m-x\n'
out_reviewer="$(printf '%s' "${prompt_reviewer}" | lr_invoke 2>/dev/null)"
printf '%s' "${out_reviewer}" | grep -q 'reviewer fallback' \
  || fail "lookup priority: role-only fixture fallback failed (got='${out_reviewer}')"

# ----------------------------------------------------------------------------
# (4) 헤더 누락 prompt → 비0 + stderr 메시지
# ----------------------------------------------------------------------------
prompt_no_role=$'# Operation: Compose-PO\n# Manifest-id: m-1\n\nbody'
err="$(printf '%s' "${prompt_no_role}" | lr_invoke 2>&1 1>/dev/null)" && \
  fail "lr_invoke without Role header should return non-zero"
printf '%s' "${err}" | grep -q 'no role/operation/manifest header' \
  || fail "missing-header diagnostic should mention 'no role/operation/manifest header' (got='${err}')"

prompt_no_op=$'# Role: po\n# Manifest-id: m-1\n'
printf '%s' "${prompt_no_op}" | lr_invoke 2>/dev/null && fail "lr_invoke without Operation header should fail"

prompt_no_manifest=$'# Role: po\n# Operation: Compose-PO\n'
printf '%s' "${prompt_no_manifest}" | lr_invoke 2>/dev/null && fail "lr_invoke without Manifest-id header should fail"

# ----------------------------------------------------------------------------
# (5) fixture 부재 → 비0 + stderr "no fixture for"
# ----------------------------------------------------------------------------
prompt_unknown=$'# Role: planner\n# Operation: Decompose\n# Manifest-id: m-1\n'
err_nf="$(printf '%s' "${prompt_unknown}" | lr_invoke 2>&1 1>/dev/null)" && \
  fail "lr_invoke for unknown role should return non-zero"
printf '%s' "${err_nf}" | grep -q 'no fixture for' \
  || fail "missing-fixture diagnostic should mention 'no fixture for' (got='${err_nf}')"

# ----------------------------------------------------------------------------
# (6) 시퀀스 fixture: 디렉토리 안의 0.json, 1.json, 2.json 순서대로 반환,
#     ps_put 카운터 영속.
# ----------------------------------------------------------------------------
seq_dir="${TEST_FIXTURE_DIR}/integrator-Refactor"
mkdir -p "${seq_dir}"
printf '%s\n' '{"call":0,"summary":"first integrator output"}' >"${seq_dir}/0.json"
printf '%s\n' '{"call":1,"summary":"second integrator output"}' >"${seq_dir}/1.json"
printf '%s\n' '{"call":2,"summary":"third integrator output"}' >"${seq_dir}/2.json"

prompt_int=$'# Role: integrator\n# Operation: Refactor\n# Manifest-id: m-seq\n'

out0="$(printf '%s' "${prompt_int}" | lr_invoke 2>/dev/null)"
printf '%s' "${out0}" | grep -q 'first integrator output' \
  || fail "sequence fixture call#0 mismatch (got='${out0}')"

out1="$(printf '%s' "${prompt_int}" | lr_invoke 2>/dev/null)"
printf '%s' "${out1}" | grep -q 'second integrator output' \
  || fail "sequence fixture call#1 mismatch (got='${out1}')"

out2="$(printf '%s' "${prompt_int}" | lr_invoke 2>/dev/null)"
printf '%s' "${out2}" | grep -q 'third integrator output' \
  || fail "sequence fixture call#2 mismatch (got='${out2}')"

# 카운터가 영속화되어 있어야 한다 (ps_get).
seq_key="$(printf '%s' "${seq_dir}" | tr '/' '_' | sed 's/[^A-Za-z0-9_-]/_/g')"
counter_json="$(ps_get llm_runner_seq "${seq_key}" 2>/dev/null || echo MISSING)"
counter_count="$(printf '%s' "${counter_json}" | jq -r '.count // 0')"
[ "${counter_count}" = "3" ] \
  || fail "sequence counter should be 3 after 3 calls (got='${counter_count}', json='${counter_json}')"

# 4번째 호출은 fixture 부재 → 비0
printf '%s' "${prompt_int}" | lr_invoke 2>/dev/null \
  && fail "sequence call#3 should fail when no 3.json fixture exists"

# ----------------------------------------------------------------------------
# (7) LLM_TEAM_FAKE_WRAP_FENCED=0 → wrapping 안 함 (raw 그대로)
# ----------------------------------------------------------------------------
LLM_TEAM_FAKE_WRAP_FENCED=0 out_raw="$(printf '%s' "${prompt_po}" | lr_invoke 2>/dev/null)"
printf '%s' "${out_raw}" | grep -q '^```json' \
  && fail "LLM_TEAM_FAKE_WRAP_FENCED=0 should not produce fenced output (got=${out_raw})"
printf '%s' "${out_raw}" | grep -q '"output_kind":"spec_proposal"' \
  || fail "raw mode should still output fixture content (got='${out_raw}')"

# ----------------------------------------------------------------------------
# (8) 빈 prompt → 비0 (port invariant I2)
# ----------------------------------------------------------------------------
printf '' | lr_invoke 2>/dev/null && fail "lr_invoke '' should fail (port invariant I2)"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} fake llm_runner check(s) failed" >&2
  exit 1
fi

echo "PASS: llm_runner fake adapter (header parse + lookup priority + sequence + wrap)"
