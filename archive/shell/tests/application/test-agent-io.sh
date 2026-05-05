#!/usr/bin/env bash
# tests/application/test-agent-io.sh
#
# application/agent_io.sh 단위 검증.
#
# 검증 항목:
#   1. agent_prompt_assemble: prompts/<role>.md head 의 __MANIFEST_ID__ 치환,
#      ## Manifest, ## Envelope Schema 섹션 포함.
#   2. agent_output_parse: 단일 ```json fenced block 정상 추출 / 0개 거부 /
#      2개 거부 / 잘못된 JSON 거부 / fenced block 외 텍스트 함께 OK.
#   3. agent_output_validate_extended (AGC-INVALID 6 invariant):
#      a. manifest 외 객체 참조 — 거부
#      b. 필수 필드 누락 — 거부
#      c. revision_pin 누락 — 거부
#      d. operational side-effect 텍스트 — 거부
#      e. secret/credential 포함 — 거부
#      f. 할당 범위 밖 file path (patch envelope) — 거부 / 내부 path → 통과
#      + 정상 envelope → 통과
#      + role × output_kind 불일치 거부
#   4. revision_pin_revalidate: in_memory adapter seed 후 pin 일치 → 0,
#      객체 변경 → 1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# 격리: 테스트 전용 in-memory issue_tracker root.
TEST_INMEM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-it-agentio-XXXXXX")"
TEST_TARGET="agentio-test-$$"
WORKDIR="${LLM_TEAM_ROOT}/workdir/${TEST_TARGET}"
export LLM_TEAM_INMEM_IT_DIR="${TEST_INMEM_ROOT}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory

cleanup() {
  rm -rf "${TEST_INMEM_ROOT}" "${WORKDIR}" 2>/dev/null || true
}
trap cleanup EXIT

# common.sh — registry will load in_memory issue_tracker via the env var.
# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/agent_io.sh
. "${LLM_TEAM_ROOT}/application/agent_io.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# Setup: a test manifest under workdir/<target>/manifests/
# ----------------------------------------------------------------------------
mkdir -p "${WORKDIR}/manifests"
manifest_path="$(context_manifest_create "${TEST_TARGET}" Implement task T-1)"
context_manifest_add_entry "${manifest_path}" task T-1 body rev-1 true "primary"
context_manifest_add_entry "${manifest_path}" task T-2 body rev-2 false "context"
context_manifest_validate "${manifest_path}" || fail "test manifest must validate"
manifest_id="$(context_manifest_id "${manifest_path}")"

# ----------------------------------------------------------------------------
# (1) agent_prompt_assemble
# ----------------------------------------------------------------------------
prompt="$(agent_prompt_assemble po "${manifest_path}")"
case "${prompt}" in
  *"# Role: po"*)              ;;
  *)                           fail "assembled prompt missing '# Role: po' header" ;;
esac
case "${prompt}" in
  *"# Manifest-id: ${manifest_id}"*) ;;
  *)                                 fail "assembled prompt did not substitute __MANIFEST_ID__ → '${manifest_id}'" ;;
esac
case "${prompt}" in
  *"## Manifest"*)             ;;
  *)                           fail "assembled prompt missing '## Manifest' section" ;;
esac
case "${prompt}" in
  *"## Envelope Schema"*)      ;;
  *)                           fail "assembled prompt missing '## Envelope Schema' section" ;;
esac
case "${prompt}" in
  *"__MANIFEST_ID__"*) fail "assembled prompt still contains __MANIFEST_ID__ placeholder" ;;
esac
# Coder prompt with extra_instruction.
coder_manifest="$(context_manifest_create "${TEST_TARGET}" Implement task T-9)"
context_manifest_add_entry "${coder_manifest}" task T-9 body rev-9 true "primary"
prompt2="$(agent_prompt_assemble coder "${coder_manifest}" "Use tabs not spaces.")"
case "${prompt2}" in
  *"## Caller Notes"*"Use tabs not spaces."*) ;;
  *) fail "coder prompt missing '## Caller Notes' with extra instruction" ;;
esac

# Invalid role.
if agent_prompt_assemble bogus "${manifest_path}" 2>/dev/null; then
  fail "agent_prompt_assemble should reject invalid role"
fi
# Missing manifest.
if agent_prompt_assemble po "/no/such/path.json" 2>/dev/null; then
  fail "agent_prompt_assemble should reject missing manifest"
fi

# ----------------------------------------------------------------------------
# (2) agent_output_parse
# ----------------------------------------------------------------------------
# Single fenced block (with surrounding text)
sample='Some chatter before.

```json
{"output_kind":"patch","x":1}
```

Trailing chatter.
'
parsed="$(agent_output_parse "${sample}")"
[ "$(printf '%s' "${parsed}" | jq -r '.output_kind')" = "patch" ] \
  || fail "agent_output_parse single-block extraction failed"

# 0 blocks
if agent_output_parse "no blocks here at all" 2>/dev/null; then
  fail "agent_output_parse should fail with 0 blocks"
fi

# 2 blocks
two_blocks='
```json
{"a":1}
```

```json
{"b":2}
```
'
if agent_output_parse "${two_blocks}" 2>/dev/null; then
  fail "agent_output_parse should fail with 2 blocks"
fi

# Invalid JSON inside block
bad_json='
```json
{this is not json}
```
'
if agent_output_parse "${bad_json}" 2>/dev/null; then
  fail "agent_output_parse should fail with invalid JSON inside block"
fi

# Path input
sample_file="${WORKDIR}/sample-stdout.txt"
mkdir -p "${WORKDIR}"
printf '%s' "${sample}" >"${sample_file}"
parsed_from_file="$(agent_output_parse "${sample_file}")"
[ "$(printf '%s' "${parsed_from_file}" | jq -r '.x')" = "1" ] \
  || fail "agent_output_parse from file failed"

# ----------------------------------------------------------------------------
# (3) agent_output_validate_extended
# ----------------------------------------------------------------------------

# Helper: build a coder envelope (output_kind=patch).
make_coder_envelope() {
  local mode="$1"
  local body
  body=$(jq -n \
    --arg mid "${manifest_id}" \
    --argjson pins '[{"object_kind":"task","object_id":"T-1","revision_pin":"rev-1"}]' \
    '{
      output_kind: "patch",
      agent_role: "Coder",
      operation: "Implement",
      object_id: "T-1",
      manifest_id: $mid,
      input_revision_pins: $pins,
      idempotency_key: "T-1:rev-1",
      summary: "Implement T-1",
      artifacts: { patch_diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+ok\n", risk_notes: "low" }
    }')
  case "${mode}" in
    valid) printf '%s' "${body}" ;;
    no_pins) printf '%s' "${body}" | jq 'del(.input_revision_pins)' ;;
    no_summary) printf '%s' "${body}" | jq 'del(.summary)' ;;
    op_text) printf '%s' "${body}" | jq '.summary = "I will run gh pr merge after this"' ;;
    secret_ghp) printf '%s' "${body}" | jq '.artifacts.risk_notes = "leaked ghp_ABCDEF1234567890XYZ token"' ;;
    secret_bearer) printf '%s' "${body}" | jq '.artifacts.risk_notes = "Authorization: Bearer abc.def-XYZ_123"' ;;
    secret_password) printf '%s' "${body}" | jq '.artifacts.risk_notes = "uses password=hunter2"' ;;
    secret_pem) printf '%s' "${body}" | jq '.artifacts.risk_notes = "key: -----BEGIN RSA PRIVATE KEY-----..."' ;;
    pin_outside_manifest) printf '%s' "${body}" \
      | jq '.input_revision_pins = [{"object_kind":"task","object_id":"T-99","revision_pin":"rev-1"}]' ;;
    abs_path_diff) printf '%s' "${body}" \
      | jq '.artifacts.patch_diff = "diff --git a//etc/passwd b//etc/passwd\n--- a//etc/passwd\n+++ b//etc/passwd\n"' ;;
    parent_path_diff) printf '%s' "${body}" \
      | jq '.artifacts.patch_diff = "diff --git a/../escape.txt b/../escape.txt\n--- a/../escape.txt\n+++ b/../escape.txt\n"' ;;
    structured_abs) printf '%s' "${body}" \
      | jq '.artifacts.files = [{"path":"/etc/shadow"}]' ;;
    role_mismatch) printf '%s' "${body}" | jq '.output_kind = "task_plan"' ;;
    *) printf 'BAD_MODE\n' >&2; return 1 ;;
  esac
}

# Sanity: valid envelope passes.
env_valid="$(make_coder_envelope valid)"
agent_output_validate_extended "${env_valid}" coder \
  || fail "valid coder envelope should pass"

# (b) 필수 필드 누락
env_no_summary="$(make_coder_envelope no_summary)"
if agent_output_validate_extended "${env_no_summary}" coder 2>/dev/null; then
  fail "envelope missing summary should be rejected"
fi
# (c) revision_pins 누락 (배열 자체 부재)
env_no_pins="$(make_coder_envelope no_pins)"
if agent_output_validate_extended "${env_no_pins}" coder 2>/dev/null; then
  fail "envelope missing input_revision_pins should be rejected"
fi
# (d) operational side-effect text
env_op="$(make_coder_envelope op_text)"
if agent_output_validate_extended "${env_op}" coder 2>/dev/null; then
  fail "envelope with operational side-effect text should be rejected"
fi
# (e) secrets
for mode in secret_ghp secret_bearer secret_password secret_pem; do
  env_sec="$(make_coder_envelope "${mode}")"
  if agent_output_validate_extended "${env_sec}" coder 2>/dev/null; then
    fail "envelope with ${mode} secret should be rejected"
  fi
done
# (a) manifest 외 객체 참조
env_outside="$(make_coder_envelope pin_outside_manifest)"
if agent_output_validate_extended "${env_outside}" coder 2>/dev/null; then
  fail "envelope referencing object_id outside manifest should be rejected"
fi
# (f) 절대경로
env_abs="$(make_coder_envelope abs_path_diff)"
if agent_output_validate_extended "${env_abs}" coder 2>/dev/null; then
  fail "envelope with absolute patch path should be rejected"
fi
# (f) parent traversal
env_parent="$(make_coder_envelope parent_path_diff)"
if agent_output_validate_extended "${env_parent}" coder 2>/dev/null; then
  fail "envelope with '../' patch path should be rejected"
fi
# (f) structured absolute path
env_struct="$(make_coder_envelope structured_abs)"
if agent_output_validate_extended "${env_struct}" coder 2>/dev/null; then
  fail "envelope with structured absolute artifact path should be rejected"
fi
# role × output_kind mismatch
env_role="$(make_coder_envelope role_mismatch)"
if agent_output_validate_extended "${env_role}" coder 2>/dev/null; then
  fail "envelope with output_kind not matching role should be rejected"
fi

# Other roles (non-patch): role mismatch when sent to coder.
po_envelope=$(jq -n --arg mid "${manifest_id}" '
  {
    output_kind: "spec_proposal",
    agent_role: "PO",
    operation: "Compose-PO",
    object_id: "M-1",
    manifest_id: $mid,
    input_revision_pins: [],
    idempotency_key: "po:M-1",
    summary: "PO spec",
    artifacts: {}
  }
')
agent_output_validate_extended "${po_envelope}" po \
  || fail "valid PO envelope should pass"
if agent_output_validate_extended "${po_envelope}" coder 2>/dev/null; then
  fail "PO envelope should fail when validated as coder"
fi

# Required code_tree entries must be echoed in input_revision_pins.
code_tree_manifest="$(context_manifest_create "${TEST_TARGET}" Compose-PO milestone M-code-tree)"
context_manifest_add_entry "${code_tree_manifest}" issue 42 body rev-issue true "primary issue"
context_manifest_add_entry "${code_tree_manifest}" code_tree acme/widgets tree rev-code true "read-only codebase"
context_manifest_validate "${code_tree_manifest}" || fail "code_tree manifest must validate"
code_tree_manifest_id="$(context_manifest_id "${code_tree_manifest}")"

po_missing_code_tree_pin="$(jq -n --arg mid "${code_tree_manifest_id}" '
  {
    output_kind: "spec_proposal",
    agent_role: "PO",
    operation: "Compose-PO",
    object_id: "M-code-tree",
    manifest_id: $mid,
    input_revision_pins: [{"object_kind":"issue","object_id":"42","revision_pin":"rev-issue"}],
    idempotency_key: "po:M-code-tree",
    summary: "PO spec",
    artifacts: {}
  }
')"
if agent_output_validate_extended "${po_missing_code_tree_pin}" po 2>/dev/null; then
  fail "PO envelope missing required code_tree pin should be rejected"
fi

po_with_code_tree_pin="$(printf '%s' "${po_missing_code_tree_pin}" | jq '
  .input_revision_pins += [{"object_kind":"code_tree","object_id":"acme/widgets","revision_pin":"rev-code"}]
')"
agent_output_validate_extended "${po_with_code_tree_pin}" po \
  || fail "PO envelope echoing required code_tree pin should pass"

# ----------------------------------------------------------------------------
# (3.x) KAC-TRACEABILITY (P1-6): Planner ac_id_to_task + QA ac_results gate
# ----------------------------------------------------------------------------
make_planner_envelope() {
  local artifacts="$1"
  jq -nc --arg mid "${manifest_id}" --argjson art "${artifacts}" '
    {
      output_kind: "task_plan",
      agent_role: "Planner",
      operation: "Decompose",
      object_id: "M-1",
      manifest_id: $mid,
      input_revision_pins: [],
      idempotency_key: "planner:M-1",
      summary: "decompose",
      artifacts: $art
    }'
}

# Valid: ac_id_to_task references existing task slugs.
env_planner_ok="$(make_planner_envelope '{
  "tasks": [{"slug":"t1","title":"a","body":"x"},{"slug":"t2","title":"b","body":"y"}],
  "ac_id_to_task": {"AC-1":["t1"], "AC-2":["t1","t2"]}
}')"
agent_output_validate_extended "${env_planner_ok}" planner \
  || fail "Planner with valid ac_id_to_task must pass"

# Missing ac_id_to_task → reject.
env_planner_no_ac="$(make_planner_envelope '{
  "tasks": [{"slug":"t1","title":"a","body":"x"}]
}')"
if agent_output_validate_extended "${env_planner_no_ac}" planner 2>/dev/null; then
  fail "Planner without ac_id_to_task must fail (P1-6)"
fi

# ac_id_to_task references unknown slug → reject.
env_planner_bad_slug="$(make_planner_envelope '{
  "tasks": [{"slug":"t1","title":"a","body":"x"}],
  "ac_id_to_task": {"AC-1":["t1","t-ghost"]}
}')"
if agent_output_validate_extended "${env_planner_bad_slug}" planner 2>/dev/null; then
  fail "Planner with ac_id mapping to unknown task slug must fail (P1-6)"
fi

# Empty ac_id_to_task → reject.
env_planner_empty_ac="$(make_planner_envelope '{
  "tasks": [{"slug":"t1","title":"a","body":"x"}],
  "ac_id_to_task": {}
}')"
if agent_output_validate_extended "${env_planner_empty_ac}" planner 2>/dev/null; then
  fail "Planner with empty ac_id_to_task must fail (P1-6)"
fi

make_qa_envelope() {
  local artifacts="$1"
  jq -nc --arg mid "${manifest_id}" --argjson art "${artifacts}" '
    {
      output_kind: "milestone_package",
      agent_role: "QA",
      operation: "Validate",
      object_id: "M-1",
      manifest_id: $mid,
      input_revision_pins: [],
      idempotency_key: "qa:M-1",
      summary: "validate",
      artifacts: $art
    }'
}

env_qa_ok="$(make_qa_envelope '{
  "outcome":"PASS",
  "ac_results":[{"ac_id":"AC-1","verdict":"PASS","responsible_task_ids":["1","2"]}]
}')"
agent_output_validate_extended "${env_qa_ok}" qa \
  || fail "QA PASS with valid ac_results must pass"

env_qa_no_ac="$(make_qa_envelope '{"outcome":"PASS"}')"
if agent_output_validate_extended "${env_qa_no_ac}" qa 2>/dev/null; then
  fail "QA PASS without ac_results must fail (P1-6)"
fi

env_qa_bad_verdict="$(make_qa_envelope '{
  "outcome":"PASS",
  "ac_results":[{"ac_id":"AC-1","verdict":"MAYBE","responsible_task_ids":[]}]
}')"
if agent_output_validate_extended "${env_qa_bad_verdict}" qa 2>/dev/null; then
  fail "QA ac_results.verdict not in {PASS,FAIL} must fail (P1-6)"
fi

# QA with non-terminal outcome (NO-OP / STALE) is allowed without ac_results.
env_qa_noop="$(make_qa_envelope '{"outcome":"NO-OP"}')"
agent_output_validate_extended "${env_qa_noop}" qa \
  || fail "QA NO-OP without ac_results must still pass (gate is verdict-scoped)"

# ----------------------------------------------------------------------------
# (4) revision_pin_revalidate (uses in_memory issue_tracker)
# ----------------------------------------------------------------------------
repo="acme/widgets"
issue_num="$(it_issue_create "${repo}" --title "Login" --body "")"
pin_now="$(it_revision_pin_get "${repo}" issue "${issue_num}")"

env_for_pin=$(jq -n \
  --arg mid "${manifest_id}" \
  --arg id "${issue_num}" \
  --arg pin "${pin_now}" '
  {
    output_kind: "patch",
    agent_role: "Coder",
    operation: "Implement",
    object_id: "T-1",
    manifest_id: $mid,
    input_revision_pins: [{object_kind: "issue", object_id: $id, revision_pin: $pin}],
    idempotency_key: "x",
    summary: "y",
    artifacts: {}
  }
')

revision_pin_revalidate "${env_for_pin}" "${repo}" \
  || fail "revision_pin_revalidate should pass for matching pin"

# Force-update the issue → pin changes → revalidate should fail.
sleep 1
it_issue_set_state "${repo}" "${issue_num}" TASK_READY \
  || fail "issue state set failed in setup"
if revision_pin_revalidate "${env_for_pin}" "${repo}" 2>/dev/null; then
  fail "revision_pin_revalidate should fail after pin changed"
fi

# Empty pins → ok.
env_no_pin_arr=$(jq -n --arg mid "${manifest_id}" '
  {
    output_kind: "patch", agent_role: "Coder", operation: "Implement",
    object_id: "T-1", manifest_id: $mid, input_revision_pins: [],
    idempotency_key: "x", summary: "y", artifacts: {}
  }
')
revision_pin_revalidate "${env_no_pin_arr}" "${repo}" \
  || fail "revision_pin_revalidate with empty pins should pass"


# ----------------------------------------------------------------------------
export LLM_TEAM_INMEM_WS_DIR="${TEST_INMEM_ROOT}/ws"

# (4b) code_tree revision_pin_revalidate — RO tree pin 일치/불일치
# ----------------------------------------------------------------------------
# in_memory workspace 어댑터가 ws_ensure_ro_tree/ws_ro_tree_revision_pin 을
# 제공하므로 code_tree pin 검증이 가능함.
#
# revision_pin_revalidate 는 code_tree object_id 를 repo 와 대조하고,
# RO tree pin 은 TARGET_NAME target context 에서 조회한다.

# fixture: canonical clone + default branch seed 필요
registry_load_adapter workspace in_memory >/dev/null 2>&1 || true

# target yaml 설정 (in_memory workspace 가 필요)
CODE_TREE_TARGET="${TEST_TARGET}-code-tree"
export TARGET_NAME="${CODE_TREE_TARGET}"
export TARGET_DEFAULT_BRANCH="main"
export LLM_TEAM_INTEGRATION_BRANCH="integration"
unset TARGET_RO_TREE_PATH

# ws_ensure_clone 시뮬레이션: in_memory adapter 는 ws_ensure_clone 호출로 seed
ws_ensure_clone "${CODE_TREE_TARGET}" >/dev/null 2>&1 || true

# RO tree 생성 (seed SHA 기반)
RO_TREE_PATH="$(ws_ensure_ro_tree "${CODE_TREE_TARGET}" 2>/dev/null)" || \
  fail "code_tree: ws_ensure_ro_tree failed"
CODE_TREE_PIN="$(ws_ro_tree_revision_pin "${CODE_TREE_TARGET}" 2>/dev/null)" || \
  fail "code_tree: ws_ro_tree_revision_pin failed"

# matching pin → PASS
env_code_tree_ok="$(jq -n \
  --arg id "${repo}" \
  --arg pin "${CODE_TREE_PIN}" \
  '{
    manifest_id: "m-1", role: "PO", operation: "create",
    input_revision_pins: [{object_kind: "code_tree", object_id: $id, revision_pin: $pin}],
    idempotency_key: "x", summary: "y", artifacts: {}
  }')"
printf '%s\n' "${env_code_tree_ok}" >"${TEST_INMEM_ROOT}/env-code-tree-ok.json"
revision_pin_revalidate "${TEST_INMEM_ROOT}/env-code-tree-ok.json" "${repo}" \
  || fail "code_tree: matching pin should pass"

# stale pin (다른 SHA) → FAIL
env_code_tree_stale="$(jq -n \
  --arg id "${repo}" \
  '{
    manifest_id: "m-1", role: "PO", operation: "create",
    input_revision_pins: [{object_kind: "code_tree", object_id: $id, revision_pin: "deadbeef00000000000000000000000000000000"}],
    idempotency_key: "x", summary: "y", artifacts: {}
  }')"
printf '%s\n' "${env_code_tree_stale}" >"${TEST_INMEM_ROOT}/env-code-tree-stale.json"
if revision_pin_revalidate "${TEST_INMEM_ROOT}/env-code-tree-stale.json" "${repo}" 2>/dev/null; then
  fail "code_tree: stale pin should fail"
fi

# object_id 가 repo 인자와 다르면 실패.
env_code_tree_wrong_repo="$(printf '%s' "${env_code_tree_ok}" \
  | jq '.input_revision_pins[0].object_id = "evil/widgets"')"
printf '%s\n' "${env_code_tree_wrong_repo}" >"${TEST_INMEM_ROOT}/env-code-tree-wrong-repo.json"
if revision_pin_revalidate "${TEST_INMEM_ROOT}/env-code-tree-wrong-repo.json" "${repo}" 2>/dev/null; then
  fail "code_tree: mismatched object_id should fail"
fi

# ----------------------------------------------------------------------------
# ----------------------------------------------------------------------------
# (5) AGC-CALL-BOUNDARY: agent_io.sh has no direct gh/git/curl/claude calls
# ----------------------------------------------------------------------------
boundary_hits="$(grep -nE '(^|[^_a-zA-Z0-9])(gh|git|curl|claude)\b' \
  "${LLM_TEAM_ROOT}/application/agent_io.sh" \
  | grep -vE '^\s*#' \
  | grep -vE '\b(github|gh_with_retry|git_worktree|gh api|claude_code)\b' \
  | grep -vE 'awk|sed|jq|grep|cat|printf|bash|case|fi|do|done' \
  || true)"
# The simpler/positive check: ensure no executable command starts with 'gh ',
# 'git ', 'curl ', or 'claude '. We allow comments and identifier names.
exec_calls="$(grep -nE '(^|[ |&;{(])(gh|git|curl|claude) [^[:space:]]' \
  "${LLM_TEAM_ROOT}/application/agent_io.sh" \
  | grep -vE '^\s*#' \
  | grep -vE '#.*(gh|git|curl|claude) ' \
  || true)"
if [ -n "${exec_calls}" ]; then
  fail "agent_io.sh should not invoke gh/git/curl/claude directly:"
  printf '%s\n' "${exec_calls}" >&2
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} agent_io check(s) failed" >&2
  exit 1
fi

echo "PASS: application/agent_io.sh (assemble + parse + 6-invariant validate + revalidate)"
