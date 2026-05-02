#!/usr/bin/env bash
# adapters/workspace/git_worktree.sh
#
# Concrete adapter for the workspace port using `git worktree`.
# unit_id 별로 격리된 worktree 디렉토리를 제공한다.
#
# 디렉토리 레이아웃:
#   ${TARGET_CLONE_PATH}                (또는 ${LLM_TEAM_ROOT}/workdir/<target>/repo)
#       ↳ canonical clone of target repo (1회 clone, 이후 fetch only)
#   ${LLM_TEAM_ROOT}/workdir/<target>/wt/<unit_id>
#       ↳ git worktree, 브랜치는 'llm-team/<unit_id>'
#
# 호출자 규칙:
#   • TARGET_NAME / TARGET_GH_OWNER / TARGET_GH_REPO / TARGET_CLONE_PATH /
#     TARGET_DEFAULT_BRANCH 환경변수가 설정된 상태에서 호출 (load_target 후).
#   • 인증: HTTPS clone 시 GH_TOKEN 환경변수가 git credential helper 와 호환되도록
#     배포되어 있어야 한다 (별도 설정은 본 adapter 책임 외).

# Internal: canonical clone path 를 결정.
_workspace_clone_path() {
  if [ -n "${TARGET_CLONE_PATH:-}" ]; then
    printf '%s' "${TARGET_CLONE_PATH}"
  else
    printf '%s/workdir/%s/repo' "${LLM_TEAM_ROOT}" "${TARGET_NAME}"
  fi
}

# Internal: unit_id 의 worktree 경로.
_workspace_unit_path() {
  local unit_id="$1"
  printf '%s/workdir/%s/wt/%s' "${LLM_TEAM_ROOT}" "${TARGET_NAME}" "${unit_id}"
}

# ws_ensure_clone <target>
# canonical clone 이 있으면 fetch, 없으면 clone.
ws_ensure_clone() {
  local target="${1:-${TARGET_NAME:-}}"
  if [ -z "${target}" ]; then
    log_error "ws_ensure_clone: target name is required"
    return 1
  fi
  if [ -z "${TARGET_GH_OWNER:-}" ] || [ -z "${TARGET_GH_REPO:-}" ]; then
    log_error "ws_ensure_clone: TARGET_GH_OWNER / TARGET_GH_REPO must be set (call load_target first)"
    return 1
  fi
  local clone_path
  clone_path="$(_workspace_clone_path)"
  mkdir -p "$(dirname "${clone_path}")" || return 1
  if [ -d "${clone_path}/.git" ]; then
    ( cd "${clone_path}" && git fetch --prune origin >/dev/null 2>&1 ) \
      || log_warn "ws_ensure_clone: fetch failed for ${clone_path}"
  else
    log_info "ws_ensure_clone: cloning ${TARGET_GH_OWNER}/${TARGET_GH_REPO} → ${clone_path}"
    git clone "https://github.com/${TARGET_GH_OWNER}/${TARGET_GH_REPO}.git" "${clone_path}" \
      >/dev/null 2>&1 \
      || { log_error "ws_ensure_clone: clone failed"; return 1; }
  fi
  printf '%s\n' "${clone_path}"
}

# ws_ensure <unit_id> [base_branch=integration]
# unit_id 별 worktree 를 생성 또는 reuse. stdout 에 worktree 경로.
ws_ensure() {
  local unit_id="$1"
  local base_branch="${2:-integration}"
  if [ -z "${unit_id}" ] || [ -z "${TARGET_NAME:-}" ]; then
    log_error "ws_ensure: unit_id and TARGET_NAME are required"
    return 1
  fi
  local clone_path wt_path branch
  clone_path="$(_workspace_clone_path)"
  wt_path="$(_workspace_unit_path "${unit_id}")"
  branch="llm-team/${unit_id}"

  if [ -d "${wt_path}/.git" ] || [ -f "${wt_path}/.git" ]; then
    log_info "ws_ensure: ${unit_id} already exists at ${wt_path}; reusing"
    printf '%s\n' "${wt_path}"
    return 0
  fi
  if [ ! -d "${clone_path}/.git" ]; then
    log_error "ws_ensure: canonical clone missing at ${clone_path}; call ws_ensure_clone first"
    return 1
  fi

  mkdir -p "$(dirname "${wt_path}")" || return 1

  (
    cd "${clone_path}" || exit 1
    git fetch origin "${branch}" >/dev/null 2>&1 || true
    if git rev-parse --verify --quiet "origin/${branch}" >/dev/null 2>&1; then
      git worktree add "${wt_path}" "${branch}" >/dev/null 2>&1 \
        || git worktree add -B "${branch}" "${wt_path}" "origin/${branch}" >/dev/null 2>&1 \
        || { log_error "ws_ensure: worktree add for existing branch ${branch} failed"; exit 1; }
      exit 0
    fi
    git fetch origin "${base_branch}" >/dev/null 2>&1 || true
    if git rev-parse --verify --quiet "origin/${base_branch}" >/dev/null 2>&1; then
      git worktree add -b "${branch}" "${wt_path}" "origin/${base_branch}" >/dev/null 2>&1 \
        || { log_error "ws_ensure: worktree add new branch from ${base_branch} failed"; exit 1; }
      exit 0
    fi
    git fetch origin "${TARGET_DEFAULT_BRANCH:-main}" >/dev/null 2>&1 || true
    git worktree add -b "${branch}" "${wt_path}" "origin/${TARGET_DEFAULT_BRANCH:-main}" >/dev/null 2>&1 \
      || { log_error "ws_ensure: worktree add new branch from default failed"; exit 1; }
  ) || return 1

  printf '%s\n' "${wt_path}"
}

# ws_refresh <unit_id>
# worktree 를 origin/<branch> tip 으로 강제 동기화. cycle 사이 다른 워커가
# 동일 브랜치를 진척시켰거나 다른 호스트에서 push 한 경우에 대비. unit 의
# branch ref 가 origin 에 없으면(아직 publish 전) no-op.
ws_refresh() {
  local unit_id="$1"
  local wt_path branch
  wt_path="$(_workspace_unit_path "${unit_id}")"
  branch="llm-team/${unit_id}"
  if [ ! -d "${wt_path}/.git" ] && [ ! -f "${wt_path}/.git" ]; then
    log_error "ws_refresh: workspace not found for unit '${unit_id}'"
    return 1
  fi
  (
    cd "${wt_path}" || exit 1
    git fetch origin "${branch}" >/dev/null 2>&1 || exit 0
    if git rev-parse --verify --quiet "origin/${branch}" >/dev/null 2>&1; then
      git reset --hard "origin/${branch}" >/dev/null 2>&1 || exit 1
    fi
  ) || { log_error "ws_refresh: failed to refresh worktree for unit '${unit_id}'"; return 1; }
}

# ws_path_of <unit_id>  → echo path or empty
ws_path_of() {
  local unit_id="$1"
  local wt_path
  wt_path="$(_workspace_unit_path "${unit_id}")"
  if [ -d "${wt_path}/.git" ] || [ -f "${wt_path}/.git" ]; then
    printf '%s\n' "${wt_path}"
  fi
}

# ws_apply_patch <unit_id> <patch_text_or_file> [commit_message]
# 두 번째 인자가 일반 파일이면 그대로 적용, 그렇지 않으면 stdin patch 로 간주.
# 적용 후 자동으로 `git add -A && git commit` 을 수행해 변경을 브랜치 tip 으로
# 영속화한다. commit_message 가 비어 있으면 기본 메시지를 사용한다.
# 변경이 없는 경우(빈 diff) 커밋은 생략하고 성공으로 취급(멱등).
ws_apply_patch() {
  local unit_id="$1" patch_arg="$2" commit_message="${3:-}"
  local wt_path
  wt_path="$(_workspace_unit_path "${unit_id}")"
  if [ ! -d "${wt_path}/.git" ] && [ ! -f "${wt_path}/.git" ]; then
    log_error "ws_apply_patch: workspace not found for unit '${unit_id}'"
    return 1
  fi
  if [ -z "${commit_message}" ]; then
    commit_message="llm-team: apply patch for ${unit_id}"
  fi
  local author_name="${LLM_TEAM_GIT_AUTHOR_NAME:-llm-team}"
  local author_email="${LLM_TEAM_GIT_AUTHOR_EMAIL:-llm-team@local}"
  (
    cd "${wt_path}" || exit 1
    if [ -f "${patch_arg}" ]; then
      git apply --3way "${patch_arg}" || exit 1
    else
      printf '%s\n' "${patch_arg}" | git apply --3way - || exit 1
    fi
    git add -A || exit 1
    if git diff --cached --quiet; then
      # 빈 diff — patch 가 이미 반영되어 있는 멱등 호출. 커밋 생략.
      exit 0
    fi
    git -c "user.name=${author_name}" -c "user.email=${author_email}" \
        commit --no-verify -m "${commit_message}" >/dev/null || exit 1
  ) || { log_error "ws_apply_patch: git apply/commit failed for unit '${unit_id}'"; return 1; }
}

# ws_publish_branch <unit_id> [branch_name=llm-team/<unit_id>]
ws_publish_branch() {
  local unit_id="$1"
  local branch="${2:-llm-team/${unit_id}}"
  local wt_path
  wt_path="$(_workspace_unit_path "${unit_id}")"
  if [ ! -d "${wt_path}/.git" ] && [ ! -f "${wt_path}/.git" ]; then
    log_error "ws_publish_branch: workspace not found for unit '${unit_id}'"
    return 1
  fi
  (
    cd "${wt_path}" || exit 1
    git push -u origin "${branch}"
  ) >/dev/null 2>&1 \
    || { log_error "ws_publish_branch: push failed for unit '${unit_id}' branch '${branch}'"; return 1; }
}

# ws_destroy <unit_id>  (best-effort)
ws_destroy() {
  local unit_id="$1"
  local wt_path clone_path
  wt_path="$(_workspace_unit_path "${unit_id}")"
  clone_path="$(_workspace_clone_path)"
  if [ -d "${clone_path}/.git" ]; then
    ( cd "${clone_path}" && git worktree remove --force "${wt_path}" >/dev/null 2>&1 ) || true
  fi
  rm -rf "${wt_path}" >/dev/null 2>&1 || true
  return 0
}

# ws_list <target>  → unit_ids (one per line)
ws_list() {
  local target="${1:-${TARGET_NAME:-}}"
  if [ -z "${target}" ]; then
    log_error "ws_list: target is required"
    return 1
  fi
  local wt_dir="${LLM_TEAM_ROOT}/workdir/${target}/wt"
  if [ -d "${wt_dir}" ]; then
    ls -1 "${wt_dir}" 2>/dev/null || true
  fi
}

# ws_get_branch_head <repo> <branch>  → echo head sha of <branch>
# `repo` 인자는 contract 시그니처 호환용 — git_worktree adapter 는 canonical clone 을
# 사용하므로 TARGET_NAME 기반 clone path 에서 조회. 인자 검증만 수행.
ws_get_branch_head() {
  local repo="$1" branch="$2"
  if [ -z "${repo}" ] || [ -z "${branch}" ]; then
    log_error "ws_get_branch_head: repo and branch are required"
    return 1
  fi
  local clone_path
  clone_path="$(_workspace_clone_path)"
  if [ ! -d "${clone_path}/.git" ]; then
    log_error "ws_get_branch_head: canonical clone missing at ${clone_path}; call ws_ensure_clone first"
    return 1
  fi
  # 로컬에 branch ref 가 있으면 그대로, 없으면 fetch 후 origin/<branch>.
  (
    cd "${clone_path}" || exit 1
    if git rev-parse --verify --quiet "${branch}" >/dev/null 2>&1; then
      git rev-parse "${branch}"
      exit 0
    fi
    git fetch --quiet origin "${branch}" >/dev/null 2>&1 || true
    if git rev-parse --verify --quiet "origin/${branch}" >/dev/null 2>&1; then
      git rev-parse "origin/${branch}"
      exit 0
    fi
    exit 1
  ) || {
    log_error "ws_get_branch_head: branch '${branch}' not found in ${clone_path}"
    return 1
  }
}

# ws_get_branch_base <repo> <branch>  → echo merge-base sha (branch ↔ integration)
# integration branch 는 ${LLM_TEAM_INTEGRATION_BRANCH:-integration} 에서 결정.
ws_get_branch_base() {
  local repo="$1" branch="$2"
  if [ -z "${repo}" ] || [ -z "${branch}" ]; then
    log_error "ws_get_branch_base: repo and branch are required"
    return 1
  fi
  local clone_path integration
  clone_path="$(_workspace_clone_path)"
  integration="${LLM_TEAM_INTEGRATION_BRANCH:-integration}"
  if [ ! -d "${clone_path}/.git" ]; then
    log_error "ws_get_branch_base: canonical clone missing at ${clone_path}; call ws_ensure_clone first"
    return 1
  fi
  (
    cd "${clone_path}" || exit 1
    # branch resolution: local first, fall back to origin/<branch> after fetch.
    local b_ref="" i_ref=""
    if git rev-parse --verify --quiet "${branch}" >/dev/null 2>&1; then
      b_ref="${branch}"
    else
      git fetch --quiet origin "${branch}" >/dev/null 2>&1 || true
      if git rev-parse --verify --quiet "origin/${branch}" >/dev/null 2>&1; then
        b_ref="origin/${branch}"
      fi
    fi
    if git rev-parse --verify --quiet "${integration}" >/dev/null 2>&1; then
      i_ref="${integration}"
    else
      git fetch --quiet origin "${integration}" >/dev/null 2>&1 || true
      if git rev-parse --verify --quiet "origin/${integration}" >/dev/null 2>&1; then
        i_ref="origin/${integration}"
      fi
    fi
    [ -n "${b_ref}" ] && [ -n "${i_ref}" ] || exit 1
    git merge-base "${b_ref}" "${i_ref}"
  ) || {
    log_error "ws_get_branch_base: cannot compute merge-base for '${branch}' against '${integration}'"
    return 1
  }
}
