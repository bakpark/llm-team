#!/usr/bin/env bash
# tests/cli/test-onboarding-cli.sh
#
# llm-team onboarding {status, ack, list-schemas} 의 CLI 표면을 격리된
# 임시 LLM_TEAM_ROOT 안에서 호출하여 검증한다.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/onb-cli-XXXXXX")"
cleanup() { rm -rf "${SANDBOX}" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "${SANDBOX}/targets" "${SANDBOX}/inputs" "${SANDBOX}/workdir" "${SANDBOX}/bin"
ln -s "${SOURCE_ROOT}/lib"          "${SANDBOX}/lib"
ln -s "${SOURCE_ROOT}/adapters"     "${SANDBOX}/adapters"
ln -s "${SOURCE_ROOT}/application"  "${SANDBOX}/application"
ln -s "${SOURCE_ROOT}/scripts"      "${SANDBOX}/scripts"
ln -s "${SOURCE_ROOT}/prompts"      "${SANDBOX}/prompts"
ln -s "${SOURCE_ROOT}/bin/llm-team" "${SANDBOX}/bin/llm-team"

export LLM_TEAM_ROOT="${SANDBOX}"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

# 외부 명령 stub: gh / claude 는 모두 성공으로 가정.
# 단, _check_github_repo_reachable / _check_integration_branch / _check_labels_bootstrap_done
# 등이 호출하는 gh 명령에서 'auth status' 와 'api', 'label list' 를 stub 한다.
mkdir -p "${SANDBOX}/stub-bin"
cat >"${SANDBOX}/stub-bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  auth)
    [ "$2" = "status" ] && { printf "Logged in to github.com\n  scopes: 'repo, read:org'\n"; exit 0; }
    exit 0 ;;
  api)
    case "$2" in
      repos/*/branches/*) [ "${GH_BRANCH_HAS:-1}" = "1" ] && exit 0 || exit 1 ;;
      repos/*) [ "${GH_REPO_OK:-1}" = "1" ] && exit 0 || exit 1 ;;
    esac
    exit 0 ;;
  label)
    # list --repo R --search NAME --json name
    name=""; for ((i=1;i<=$#;i++)); do
      if [ "${!i}" = "--search" ]; then j=$((i+1)); name="${!j}"; break; fi
    done
    [ "${GH_LABELS_HAVE:-1}" = "1" ] && printf '[{"name":"%s"}]\n' "${name}" || printf '[]\n'
    exit 0 ;;
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

# fixture target.
TARGET="cli-onb"
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
# (1) list-schemas
# ---------------------------------------------------------------------------
out="$("${CLI}" onboarding list-schemas 2>&1)" \
  || fail "list-schemas exited non-zero"
printf '%s\n' "${out}" | grep -q "github-pipeline/v1" \
  || fail "list-schemas: missing github-pipeline/v1"
printf '%s\n' "${out}" | grep -q "branch_protection_policy_decided" \
  || fail "list-schemas: missing branch_protection_policy_decided item"
pass "list-schemas"

# ---------------------------------------------------------------------------
# (2) status: 빈 fixture → exit 2.
# ---------------------------------------------------------------------------
set +e
out="$("${CLI}" onboarding status "${TARGET}" 2>&1)"
rc=$?
set -e
[ "${rc}" = "2" ] || fail "status: expected rc=2 on bare target, got ${rc}"
printf '%s\n' "${out}" | grep -q "fail (block)" \
  || fail "status: missing fail summary line"
pass "status: bare target → rc=2"

# ---------------------------------------------------------------------------
# (3) ack set / status PASS / unset / status FAIL.
# ---------------------------------------------------------------------------
"${CLI}" onboarding ack "${TARGET}" branch_protection_policy_decided --note "via cli test" >/dev/null \
  || fail "ack set failed"
yq -r '.onboarding.acks."branch_protection_policy_decided".value' \
  "${SANDBOX}/targets/${TARGET}.yaml" \
  | grep -q "^true$" \
  || fail "ack set: yaml not updated"
yq -r '.onboarding.acks."branch_protection_policy_decided".note' \
  "${SANDBOX}/targets/${TARGET}.yaml" \
  | grep -q "via cli test" \
  || fail "ack set: note not recorded"

set +e
out="$("${CLI}" onboarding status "${TARGET}" 2>&1)"
rc=$?
set -e
printf '%s\n' "${out}" | grep -E "^PASS\s+branch_protection_policy_decided" >/dev/null \
  || fail "status after ack: expected PASS line for branch_protection_policy_decided"

"${CLI}" onboarding ack "${TARGET}" branch_protection_policy_decided --unset >/dev/null \
  || fail "ack unset failed"
out="$(yq -r '.onboarding.acks | keys | length' "${SANDBOX}/targets/${TARGET}.yaml" 2>&1)"
[ "${out}" = "0" ] || fail "ack unset: acks not empty (got ${out})"
pass "ack set/unset roundtrip"

# ---------------------------------------------------------------------------
# (3b) ack --note 이스케이프: 백슬래시 / 큰따옴표 / 백슬래시-n 리터럴이
#      yaml round-trip 후에도 그대로 보존되어야 한다 (strenv 패턴).
# ---------------------------------------------------------------------------
note_cases=(
  $'backslash\\value'
  $'has "double quotes" inside'
  $'literal \\n not newline'
)
for nc in "${note_cases[@]}"; do
  "${CLI}" onboarding ack "${TARGET}" branch_protection_policy_decided --note "${nc}" \
    >/dev/null || fail "ack note roundtrip: set failed for ${nc}"
  got="$(yq -r '.onboarding.acks."branch_protection_policy_decided".note' \
    "${SANDBOX}/targets/${TARGET}.yaml")"
  if [ "${got}" != "${nc}" ]; then
    fail "ack note roundtrip mismatch: expected $'${nc}', got $'${got}'"
  fi
  "${CLI}" onboarding ack "${TARGET}" branch_protection_policy_decided --unset >/dev/null
done
pass "ack --note: backslash/quotes/literal escapes round-trip safely"

# ---------------------------------------------------------------------------
# (4) ack 키 검증: 잘못된 형식 거부.
# ---------------------------------------------------------------------------
set +e
"${CLI}" onboarding ack "${TARGET}" "bad key with space" >/dev/null 2>&1
rc=$?
set -e
[ "${rc}" -ne 0 ] || fail "ack: bad key should be rejected"
pass "ack: invalid key format rejected"

# ---------------------------------------------------------------------------
# (5) status --json: parsable, contains exit_code/items.
# ---------------------------------------------------------------------------
set +e
json="$("${CLI}" onboarding status "${TARGET}" --json 2>&1)"
set -e
echo "${json}" | jq -e '.exit_code == 2' >/dev/null \
  || fail "status --json: exit_code != 2"
echo "${json}" | jq -e '.items | length >= 16' >/dev/null \
  || fail "status --json: items length < 16"
echo "${json}" | jq -e '.items[] | select(.id == "branch_protection_policy_decided")' >/dev/null \
  || fail "status --json: missing branch_protection_policy_decided item"
pass "status --json"

# ---------------------------------------------------------------------------
# (6) status --quiet: no stdout, but rc=2.
# ---------------------------------------------------------------------------
set +e
out="$("${CLI}" onboarding status "${TARGET}" --quiet 2>&1)"
rc=$?
set -e
[ "${rc}" = "2" ] || fail "status --quiet: rc should still reflect verify result"
[ -z "${out}" ] || fail "status --quiet: expected empty stdout, got: ${out}"
pass "status --quiet"

# ---------------------------------------------------------------------------
# (7) target add 에 onboarding 섹션이 자동 생성되는지.
# ---------------------------------------------------------------------------
"${CLI}" target add cli-onb-add --repo example/cli-onb-add --self-hosting --disabled --force >/dev/null \
  || fail "target add --self-hosting failed"
[ "$(yq -r '.onboarding.schema' "${SANDBOX}/targets/cli-onb-add.yaml")" = "github-pipeline/v1" ] \
  || fail "target add: onboarding.schema not set"
[ "$(yq -r '.onboarding.self_hosting' "${SANDBOX}/targets/cli-onb-add.yaml")" = "true" ] \
  || fail "target add --self-hosting: self_hosting != true"
[ "$(yq -r '.onboarding.acks | length' "${SANDBOX}/targets/cli-onb-add.yaml")" = "0" ] \
  || fail "target add: onboarding.acks should be empty map"
pass "target add: onboarding section auto-generated"

# (8) wizard non-TTY 거부.
set +e
out="$("${CLI}" onboarding wizard "${TARGET}" </dev/null 2>&1)"
rc=$?
set -e
[ "${rc}" = "2" ] || fail "wizard non-tty: expected exit 2, got ${rc}"
printf '%s' "${out}" | grep -q "interactive TTY" \
  || fail "wizard non-tty: missing TTY message"
pass "wizard: non-TTY rejected"

# ---------------------------------------------------------------------------
if [ "${failures}" -gt 0 ]; then
  echo "FAILURES: ${failures}" >&2
  exit 1
fi
echo "PASS: onboarding CLI"
