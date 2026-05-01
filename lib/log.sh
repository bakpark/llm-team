#!/usr/bin/env bash
# lib/log.sh — logging helpers (sourced via lib/common.sh).
#
# Public API:
#   log_info <msg>           — INFO level to stderr.
#   log_warn <msg>           — WARN level to stderr.
#   log_error <msg>          — ERROR level to stderr.
#   log_init <agent> <target>
#                            — tee stdout/stderr into workdir/<target>/logs/<agent>-<ISO>.log
#                              while still emitting to the original streams.
#
# Format: `[<UTC ISO8601>] [<LEVEL>] <message>` on stderr.
# Library files do not set `errexit`/`nounset` — the caller controls shell options.

_log() {
  local level="$1"; shift
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] [%s] %s\n' "${ts}" "${level}" "$*" >&2
}

log_info()  { _log INFO  "$*"; }
log_warn()  { _log WARN  "$*"; }
log_error() { _log ERROR "$*"; }

# log_init <agent> <target>
log_init() {
  local agent="$1"
  local target="$2"
  if [ -z "${agent}" ] || [ -z "${target}" ]; then
    log_error "log_init: agent and target arguments are required"
    return 1
  fi
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local log_dir="${LLM_TEAM_ROOT}/workdir/${target}/logs"
  mkdir -p "${log_dir}" || {
    log_error "log_init: failed to create ${log_dir}"
    return 1
  }
  local log_file="${log_dir}/${agent}-${ts}.log"
  # Tee both stdout and stderr to the log while preserving the originals.
  exec  > >(tee -a "${log_file}")
  exec 2> >(tee -a "${log_file}" >&2)
  log_info "log_init agent=${agent} target=${target} log=${log_file}"
}
