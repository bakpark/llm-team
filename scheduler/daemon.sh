#!/usr/bin/env bash
# Thin long-running wrapper around scheduler/runner.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <role> [interval_seconds]

role must be one of: po | pm | planner | coder | reviewer | integrator | qa
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
LOCKDIR="${LOCK_PARENT}/daemon-${ROLE}.lockd"
mkdir -p "${LOCK_PARENT}"
if ! mkdir "${LOCKDIR}" 2>/dev/null; then
  log_error "daemon: ${ROLE} runner already has an active daemon lock"
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

log_info "daemon: started role=${ROLE} interval=${INTERVAL}s"
while [ "${SHUTDOWN}" -eq 0 ]; do
  targets="$(list_active_targets 2>/dev/null || true)"
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
