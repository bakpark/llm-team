#!/usr/bin/env bash
# Runner CLI commands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team run <role> <target> [--dry-run]
  llm-team run-once <target> [--roles po,pm,planner,coder,reviewer,integrator,qa|all] [--dry-run]
EOF
}

run_one() {
  local role="${1:-}" target="${2:-}"
  [ -n "${role}" ] && [ -n "${target}" ] || cli_die "run requires <role> <target>"
  role="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
  cli_role_is_valid "${role}" || cli_die "invalid role: ${role}"
  cli_require_target_file "${target}"
  shift 2 || true
  exec "${LLM_TEAM_ROOT}/scheduler/runner.sh" "${role}" "${target}" "$@"
}

run_once() {
  local target="${1:-}"
  [ -n "${target}" ] || cli_die "run-once requires <target>"
  shift || true
  cli_require_target_file "${target}"

  local roles="all" dry_run=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --roles) roles="${2:-}"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) cli_die "unknown run-once argument: $1" ;;
    esac
  done

  local role args=()
  [ "${dry_run}" -eq 1 ] && args+=(--dry-run)
  while IFS= read -r role; do
    [ -n "${role}" ] || continue
    "${LLM_TEAM_ROOT}/scheduler/runner.sh" "${role}" "${target}" "${args[@]}"
  done <<EOF
$(cli_expand_roles "${roles}")
EOF
}

mode="${1:-}"
shift || true
case "${mode}" in
  -h|--help|'') usage ;;
  run) run_one "$@" ;;
  run-once) run_once "$@" ;;
  *) cli_die "unknown run mode: ${mode}" ;;
esac
