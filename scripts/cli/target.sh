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
  llm-team target add [name] --from-current [--path checkout] [--separate-clone] [options]
  llm-team target init <name> [--dry-run] [--skip-labels]
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

# Resolve absolute path (handles ~ and . segments) for clone_path comparison.
_abs_path() {
  local p="$1"
  [ -n "${p}" ] || return 1
  case "${p}" in
    "~"|"~/"*)
      p="${HOME}${p#\~}"
      ;;
  esac
  if [ -d "${p}" ]; then
    ( cd "${p}" 2>/dev/null && pwd -P ) || printf '%s' "${p}"
  else
    # Resolve parent dir, append basename — works for not-yet-existing paths.
    local parent base
    parent="$(dirname "${p}")"
    base="$(basename "${p}")"
    if [ -d "${parent}" ]; then
      printf '%s/%s' "$( cd "${parent}" 2>/dev/null && pwd -P )" "${base}"
    else
      printf '%s' "${p}"
    fi
  fi
}

# H6: 동일 clone_path 를 가리키는 다른 target 이 이미 존재하면 그 이름을 출력.
# 비어 있는 clone_path 는 검사하지 않음(기본 workdir/<target>/repo 자동 결정 — target 별 분리됨).
_target_clone_path_collision() {
  local skip_name="$1" candidate_abs="$2"
  [ -n "${candidate_abs}" ] || return 1
  local dir="${LLM_TEAM_ROOT}/targets" f existing other_abs
  [ -d "${dir}" ] || return 1
  for f in "${dir}"/*.yaml; do
    [ -f "${f}" ] || continue
    existing="$(yq -r '.name // ""' "${f}" 2>/dev/null)"
    [ -n "${existing}" ] || existing="$(basename "${f}" .yaml)"
    [ "${existing}" = "${skip_name}" ] && continue
    other_abs="$(yq -r '.local.clone_path // ""' "${f}" 2>/dev/null)"
    [ -n "${other_abs}" ] || continue
    other_abs="$(_abs_path "${other_abs}")"
    if [ "${other_abs}" = "${candidate_abs}" ]; then
      printf '%s' "${existing}"
      return 0
    fi
  done
  return 1
}

target_add() {
  local name="" repo="" branch="main" clone_path="" label_prefix="" notifier="none" webhook_ref="" enabled="true" force=0
  local from_current=0 checkout_path="." separate_clone=0
  if [ "${1:-}" != "" ] && [ "${1#-}" = "${1}" ]; then
    name="$1"
    shift || true
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:-}"; shift 2 ;;
      --url|--github-url) repo="${2:-}"; shift 2 ;;
      --from-current) from_current=1; shift ;;
      --separate-clone) separate_clone=1; shift ;;
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
    # H6: 기본 동작은 사용자 체크아웃 root 를 그대로 canonical clone 으로 쓰지
    # 않는다 — fetch --prune origin 이 사용자 작업 흐름을 흔들고, 다른 target
    # 과 clone_path 를 충돌시킬 위험이 있다. --separate-clone 또는 --clone-path
    # 미지정 시 자동으로 workdir/<target>/repo 를 사용하도록 비워 둔다.
    if [ -z "${clone_path}" ] && [ "${separate_clone}" -ne 1 ]; then
      printf 'note: --from-current 은 origin URL 만 수집합니다. canonical clone 은 workdir/<target>/repo 에 별도로 만들어집니다.\n' >&2
      printf '      사용자 체크아웃을 그대로 canonical 로 쓰려면 --clone-path %s 를 명시하세요.\n' "$(git_checkout_root "${checkout_path}" 2>/dev/null || echo "${checkout_path}")" >&2
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

  # H6: clone_path 충돌 검증 — 명시적으로 clone_path 가 지정된 경우만.
  # 비어 있는 clone_path 는 ws_ensure_clone 이 workdir/<target>/repo 로
  # 자동 분리하므로 충돌 위험 없음.
  if [ -n "${clone_path}" ]; then
    cli_require_cmd yq
    local clone_path_abs
    clone_path_abs="$(_abs_path "${clone_path}")"
    local collided
    if collided="$(_target_clone_path_collision "${name}" "${clone_path_abs}")"; then
      if [ "${force}" -ne 1 ]; then
        cli_die "clone_path 충돌: '${clone_path_abs}' 가 이미 target '${collided}' 에 사용 중입니다 (--force 로 강제 덮어쓰기 가능)" 1
      fi
      printf 'WARN: clone_path 가 target %s 와 충돌하지만 --force 로 진행합니다\n' "${collided}" >&2
    fi
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

target_init() {
  local target="${1:-}"
  shift || true
  local dry_run=0 skip_labels=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --skip-labels) skip_labels=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) cli_die "unknown target init argument: $1" ;;
    esac
  done
  [ -n "${target}" ] || cli_die "target init requires <name>"
  cli_require_target_file "${target}"

  cli_source_runtime
  load_target "${target}" || cli_die "failed to load target ${target}"

  local workdir="${LLM_TEAM_ROOT}/workdir/${target}"
  printf '[init] target %s\n' "${target}"

  # 1. canonical clone (workspace adapter는 git_worktree 가 default).
  if [ "${dry_run}" -eq 1 ]; then
    printf '[init] (dry-run) skipping ws_ensure_clone\n'
  else
    local clone_out
    if clone_out="$(ws_ensure_clone "${target}" 2>&1)"; then
      printf '[init] clone ready: %s\n' "${clone_out}"
    else
      printf '[init] WARN: ws_ensure_clone failed:\n%s\n' "${clone_out}" >&2
    fi
  fi

  # 2. workdir scaffold.
  local d
  for d in manifests leases ledger wt change-proposals; do
    mkdir -p "${workdir}/${d}"
  done
  printf '[init] workdir scaffold: %s/{manifests,leases,ledger,wt,change-proposals}\n' "${workdir}"

  # 3. agent-cwd (read-only context, agent_workspace_for 와 동일 정책).
  local role role_lower
  for role in po pm planner; do
    mkdir -p "${workdir}/agent-cwd/${role}"
  done
  printf '[init] agent-cwd: %s/agent-cwd/{po,pm,planner}\n' "${workdir}"

  # 4. labels bootstrap (best-effort — gh 인증 미설정 시 warn).
  if [ "${skip_labels}" -eq 1 ]; then
    printf '[init] (--skip-labels) skipping labels bootstrap\n'
  else
    local label_args=("${LLM_TEAM_ROOT}/scripts/bootstrap-labels.sh" "${target}")
    [ "${dry_run}" -eq 1 ] && label_args+=(--dry-run)
    if "${label_args[@]}" >/dev/null 2>&1; then
      printf '[init] labels bootstrap: ok\n'
    else
      printf '[init] WARN: labels bootstrap failed (gh auth?). Re-run: llm-team labels bootstrap %s\n' "${target}" >&2
    fi
  fi

  # 5. role cwd policy matrix (agent_workspace_for 와 단일 source-of-truth).
  printf '[init] role cwd policy:\n'
  for role in PO PM Planner; do
    role_lower="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
    printf '  %-10s %s\n' "${role}" "${workdir}/agent-cwd/${role_lower}"
  done
  for role in Coder Reviewer Integrator QA; do
    printf '  %-10s %s/wt/task-<unit_id>\n' "${role}" "${workdir}"
  done

  printf '[init] target %s ready\n' "${target}"
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
  init) shift; target_init "$@" ;;
  enable) shift; target_set_enabled "${1:-}" true ;;
  disable) shift; target_set_enabled "${1:-}" false ;;
  *) cli_die "unknown target command: ${cmd}" ;;
esac
