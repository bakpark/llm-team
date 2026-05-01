#!/usr/bin/env bash
# Shared helpers for llm-team CLI command modules.

if [ -n "${LLM_TEAM_CLI_COMMON_LOADED:-}" ]; then
  return 0
fi
LLM_TEAM_CLI_COMMON_LOADED=1

if [ -z "${LLM_TEAM_ROOT:-}" ]; then
  _cli_common_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  LLM_TEAM_ROOT="$(cd "${_cli_common_dir}/../.." && pwd)"
  export LLM_TEAM_ROOT
  unset _cli_common_dir
fi

CLI_ROLES=(po pm planner coder reviewer integrator qa)

cli_error() {
  printf 'ERROR: %s\n' "$*" >&2
}

cli_warn() {
  printf 'WARN: %s\n' "$*" >&2
}

cli_die() {
  local msg="$1" code="${2:-64}"
  cli_error "${msg}"
  exit "${code}"
}

cli_require_cmd() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || cli_die "required command not found: ${cmd}" 1
}

cli_source_runtime() {
  # shellcheck source=../../lib/common.sh
  . "${LLM_TEAM_ROOT}/lib/common.sh"
}

cli_target_file() {
  local target="$1"
  printf '%s/targets/%s.yaml' "${LLM_TEAM_ROOT}" "${target}"
}

cli_validate_target_name() {
  local target="$1"
  [ -n "${target}" ] || return 1
  printf '%s' "${target}" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'
}

cli_require_target_name() {
  local target="$1"
  cli_validate_target_name "${target}" || cli_die "invalid target name: ${target}"
}

cli_require_target_file() {
  local target="$1" file
  cli_require_target_name "${target}"
  file="$(cli_target_file "${target}")"
  [ -f "${file}" ] || cli_die "target not found: ${target}" 1
}

cli_role_is_valid() {
  local role="$1" item
  for item in "${CLI_ROLES[@]}"; do
    [ "${role}" = "${item}" ] && return 0
  done
  return 1
}

cli_expand_roles() {
  local spec="${1:-all}" role
  if [ "${spec}" = "all" ]; then
    printf '%s\n' "${CLI_ROLES[@]}"
    return 0
  fi
  printf '%s\n' "${spec}" | tr ',' '\n' | while IFS= read -r role; do
    [ -n "${role}" ] || continue
    role="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
    cli_role_is_valid "${role}" || cli_die "invalid role: ${role}"
    printf '%s\n' "${role}"
  done
}

cli_scope_label() {
  local scope="${1:-all}"
  if [ "${scope}" = "--all" ] || [ "${scope}" = "all" ]; then
    printf 'all'
  else
    printf '%s' "${scope}"
  fi
}

cli_daemon_dir() {
  local scope
  scope="$(cli_scope_label "${1:-all}")"
  if [ "${scope}" = "all" ]; then
    printf '%s/workdir/daemon' "${LLM_TEAM_ROOT}"
  else
    printf '%s/workdir/%s/daemon' "${LLM_TEAM_ROOT}" "${scope}"
  fi
}

cli_pid_running() {
  local pid="$1"
  case "${pid}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "${pid}" >/dev/null 2>&1
}

cli_control_state_get() {
  local path="${LLM_TEAM_ROOT}/workdir/control-state"
  if [ -f "${path}" ]; then
    cat "${path}"
  else
    printf 'RUNNING'
  fi
}
