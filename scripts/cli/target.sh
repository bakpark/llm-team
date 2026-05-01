#!/usr/bin/env bash
# Manage llm-team targets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team target list
  llm-team target show <name>
  llm-team target add [name] --repo owner/repo|github-url [--branch main] [--clone-path path] [--label-prefix prefix] [--notifier none] [--webhook-ref KEY] [--disabled] [--force]
  llm-team target add [name] --url github-url [options]
  llm-team target add [name] --from-current [--path checkout] [options]
  llm-team target enable <name>
  llm-team target disable <name>
EOF
}

target_list() {
  cli_require_cmd yq
  local dir="${LLM_TEAM_ROOT}/targets" f name enabled owner repo branch
  printf '%-20s %-8s %-32s %s\n' "target" "enabled" "repo" "branch"
  [ -d "${dir}" ] || return 0
  for f in "${dir}"/*.yaml; do
    [ -f "${f}" ] || continue
    name="$(yq -r '.name // ""' "${f}")"
    [ -n "${name}" ] || name="$(basename "${f}" .yaml)"
    enabled="$(yq -r '.enabled // false' "${f}")"
    owner="$(yq -r '.github.owner // ""' "${f}")"
    repo="$(yq -r '.github.repo // ""' "${f}")"
    branch="$(yq -r '.github.default_branch // "main"' "${f}")"
    printf '%-20s %-8s %-32s %s\n' "${name}" "${enabled}" "${owner}/${repo}" "${branch}"
  done
}

target_show() {
  local target="${1:-}" file
  [ -n "${target}" ] || cli_die "target show requires <name>"
  cli_require_target_file "${target}"
  file="$(cli_target_file "${target}")"
  cat "${file}"
}

github_repo_normalize() {
  local raw="$1" spec owner repo
  [ -n "${raw}" ] || return 1
  spec="${raw}"
  spec="${spec#https://}"
  spec="${spec#http://}"
  spec="${spec#ssh://git@}"
  spec="${spec#git@}"
  spec="${spec#www.}"
  spec="${spec#github.com/}"
  spec="${spec#github.com:}"
  spec="${spec%.git}"
  spec="${spec%%#*}"
  spec="${spec%%\?*}"

  case "${spec}" in
    */*) ;;
    *) return 1 ;;
  esac
  owner="${spec%%/*}"
  repo="${spec#*/}"
  repo="${repo%%/*}"
  [ -n "${owner}" ] && [ -n "${repo}" ] || return 1
  printf '%s/%s\n' "${owner}" "${repo}"
}

target_name_from_repo() {
  local repo="$1" name
  name="${repo##*/}"
  name="${name%.git}"
  name="$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
  [ -n "${name}" ] || name="target"
  printf '%s\n' "${name}"
}

git_remote_origin_url() {
  local path="$1"
  git -C "${path}" remote get-url origin 2>/dev/null
}

git_checkout_root() {
  local path="$1"
  git -C "${path}" rev-parse --show-toplevel 2>/dev/null
}

git_default_branch_guess() {
  local path="$1" ref branch
  ref="$(git -C "${path}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)"
  branch="${ref#refs/remotes/origin/}"
  if [ -n "${branch}" ] && [ "${branch}" != "${ref}" ]; then
    printf '%s\n' "${branch}"
    return 0
  fi
  git -C "${path}" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'main\n'
}

target_add() {
  local name="" repo="" branch="main" clone_path="" label_prefix="" notifier="none" webhook_ref="" enabled="true" force=0
  local from_current=0 checkout_path="."
  if [ "${1:-}" != "" ] && [ "${1#-}" = "${1}" ]; then
    name="$1"
    shift || true
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:-}"; shift 2 ;;
      --url|--github-url) repo="${2:-}"; shift 2 ;;
      --from-current) from_current=1; shift ;;
      --path) checkout_path="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --clone-path) clone_path="${2:-}"; shift 2 ;;
      --label-prefix) label_prefix="${2:-}"; shift 2 ;;
      --notifier) notifier="${2:-}"; shift 2 ;;
      --webhook-ref) webhook_ref="${2:-}"; shift 2 ;;
      --disabled) enabled="false"; shift ;;
      --force) force=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) cli_die "unknown target add argument: $1" ;;
    esac
  done

  if [ "${from_current}" -eq 1 ]; then
    command -v git >/dev/null 2>&1 || cli_die "git is required for --from-current" 1
    repo="${repo:-$(git_remote_origin_url "${checkout_path}" || true)}"
    [ -n "${repo}" ] || cli_die "--from-current could not read origin remote from ${checkout_path}"
    if [ -z "${clone_path}" ]; then
      clone_path="$(git_checkout_root "${checkout_path}" || true)"
    fi
    if [ "${branch}" = "main" ]; then
      branch="$(git_default_branch_guess "${checkout_path}")"
    fi
  fi

  [ -n "${repo}" ] || cli_die "target add requires --repo owner/repo, --url github-url, or --from-current"
  repo="$(github_repo_normalize "${repo}")" || cli_die "--repo/--url must be a GitHub repo (owner/repo, https://github.com/owner/repo, or git@github.com:owner/repo.git)"
  local owner="${repo%%/*}" repo_name="${repo#*/}"

  if [ -z "${name}" ]; then
    name="$(target_name_from_repo "${repo_name}")"
  fi
  cli_require_target_name "${name}"

  local file
  file="$(cli_target_file "${name}")"
  if [ -f "${file}" ] && [ "${force}" -ne 1 ]; then
    cli_die "target already exists: ${name} (use --force to overwrite)" 1
  fi

  mkdir -p "${LLM_TEAM_ROOT}/targets" "${LLM_TEAM_ROOT}/inputs/${name}"
  cat >"${file}" <<EOF
name: ${name}
github:
  owner: ${owner}
  repo: ${repo_name}
  default_branch: ${branch}
local:
  clone_path: ${clone_path}
inputs_dir: inputs/${name}
labels:
  prefix: "${label_prefix}"
notifier:
  channel: ${notifier}
  webhook_or_id: ${webhook_ref}
dev_concurrency: 3
stale_threshold_minutes: 60
enabled: ${enabled}
EOF
  printf 'Created target %s at %s\n' "${name}" "${file}"
}

target_set_enabled() {
  local target="${1:-}" enabled="$2" file tmp
  [ -n "${target}" ] || cli_die "target ${enabled} requires <name>"
  cli_require_target_file "${target}"
  file="$(cli_target_file "${target}")"
  tmp="${file}.tmp.$$"
  awk -v enabled="${enabled}" '
    BEGIN { seen = 0 }
    /^enabled:[[:space:]]*/ {
      print "enabled: " enabled
      seen = 1
      next
    }
    { print }
    END {
      if (seen == 0) {
        print "enabled: " enabled
      }
    }
  ' "${file}" >"${tmp}" && mv "${tmp}" "${file}"
  printf 'Set target %s enabled=%s\n' "${target}" "${enabled}"
}

cmd="${1:-}"
case "${cmd}" in
  -h|--help|'') usage ;;
  list) shift; [ "$#" -eq 0 ] || cli_die "target list takes no arguments"; target_list ;;
  show) shift; target_show "$@" ;;
  add) shift; target_add "$@" ;;
  enable) shift; target_set_enabled "${1:-}" true ;;
  disable) shift; target_set_enabled "${1:-}" false ;;
  *) cli_die "unknown target command: ${cmd}" ;;
esac
