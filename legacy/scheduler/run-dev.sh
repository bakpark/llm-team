#!/usr/bin/env bash
# scheduler/run-dev.sh — DEV Agent entry point (self-fetch variant).
#
# Usage: scheduler/run-dev.sh <target>
#
# Cron/daemon-driven. Each invocation:
#   1. load_target → log_init → run_stale_recovery
#   2. Collect candidates (needs-dev ∪ qa:changes-requested), oldest first
#   3. Compute slots = TARGET_DEV_CONCURRENCY − count_in_progress(dev:in-progress)
#   4. Spawn process_one_issue() in background up to slot count, then wait
#
# process_one_issue (THIN — large data is fetched by the LLM itself):
#   • Atomic label transition (current → dev:in-progress)
#   • Mode + branch determination
#   • worktree_create
#   • claude_invoke <SMALL_PROMPT> — only identifiers injected (TARGET, REPO,
#     ISSUE_NUMBER, MODE, BRANCH, BASE_BRANCH, WORKTREE_PATH, ATTEMPTS).
#     The LLM is instructed (prompts/dev.md) to fetch issue body, comments,
#     existing PR (rework), and to perform commit + push + PR create/edit
#     itself. This keeps argv well below ARG_MAX regardless of diff size.
#   • Parse RESULT marker: SUCCESS | EMPTY_CHANGE | GIT_FAILURE
#   • SUCCESS → atomic transition dev:in-progress → needs-qa
#   • EMPTY_CHANGE / GIT_FAILURE → _dev_git_failure (issue comment + dev-failure label + Notifier)
#   • Worktree cleanup in ALL branches
#
# Sources / contracts:
#   planning.md §7.4, §8.4
#   memory/state-machine.md §1, §3, §6.2
#   memory/agent-message-contract.md §3, §6
#   .plan/26050112-daemon-self-fetch/planning.md §3.1

set -euo pipefail

usage() {
  echo "Usage: $0 <target>" >&2
  exit 64
}

TARGET="${1:-}"
[ -n "${TARGET}" ] || usage

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="${LLM_TEAM_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
export LLM_TEAM_ROOT

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# _slugify <text> — kebab-case slug for branch names.
_slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-40
}

# _extract_section <file> <KEY>
# Print lines between `<<<KEY>>>` and `<<<END_KEY>>>` (exclusive).
_extract_section() {
  local file="$1" key="$2"
  awk -v open="<<<${key}>>>" -v close="<<<END_${key}>>>" '
    $0 == open  { capture=1; next }
    $0 == close { capture=0; next }
    capture     { print }
  ' "${file}"
}

# _dev_git_failure <target> <issue_num> <branch> <kind> <detail>
_dev_git_failure() {
  local target="$1" num="$2" branch="$3" kind="$4" detail="$5"
  log_error "DEV failure on issue #${num}: ${kind} — ${detail}"

  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  local L_IN_PROG L_FAIL
  L_IN_PROG="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${LABEL_DEV_IN_PROGRESS}")"
  L_FAIL="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${LABEL_DEV_FAILURE}")"

  local body
  body="$(printf '## DEV git 작업 실패 — Human Review Required\n\n### 실패 종류\n%s\n\n### 에러 로그\n```\n%s\n```\n\n### 권장 조치\n수동 충돌 해결 / 강제 push / scope 변경 등 적절한 조치를 검토한 뒤 라벨을 재조정한다.\n' \
            "${kind}" "${detail}")"

  gh_with_retry gh issue comment "${num}" --repo "${repo}" --body "${body}" >/dev/null \
    || log_warn "_dev_git_failure: failed to post failure comment on #${num}"

  issue_set_label "${repo}" "${num}" "${L_FAIL}" "${L_IN_PROG}" \
    || log_warn "_dev_git_failure: failed to transition label on #${num}"

  notify_review_needed "${target}" "dev-failure" "issue" "${num}" \
    "https://github.com/${repo}/issues/${num}" \
    "${kind}: ${detail}" || true

  if [ -n "${branch}" ] && [ -d "${TARGET_CLONE_PATH:-/nonexistent}" ]; then
    ( cd "${TARGET_CLONE_PATH}" && worktree_remove "${target}" "${branch}" ) || true
  fi
}

# process_one_issue <target> <issue_num>
# Background-spawnable worker for a single Issue.
process_one_issue() {
  local target="$1" num="$2"
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  local prefix="${TARGET_LABEL_PREFIX}"
  local L_NEEDS_DEV L_QA_CHG L_IN_PROG L_NEEDS_QA
  L_NEEDS_DEV="$(label_with_prefix "${prefix}" "${LABEL_NEEDS_DEV}")"
  L_QA_CHG="$(label_with_prefix "${prefix}" "${LABEL_QA_CHANGES_REQUESTED}")"
  L_IN_PROG="$(label_with_prefix "${prefix}" "${LABEL_DEV_IN_PROGRESS}")"
  L_NEEDS_QA="$(label_with_prefix "${prefix}" "${LABEL_NEEDS_QA}")"

  log_info "process_one_issue: starting #${num}"

  # 1. Detect mode from current labels (race-aware).
  local labels_json
  if ! labels_json="$(gh_with_retry gh issue view "${num}" --repo "${repo}" \
                        --json labels --jq '[.labels[].name] | tojson')"; then
    log_error "process_one_issue #${num}: cannot fetch labels"
    return 1
  fi

  local mode="" current_label=""
  if printf '%s' "${labels_json}" | grep -Fq "\"${L_QA_CHG}\""; then
    mode="rework"
    current_label="${L_QA_CHG}"
  elif printf '%s' "${labels_json}" | grep -Fq "\"${L_NEEDS_DEV}\""; then
    mode="new"
    current_label="${L_NEEDS_DEV}"
  else
    log_warn "process_one_issue #${num}: lost the label race; skipping"
    return 0
  fi

  # 2. Atomic transition: current → dev:in-progress.
  if ! issue_set_label "${repo}" "${num}" "${L_IN_PROG}" "${current_label}"; then
    log_error "process_one_issue #${num}: failed to enter dev:in-progress"
    return 1
  fi

  # 3. Determine branch + ATTEMPTS.
  local branch="" attempts="0"
  if [ "${mode}" = "rework" ]; then
    # Find existing PR head ref to reuse the same branch.
    local pr_json
    pr_json="$(gh_with_retry gh pr list --repo "${repo}" --state open \
                 --json number,headRefName,body \
                 --jq "[.[] | select((.body // \"\") | contains(\"Closes #${num}\"))][0] // empty" \
               2>/dev/null || true)"
    if [ -z "${pr_json}" ]; then
      _dev_git_failure "${target}" "${num}" "" "rework PR not found" \
        "Could not locate existing PR with 'Closes #${num}'"
      return 1
    fi
    branch="$(printf '%s' "${pr_json}" | jq -r '.headRefName // ""')"
    local pr_num
    pr_num="$(printf '%s' "${pr_json}" | jq -r '.number // ""')"
    if [ -z "${branch}" ] || [ -z "${pr_num}" ]; then
      _dev_git_failure "${target}" "${num}" "" "rework PR malformed" \
        "PR JSON missing headRefName or number: ${pr_json}"
      return 1
    fi
    attempts="$(pr_body_get_attempts "${repo}" "${pr_num}" 2>/dev/null || echo "1")"
  else
    # new mode — title fetch only to derive a slug
    local title
    title="$(gh_with_retry gh issue view "${num}" --repo "${repo}" --json title --jq '.title // ""' 2>/dev/null || echo "")"
    local slug
    slug="$(_slugify "${title}")"
    [ -n "${slug}" ] || slug="task"
    branch="llm-team/issue-${num}-${slug}"
    attempts="0"
  fi

  # 4. worktree.
  if [ ! -d "${TARGET_CLONE_PATH}" ]; then
    _dev_git_failure "${target}" "${num}" "${branch}" "clone path missing" \
      "TARGET_CLONE_PATH=${TARGET_CLONE_PATH} does not exist"
    return 1
  fi
  if ! ( cd "${TARGET_CLONE_PATH}" && worktree_create "${target}" "${branch}" ); then
    _dev_git_failure "${target}" "${num}" "${branch}" "worktree_create failed" \
      "git worktree add failed for branch ${branch}"
    return 1
  fi
  local worktree="${LLM_TEAM_ROOT}/workdir/${target}/worktrees/${branch}"

  # 5. Build SMALL prompt — only identifiers, no issue/PR/diff payload.
  local prompt prompt_template
  prompt_template="$(cat "${LLM_TEAM_ROOT}/prompts/dev.md")"
  prompt="$(printf '%s\n\n---\n\n## 작업 컨텍스트\n\n- TARGET: %s\n- REPO: %s\n- ISSUE_NUMBER: %s\n- MODE: %s\n- BRANCH: %s\n- BASE_BRANCH: %s\n- WORKTREE_PATH: %s\n- ATTEMPTS: %s\n' \
              "${prompt_template}" \
              "${target}" \
              "${repo}" \
              "${num}" \
              "${mode}" \
              "${branch}" \
              "${TARGET_DEFAULT_BRANCH}" \
              "${worktree}" \
              "${attempts}")"

  # 6. claude_invoke from inside the worktree so the LLM's `gh`/`git` calls
  #    operate in the right cwd by default.
  local ts output_file
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  output_file="${LLM_TEAM_ROOT}/workdir/${target}/logs/dev-claude-${num}-${ts}.txt"
  mkdir -p "$(dirname "${output_file}")"
  if ! ( cd "${worktree}" && claude_invoke "${prompt}" >"${output_file}" 2>&1 ); then
    _dev_git_failure "${target}" "${num}" "${branch}" "claude invocation failed" \
      "claude_invoke exited non-zero. See ${output_file}"
    return 1
  fi

  # 7. Parse RESULT marker.
  local result detail pr_number
  result="$(_extract_section "${output_file}" 'RESULT' \
              | sed -e 's/^[[:space:]]*//; s/[[:space:]]*$//' \
              | awk 'NF { print; exit }')"
  detail="$(_extract_section "${output_file}" 'DETAIL')"
  pr_number="$(_extract_section "${output_file}" 'PR_NUMBER' \
                 | sed -e 's/^[[:space:]]*//; s/[[:space:]]*$//' \
                 | awk 'NF { print; exit }')"
  [ -n "${detail}" ] || detail="(LLM 출력에 DETAIL 마커가 없었습니다.)"

  case "${result}" in
    SUCCESS)
      log_info "process_one_issue #${num}: LLM reports SUCCESS pr=${pr_number:-?}"
      if ! issue_set_label "${repo}" "${num}" "${L_NEEDS_QA}" "${L_IN_PROG}"; then
        log_error "process_one_issue #${num}: failed to transition to needs-qa"
      fi
      ;;
    EMPTY_CHANGE|GIT_FAILURE)
      _dev_git_failure "${target}" "${num}" "${branch}" "${result}" "${detail}"
      ;;
    *)
      _dev_git_failure "${target}" "${num}" "${branch}" "RESULT marker missing/malformed" \
        "Expected one of SUCCESS|EMPTY_CHANGE|GIT_FAILURE. See ${output_file}"
      ;;
  esac

  # 8. Worktree cleanup.
  ( cd "${TARGET_CLONE_PATH}" && worktree_remove "${target}" "${branch}" ) || true

  log_info "process_one_issue #${num}: completed (mode=${mode}, branch=${branch}, result=${result:-?})"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

load_target "${TARGET}"
log_init dev "${TARGET}"
log_info "run-dev: starting target=${TARGET} dev_concurrency=${TARGET_DEV_CONCURRENCY}"

run_stale_recovery "${TARGET}" || log_warn "run-dev: stale recovery returned non-zero"

REPO="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
PFX="${TARGET_LABEL_PREFIX}"
LBL_NEEDS_DEV="$(label_with_prefix "${PFX}" "${LABEL_NEEDS_DEV}")"
LBL_QA_CHG="$(label_with_prefix "${PFX}" "${LABEL_QA_CHANGES_REQUESTED}")"
LBL_DEV_IN_PROGRESS="$(label_with_prefix "${PFX}" "${LABEL_DEV_IN_PROGRESS}")"

CAND_NEW="$(issue_list_by_label "${REPO}" "${LBL_NEEDS_DEV}" 2>/dev/null || true)"
CAND_REWORK="$(issue_list_by_label "${REPO}" "${LBL_QA_CHG}" 2>/dev/null || true)"
CANDIDATES="$(printf '%s\n%s\n' "${CAND_NEW}" "${CAND_REWORK}" | awk 'NF && !seen[$0]++')"

if [ -z "${CANDIDATES}" ]; then
  log_info "run-dev: no candidate issues; exit 0"
  exit 0
fi

IN_PROGRESS_COUNT="$(count_in_progress "${REPO}" "${LBL_DEV_IN_PROGRESS}" 2>/dev/null || echo 0)"
[ -n "${IN_PROGRESS_COUNT}" ] || IN_PROGRESS_COUNT=0
SLOTS=$(( TARGET_DEV_CONCURRENCY - IN_PROGRESS_COUNT ))
if [ "${SLOTS}" -le 0 ]; then
  log_info "run-dev: no slots (in_progress=${IN_PROGRESS_COUNT}, limit=${TARGET_DEV_CONCURRENCY}); exit 0"
  exit 0
fi
log_info "run-dev: in_progress=${IN_PROGRESS_COUNT} slots=${SLOTS}; spawning workers"

SELECTED="$(printf '%s\n' "${CANDIDATES}" | head -n "${SLOTS}")"
while IFS= read -r issue_num; do
  [ -n "${issue_num}" ] || continue
  process_one_issue "${TARGET}" "${issue_num}" &
done <<EOF
${SELECTED}
EOF

wait
log_info "run-dev: all workers finished"
exit 0
