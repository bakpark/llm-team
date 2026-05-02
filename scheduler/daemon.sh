#!/usr/bin/env bash
# Thin long-running wrapper around scheduler/runner.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# Daemon supervisors already redirect scheduler stdout/stderr to a daemon log.
# Avoid nested process-substitution tee from runner log_init in restricted shells.
export LLM_TEAM_LOG_TEE="${LLM_TEAM_LOG_TEE:-0}"

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <role> [interval_seconds]

role must be one of: po | pm | planner | coder | reviewer | integrator | qa

Set LLM_TEAM_DAEMON_TARGET=<target> to restrict the loop to one target.
EOF
  exit 64
}

ROLE_RAW="${1:-}"
ROLE="$(role_normalize "${ROLE_RAW}")" || usage
INTERVAL="${2:-${LLM_TEAM_DAEMON_INTERVAL:-120}}"
case "${INTERVAL}" in
  ''|*[!0-9]*) log_error "daemon: interval must be a positive integer"; exit 64 ;;
esac

LOCK_PARENT="${LLM_TEAM_ROOT}/workdir"
LOCK_SCOPE="${LLM_TEAM_DAEMON_TARGET:-all}"
LOCK_SCOPE_SAFE="$(printf '%s' "${LOCK_SCOPE}" | tr '/ :' '___')"
LOCKDIR="${LOCK_PARENT}/daemon-${ROLE}-${LOCK_SCOPE_SAFE}.lockd"
mkdir -p "${LOCK_PARENT}"

# L3: mkdir 기반 락은 SIGKILL/패닉 시 stale 디렉토리가 남는다. 락이 이미
# 존재하면 (a) 안에 있는 PID 가 아직 살아 있는지 확인하고, (b) 죽은 PID 면
# stale 로 판단해 강제 회수 후 다시 mkdir 한다. 하나의 활성 데몬만 허용한다는
# 의미는 그대로 유지한다.
_acquire_daemon_lock() {
  local i=0
  while [ "${i}" -lt 2 ]; do
    if mkdir "${LOCKDIR}" 2>/dev/null; then
      printf '%s' "$$" >"${LOCKDIR}/pid"
      return 0
    fi
    if [ -f "${LOCKDIR}/pid" ]; then
      local stale_pid
      stale_pid="$(cat "${LOCKDIR}/pid" 2>/dev/null || true)"
      if [ -n "${stale_pid}" ] && kill -0 "${stale_pid}" 2>/dev/null; then
        log_error "daemon: ${ROLE} runner already has an active daemon lock (pid=${stale_pid})"
        return 1
      fi
      log_warn "daemon: stale lock detected (pid=${stale_pid:-unknown}); reclaiming"
      rm -rf "${LOCKDIR}" 2>/dev/null || true
    else
      # pid 파일조차 없는 lockd — 이전 mkdir 후 즉시 죽은 케이스. 회수.
      log_warn "daemon: lockd without pid file; reclaiming"
      rm -rf "${LOCKDIR}" 2>/dev/null || true
    fi
    i=$((i + 1))
  done
  log_error "daemon: failed to acquire daemon lock at ${LOCKDIR}"
  return 1
}

if ! _acquire_daemon_lock; then
  exit 1
fi
trap 'rm -rf "${LOCKDIR}" 2>/dev/null || true' EXIT

SHUTDOWN=0
trap 'SHUTDOWN=1; log_info "daemon: shutdown requested for role='"${ROLE}"'"' SIGINT SIGTERM

if [ "${LLM_TEAM_DAEMON_ONCE:-0}" = "1" ]; then
  target="${LLM_TEAM_DAEMON_TARGET:-}"
  [ -n "${target}" ] || { log_error "daemon: LLM_TEAM_DAEMON_TARGET is required in ONCE mode"; exit 64; }
  "${SCRIPT_DIR}/runner.sh" "${ROLE}" "${target}"
  exit 0
fi

log_info "daemon: started role=${ROLE} target=${LOCK_SCOPE} interval=${INTERVAL}s"
while [ "${SHUTDOWN}" -eq 0 ]; do
  if [ -n "${LLM_TEAM_DAEMON_TARGET:-}" ]; then
    targets="${LLM_TEAM_DAEMON_TARGET}"
  else
    targets="$(list_active_targets 2>/dev/null || true)"
  fi
  while IFS= read -r target; do
    [ -n "${target}" ] || continue
    [ "${SHUTDOWN}" -eq 0 ] || break
    "${SCRIPT_DIR}/runner.sh" "${ROLE}" "${target}" || \
      log_warn "daemon: runner returned non-zero role=${ROLE} target=${target}"
  done <<EOF
${targets}
EOF

  i=0
  while [ "${i}" -lt "${INTERVAL}" ] && [ "${SHUTDOWN}" -eq 0 ]; do
    sleep 1
    i=$((i + 1))
  done
done

log_info "daemon: stopped role=${ROLE}"
