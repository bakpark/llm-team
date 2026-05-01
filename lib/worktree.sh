#!/usr/bin/env bash
# lib/worktree.sh — git worktree helpers for DEV/QA agents.
#
# Public API (caller MUST `cd "${TARGET_CLONE_PATH}"` before invoking):
#   worktree_create <target> <branch>  — create or reuse worktree under
#                                         workdir/<target>/worktrees/<branch>/.
#   worktree_remove <target> <branch>  — best-effort remove of the worktree.
#   worktree_list   <target>           — print existing worktree branch names.

# worktree_create <target> <branch>
# Behaviour:
#   • If a worktree at the target path already exists, return success.
#   • If origin/<branch> exists, check it out into the worktree.
#   • Else create a new branch off origin/${TARGET_DEFAULT_BRANCH}.
worktree_create() {
  local target="$1" branch="$2"
  if [ -z "${target}" ] || [ -z "${branch}" ]; then
    log_error "worktree_create: target and branch are required"
    return 1
  fi
  local wt_root="${LLM_TEAM_ROOT}/workdir/${target}/worktrees/${branch}"
  mkdir -p "$(dirname "${wt_root}")"

  if [ -e "${wt_root}/.git" ] || git worktree list --porcelain 2>/dev/null | grep -Fq "${wt_root}"; then
    log_info "worktree_create: ${wt_root} already exists; reusing"
    return 0
  fi

  if git fetch origin "${branch}" >/dev/null 2>&1 \
      && git rev-parse --verify --quiet "origin/${branch}" >/dev/null; then
    if ! git worktree add "${wt_root}" "${branch}" >/dev/null 2>&1; then
      git worktree add -B "${branch}" "${wt_root}" "origin/${branch}" \
        || { log_error "worktree_create: failed to add worktree for existing branch ${branch}"; return 1; }
    fi
  else
    git fetch origin "${TARGET_DEFAULT_BRANCH:-main}" >/dev/null 2>&1 || true
    git worktree add -b "${branch}" "${wt_root}" "origin/${TARGET_DEFAULT_BRANCH:-main}" \
      || { log_error "worktree_create: failed to create new branch ${branch}"; return 1; }
  fi
}

# worktree_remove <target> <branch>
worktree_remove() {
  local target="$1" branch="$2"
  if [ -z "${target}" ] || [ -z "${branch}" ]; then
    log_error "worktree_remove: target and branch are required"
    return 1
  fi
  local wt_root="${LLM_TEAM_ROOT}/workdir/${target}/worktrees/${branch}"
  git worktree remove --force "${wt_root}" >/dev/null 2>&1 || true
  rm -rf "${wt_root}" >/dev/null 2>&1 || true
}

# worktree_list <target>
worktree_list() {
  local target="$1"
  local wt_dir="${LLM_TEAM_ROOT}/workdir/${target}/worktrees"
  if [ -d "${wt_dir}" ]; then
    ls -1 "${wt_dir}" 2>/dev/null || true
  fi
}
