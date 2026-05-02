#!/usr/bin/env bash
# Generate a self-contained HTML dashboard for the local llm-team install.
#
# Usage:
#   llm-team dashboard [--out <path>] [--target <name>]... [--lines <N>] [--no-github]
#
# Default --out is workdir/dashboard.html. Without --target, all targets whose
# yaml has enabled=true are rendered. The output is a single static file with
# inline CSS and zero JavaScript.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"
# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../lib/html.sh
. "${LLM_TEAM_ROOT}/lib/html.sh"
# shellcheck source=../../application/ledger_summary.sh
. "${LLM_TEAM_ROOT}/application/ledger_summary.sh"

usage() {
  cat <<EOF
Usage:
  llm-team dashboard [--out <path>] [--target <name>]... [--lines <N>] [--no-github]
EOF
}

DASH_OUT=""
DASH_LINES="80"
DASH_NO_GITHUB=0
DASH_TARGETS=()

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --out)         DASH_OUT="${2:-}"; shift 2 ;;
      --target)      DASH_TARGETS+=("${2:-}"); shift 2 ;;
      --lines)       DASH_LINES="${2:-}"; shift 2 ;;
      --no-github)   DASH_NO_GITHUB=1; shift ;;
      -h|--help)     usage; exit 0 ;;
      --*)           cli_die "unknown dashboard argument: $1" ;;
      *)             cli_die "unexpected positional argument: $1" ;;
    esac
  done
  case "${DASH_LINES}" in
    ''|*[!0-9]*) cli_die "--lines must be a positive integer" ;;
  esac
  if [ -z "${DASH_OUT}" ]; then
    DASH_OUT="${LLM_TEAM_ROOT}/workdir/dashboard.html"
  fi
}

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

dash_count_files() {
  local dir="$1"
  [ -d "${dir}" ] || { printf '0'; return 0; }
  find "${dir}" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' '
}

dash_iso_now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
dash_iso_24h_ago() {
  date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ
}

# Resolve target list: explicit --target args win, else list_active_targets.
dash_resolve_targets() {
  if [ "${#DASH_TARGETS[@]}" -gt 0 ]; then
    local t
    for t in "${DASH_TARGETS[@]}"; do
      cli_require_target_file "${t}"
      printf '%s\n' "${t}"
    done
    return 0
  fi
  list_active_targets
}

# Pick the most recent agent log file for a target/role; empty if none.
dash_latest_agent_log() {
  local target="$1" role="$2" dir
  dir="${LLM_TEAM_ROOT}/workdir/${target}/logs"
  [ -d "${dir}" ] || return 0
  ls -1t "${dir}/${role}"-*.log 2>/dev/null | head -n 1
}

# Recent N manifest files (newest first).
dash_recent_manifests() {
  local target="$1" limit="${2:-5}" dir
  dir="${LLM_TEAM_ROOT}/workdir/${target}/manifests"
  [ -d "${dir}" ] || return 0
  ls -1t "${dir}"/*.json 2>/dev/null | head -n "${limit}"
}

# Open change-proposal files (state ∉ {CP_CLOSED, CP_MERGED}).
dash_open_change_proposals() {
  local target="$1" dir f state
  dir="${LLM_TEAM_ROOT}/workdir/${target}/change-proposals"
  [ -d "${dir}" ] || return 0
  for f in "${dir}"/*.json; do
    [ -f "${f}" ] || continue
    state="$(jq -r '.state // ""' "${f}" 2>/dev/null || true)"
    case "${state}" in
      CP_CLOSED|CP_MERGED) ;;
      *) printf '%s\n' "${f}" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Rendering: top-level structure
# ---------------------------------------------------------------------------

dash_render_head() {
  cat <<'EOF'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>llm-team dashboard</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         margin: 0 auto; max-width: 1200px; padding: 1.5em; color: #222; }
  h1 { margin-bottom: 0.2em; }
  h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.2em; margin-top: 2em; }
  h3 { margin-top: 1.4em; }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 0.9em; }
  th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: left;
           vertical-align: top; }
  th { background: #f5f5f5; }
  pre { background: #f8f8f8; border: 1px solid #ddd; padding: 8px;
        overflow-x: auto; font-size: 0.8em; max-height: 400px; }
  details { margin: 0.4em 0; }
  summary { cursor: pointer; font-weight: 600; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px;
           font-size: 0.75em; background: #eee; margin-right: 4px; }
  .running { background: #c8e6c9; }
  .paused  { background: #ffe082; }
  .stopped { background: #f5f5f5; color: #888; }
  .stale-pid { background: #ffccbc; }
  .meta { color: #666; font-size: 0.85em; }
  nav a { margin-right: 1em; }
  footer { margin-top: 3em; color: #888; font-size: 0.8em; }
</style>
</head>
<body>
EOF
}

dash_render_summary() {
  local control targets target_count daemon_active=0
  control="$(cli_control_state_get)"
  targets="$1"  # newline-separated
  target_count="$(printf '%s\n' "${targets}" | grep -c .)" || true

  # Active daemon count: scan global + per-target daemon dirs.
  local daemon_dirs=("${LLM_TEAM_ROOT}/workdir/daemon")
  local t
  while IFS= read -r t; do
    [ -n "${t}" ] || continue
    daemon_dirs+=("${LLM_TEAM_ROOT}/workdir/${t}/daemon")
  done <<<"${targets}"
  local d pid_file pid
  for d in "${daemon_dirs[@]}"; do
    [ -d "${d}" ] || continue
    for pid_file in "${d}"/*.pid; do
      [ -f "${pid_file}" ] || continue
      pid="$(cat "${pid_file}" 2>/dev/null || true)"
      if cli_pid_running "${pid}"; then
        daemon_active=$((daemon_active + 1))
      fi
    done
  done

  printf '<section id="summary">\n'
  printf '<h1>llm-team dashboard</h1>\n'
  printf '<p class="meta">Generated %s</p>\n' \
    "$(html_escape_arg "$(dash_iso_now)")"
  printf '<p>Control: <span class="badge %s">%s</span></p>\n' \
    "$(printf '%s' "${control}" | tr '[:upper:]' '[:lower:]' | html_escape)" \
    "$(html_escape_arg "${control}")"
  printf '<p>Targets: %d &middot; Active daemons: %d</p>\n' \
    "${target_count}" "${daemon_active}"

  # Aggregate caller results window.
  local since="$(dash_iso_24h_ago)"
  local agg_applied=0 agg_invalid=0 agg_dup=0 agg_err=0 agg_total=0
  while IFS= read -r t; do
    [ -n "${t}" ] || continue
    local w
    w="$(ledger_caller_window "${t}" "${since}")"
    agg_applied=$((agg_applied + $(printf '%s' "${w}" | jq -r '.applied')))
    agg_invalid=$((agg_invalid + $(printf '%s' "${w}" | jq -r '.invalid')))
    agg_dup=$((agg_dup + $(printf '%s' "${w}" | jq -r '.duplicate')))
    agg_err=$((agg_err + $(printf '%s' "${w}" | jq -r '.error')))
    agg_total=$((agg_total + $(printf '%s' "${w}" | jq -r '.total')))
  done <<<"${targets}"
  printf '<p>Caller results (24h): total=%d &middot; applied=%d &middot; invalid=%d &middot; duplicate=%d &middot; error=%d</p>\n' \
    "${agg_total}" "${agg_applied}" "${agg_invalid}" "${agg_dup}" "${agg_err}"

  # Anchor nav.
  if [ "${target_count}" -gt 0 ]; then
    printf '<nav>'
    while IFS= read -r t; do
      [ -n "${t}" ] || continue
      printf '<a href="#target-%s">%s</a>' \
        "$(html_escape_arg "${t}")" "$(html_escape_arg "${t}")"
    done <<<"${targets}"
    printf '</nav>\n'
  fi
  printf '</section>\n'
}

# ---------------------------------------------------------------------------
# Per-target sections
# ---------------------------------------------------------------------------

dash_render_daemons() {
  local target="$1" yaml_file owner repo branch enabled
  yaml_file="$(cli_target_file "${target}")"
  owner="$(yq -r '.github.owner // ""' "${yaml_file}")"
  repo="$(yq -r '.github.repo // ""' "${yaml_file}")"
  branch="$(yq -r '.github.default_branch // "main"' "${yaml_file}")"
  enabled="$(yq -r '.enabled // false' "${yaml_file}")"

  printf '<p class="meta">repo: %s/%s &middot; branch: %s &middot; enabled: %s</p>\n' \
    "$(html_escape_arg "${owner}")" \
    "$(html_escape_arg "${repo}")" \
    "$(html_escape_arg "${branch}")" \
    "$(html_escape_arg "${enabled}")"

  printf '<h3>Daemons</h3>\n'
  html_table_open "scope" "role" "status" "pid" "log"
  local scope role pid_file pid status log_file
  for scope in all "${target}"; do
    local dir
    if [ "${scope}" = "all" ]; then
      dir="${LLM_TEAM_ROOT}/workdir/daemon"
    else
      dir="${LLM_TEAM_ROOT}/workdir/${scope}/daemon"
    fi
    for role in "${CLI_ROLES[@]}"; do
      pid_file="${dir}/${role}.pid"
      log_file="${dir}/${role}.log"
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
      # Skip rows with no pid file and no log file to avoid noise.
      if [ -z "${pid}" ] && [ ! -f "${log_file}" ]; then
        continue
      fi
      html_table_row "${scope}" "${role}" "${status}" "${pid:--}" "${log_file}"
    done
  done
  html_table_close
}

dash_render_github() {
  local target="$1" yaml_file owner repo full_repo
  yaml_file="$(cli_target_file "${target}")"
  owner="$(yq -r '.github.owner // ""' "${yaml_file}")"
  repo="$(yq -r '.github.repo // ""' "${yaml_file}")"
  full_repo="${owner}/${repo}"

  printf '<h3>GitHub</h3>\n'
  if [ "${DASH_NO_GITHUB}" -eq 1 ]; then
    printf '<p class="meta">(skipped via --no-github)</p>\n'
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    printf '<p class="meta">(unavailable: gh not installed)</p>\n'
    return 0
  fi
  if [ -z "${owner}" ] || [ -z "${repo}" ]; then
    printf '<p class="meta">(unavailable: target repo not configured)</p>\n'
    return 0
  fi

  local issues prs milestones rc=0
  issues="$(gh issue list --repo "${full_repo}" --state open --limit 1000 --json number 2>/dev/null \
              | jq 'length' 2>/dev/null)" || rc=1
  prs="$(gh pr list --repo "${full_repo}" --state open --limit 1000 --json number 2>/dev/null \
           | jq 'length' 2>/dev/null)" || rc=1
  milestones="$(gh api "repos/${full_repo}/milestones?state=open&per_page=100" --jq 'length' 2>/dev/null)" || rc=1

  if [ "${rc}" -ne 0 ] || [ -z "${issues}" ] || [ -z "${prs}" ] || [ -z "${milestones}" ]; then
    printf '<p class="meta">(unavailable: gh request failed)</p>\n'
    return 0
  fi
  html_table_open "open issues" "open PRs" "open milestones"
  html_table_row "${issues}" "${prs}" "${milestones}"
  html_table_close
}

dash_render_caller_results() {
  local target="$1" since w
  since="$(dash_iso_24h_ago)"
  w="$(ledger_caller_window "${target}" "${since}")"
  printf '<h3>Caller results (24h)</h3>\n'
  html_table_open "total" "applied" "invalid" "duplicate" "error"
  html_table_row \
    "$(printf '%s' "${w}" | jq -r '.total')" \
    "$(printf '%s' "${w}" | jq -r '.applied')" \
    "$(printf '%s' "${w}" | jq -r '.invalid')" \
    "$(printf '%s' "${w}" | jq -r '.duplicate')" \
    "$(printf '%s' "${w}" | jq -r '.error')"
  html_table_close
}

dash_render_pipeline() {
  local target="$1" rows
  rows="$(ledger_pipeline_summary "${target}")"
  printf '<h3>Pipeline</h3>\n'
  local count
  count="$(printf '%s' "${rows}" | jq 'length')"
  if [ "${count}" -eq 0 ]; then
    printf '<p class="meta">(no transitions yet)</p>\n'
    return 0
  fi
  html_table_open "kind" "id" "from" "to" "result" "operation" "timestamp"
  while IFS= read -r row; do
    [ -n "${row}" ] || continue
    html_table_row \
      "$(printf '%s' "${row}" | jq -r '.object_kind')" \
      "$(printf '%s' "${row}" | jq -r '.object_id')" \
      "$(printf '%s' "${row}" | jq -r '.from_state')" \
      "$(printf '%s' "${row}" | jq -r '.to_state')" \
      "$(printf '%s' "${row}" | jq -r '.result')" \
      "$(printf '%s' "${row}" | jq -r '.operation')" \
      "$(printf '%s' "${row}" | jq -r '.timestamp')"
  done < <(printf '%s' "${rows}" | jq -c '.[]')
  html_table_close
}

dash_render_leases() {
  local target="$1" dir f
  dir="${LLM_TEAM_ROOT}/workdir/${target}/leases"
  printf '<h3>Active leases</h3>\n'
  if [ ! -d "${dir}" ] || [ -z "$(ls -A "${dir}" 2>/dev/null)" ]; then
    printf '<p class="meta">(none)</p>\n'
    return 0
  fi
  html_table_open "object_id" "operation" "worker" "claimed_at" "expires_at"
  for f in "${dir}"/*.json; do
    [ -f "${f}" ] || continue
    html_table_row \
      "$(jq -r '.object_id // ""' "${f}")" \
      "$(jq -r '.operation // ""' "${f}")" \
      "$(jq -r '.worker_id // ""' "${f}")" \
      "$(jq -r '.claimed_at // ""' "${f}")" \
      "$(jq -r '.expires_at // ""' "${f}")"
  done
  html_table_close
}

dash_render_manifests() {
  local target="$1" files f
  printf '<h3>Recent manifests</h3>\n'
  files="$(dash_recent_manifests "${target}" 5)"
  if [ -z "${files}" ]; then
    printf '<p class="meta">(none)</p>\n'
    return 0
  fi
  html_table_open "manifest_id" "operation" "target" "created_at" "entries"
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    html_table_row \
      "$(jq -r '.manifest_id // ""' "${f}")" \
      "$(jq -r '.operation // ""' "${f}")" \
      "$(jq -r '"\(.target.kind // "")#\(.target.id // "")"' "${f}")" \
      "$(jq -r '.created_at // ""' "${f}")" \
      "$(jq -r '.entries | length' "${f}")"
  done <<<"${files}"
  html_table_close
}

dash_render_change_proposals() {
  local target="$1" files f
  printf '<h3>Open change-proposals</h3>\n'
  files="$(dash_open_change_proposals "${target}")"
  if [ -z "${files}" ]; then
    printf '<p class="meta">(none)</p>\n'
    return 0
  fi
  html_table_open "id" "kind" "role" "target_id" "state" "pr"
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    html_table_row \
      "$(jq -r '.change_proposal_id // ""' "${f}")" \
      "$(jq -r '.cp_kind // ""' "${f}")" \
      "$(jq -r '.source_role // ""' "${f}")" \
      "$(jq -r '.target_id // ""' "${f}")" \
      "$(jq -r '.state // ""' "${f}")" \
      "$(jq -r '.pr_number // "" | tostring' "${f}")"
  done <<<"${files}"
  html_table_close
}

dash_render_logs_section() {
  local target="$1" heading="$2" picker="$3"
  printf '<h3>%s (last %s lines)</h3>\n' \
    "$(html_escape_arg "${heading}")" "$(html_escape_arg "${DASH_LINES}")"
  local rendered=0 role log_file
  for role in "${CLI_ROLES[@]}"; do
    log_file="$("${picker}" "${target}" "${role}")"
    [ -n "${log_file}" ] && [ -f "${log_file}" ] || continue
    rendered=$((rendered + 1))
    html_details_open "${role} — ${log_file}"
    tail -n "${DASH_LINES}" "${log_file}" | html_escape
    html_details_close
  done
  if [ "${rendered}" -eq 0 ]; then
    printf '<p class="meta">(no logs)</p>\n'
  fi
}

dash_pick_agent_log() {
  dash_latest_agent_log "$1" "$2"
}

dash_pick_daemon_log() {
  local target="$1" role="$2"
  local target_log="${LLM_TEAM_ROOT}/workdir/${target}/daemon/${role}.log"
  if [ -f "${target_log}" ]; then
    printf '%s' "${target_log}"
    return 0
  fi
  local global_log="${LLM_TEAM_ROOT}/workdir/daemon/${role}.log"
  if [ -f "${global_log}" ]; then
    printf '%s' "${global_log}"
  fi
}

dash_render_target() {
  local target="$1"
  printf '<section id="target-%s">\n' "$(html_escape_arg "${target}")"
  printf '<h2>%s</h2>\n' "$(html_escape_arg "${target}")"
  dash_render_daemons          "${target}"
  dash_render_github           "${target}"
  dash_render_caller_results   "${target}"
  dash_render_pipeline         "${target}"
  dash_render_leases           "${target}"
  dash_render_manifests        "${target}"
  dash_render_change_proposals "${target}"
  dash_render_logs_section     "${target}" "Agent logs"  dash_pick_agent_log
  dash_render_logs_section     "${target}" "Daemon logs" dash_pick_daemon_log
  printf '</section>\n'
}

dash_render_footer() {
  printf '<footer>Generated by llm-team dashboard at %s</footer>\n' \
    "$(html_escape_arg "$(dash_iso_now)")"
  printf '</body></html>\n'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  cli_require_cmd jq
  cli_require_cmd yq

  local out_dir tmp targets t
  out_dir="$(dirname "${DASH_OUT}")"
  mkdir -p "${out_dir}" || cli_die "cannot create output directory: ${out_dir}" 1

  targets="$(dash_resolve_targets || true)"

  tmp="$(mktemp "${DASH_OUT}.XXXXXX")" || cli_die "mktemp failed" 1
  {
    dash_render_head
    dash_render_summary "${targets}"
    while IFS= read -r t; do
      [ -n "${t}" ] || continue
      dash_render_target "${t}"
    done <<<"${targets}"
    dash_render_footer
  } >"${tmp}"
  mv "${tmp}" "${DASH_OUT}"
  printf 'wrote dashboard: %s\n' "${DASH_OUT}"
}

main "$@"
