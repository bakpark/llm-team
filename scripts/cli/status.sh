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

  # Worktrees: workdir/<target>/wt/* (each has .git or .inmem-meta).
  local wt_count=0 wt_names=""
  if [ -d "${workdir}/wt" ]; then
    local p name
    for p in "${workdir}/wt"/*; do
      [ -d "${p}" ] || continue
      [ -f "${p}/.git" ] || [ -d "${p}/.git" ] || [ -f "${p}/.inmem-meta.json" ] || continue
      name="$(basename "${p}")"
      wt_names="${wt_names}${wt_names:+, }${name}"
      wt_count=$((wt_count + 1))
    done
  fi

  # Change-proposals: workdir/<target>/change-proposals/*.json.
  # Terminal states (CP_CLOSED/CP_MERGED/CP_STALE) 는 open 에서 제외.
  local cp_open=0
  if [ -d "${workdir}/change-proposals" ] && command -v jq >/dev/null 2>&1; then
    local f st
    for f in "${workdir}/change-proposals"/*.json; do
      [ -f "${f}" ] || continue
      st="$(jq -r '.state // ""' "${f}" 2>/dev/null)"
      case "${st}" in
        ''|CP_CLOSED|CP_MERGED|CP_STALE) ;;
        *) cp_open=$((cp_open + 1)) ;;
      esac
    done
  fi

  printf 'Target: %s\n' "${target}"
  printf 'Repo: %s\n' "${repo}"
  printf 'Default Branch: %s\n' "${branch}"
  printf 'Enabled: %s\n' "${enabled}"
  printf 'Control: %s\n\n' "$(cli_control_state_get)"
  printf 'Local State:\n'
  printf '  manifests: %s\n' "${manifests}"
  printf '  active lease files: %s\n' "${leases}"
  printf '  ledger entries: %s\n' "${ledger_lines}"
  if [ "${wt_count}" -gt 0 ]; then
    printf '  worktrees: %s (%s)\n' "${wt_count}" "${wt_names}"
  else
    printf '  worktrees: 0\n'
  fi
  printf '  open change-proposals: %s\n\n' "${cp_open}"

  # Pipeline summary: ledger 의 마지막 N라인을 (object_kind, object_id) 별로
  # group-by 하여 가장 최근 from→to/result 를 표시.
  local ledger="${workdir}/ledger/transitions.jsonl"
  if [ -f "${ledger}" ] && command -v jq >/dev/null 2>&1; then
    printf 'Pipeline (most recent per object):\n'
    tail -n 200 "${ledger}" 2>/dev/null \
      | jq -r 'select(.object_id != null) | [.object_kind, .object_id, .from_state, .to_state, (.result // "?")] | @tsv' 2>/dev/null \
      | awk -F'\t' '
        { last[$1"/"$2] = $0 }
        END { for (k in last) print last[k] }
      ' \
      | sort \
      | awk -F'\t' '{
          if ($3 == $4) printf "  %-12s %-8s %s (%s)\n", $1, $2, $4, $5
          else printf "  %-12s %-8s %s -> %s (%s)\n", $1, $2, $3, $4, $5
        }' \
      || true
    printf '\n'
  fi

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
