#!/usr/bin/env bash
# Manage local llm-team daemon processes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"
# shellcheck source=_onboarding_gate.sh
. "${SCRIPT_DIR}/_onboarding_gate.sh"

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
  # 게이트 flag (start 만 의미; 다른 서브커맨드에는 무시됨).
  onboarding_gate_detect_flags "$@"
  local filtered=() arg _tmp
  _tmp="$(mktemp "${TMPDIR:-/tmp}/onb-args-XXXXXX")"
  onboarding_gate_filter_args "$@" >"${_tmp}"
  while IFS= read -r arg; do filtered+=("${arg}"); done <"${_tmp}"
  rm -f "${_tmp}"
  set -- "${filtered[@]+"${filtered[@]}"}"

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

  # P2-7 / RGC-DAEMON-STARTUP: brief liveness check so atomic-start can detect
  # a worker that died at boot (e.g. lockd conflict). Sleep small fraction of a
  # second to let nohup'd process settle, then verify pid.
  sleep 1
  if ! cli_pid_running "${pid}"; then
    rm -f "${pid_file}" 2>/dev/null || true
    log_error "daemon scope=${scope} role=${role}: pid=${pid} died immediately after start"
    return 1
  fi
  return 0
}

# RGC-DAEMON-STARTUP: pre-flight scan. Returns 0 if NO daemon for any
# (scope, role) in the about-to-start set is currently holding its lockd via a
# live pid. Returns 1 with a stderr report listing conflicts.
daemon_start_preflight() {
  local scope="$1" role_spec="$2"
  local conflicts=0 role lockd lock_pid scope_safe scope_label
  scope_label="$(cli_scope_label "${scope}")"
  scope_safe="$(printf '%s' "${scope_label}" | tr '/ :' '___')"
  while IFS= read -r role; do
    [ -n "${role}" ] || continue
    lockd="${LLM_TEAM_ROOT}/workdir/daemon-${role}-${scope_safe}.lockd"
    [ -d "${lockd}" ] || continue
    lock_pid="$(cat "${lockd}/pid" 2>/dev/null || true)"
    if [ -n "${lock_pid}" ] && cli_pid_running "${lock_pid}"; then
      printf 'preflight: lockd held by live pid for scope=%s role=%s pid=%s\n' \
        "${scope}" "${role}" "${lock_pid}" >&2
      conflicts=$((conflicts + 1))
    fi
  done <<EOF
$(cli_expand_roles "${role_spec}")
EOF
  [ "${conflicts}" -eq 0 ]
}

# RGC-DAEMON-STARTUP: atomic-start wrapper. Starts every (scope, role) pair in
# DAEMON_ROLE_SPEC. If any role fails to start, stops all already-started
# siblings and writes a single ledger row {object_kind:system, object_id:<scope>}
# with result=rolled_back (or escalated if a sibling refuses to stop).
daemon_start_atomic() {
  local scope="$1"
  if ! daemon_start_preflight "${scope}" "${DAEMON_ROLE_SPEC}"; then
    cli_die "daemon start aborted: lock conflicts detected (RGC-DAEMON-STARTUP)" 1
  fi

  local started_roles=() role rc
  while IFS= read -r role; do
    [ -n "${role}" ] || continue
    if daemon_start_role "${scope}" "${role}" "${DAEMON_INTERVAL}"; then
      started_roles+=("${role}")
    else
      log_error "daemon start: role=${role} failed; rolling back ${#started_roles[@]} sibling(s)"
      local rb_role rb_failed=0
      for rb_role in "${started_roles[@]+"${started_roles[@]}"}"; do
        if ! daemon_stop_role "${scope}" "${rb_role}" >/dev/null 2>&1; then
          rb_failed=$((rb_failed + 1))
          log_error "daemon start rollback: stop ${rb_role} failed"
        fi
      done
      _daemon_atomic_ledger "${scope}" \
        "$([ "${rb_failed}" -eq 0 ] && echo rolled_back || echo escalated)" \
        "${started_roles[*]+"${started_roles[*]}"}" "${role}"
      cli_die "daemon start failed for role=${role}; siblings rolled back" 1
    fi
  done <<EOF
$(cli_expand_roles "${DAEMON_ROLE_SPEC}")
EOF
}

# Append a #RGC-LEDGER row (object_kind=system, object_id=<scope>) describing
# an atomic-start rollback. Best-effort: ledger writer is sourced lazily, and
# any failure is logged but does not abort the user-facing error path.
_daemon_atomic_ledger() {
  local scope="$1" result="$2" started="$3" failed_role="$4"
  local target ledger_target
  if [ "${scope}" = "all" ]; then
    target="all"
  else
    target="${scope}"
  fi
  if ! command -v transition_ledger_write >/dev/null 2>&1; then
    cli_source_runtime 2>/dev/null || true
  fi
  command -v transition_ledger_write >/dev/null 2>&1 || return 0
  local tmp
  tmp="$(mktemp -t daemon-startup-ledger.XXXXXX)" || return 0
  jq -n \
    --arg transition_id "daemon-startup-${result}-$(date -u +%s)-$$-${RANDOM}" \
    --arg target_id "${target}" \
    --arg object_kind "system" \
    --arg object_id "${target}" \
    --arg from_state "(startup)" \
    --arg to_state "(startup)" \
    --arg operation "DaemonStartup" \
    --arg caller_id "cli-daemon-${USER:-unknown}-$$" \
    --arg idempotency_key "daemon-startup-${target}-$(date -u +%s%N 2>/dev/null || date -u +%s)" \
    --arg manifest_id "" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg result "${result}" \
    --arg started "${started}" \
    --arg failed_role "${failed_role}" \
    '{
       transition_id: $transition_id,
       target_id: $target_id,
       object_kind: $object_kind,
       object_id: $object_id,
       from_state: $from_state,
       to_state: $to_state,
       operation: $operation,
       caller_id: $caller_id,
       idempotency_key: $idempotency_key,
       manifest_id: $manifest_id,
       timestamp: $timestamp,
       lease_token: null,
       result: $result,
       duplicate: false,
       result_detail: ("started_roles=" + $started + " failed_role=" + $failed_role)
     }' >"${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 0; }
  ledger_target="${target}"
  [ "${ledger_target}" != "all" ] || ledger_target="system"
  transition_ledger_write "${ledger_target}" "${tmp}" 2>/dev/null || true
  rm -f "${tmp}" 2>/dev/null || true
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
    # Wait for graceful exit so the daemon's EXIT trap can release its
    # lockdir before any subsequent `daemon start` reacquires it.
    local timeout="${LLM_TEAM_DAEMON_STOP_TIMEOUT:-10}"
    local waited=0
    while cli_pid_running "${pid}" && [ "${waited}" -lt "${timeout}" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if cli_pid_running "${pid}"; then
      kill -9 "${pid}" >/dev/null 2>&1 || true
      sleep 1
    fi
  fi
  rm -f "${pid_file}"
  # Defensive: if the daemon was SIGKILLed before its EXIT trap fired, its
  # lockdir under workdir/daemon-<role>-<scope>.lockd lingers and would block
  # the next start. Remove it only if the recorded pid (or any pid inside) is
  # no longer alive, mirroring the "stale lock" reclaim path in daemon.sh.
  local scope_label scope_safe lockdir lock_pid
  scope_label="$(cli_scope_label "${scope}")"
  scope_safe="$(printf '%s' "${scope_label}" | tr '/ :' '___')"
  lockdir="${LLM_TEAM_ROOT}/workdir/daemon-${role}-${scope_safe}.lockd"
  if [ -d "${lockdir}" ]; then
    lock_pid="$(cat "${lockdir}/pid" 2>/dev/null || true)"
    if [ -z "${lock_pid}" ] || ! cli_pid_running "${lock_pid}"; then
      rm -rf "${lockdir}" 2>/dev/null || true
    fi
  fi
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
    # 시작 전 게이트: scope=all 이면 enabled target 전부, 특정 target 이면 그 하나.
    if [ "${DAEMON_SCOPE}" = "all" ]; then
      cli_source_runtime
      while IFS= read -r _t; do
        [ -n "${_t}" ] || continue
        onboarding_gate_check "${_t}" || exit $?
      done < <(list_active_targets)
    else
      onboarding_gate_check "${DAEMON_SCOPE}" || exit $?
    fi
    # P2-7 / RGC-DAEMON-STARTUP: atomic startup. preflight + start-all-or-rollback.
    daemon_start_atomic "${DAEMON_SCOPE}"
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
