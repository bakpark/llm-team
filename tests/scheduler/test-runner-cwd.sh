#!/usr/bin/env bash
# tests/scheduler/test-runner-cwd.sh
#
# scheduler/runner.sh 의 agent cwd 격리 검증 (workspace-spec-agent-strategy.md §1).
#
# 검증:
#   1. PO happy path: lr_invoke 호출 시점 pwd == workdir/<target>/agent-cwd/po.
#      (LLM_TEAM_ROOT 가 아니어야 한다 — framework repo 보호.)
#
# 실행 환경: in_memory it/ws/ps + fake llm_runner. fixture/디렉토리는 mktemp 격리.
# fake.sh 의 LLM_TEAM_FAKE_PWD_LOG 토글로 pwd 를 capture.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME_T="runner-cwd-test-$$"
TEST_INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rc-it-XXXXXX")"
TEST_INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rc-ws-XXXXXX")"
TEST_INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rc-ps-XXXXXX")"
TEST_FAKE_FIX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-rc-fx-XXXXXX")"
TEST_PWD_LOG="$(mktemp "${TMPDIR:-/tmp}/llm-team-rc-pwd-XXXXXX")"
TEST_TARGET_YAML="${LLM_TEAM_ROOT}/targets/${TARGET_NAME_T}.yaml"
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME_T}"
CONTROL_STATE_FILE="${LLM_TEAM_ROOT}/workdir/control-state"
CONTROL_STATE_BACKUP=""

cleanup() {
  rm -rf "${TEST_INMEM_IT_DIR}" "${TEST_INMEM_WS_DIR}" "${TEST_INMEM_PS_DIR}" \
         "${TEST_FAKE_FIX_DIR}" "${TARGET_WORKDIR}" 2>/dev/null || true
  rm -f "${TEST_TARGET_YAML}" "${TEST_PWD_LOG}" 2>/dev/null || true
  if [ -n "${CONTROL_STATE_BACKUP}" ] && [ -f "${CONTROL_STATE_BACKUP}" ]; then
    mv "${CONTROL_STATE_BACKUP}" "${CONTROL_STATE_FILE}" 2>/dev/null || true
  else
    rm -f "${CONTROL_STATE_FILE}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ -f "${CONTROL_STATE_FILE}" ]; then
  CONTROL_STATE_BACKUP="$(mktemp)"
  cp "${CONTROL_STATE_FILE}" "${CONTROL_STATE_BACKUP}" 2>/dev/null || true
fi

cat >"${TEST_TARGET_YAML}" <<EOF
name: ${TARGET_NAME_T}
github:
  owner: test-owner
  repo: ${TARGET_NAME_T}
  default_branch: main
local:
  clone_path: ${TEST_INMEM_WS_DIR}
inputs_dir: inputs/${TARGET_NAME_T}
labels:
  prefix: ""
notifier:
  channel: none
  webhook_or_id: ""
dev_concurrency: 1
stale_threshold_minutes: 60
verification:
  commands: ["true"]
enabled: true
EOF

mkdir -p "${TARGET_WORKDIR}/manifests"

export TARGET_NAME="${TARGET_NAME_T}"
export LLM_TEAM_INMEM_IT_DIR="${TEST_INMEM_IT_DIR}"
export LLM_TEAM_INMEM_WS_DIR="${TEST_INMEM_WS_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${TEST_INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
export LLM_TEAM_ADAPTER_WORKSPACE=in_memory
export LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory
export LLM_TEAM_ADAPTER_LLM_RUNNER=fake
export LLM_TEAM_FAKE_FIXTURE_DIR="${TEST_FAKE_FIX_DIR}"
export LLM_TEAM_FAKE_PWD_LOG="${TEST_PWD_LOG}"
export LLM_TEAM_INMEM_IT_ACTOR="alice"
export LLM_TEAM_LEASE_TTL=600

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

REPO="test-owner/${TARGET_NAME_T}"

# ----------------------------------------------------------------------------
# Scenario 1: PO happy path → pwd == agent-cwd/po
# ----------------------------------------------------------------------------
ms="$(it_milestone_create "${REPO}" "cwd-test-po" "seeded body" 2>/dev/null)" \
  || { fail "seed milestone failed"; exit 1; }
it_milestone_set_state "${REPO}" "${ms}" PO_DRAFT 2>/dev/null \
  || { fail "set_state PO_DRAFT failed"; exit 1; }
pin="$(it_revision_pin_get "${REPO}" milestone "${ms}" 2>/dev/null)"

cat >"${TEST_FAKE_FIX_DIR}/po-Compose-PO.json" <<EOF
{
  "output_kind": "spec_proposal",
  "agent_role": "PO",
  "operation": "Compose-PO",
  "target_id": "${ms}",
  "manifest_id": "__MANIFEST_ID__",
  "input_revision_pins": [
    { "object_kind": "milestone", "object_id": "${ms}", "revision_pin": "${pin}" }
  ],
  "idempotency_key": "po-cwd-${ms}",
  "summary": "PO compose result",
  "artifacts": {
    "milestone_body": "Updated body",
    "cp_artifact_ref": "spec/po-cwd.md"
  }
}
EOF

: >"${TEST_PWD_LOG}"   # truncate

out="$(mktemp)"
if ! bash "${LLM_TEAM_ROOT}/scheduler/runner.sh" po "${TARGET_NAME_T}" >"${out}" 2>&1; then
  echo "--- runner output ---" >&2
  cat "${out}" >&2
  fail "scenario1: runner exited non-zero"
  rm -f "${out}"
  exit 1
fi
rm -f "${out}"

expected_cwd="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME_T}/agent-cwd/po"
captured="$(head -n1 "${TEST_PWD_LOG}" 2>/dev/null || true)"

if [ -z "${captured}" ]; then
  fail "scenario1: PWD log empty (fake adapter not invoked or PWD_LOG misconfigured)"
elif [ "${captured}" != "${expected_cwd}" ]; then
  fail "scenario1: pwd mismatch. expected='${expected_cwd}' got='${captured}'"
else
  pass "scenario1: PO lr_invoke pwd == agent-cwd/po"
fi

# Negative assertion: pwd must not be LLM_TEAM_ROOT
if [ "${captured}" = "${LLM_TEAM_ROOT}" ]; then
  fail "scenario1: pwd is framework root (LLM_TEAM_ROOT) — isolation broken"
fi

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} scenario(s) failed in test-runner-cwd" >&2
  exit 1
fi
echo "PASS: tests/scheduler/test-runner-cwd.sh"
