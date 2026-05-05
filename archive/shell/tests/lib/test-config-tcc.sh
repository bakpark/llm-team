#!/usr/bin/env bash
# tests/lib/test-config-tcc.sh
#
# TCC (target-config-contract) loader semantics — Phase G:
#
#   1. load_target exports TCC-IDENTITY 3 fields (P1-10):
#      TARGET_ID, TARGET_PERSISTENT_STORE_REF, TARGET_LABEL_PREFIX.
#      Falls back to (.name, .github.{owner,repo}) when explicit fields are
#      absent (migration grace).
#   2. load_target exports TCC-LEASE-CONFIG (P1-9):
#      TARGET_LEASE_TTL_DEFAULT (sec, ≥1) and TARGET_LEASE_TTL_BY_ROLE_JSON.
#   3. load_target exports TCC-AGENT-RUNNER-MAP (P1-9):
#      TARGET_AGENT_RUNNER_DEFAULT and TARGET_AGENT_RUNNER_BY_ROLE_JSON.
#   4. config_lease_ttl_for_role obeys TCC-PRECEDENCE (env > by_role > default).
#   5. config_agent_runner_for_role obeys TCC-AGENT-RUNNER-MAP (by_role > default).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

TARGET_NAME_T="tcc-loader-$$"
TEST_TARGET_YAML="${LLM_TEAM_ROOT}/targets/${TARGET_NAME_T}.yaml"
cleanup() { rm -f "${TEST_TARGET_YAML}" 2>/dev/null || true; }
trap cleanup EXIT

cat >"${TEST_TARGET_YAML}" <<EOF
name: ${TARGET_NAME_T}
target_id: ${TARGET_NAME_T}
persistent_store_ref: acme/widgets
github:
  owner: acme
  repo: widgets
  default_branch: main
local:
  clone_path: ""
inputs_dir: inputs/${TARGET_NAME_T}
labels:
  prefix: "lt-"
notifier:
  channel: none
  webhook_or_id: ""
dev_concurrency: 1
stale_threshold_minutes: 60
lease:
  ttl_default: 1800
  ttl_by_role:
    Coder: 900
    qa: 7200
agent_runner:
  default: claude_code
  by_role:
    Coder: fake
    qa: fake
verification:
  commands: ["true"]
enabled: true
onboarding:
  preset: github-pipeline/v1
  skip_flags: []
  acks: {}
EOF

# Reset target vars before load.
unset TARGET_ID TARGET_PERSISTENT_STORE_REF TARGET_LEASE_TTL_DEFAULT \
      TARGET_LEASE_TTL_BY_ROLE_JSON TARGET_AGENT_RUNNER_DEFAULT \
      TARGET_AGENT_RUNNER_BY_ROLE_JSON LLM_TEAM_LEASE_TTL

load_target "${TARGET_NAME_T}" >/dev/null \
  || { fail "load_target failed"; exit 1; }

# ── (1) TCC-IDENTITY ──────────────────────────────────────────────────────
[ "${TARGET_ID}" = "${TARGET_NAME_T}" ] \
  || fail "TARGET_ID expected '${TARGET_NAME_T}', got '${TARGET_ID}'"
[ "${TARGET_PERSISTENT_STORE_REF}" = "acme/widgets" ] \
  || fail "TARGET_PERSISTENT_STORE_REF expected 'acme/widgets', got '${TARGET_PERSISTENT_STORE_REF}'"
[ "${TARGET_LABEL_PREFIX}" = "lt-" ] \
  || fail "TARGET_LABEL_PREFIX expected 'lt-', got '${TARGET_LABEL_PREFIX}'"

# ── (2) TCC-LEASE-CONFIG ──────────────────────────────────────────────────
[ "${TARGET_LEASE_TTL_DEFAULT}" = "1800" ] \
  || fail "TARGET_LEASE_TTL_DEFAULT expected '1800', got '${TARGET_LEASE_TTL_DEFAULT}'"
echo "${TARGET_LEASE_TTL_BY_ROLE_JSON}" | jq -e '.Coder == 900 and .qa == 7200' >/dev/null \
  || fail "TARGET_LEASE_TTL_BY_ROLE_JSON unexpected: ${TARGET_LEASE_TTL_BY_ROLE_JSON}"

# ── (3) TCC-AGENT-RUNNER-MAP ──────────────────────────────────────────────
[ "${TARGET_AGENT_RUNNER_DEFAULT}" = "claude_code" ] \
  || fail "TARGET_AGENT_RUNNER_DEFAULT expected 'claude_code', got '${TARGET_AGENT_RUNNER_DEFAULT}'"
echo "${TARGET_AGENT_RUNNER_BY_ROLE_JSON}" | jq -e '.Coder == "fake" and .qa == "fake"' >/dev/null \
  || fail "TARGET_AGENT_RUNNER_BY_ROLE_JSON unexpected: ${TARGET_AGENT_RUNNER_BY_ROLE_JSON}"

# ── (4) config_lease_ttl_for_role precedence ──────────────────────────────
ttl_coder="$(config_lease_ttl_for_role Coder)"
[ "${ttl_coder}" = "900" ] || fail "lease ttl Coder expected 900, got '${ttl_coder}'"
ttl_qa_lower="$(config_lease_ttl_for_role qa)"
[ "${ttl_qa_lower}" = "7200" ] || fail "lease ttl qa expected 7200, got '${ttl_qa_lower}'"
ttl_qa_upper="$(config_lease_ttl_for_role QA)"
[ "${ttl_qa_upper}" = "7200" ] || fail "lease ttl QA (case-insensitive) expected 7200, got '${ttl_qa_upper}'"
ttl_planner="$(config_lease_ttl_for_role Planner)"
[ "${ttl_planner}" = "1800" ] || fail "lease ttl Planner (default) expected 1800, got '${ttl_planner}'"

# Env override beats by_role.
LLM_TEAM_LEASE_TTL=42 ttl_env="$(config_lease_ttl_for_role Coder)"
[ "${ttl_env}" = "42" ] \
  || fail "LLM_TEAM_LEASE_TTL env override should win over by_role (got '${ttl_env}')"

# ── (5) config_agent_runner_for_role precedence ───────────────────────────
ar_coder="$(config_agent_runner_for_role Coder)"
[ "${ar_coder}" = "fake" ] || fail "agent_runner Coder expected 'fake', got '${ar_coder}'"
ar_planner="$(config_agent_runner_for_role Planner)"
[ "${ar_planner}" = "claude_code" ] || fail "agent_runner Planner (default) expected 'claude_code', got '${ar_planner}'"

# ── (6) Migration fallback: yaml without identity 3-field falls back ──────
LEGACY_YAML="${LLM_TEAM_ROOT}/targets/${TARGET_NAME_T}-legacy.yaml"
cat >"${LEGACY_YAML}" <<EOF
name: ${TARGET_NAME_T}-legacy
github:
  owner: legacy-owner
  repo: legacy-repo
  default_branch: main
local:
  clone_path: ""
inputs_dir: inputs/${TARGET_NAME_T}-legacy
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
onboarding:
  schema: github-pipeline/v1
  acks: {}
EOF

unset TARGET_ID TARGET_PERSISTENT_STORE_REF
load_target "${TARGET_NAME_T}-legacy" >/dev/null \
  || fail "legacy load_target failed"
[ "${TARGET_ID}" = "${TARGET_NAME_T}-legacy" ] \
  || fail "legacy TARGET_ID fallback to .name failed (got '${TARGET_ID}')"
[ "${TARGET_PERSISTENT_STORE_REF}" = "legacy-owner/legacy-repo" ] \
  || fail "legacy TARGET_PERSISTENT_STORE_REF fallback failed (got '${TARGET_PERSISTENT_STORE_REF}')"
[ "${TARGET_LEASE_TTL_DEFAULT}" = "3600" ] \
  || fail "legacy TARGET_LEASE_TTL_DEFAULT fallback to 3600 failed (got '${TARGET_LEASE_TTL_DEFAULT}')"
rm -f "${LEGACY_YAML}"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} TCC loader check(s) failed" >&2
  exit 1
fi

echo "PASS: TCC loader (identity + lease + agent_runner + precedence + legacy fallback)"
