#!/usr/bin/env bash
# Human-readable local status.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team status [target]
EOF
}

count_files() {
  local dir="$1"
  [ -d "${dir}" ] || { printf '0'; return 0; }
  find "${dir}" -type f 2>/dev/null | wc -l | tr -d ' '
}

status_all() {
  cli_require_cmd yq
  local control
  control="$(cli_control_state_get)"
  printf 'Control: %s\n\n' "${control}"
  "${LLM_TEAM_ROOT}/scripts/cli/target.sh" list
}

status_target() {
  local target="$1" file workdir repo enabled branch manifests leases ledger_lines
  cli_require_cmd yq
  cli_require_target_file "${target}"
  file="$(cli_target_file "${target}")"
  workdir="${LLM_TEAM_ROOT}/workdir/${target}"
  repo="$(yq -r '(.github.owner // "") + "/" + (.github.repo // "")' "${file}")"
  enabled="$(yq -r '.enabled // false' "${file}")"
  branch="$(yq -r '.github.default_branch // "main"' "${file}")"
  manifests="$(count_files "${workdir}/manifests")"
  leases="$(count_files "${workdir}/leases")"
  if [ -f "${workdir}/ledger/transitions.jsonl" ]; then
    ledger_lines="$(wc -l <"${workdir}/ledger/transitions.jsonl" | tr -d ' ')"
  else
    ledger_lines="0"
  fi

  printf 'Target: %s\n' "${target}"
  printf 'Repo: %s\n' "${repo}"
  printf 'Default Branch: %s\n' "${branch}"
  printf 'Enabled: %s\n' "${enabled}"
  printf 'Control: %s\n\n' "$(cli_control_state_get)"
  printf 'Local State:\n'
  printf '  manifests: %s\n' "${manifests}"
  printf '  active lease files: %s\n' "${leases}"
  printf '  ledger entries: %s\n\n' "${ledger_lines}"
  "${LLM_TEAM_ROOT}/scripts/cli/daemon.sh" status "${target}"
}

case "${1:-}" in
  -h|--help)
    usage
    ;;
  '')
    status_all
    ;;
  *)
    status_target "$1"
    ;;
esac
