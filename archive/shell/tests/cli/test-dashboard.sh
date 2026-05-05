#!/usr/bin/env bash
# tests/cli/test-dashboard.sh
#
# Integration test for `llm-team dashboard`:
#   • Generates HTML against a fixture target (manifests / leases / ledger /
#     change-proposals / logs).
#   • Verifies summary anchor, target anchor, HTML escaping of hostile data.
#   • Verifies --lines clamps log tail length.
#   • Runs with --no-github to avoid live network.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

TARGET_NAME="dashboard-test-$$"
TARGET_FILE="${LLM_TEAM_ROOT}/targets/${TARGET_NAME}.yaml"
TARGET_WORKDIR="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}"
OUT_FILE="$(mktemp -t dashboard.XXXXXX.html)"

cleanup() {
  rm -f "${TARGET_FILE}" "${OUT_FILE}" 2>/dev/null || true
  rm -rf "${TARGET_WORKDIR}" 2>/dev/null || true
}
trap cleanup EXIT

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# --- fixture: target yaml ---------------------------------------------------
mkdir -p "${LLM_TEAM_ROOT}/targets"
cat >"${TARGET_FILE}" <<EOF
name: ${TARGET_NAME}
github:
  owner: acme
  repo: dashboard-fixture
  default_branch: main
local:
  clone_path: /tmp/${TARGET_NAME}
inputs_dir: inputs/${TARGET_NAME}
labels:
  prefix: ""
notifier:
  channel: none
  webhook_or_id: ""
dev_concurrency: 1
stale_threshold_minutes: 60
enabled: true
EOF

# --- fixture: workdir contents ---------------------------------------------
mkdir -p \
  "${TARGET_WORKDIR}/manifests" \
  "${TARGET_WORKDIR}/leases" \
  "${TARGET_WORKDIR}/ledger" \
  "${TARGET_WORKDIR}/change-proposals" \
  "${TARGET_WORKDIR}/logs" \
  "${TARGET_WORKDIR}/daemon"

# Manifest with hostile string in target.id (escaping check).
HOSTILE='<script>alert(1)</script>'
cat >"${TARGET_WORKDIR}/manifests/m-test-1.json" <<EOF
{
  "manifest_id": "m-test-1",
  "operation": "spec_proposal",
  "target": {"kind": "milestone", "id": "${HOSTILE}"},
  "entries": [],
  "created_at": "2026-05-01T00:00:00Z"
}
EOF

# Active lease.
cat >"${TARGET_WORKDIR}/leases/42.json" <<'EOF'
{
  "lease_id": "lease-42",
  "object_id": "42",
  "operation": "patch",
  "worker_id": "coder-1",
  "claimed_at": "2026-05-01T01:00:00Z",
  "expires_at": "2026-05-01T01:15:00Z",
  "expires_epoch": 9999999999
}
EOF

# Ledger transitions.
LEDGER="${TARGET_WORKDIR}/ledger/transitions.jsonl"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  jq -nc --arg ts "${NOW}" '{
    transition_id:"tx-1",object_kind:"milestone",object_id:"7",
    from_state:"PO_DRAFT",to_state:"PO_GATE",operation:"spec_proposal",
    caller_id:"caller_dispatch",idempotency_key:"k1",manifest_id:"m-test-1",
    timestamp:$ts,result:"applied",duplicate:false
  }'
  jq -nc --arg ts "${NOW}" '{
    transition_id:"tx-2",object_kind:"task",object_id:"42",
    from_state:"TASK_READY",to_state:"TASK_REVIEW_READY",operation:"patch",
    caller_id:"caller_dispatch",idempotency_key:"k2",manifest_id:"m-test-1",
    timestamp:$ts,result:"applied",duplicate:false
  }'
} >"${LEDGER}"

# Change proposal (open).
cat >"${TARGET_WORKDIR}/change-proposals/cp-1.json" <<'EOF'
{
  "change_proposal_id": "cp-1",
  "cp_kind": "Code",
  "source_role": "Coder",
  "operation": "patch",
  "target_id": "42",
  "state": "CP_READY_FOR_REVIEW",
  "artifact_ref": "branch:llm-team/task-42",
  "created_at": "2026-05-01T00:00:00Z"
}
EOF
# Closed CP — should NOT appear in the open-CP table.
cat >"${TARGET_WORKDIR}/change-proposals/cp-old.json" <<'EOF'
{
  "change_proposal_id": "cp-old",
  "cp_kind": "Code",
  "source_role": "Coder",
  "operation": "patch",
  "target_id": "1",
  "state": "CP_MERGED",
  "artifact_ref": "branch:llm-team/task-1",
  "created_at": "2026-04-01T00:00:00Z"
}
EOF

# Agent log with 12 lines so we can verify --lines 5 truncation.
AGENT_LOG="${TARGET_WORKDIR}/logs/coder-20260501T000000Z.log"
{
  for i in $(seq 1 12); do
    printf 'agent log line %d\n' "${i}"
  done
} >"${AGENT_LOG}"

# Daemon log (target-scoped).
mkdir -p "${TARGET_WORKDIR}/daemon"
printf 'daemon line %s\n' alpha beta gamma >"${TARGET_WORKDIR}/daemon/coder.log"

# --- Run dashboard ----------------------------------------------------------
if ! "${LLM_TEAM_ROOT}/bin/llm-team" dashboard \
       --no-github --target "${TARGET_NAME}" \
       --lines 5 --out "${OUT_FILE}" >/dev/null 2>&1; then
  fail "dashboard command exited non-zero"
fi

[ -s "${OUT_FILE}" ] || fail "dashboard output file is empty: ${OUT_FILE}"

assert_contains() {
  local needle="$1" label="$2"
  if ! grep -Fq -- "${needle}" "${OUT_FILE}"; then
    fail "${label}: expected to contain '${needle}'"
  fi
}
assert_not_contains() {
  local needle="$1" label="$2"
  if grep -Fq -- "${needle}" "${OUT_FILE}"; then
    fail "${label}: expected NOT to contain '${needle}'"
  fi
}

assert_contains 'id="summary"'                       'summary anchor'
assert_contains "id=\"target-${TARGET_NAME}\""       'target anchor'
assert_contains 'TASK_REVIEW_READY'                   'pipeline row rendered'
assert_contains 'cp-1'                                'open CP listed'
assert_not_contains 'cp-old'                          'closed CP omitted'
assert_contains 'coder-1'                             'lease worker rendered'

# Hostile string must be escaped, not raw.
assert_not_contains '<script>alert(1)</script>'      'hostile script escaped'
assert_contains '&lt;script&gt;alert(1)&lt;/script&gt;' 'hostile string escaped'

# --lines 5 → at most 5 of the 12 agent lines.
agent_count="$(grep -c 'agent log line' "${OUT_FILE}" || true)"
[ "${agent_count}" -le 5 ] || fail "agent log lines: expected <=5 with --lines 5, got ${agent_count}"
[ "${agent_count}" -ge 1 ] || fail "agent log lines: expected >=1, got ${agent_count}"

# Daemon log should appear.
assert_contains 'daemon line alpha'                   'daemon log rendered'

# No JS — `<script>` should not appear (only escaped form may exist).
if grep -Fq '<script' "${OUT_FILE}"; then
  fail "raw <script tag present in output"
fi

if [ "${failures}" -eq 0 ]; then
  printf 'PASS tests/cli/test-dashboard.sh\n'
  exit 0
fi
printf 'FAIL tests/cli/test-dashboard.sh (failures=%d)\n' "${failures}" >&2
exit 1
