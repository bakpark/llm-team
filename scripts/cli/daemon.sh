#!/usr/bin/env bash
# Manage local llm-team daemon processes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team daemon start [target|--all] [--role role|all] [--interval seconds]
  llm-team daemon stop [target|--all] [--role role|all]
  llm-team daemon status [target|--all] [--role role|all]
  llm-team daemon logs [target|--all] [--role role|all] [--lines N]
EOF
}

parse_scope_and_options() {
  DAEMON_SCOPE="all"
  DAEMON_SCOPE_EXPLICIT=0
  DAEMON_ROLE_SPEC="all"
  DAEMON_INTERVAL="120"
  DAEMON_LINES="80"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --all) DAEMON_SCOPE="all"; DAEMON_SCOPE_EXPLICIT=1; shift ;;
      --role) DAEMON_ROLE_SPEC="${2:-}"; shift 2 ;;
      --interval) DAEMON_INTERVAL="${2:-}"; shift 2 ;;
      --lines) DAEMON_LINES="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      --*) cli_die "unknown daemon argument: $1" ;;
      *)
        if [ "${DAEMON_SCOPE_EXPLICIT}" -eq 1 ]; then
          cli_die "daemon scope specified more than once"
        fi
        DAEMON_SCOPE="$1"
        DAEMON_SCOPE_EXPLICIT=1
        shift
        ;;
    esac
  done

  DAEMON_SCOPE="$(cli_scope_label "${DAEMON_SCOPE}")"
  if [ "${DAEMON_SCOPE}" != "all" ]; then
    cli_require_target_file "${DAEMON_SCOPE}"
  fi
  case "${DAEMON_INTERVAL}" in
    ''|*[!0-9]*) cli_die "--interval must be a positive integer" ;;
  esac
  case "${DAEMON_LINES}" in
    ''|*[!0-9]*) cli_die "--lines must be a positive integer" ;;
  esac
}

daemon_pid_file() {
  local scope="$1" role="$2"
  printf '%s/%s.pid' "$(cli_daemon_dir "${scope}")" "${role}"
}

daemon_log_file() {
  local scope="$1" role="$2"
  printf '%s/%s.log' "$(cli_daemon_dir "${scope}")" "${role}"
}

daemon_start_role() {
  local scope="$1" role="$2" interval="$3" dir pid_file log_file pid
  dir="$(cli_daemon_dir "${scope}")"
  pid_file="$(daemon_pid_file "${scope}" "${role}")"
  log_file="$(daemon_log_file "${scope}" "${role}")"
  mkdir -p "${dir}"

  if [ -f "${pid_file}" ]; then
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if cli_pid_running "${pid}"; then
      printf 'daemon scope=%s role=%s already running pid=%s\n' "${scope}" "${role}" "${pid}"
      return 0
    fi
    rm -f "${pid_file}"
  fi

  if [ "${scope}" = "all" ]; then
    nohup "${LLM_TEAM_ROOT}/scheduler/daemon.sh" "${role}" "${interval}" >>"${log_file}" 2>&1 &
  else
    LLM_TEAM_DAEMON_TARGET="${scope}" nohup "${LLM_TEAM_ROOT}/scheduler/daemon.sh" "${role}" "${interval}" >>"${log_file}" 2>&1 &
  fi
  pid="$!"
  printf '%s\n' "${pid}" >"${pid_file}"
  printf 'started daemon scope=%s role=%s pid=%s log=%s\n' "${scope}" "${role}" "${pid}" "${log_file}"
}

daemon_stop_role() {
  local scope="$1" role="$2" pid_file pid
  pid_file="$(daemon_pid_file "${scope}" "${role}")"
  if [ ! -f "${pid_file}" ]; then
    printf 'daemon scope=%s role=%s stopped\n' "${scope}" "${role}"
    return 0
  fi
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  if cli_pid_running "${pid}"; then
    kill "${pid}" >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -f "${pid_file}"
  printf 'stopped daemon scope=%s role=%s\n' "${scope}" "${role}"
}

daemon_status_role() {
  local scope="$1" role="$2" pid_file pid status
  pid_file="$(daemon_pid_file "${scope}" "${role}")"
  pid=""
  status="stopped"
  if [ -f "${pid_file}" ]; then
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if cli_pid_running "${pid}"; then
      status="running"
    else
      status="stale-pid"
    fi
  fi
  printf '%-16s %-12s %-10s %s\n' "${scope}" "${role}" "${status}" "${pid:-"-"}"
}

daemon_logs_role() {
  local scope="$1" role="$2" lines="$3" log_file
  log_file="$(daemon_log_file "${scope}" "${role}")"
  if [ ! -f "${log_file}" ]; then
    printf 'No log for scope=%s role=%s (%s)\n' "${scope}" "${role}" "${log_file}"
    return 0
  fi
  printf '==> %s scope=%s role=%s <==\n' "${log_file}" "${scope}" "${role}"
  tail -n "${lines}" "${log_file}"
}

run_for_roles() {
  local fn="$1" scope="$2" role
  while IFS= read -r role; do
    [ -n "${role}" ] || continue
    "${fn}" "${scope}" "${role}" "${DAEMON_INTERVAL}"
  done <<EOF
$(cli_expand_roles "${DAEMON_ROLE_SPEC}")
EOF
}

run_status_for_roles() {
  local scope="$1" role
  while IFS= read -r role; do
    [ -n "${role}" ] || continue
    daemon_status_role "${scope}" "${role}"
  done <<EOF
$(cli_expand_roles "${DAEMON_ROLE_SPEC}")
EOF
}

run_logs_for_roles() {
  local scope="$1" role
  while IFS= read -r role; do
    [ -n "${role}" ] || continue
    daemon_logs_role "${scope}" "${role}" "${DAEMON_LINES}"
  done <<EOF
$(cli_expand_roles "${DAEMON_ROLE_SPEC}")
EOF
}

cmd="${1:-}"
shift || true
case "${cmd}" in
  -h|--help|'')
    usage
    ;;
  start)
    parse_scope_and_options "$@"
    run_for_roles daemon_start_role "${DAEMON_SCOPE}"
    ;;
  stop)
    parse_scope_and_options "$@"
    run_for_roles daemon_stop_role "${DAEMON_SCOPE}"
    ;;
  status)
    parse_scope_and_options "$@"
    printf '%-16s %-12s %-10s %s\n' "scope" "role" "status" "pid"
    run_status_for_roles "${DAEMON_SCOPE}"
    ;;
  logs)
    parse_scope_and_options "$@"
    run_logs_for_roles "${DAEMON_SCOPE}"
    ;;
  *)
    cli_die "unknown daemon command: ${cmd}"
    ;;
esac
