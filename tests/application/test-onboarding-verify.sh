#!/usr/bin/env bash
# tests/application/test-onboarding-verify.sh
#
# application/onboarding/verify.sh + checklists/github_pipeline_v1.sh 의
# 검증 엔진을 격리된 LLM_TEAM_ROOT 안에서 직접 호출하여 검증한다.
#
# 검증 항목:
#   1. 새로 만든 비어있는 fixture target 은 다수 항목이 FAIL → exit 2.
#   2. 누락 보충 (workdir scaffold, inputs seed, ack 추가) 후 exit 0 가능.
#   3. severity=warn 항목의 FAIL 은 WARN 으로 down-grade 되어 block 카운터에서 제외.
#   4. self_hosting_only 항목은 onboarding.self_hosting=true 일 때만 평가.
#   5. auto_or_ack 항목은 ack 만으로도 PASS.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# 격리된 LLM_TEAM_ROOT 를 임시 디렉토리에 구성: 필요한 파일만 심볼릭 링크.
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/onb-verify-XXXXXX")"
cleanup() { rm -rf "${SANDBOX}" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "${SANDBOX}/targets" "${SANDBOX}/inputs" "${SANDBOX}/workdir"
ln -s "${SOURCE_ROOT}/lib"          "${SANDBOX}/lib"
ln -s "${SOURCE_ROOT}/adapters"     "${SANDBOX}/adapters"
ln -s "${SOURCE_ROOT}/application"  "${SANDBOX}/application"
ln -s "${SOURCE_ROOT}/scripts"      "${SANDBOX}/scripts"
ln -s "${SOURCE_ROOT}/prompts"      "${SANDBOX}/prompts"

export LLM_TEAM_ROOT="${SANDBOX}"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

# --- gh / 외부 명령 stub --------------------------------------------------
# 테스트에서는 gh 를 호출하지 않도록 모든 외부 IO 를 함수 override 로 차단.
# 외부 IO 대신 내부 변수 GH_REPO_OK / GH_TOKEN_HAS_REPO / GH_LABELS_HAVE /
# GH_BRANCH_HAS 로 응답을 흉내낸다.
GH_REPO_OK=1
GH_TOKEN_HAS_REPO=1
GH_LABELS_HAVE=1
GH_BRANCH_HAS=1

gh() {
  case "$1" in
    api)
      # Skip gh-flag args (--paginate, --jq <expr>, --silent, ...) so the
      # endpoint is consistently $2 regardless of caller-side flag ordering.
      shift
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --paginate|--silent) shift ;;
          --jq|-X|-H|-f|-F) shift 2 ;;
          *) break ;;
        esac
      done
      local endpoint="${1:-}"
      case "${endpoint}" in
        repos/*/branches/*)
          [ "${GH_BRANCH_HAS}" = "1" ] && return 0 || return 1
          ;;
        repos/*/labels)
          if [ "${GH_LABELS_HAVE}" = "1" ]; then
            # _check_labels_bootstrap_done extracts names via --jq '.[].name';
            # emit one name per line — that matches the post-jq stdout shape.
            printf 'task:ready\ncp:ready-for-review\nhuman-gate:po\npaused\nfeature-request\n'
            return 0
          fi
          printf ''
          return 0
          ;;
        repos/*)
          [ "${GH_REPO_OK}" = "1" ] && return 0 || return 1
          ;;
      esac
      return 0
      ;;
    auth)
      if [ "$2" = "status" ]; then
        if [ "${GH_TOKEN_HAS_REPO}" = "1" ]; then
          printf "Logged in to github.com\n  scopes: 'repo, read:org'\n"
          return 0
        fi
        printf 'not logged in\n' >&2
        return 1
      fi
      return 0
      ;;
    label)
      # `gh label list --repo R --search NAME --json name`
      if [ "${GH_LABELS_HAVE}" = "1" ]; then
        # search 값을 그대로 반복해 emit (preset check 가 grep 으로 매칭)
        # arguments: list --repo R --search NAME --json name
        local i name=""
        for ((i=1; i<=$#; i++)); do
          if [ "${!i}" = "--search" ]; then
            local j=$((i+1))
            name="${!j}"
            break
          fi
        done
        printf '[{"name":"%s"}]\n' "${name}"
        return 0
      fi
      printf '[]\n'
      return 0
      ;;
  esac
  return 0
}
export -f gh

# claude 도 stub (doctor_dependencies 항목용)
claude() { return 0; }
export -f claude

# ---------------------------------------------------------------------------
# fixture: target.yaml + workdir + inputs
# ---------------------------------------------------------------------------
TARGET="onb-test"
TARGET_YAML="${SANDBOX}/targets/${TARGET}.yaml"
cat >"${TARGET_YAML}" <<EOF
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

# 일부러 workdir scaffold 를 만들지 않음 → target_init_scaffold FAIL 유도.
# canonical_clone_present 도 FAIL.

# ---------------------------------------------------------------------------
# load engine
# ---------------------------------------------------------------------------
# shellcheck source=../../application/onboarding/verify.sh
. "${SANDBOX}/application/onboarding/verify.sh"

run_verify() {
  local _out_var="$1" _rc_var="$2"
  local _tmp _rc_value _out_value
  _tmp="$(mktemp "${TMPDIR:-/tmp}/onb-out-XXXXXX")"
  set +e
  onboarding_verify "${TARGET}" >"${_tmp}" 2>/dev/null
  _rc_value=$?
  set -e
  _out_value="$(cat "${_tmp}")"
  printf -v "${_out_var}" '%s' "${_out_value}"
  printf -v "${_rc_var}" '%s' "${_rc_value}"
  rm -f "${_tmp}"
}

# ---------------------------------------------------------------------------
# (1) 빈 fixture: 다수 FAIL, exit 2.
# ---------------------------------------------------------------------------
run_verify out rc
if [ "${rc}" != "2" ]; then
  fail "case 1: expected rc=2 on bare target, got rc=${rc}"
  printf '%s\n' "${out}"
fi

# id 별 status 추출 helper
status_of() {
  printf '%s\n' "${out}" | awk -F'\t' -v id="$1" '$2==id {print $1}'
}

# 핵심 FAIL 들이 보이는지
for id in target_init_scaffold canonical_clone_present \
          branch_protection_policy_decided notifier_channel_decided; do
  s="$(status_of "${id}")"
  [ "${s}" = "FAIL" ] || fail "case 1: ${id} expected FAIL, got '${s}'"
done

# warn 항목은 WARN 으로 down-grade 되어야
s="$(status_of "inputs_dir_seeded")"
[ "${s}" = "WARN" ] || fail "case 1: inputs_dir_seeded expected WARN (severity=warn), got '${s}'"

s="$(status_of "dev_concurrency_reviewed")"
[ "${s}" = "WARN" ] || fail "case 1: dev_concurrency_reviewed expected WARN, got '${s}'"

# self_hosting_only 항목은 SKIP
s="$(status_of "amendment_policy_acknowledged")"
[ "${s}" = "SKIP" ] || fail "case 1: amendment_policy_acknowledged expected SKIP (self_hosting=false), got '${s}'"

s="$(status_of "ci_workflow_loop_guard")"
[ "${s}" = "SKIP" ] || fail "case 1: ci_workflow_loop_guard expected SKIP, got '${s}'"

pass "case 1: bare target → rc=2 with expected FAIL/WARN/SKIP mix"

# ---------------------------------------------------------------------------
# (2) workdir scaffold + canonical clone fixture + ack 보충 → rc=0.
# ---------------------------------------------------------------------------
WD="${SANDBOX}/workdir/${TARGET}"
mkdir -p "${WD}/manifests" "${WD}/leases" "${WD}/ledger" \
         "${WD}/wt" "${WD}/change-proposals" \
         "${WD}/agent-cwd/po" "${WD}/agent-cwd/pm" "${WD}/agent-cwd/planner"
# canonical clone fake
mkdir -p "${WD}/repo/.git"

# inputs seed (warn 가 PASS 가 되도록)
mkdir -p "${SANDBOX}/inputs/${TARGET}"
echo "seed" >"${SANDBOX}/inputs/${TARGET}/seed.txt"

# ack 보충: yq 로 nested 추가
yq -i '
  .onboarding.acks.branch_protection_policy_decided = {"value": true, "note": "test"} |
  .onboarding.acks.use_default_branch_as_integration = {"value": true} |
  .onboarding.acks.intentionally_silent = {"value": true}
' "${TARGET_YAML}"

# integration_branch_present 는 ack 로 면제, gh 호출은 stub 로 PASS 도 가능.
# notifier_channel_decided 도 ack 로 면제.

run_verify out rc
if [ "${rc}" != "0" ]; then
  fail "case 2: expected rc=0 after fixes, got rc=${rc}"
  printf '%s\n' "${out}"
fi

s="$(status_of "branch_protection_policy_decided")"
[ "${s}" = "PASS" ] || fail "case 2: branch_protection_policy_decided expected PASS via ack, got '${s}'"

s="$(status_of "notifier_channel_decided")"
[ "${s}" = "PASS" ] || fail "case 2: notifier_channel_decided expected PASS via ack, got '${s}'"

s="$(status_of "inputs_dir_seeded")"
[ "${s}" = "PASS" ] || fail "case 2: inputs_dir_seeded expected PASS after seed, got '${s}'"

pass "case 2: scaffold+ack 후 rc=0"

# ---------------------------------------------------------------------------
# (3) self_hosting=true 시 self-hosting 항목이 평가됨.
# ---------------------------------------------------------------------------
yq -i '.onboarding.self_hosting = true' "${TARGET_YAML}"

run_verify out rc
# amendment_policy_acknowledged 가 ack 없어 FAIL
s="$(status_of "amendment_policy_acknowledged")"
[ "${s}" = "FAIL" ] || fail "case 3: amendment_policy_acknowledged expected FAIL when self_hosting+no ack, got '${s}'"

# ci_workflow_loop_guard 는 .github/workflows 부재 → auto check PASS
s="$(status_of "ci_workflow_loop_guard")"
[ "${s}" = "PASS" ] || fail "case 3: ci_workflow_loop_guard expected PASS (no workflows dir), got '${s}'"

[ "${rc}" = "2" ] || fail "case 3: expected rc=2 with self_hosting+missing ack, got rc=${rc}"
pass "case 3: self_hosting flag flips evaluation of conditional items"

# ack 추가 후 rc=0 회복
yq -i '.onboarding.acks.amendment_policy_acknowledged = {"value": true}' "${TARGET_YAML}"
run_verify out rc
[ "${rc}" = "0" ] || fail "case 3b: expected rc=0 after amendment ack, got rc=${rc}"
pass "case 3b: amendment ack 추가 후 rc=0"

# ---------------------------------------------------------------------------
# (4) gh stub 변경 — token 스코프 부족 시 FAIL.
# ---------------------------------------------------------------------------
GH_TOKEN_HAS_REPO=0
run_verify out rc
s="$(status_of "gh_token_scopes_sufficient")"
[ "${s}" = "FAIL" ] || fail "case 4: gh_token_scopes_sufficient expected FAIL when scope missing, got '${s}'"
[ "${rc}" = "2" ] || fail "case 4: expected rc=2 when token scope missing, got rc=${rc}"
GH_TOKEN_HAS_REPO=1
pass "case 4: gh token 스코프 누락 시 FAIL"

# ---------------------------------------------------------------------------
# (5) auto_or_ack: 자동 PASS 일 때 ack 없어도 PASS.
# ---------------------------------------------------------------------------
yq -i 'del(.onboarding.acks.use_default_branch_as_integration)' "${TARGET_YAML}"
GH_BRANCH_HAS=1
run_verify out rc
s="$(status_of "integration_branch_present")"
[ "${s}" = "PASS" ] || fail "case 5: integration_branch_present expected PASS via auto, got '${s}'"
[ "${rc}" = "0" ] || fail "case 5: expected rc=0 when auto passes, got rc=${rc}"
pass "case 5: auto_or_ack — auto PASS 만으로 충분"

# auto FAIL + ack 없음 → FAIL
GH_BRANCH_HAS=0
run_verify out rc
s="$(status_of "integration_branch_present")"
[ "${s}" = "FAIL" ] || fail "case 5b: integration_branch_present expected FAIL when neither auto nor ack, got '${s}'"
[ "${rc}" = "2" ] || fail "case 5b: expected rc=2, got rc=${rc}"
pass "case 5b: auto FAIL + ack 없음 → FAIL"

# ---------------------------------------------------------------------------
# (6) inputs_dir_seeded: .gitkeep / 빈 파일만으로는 PASS 가 아니어야 함.
# ---------------------------------------------------------------------------
# auto/ack 회복 (case 5b 잔존 상태 정리).
GH_BRANCH_HAS=1
yq -i '.onboarding.acks.use_default_branch_as_integration = {"value": true}' "${TARGET_YAML}"

# inputs 디렉토리를 placeholder 만 있는 상태로 재구성.
rm -rf "${SANDBOX}/inputs/${TARGET}"
mkdir -p "${SANDBOX}/inputs/${TARGET}"
: >"${SANDBOX}/inputs/${TARGET}/.gitkeep"
: >"${SANDBOX}/inputs/${TARGET}/empty.txt"

run_verify out rc
s="$(status_of "inputs_dir_seeded")"
[ "${s}" = "WARN" ] \
  || fail "case 6a: inputs_dir_seeded expected WARN with only placeholders, got '${s}'"
pass "case 6a: .gitkeep + 빈 파일만 있으면 WARN (placeholder 무시)"

# 실 콘텐츠 파일 추가 시 PASS 회복.
echo "real content" >"${SANDBOX}/inputs/${TARGET}/auth.md"
run_verify out rc
s="$(status_of "inputs_dir_seeded")"
[ "${s}" = "PASS" ] \
  || fail "case 6b: inputs_dir_seeded expected PASS after content file, got '${s}'"
pass "case 6b: 콘텐츠 파일 추가 후 PASS 회복"

# ---------------------------------------------------------------------------
# (7) ci_workflow_loop_guard: 안전한 트리거만 있으면 자동 PASS,
#     pull_request_target 가 있으면 ack 요구.
# ---------------------------------------------------------------------------
# self_hosting=true 상태 유지 (case 3 에서 이미 활성). amendment ack 도 활성.
mkdir -p "${WD}/repo/.github/workflows"
cat >"${WD}/repo/.github/workflows/ci.yml" <<'YAML'
name: ci
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
YAML

run_verify out rc
s="$(status_of "ci_workflow_loop_guard")"
[ "${s}" = "PASS" ] \
  || fail "case 7a: ci_workflow_loop_guard expected PASS with safe triggers, got '${s}'"
pass "case 7a: 안전한 트리거(push/pull_request) → 자동 PASS"

# 위험 트리거 추가 (pull_request_target).
cat >"${WD}/repo/.github/workflows/danger.yml" <<'YAML'
name: danger
on:
  pull_request_target:
    types: [opened]
jobs:
  echo:
    runs-on: ubuntu-latest
    steps:
      - run: echo unsafe
YAML

run_verify out rc
s="$(status_of "ci_workflow_loop_guard")"
[ "${s}" = "FAIL" ] \
  || fail "case 7b: ci_workflow_loop_guard expected FAIL with pull_request_target, got '${s}'"
pass "case 7b: pull_request_target 발견 시 ack 요구"

# ack 추가 시 PASS.
yq -i '.onboarding.acks.ci_workflow_loop_guard_decided = {"value": true}' "${TARGET_YAML}"
run_verify out rc
s="$(status_of "ci_workflow_loop_guard")"
[ "${s}" = "PASS" ] \
  || fail "case 7c: ci_workflow_loop_guard expected PASS via ack, got '${s}'"
pass "case 7c: ack 후 PASS 회복"

# 정리: 위험 워크플로우 제거 후 ack 없이도 PASS.
rm -f "${WD}/repo/.github/workflows/danger.yml"
yq -i 'del(.onboarding.acks.ci_workflow_loop_guard_decided)' "${TARGET_YAML}"
run_verify out rc
s="$(status_of "ci_workflow_loop_guard")"
[ "${s}" = "PASS" ] \
  || fail "case 7d: ci_workflow_loop_guard expected PASS after removing risky workflow, got '${s}'"
pass "case 7d: 위험 트리거 제거 시 ack 없이도 PASS"

# ---------------------------------------------------------------------------
if [ "${failures}" -gt 0 ]; then
  echo "FAILURES: ${failures}" >&2
  exit 1
fi
echo "PASS: onboarding_verify"
