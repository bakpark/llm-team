#!/usr/bin/env bash
# Label-related CLI commands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team labels bootstrap <target> [--dry-run]
EOF
}

cmd="${1:-}"
case "${cmd}" in
  -h|--help|'')
    usage
    ;;
  bootstrap)
    shift
    target="${1:-}"
    [ -n "${target}" ] || cli_die "labels bootstrap requires <target>"
    cli_require_target_file "${target}"
    shift || true
    exec "${LLM_TEAM_ROOT}/scripts/bootstrap-labels.sh" "${target}" "$@"
    ;;
  *)
    cli_die "unknown labels command: ${cmd}"
    ;;
esac
