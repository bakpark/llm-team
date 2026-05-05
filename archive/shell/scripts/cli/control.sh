#!/usr/bin/env bash
# Pause/resume global llm-team control state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team pause [--all]
  llm-team resume [--all]

Pause/resume is currently global. Target-specific pause is not implemented.
EOF
}

cmd="${1:-}"
shift || true
case "${cmd}" in
  pause|resume) ;;
  -h|--help|'') usage; exit 0 ;;
  *) cli_die "unknown control command: ${cmd}" ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all) shift ;;
    -h|--help) usage; exit 0 ;;
    *) cli_die "target-specific ${cmd} is not implemented; use --all or no argument" ;;
  esac
done

cli_source_runtime
if [ "${cmd}" = "pause" ]; then
  control_state_set PAUSED
else
  control_state_set RUNNING
fi
printf 'Control: %s\n' "$(control_state_get)"
