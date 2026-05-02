#!/usr/bin/env bash
# tests/cli/test-onboarding-gate.sh
#
# run / run-once / daemon start 의 hard gate 동작 검증.
#   - 미충족 target 으로 run/daemon start 호출 → exit 2.
#   - --dry-run 또는 --allow-incomplete-onboarding 또는
#     LLM_TEAM_SKIP_ONBOARDING_GATE=1 환경변수 시 우회.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/onb-gate-XXXXXX")"
cleanup() { rm -rf "${SANDBOX}" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "${SANDBOX}/targets" "${SANDBOX}/inputs" "${SANDBOX}/workdir" "${SANDBOX}/bin"
ln -s "${SOURCE_ROOT}/lib"          "${SANDBOX}/lib"
ln -s "${SOURCE_ROOT}/adapters"     "${SANDBOX}/adapters"
ln -s "${SOURCE_ROOT}/application"  "${SANDBOX}/application"
ln -s "${SOURCE_ROOT}/scheduler"    "${SANDBOX}/scheduler"
ln -s "${SOURCE_ROOT}/scripts"      "${SANDBOX}/scripts"
ln -s "${SOURCE_ROOT}/prompts"      "${SANDBOX}/prompts"
ln -s "${SOURCE_ROOT}/bin/llm-team" "${SANDBOX}/bin/llm-team"

export LLM_TEAM_ROOT="${SANDBOX}"

# stub gh / claude
mkdir -p "${SANDBOX}/stub-bin"
cat >"${SANDBOX}/stub-bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  auth) [ "$2" = "status" ] && { printf "scopes: 'repo'\n"; exit 0; }; exit 0 ;;
  api) exit 0 ;;
  label) printf '[]\n'; exit 0 ;;
esac
exit 0
STUB
chmod +x "${SANDBOX}/stub-bin/gh"
cat >"${SANDBOX}/stub-bin/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "${SANDBOX}/stub-bin/claude"
export PATH="${SANDBOX}/stub-bin:${PATH}"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

TARGET="gate-test"
cat >"${SANDBOX}/targets/${TARGET}.yaml" <<EOF
name: ${TARGET}
github:
  owner: example
  repo: ${TARGET}
  default_branch: main
local:
  clone_path: ""
inputs_dir: inputs/${TARGET}
labels:
  prefix: ""
notifier:
  channel: none
  webhook_or_id: ""
dev_concurrency: 3
stale_threshold_minutes: 60
enabled: true
onboarding:
  schema: github-pipeline/v1
  self_hosting: false
  acks: {}
EOF

CLI="${SANDBOX}/bin/llm-team"

# ---------------------------------------------------------------------------
# (1) run: 미충족 → exit 2.
# ---------------------------------------------------------------------------
set +e
out="$("${CLI}" run po "${TARGET}" 2>&1)"
rc=$?
set -e
[ "${rc}" = "2" ] || fail "run: expected exit 2 on incomplete onboarding, got ${rc}"
printf '%s\n' "${out}" | grep -q "onboarding gate FAILED" \
  || fail "run: missing 'onboarding gate FAILED' message"
pass "run: hard gate blocks incomplete onboarding"

# ---------------------------------------------------------------------------
# (2) run --dry-run: 게이트 우회.
# ---------------------------------------------------------------------------
set +e
out="$("${CLI}" run po "${TARGET}" --dry-run 2>&1)"
rc=$?
set -e
# dry-run 은 실제 작업 흐름에 들어가므로 rc=0 이거나 다른 비-게이트 사유 (manifest 등).
# 핵심: "onboarding gate FAILED" 가 출력에 없어야 한다.
printf '%s\n' "${out}" | grep -q "onboarding gate FAILED" \
  && fail "run --dry-run: gate should be bypassed but FAILED message present"
pass "run --dry-run: gate bypassed"

# ---------------------------------------------------------------------------
# (3) run --allow-incomplete-onboarding: 게이트 우회 + warn.
# ---------------------------------------------------------------------------
set +e
out="$("${CLI}" run po "${TARGET}" --allow-incomplete-onboarding 2>&1)"
rc=$?
set -e
printf '%s\n' "${out}" | grep -q "onboarding gate bypassed" \
  || fail "run --allow-incomplete-onboarding: missing bypass warn"
pass "run --allow-incomplete-onboarding: bypass + warn"

# ---------------------------------------------------------------------------
# (4) LLM_TEAM_SKIP_ONBOARDING_GATE=1 env: 게이트 우회.
# ---------------------------------------------------------------------------
set +e
out="$(LLM_TEAM_SKIP_ONBOARDING_GATE=1 "${CLI}" run po "${TARGET}" 2>&1)"
rc=$?
set -e
printf '%s\n' "${out}" | grep -q "onboarding gate FAILED" \
  && fail "env bypass: gate should be skipped"
printf '%s\n' "${out}" | grep -q "onboarding gate bypassed" \
  || fail "env bypass: missing bypass warn"
pass "LLM_TEAM_SKIP_ONBOARDING_GATE=1: bypass"

# ---------------------------------------------------------------------------
# (5) run-once: 미충족 → exit 2.
# ---------------------------------------------------------------------------
set +e
out="$("${CLI}" run-once "${TARGET}" --roles po 2>&1)"
rc=$?
set -e
[ "${rc}" = "2" ] || fail "run-once: expected exit 2, got ${rc}"
pass "run-once: hard gate blocks"

set +e
out="$("${CLI}" run-once "${TARGET}" --roles po --dry-run 2>&1)"
rc=$?
set -e
printf '%s\n' "${out}" | grep -q "onboarding gate FAILED" \
  && fail "run-once --dry-run: should bypass"
pass "run-once --dry-run: bypass"

# ---------------------------------------------------------------------------
# (6) daemon start: 미충족 → exit 2.
# ---------------------------------------------------------------------------
set +e
out="$("${CLI}" daemon start "${TARGET}" --role po --interval 60 2>&1)"
rc=$?
set -e
[ "${rc}" = "2" ] || fail "daemon start: expected exit 2, got ${rc} out=${out}"
printf '%s\n' "${out}" | grep -q "onboarding gate FAILED" \
  || fail "daemon start: missing FAILED message"
pass "daemon start: hard gate blocks"

# ---------------------------------------------------------------------------
# (7) ack 보충 후 daemon start dry-run 유사 호출 — 사실 daemon start 는
#     실제 프로세스를 띄우므로 종료 후 stop 으로 정리.
# ---------------------------------------------------------------------------
# 모든 fail 항목 보충: workdir scaffold + clone + ack 들.
WD="${SANDBOX}/workdir/${TARGET}"
mkdir -p "${WD}/manifests" "${WD}/leases" "${WD}/ledger" "${WD}/wt" "${WD}/change-proposals"
mkdir -p "${WD}/agent-cwd/po" "${WD}/agent-cwd/pm" "${WD}/agent-cwd/planner"
mkdir -p "${WD}/repo/.git"
mkdir -p "${SANDBOX}/inputs/${TARGET}" && echo seed >"${SANDBOX}/inputs/${TARGET}/seed.txt"
yq -i '
  .onboarding.acks.use_default_branch_as_integration = {"value": true} |
  .onboarding.acks.branch_protection_policy_decided = {"value": true} |
  .onboarding.acks.intentionally_silent = {"value": true}
' "${SANDBOX}/targets/${TARGET}.yaml"
# labels stub: present
cat >"${SANDBOX}/stub-bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  auth) [ "$2" = "status" ] && { printf "scopes: 'repo'\n"; exit 0; }; exit 0 ;;
  api) exit 0 ;;
  label)
    name=""; for ((i=1;i<=$#;i++)); do
      if [ "${!i}" = "--search" ]; then j=$((i+1)); name="${!j}"; break; fi
    done
    printf '[{"name":"%s"}]\n' "${name}"; exit 0 ;;
esac
exit 0
STUB
chmod +x "${SANDBOX}/stub-bin/gh"

set +e
out="$("${CLI}" onboarding status "${TARGET}" --quiet 2>&1)"
rc=$?
set -e
[ "${rc}" = "0" ] || fail "post-fix status: expected rc=0, got ${rc}"
pass "post-fix: onboarding status PASS"

set +e
out="$("${CLI}" run po "${TARGET}" --dry-run 2>&1)"
rc=$?
set -e
printf '%s\n' "${out}" | grep -q "onboarding gate FAILED" \
  && fail "post-fix run: should not be blocked"
pass "post-fix: run --dry-run no gate FAILED"

# ---------------------------------------------------------------------------
if [ "${failures}" -gt 0 ]; then
  echo "FAILURES: ${failures}" >&2
  exit 1
fi
echo "PASS: onboarding gate"
