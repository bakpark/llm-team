#!/usr/bin/env bash
# Local prerequisite and target checks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team doctor [target]
EOF
}

failures=0
warnings=0

ok() {
  printf 'OK: %s\n' "$*"
}

warn() {
  warnings=$((warnings + 1))
  printf 'WARN: %s\n' "$*"
}

fail() {
  failures=$((failures + 1))
  printf 'FAIL: %s\n' "$*"
}

check_cmd_required() {
  local cmd="$1"
  if command -v "${cmd}" >/dev/null 2>&1; then
    ok "${cmd} found"
  else
    fail "${cmd} not found"
  fi
}

check_cmd_optional() {
  local cmd="$1"
  if command -v "${cmd}" >/dev/null 2>&1; then
    ok "${cmd} found"
  else
    warn "${cmd} not found"
  fi
}

check_target() {
  local target="$1" file name owner repo branch enabled prompt role
  if ! cli_validate_target_name "${target}"; then
    fail "invalid target name: ${target}"
    return
  fi
  file="$(cli_target_file "${target}")"
  if [ ! -f "${file}" ]; then
    fail "target file missing: ${file}"
    return
  fi
  ok "target file found: ${file}"
  if ! command -v yq >/dev/null 2>&1; then
    fail "cannot inspect target without yq"
    return
  fi
  name="$(yq -r '.name // ""' "${file}")"
  owner="$(yq -r '.github.owner // ""' "${file}")"
  repo="$(yq -r '.github.repo // ""' "${file}")"
  branch="$(yq -r '.github.default_branch // "main"' "${file}")"
  enabled="$(yq -r '.enabled // false' "${file}")"
  [ -n "${name}" ] || fail "target .name is empty"
  [ -n "${owner}" ] || fail "target .github.owner is empty"
  [ -n "${repo}" ] || fail "target .github.repo is empty"
  [ -n "${branch}" ] || fail "target .github.default_branch is empty"
  ok "target repo=${owner}/${repo} branch=${branch} enabled=${enabled}"

  for role in "${CLI_ROLES[@]}"; do
    prompt="${LLM_TEAM_ROOT}/prompts/${role}.md"
    [ -f "${prompt}" ] || fail "missing prompt: ${prompt}"
  done
}

target=""
case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  '')
    ;;
  *)
    target="$1"
    ;;
esac

check_cmd_required bash
check_cmd_required jq
check_cmd_required yq
check_cmd_optional gh
check_cmd_optional claude

if mkdir -p "${LLM_TEAM_ROOT}/workdir" >/dev/null 2>&1 && [ -w "${LLM_TEAM_ROOT}/workdir" ]; then
  ok "workdir writable"
else
  fail "workdir is not writable: ${LLM_TEAM_ROOT}/workdir"
fi

if [ -n "${target}" ]; then
  check_target "${target}"
fi

if [ "${failures}" -gt 0 ]; then
  printf 'Doctor: FAIL (%d failure(s), %d warning(s))\n' "${failures}" "${warnings}"
  exit 1
fi

printf 'Doctor: OK (%d warning(s))\n' "${warnings}"
