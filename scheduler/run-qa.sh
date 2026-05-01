#!/usr/bin/env bash
# scheduler/run-qa.sh — QA Agent entry point (self-fetch variant).
#
# Usage: scheduler/run-qa.sh <target>
#
# Behaviour (planning.md §8.5, memory/state-machine.md §4 + §8,
#            .plan/26050112-daemon-self-fetch §3.1):
#   1. Load target yaml, init logs, run stale recovery
#   2. Pick up open issues labeled `needs-qa`
#   3. Spawn process_one_issue() in background up to TARGET_DEV_CONCURRENCY (MVP reuse)
#   4. Each worker:
#        a. atomic transition needs-qa → qa:in-progress
#        b. find linked PR, attempts marker, head ref
#        c. worktree_create at PR head
#        d. claude_invoke <SMALL_PROMPT> — only identifiers injected;
#           the LLM (prompts/qa.md) fetches issue body, PR body, diff itself
#        e. parse first line: RESULT: PASS | FAIL
#        f. branch on PASS / FAIL+N=1 / FAIL+N=2
#        g. cleanup worktree in ALL branches
#   5. PASS branch: PR merge → Issue close → labels removed →
#      milestone progress check → milestone close (if last issue)

set -euo pipefail

_QA_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${_QA_SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT
unset _QA_SCRIPT_DIR
# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

qa_label() {
  label_with_prefix "${TARGET_LABEL_PREFIX:-}" "$1"
}

qa_find_pr_for_issue() {
  local repo="$1" issue_num="$2"
  local pr_num=""
  pr_num="$(gh_with_retry gh pr list --repo "${repo}" --state open \
              --search "in:body \"Closes #${issue_num}\"" \
              --json number,createdAt \
              --jq 'sort_by(.createdAt) | .[-1].number // empty' 2>/dev/null || true)"
  if [ -z "${pr_num}" ]; then
    pr_num="$(gh_with_retry gh api "repos/${repo}/issues/${issue_num}/timeline" \
                -H "Accept: application/vnd.github.mockingbird-preview+json" \
                --jq '[.[] | select(.event=="cross-referenced" and .source.issue.pull_request != null) | .source.issue.number] | last // empty' \
                2>/dev/null || true)"
  fi
  printf '%s' "${pr_num}"
}

qa_pr_get_head() {
  gh_with_retry gh api "repos/$1/pulls/$2" --jq '.head.ref // ""'
}
qa_pr_get_url() {
  gh_with_retry gh api "repos/$1/pulls/$2" --jq '.html_url // ""'
}
qa_issue_get_url() {
  gh_with_retry gh api "repos/$1/issues/$2" --jq '.html_url // ""'
}

qa_remove_all_state_labels() {
  local repo="$1" num="$2"
  issue_clear_state_labels "${repo}" "${num}" "${TARGET_LABEL_PREFIX:-}"
}

qa_pr_comment() {
  local repo="$1" pr_num="$2" body="$3"
  gh_with_retry gh pr comment "${pr_num}" --repo "${repo}" --body "${body}" >/dev/null
}

qa_issue_comment() {
  local repo="$1" issue_num="$2" body="$3"
  gh_with_retry gh issue comment "${issue_num}" --repo "${repo}" --body "${body}" >/dev/null
}

# -----------------------------------------------------------------------------
# process_one_issue <target> <issue_num>
# -----------------------------------------------------------------------------
process_one_issue() {
  local target="$1" issue_num="$2"

  if [ "${TARGET_NAME:-}" != "${target}" ]; then
    load_target "${target}" || { log_error "process_one_issue: load_target failed"; return 0; }
  fi
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"

  log_info "qa: picking issue #${issue_num}"

  local lbl_needs_qa lbl_qa_in_progress lbl_changes_requested lbl_dev_failure
  lbl_needs_qa="$(qa_label "${LABEL_NEEDS_QA}")"
  lbl_qa_in_progress="$(qa_label "${LABEL_QA_IN_PROGRESS}")"
  lbl_changes_requested="$(qa_label "${LABEL_QA_CHANGES_REQUESTED}")"
  lbl_dev_failure="$(qa_label "${LABEL_DEV_FAILURE}")"

  # Step 1: atomic transition.
  if ! issue_set_label "${repo}" "${issue_num}" "${lbl_qa_in_progress}" "${lbl_needs_qa}"; then
    log_warn "qa: failed to transition issue #${issue_num} to qa:in-progress; skipping"
    return 0
  fi

  # Step 2: locate the PR + attempts marker.
  local pr_num head_ref pr_url
  pr_num="$(qa_find_pr_for_issue "${repo}" "${issue_num}")"
  if [ -z "${pr_num}" ]; then
    log_error "qa: no linked PR found for issue #${issue_num}"
    qa_issue_comment "${repo}" "${issue_num}" \
      "QA Agent: 연결된 PR을 찾을 수 없습니다. 사람의 검토가 필요합니다." || true
    issue_set_label "${repo}" "${issue_num}" "${lbl_dev_failure}" "${lbl_qa_in_progress}" || true
    local issue_url
    issue_url="$(qa_issue_get_url "${repo}" "${issue_num}")"
    notify_review_needed "${target}" "dev-failure" "issue" "${issue_num}" \
      "${issue_url}" "QA Agent: linked PR not found for issue #${issue_num}." || true
    return 0
  fi

  local attempts
  attempts="$(pr_body_get_attempts "${repo}" "${pr_num}" 2>/dev/null || echo "0")"
  if [ -z "${attempts}" ] || [ "${attempts}" = "0" ]; then
    attempts="1"
  fi
  head_ref="$(qa_pr_get_head "${repo}" "${pr_num}" 2>/dev/null || echo "")"
  pr_url="$(qa_pr_get_url "${repo}" "${pr_num}" 2>/dev/null || echo "")"

  if [ -z "${head_ref}" ]; then
    log_error "qa: PR #${pr_num} has no head.ref"
    qa_pr_comment "${repo}" "${pr_num}" \
      "QA Agent: PR head 브랜치를 식별할 수 없습니다. 사람 검토 필요." || true
    issue_set_label "${repo}" "${issue_num}" "${lbl_dev_failure}" "${lbl_qa_in_progress}" || true
    notify_review_needed "${target}" "dev-failure" "issue" "${issue_num}" \
      "${pr_url}" "QA Agent: PR #${pr_num} head ref missing." || true
    return 0
  fi

  # Step 3: prepare worktree at PR head.
  local clone_path="${TARGET_CLONE_PATH}"
  if [ ! -d "${clone_path}" ]; then
    log_error "qa: clone path does not exist: ${clone_path}"
    qa_pr_comment "${repo}" "${pr_num}" \
      "QA Agent: 로컬 clone 경로(${clone_path})가 없어 검증을 시작할 수 없습니다." || true
    return 0
  fi

  local worktree_path="${LLM_TEAM_ROOT}/workdir/${target}/worktrees/${head_ref}"
  if ! ( cd "${clone_path}" && worktree_create "${target}" "${head_ref}" ); then
    log_error "qa: worktree_create failed for ${head_ref}"
    qa_pr_comment "${repo}" "${pr_num}" \
      "QA Agent: worktree 생성 실패 (\`${head_ref}\`)." || true
    ( cd "${clone_path}" && worktree_remove "${target}" "${head_ref}" ) || true
    return 0
  fi

  # Step 4: build SMALL prompt (no diff/issue/PR body injected — LLM fetches).
  local prompt prompt_template
  prompt_template="$(cat "${LLM_TEAM_ROOT}/prompts/qa.md")"
  prompt="$(printf '%s\n\n---\n\n## 작업 컨텍스트\n\n- TARGET: %s\n- REPO: %s\n- ISSUE_NUMBER: %s\n- PR_NUMBER: %s\n- ATTEMPTS: %s\n- WORKTREE_PATH: %s\n- BASE_BRANCH: %s\n' \
              "${prompt_template}" \
              "${target}" \
              "${repo}" \
              "${issue_num}" \
              "${pr_num}" \
              "${attempts}" \
              "${worktree_path}" \
              "${TARGET_DEFAULT_BRANCH}")"

  local output_file
  output_file="$(mktemp -t llm-team-qa-XXXXXX)"

  local llm_rc=0
  ( cd "${worktree_path}" && claude_invoke "${prompt}" ) >"${output_file}" 2>&1 || llm_rc=$?

  # Step 5: parse output.
  local first_line llm_body result
  first_line="$(head -n 1 "${output_file}" 2>/dev/null || echo "")"
  llm_body="$(tail -n +2 "${output_file}" 2>/dev/null || echo "")"

  case "${first_line}" in
    "RESULT: PASS") result="PASS" ;;
    "RESULT: FAIL") result="FAIL" ;;
    *)
      log_warn "qa: malformed output for issue #${issue_num} (rc=${llm_rc}); treating as FAIL N=1"
      result="FAIL"
      attempts="1"
      llm_body="$(printf '## QA Agent output malformed\n\nClaude Code 호출이 contract 위반 출력을 반환했습니다.\n\n### 첫 줄 (received)\n\n```\n%s\n```\n\n### 원본 출력 (truncated)\n\n```\n%s\n```\n' \
        "${first_line}" "$(head -c 4000 "${output_file}" 2>/dev/null || echo "")" )"
      ;;
  esac

  rm -f "${output_file}" || true

  # Step 6: branch on result.
  if [ "${result}" = "PASS" ]; then
    qa_handle_pass "${target}" "${repo}" "${issue_num}" "${pr_num}" "${head_ref}" "${pr_url}"
  elif [ "${attempts}" = "2" ]; then
    qa_handle_fail_second "${target}" "${repo}" "${issue_num}" "${pr_num}" "${pr_url}" "${llm_body}"
  else
    qa_handle_fail_first "${target}" "${repo}" "${issue_num}" "${pr_num}" "${llm_body}"
  fi

  # Step 7: cleanup worktree always.
  ( cd "${clone_path}" && worktree_remove "${target}" "${head_ref}" ) || true

  return 0
}

# -----------------------------------------------------------------------------
qa_handle_pass() {
  local target="$1" repo="$2" issue_num="$3" pr_num="$4" head_ref="$5" pr_url="$6"
  local lbl_qa_in_progress lbl_dev_failure
  lbl_qa_in_progress="$(qa_label "${LABEL_QA_IN_PROGRESS}")"
  lbl_dev_failure="$(qa_label "${LABEL_DEV_FAILURE}")"

  log_info "qa: PASS — merging PR #${pr_num} for issue #${issue_num}"

  local milestone_num
  milestone_num="$(issue_get_milestone "${repo}" "${issue_num}" 2>/dev/null || echo "")"

  if ! gh_with_retry gh pr merge "${pr_num}" --repo "${repo}" --squash --delete-branch >/dev/null 2>&1; then
    log_error "qa: merge failed for PR #${pr_num} (likely conflict)"
    qa_pr_comment "${repo}" "${pr_num}" \
      "$(printf '## DEV git 작업 실패 — Human Review Required\n\n### 실패 종류\nQA가 PASS 판정 후 squash merge를 시도했으나 실패했습니다 (대부분 머지 충돌).\n\n### 권장 조치\n- 충돌 해결 후 수동 머지\n- 또는 브랜치 폐기 후 재시작\n')"
    issue_set_label "${repo}" "${issue_num}" "${lbl_dev_failure}" "${lbl_qa_in_progress}" || true
    notify_review_needed "${target}" "dev-failure" "issue" "${issue_num}" \
      "${pr_url}" "QA Agent: merge conflict on PR #${pr_num} after PASS verdict." || true
    return 0
  fi

  gh_with_retry gh issue close "${issue_num}" --repo "${repo}" >/dev/null 2>&1 || true
  qa_remove_all_state_labels "${repo}" "${issue_num}"

  if [ -n "${milestone_num}" ]; then
    local progress open_count
    progress="$(milestone_get_progress "${repo}" "${milestone_num}" 2>/dev/null || echo "")"
    open_count="$(printf '%s' "${progress}" | sed -n 's/^open=\([0-9]*\).*/\1/p')"
    if [ -n "${open_count}" ] && [ "${open_count}" -eq 0 ]; then
      log_info "qa: closing milestone #${milestone_num} (no open issues remain)"
      milestone_close "${repo}" "${milestone_num}" || \
        log_warn "qa: milestone_close failed for #${milestone_num}"
    else
      log_info "qa: milestone #${milestone_num} still has open issues (${progress}); leaving open"
    fi
  fi
}

# -----------------------------------------------------------------------------
qa_handle_fail_first() {
  local target="$1" repo="$2" issue_num="$3" pr_num="$4" llm_body="$5"
  local lbl_qa_in_progress lbl_changes_requested
  lbl_qa_in_progress="$(qa_label "${LABEL_QA_IN_PROGRESS}")"
  lbl_changes_requested="$(qa_label "${LABEL_QA_CHANGES_REQUESTED}")"

  log_info "qa: FAIL (1st) — sending changes-requested for issue #${issue_num}"

  qa_pr_comment "${repo}" "${pr_num}" "${llm_body}" || \
    log_warn "qa: failed to post 1st-fail PR comment on #${pr_num}"

  issue_set_label "${repo}" "${issue_num}" "${lbl_changes_requested}" "${lbl_qa_in_progress}" || \
    log_error "qa: failed to transition issue #${issue_num} to qa:changes-requested"
}

# -----------------------------------------------------------------------------
qa_handle_fail_second() {
  local target="$1" repo="$2" issue_num="$3" pr_num="$4" pr_url="$5" llm_body="$6"
  local lbl_qa_in_progress lbl_dev_failure
  lbl_qa_in_progress="$(qa_label "${LABEL_QA_IN_PROGRESS}")"
  lbl_dev_failure="$(qa_label "${LABEL_DEV_FAILURE}")"

  log_info "qa: FAIL (2nd) — escalating issue #${issue_num} to human"

  qa_pr_comment "${repo}" "${pr_num}" "${llm_body}" || \
    log_warn "qa: failed to post 2nd-fail PR comment on #${pr_num}"

  issue_set_label "${repo}" "${issue_num}" "${lbl_dev_failure}" "${lbl_qa_in_progress}" || \
    log_error "qa: failed to transition issue #${issue_num} to needs-human-review:dev-failure"

  local summary
  summary="$(printf 'PR #%s: 2차 QA 실패 (사람 개입 필요).' "${pr_num}")"
  notify_review_needed "${target}" "dev-failure" "issue" "${issue_num}" \
    "${pr_url}" "${summary}" || true
}

# -----------------------------------------------------------------------------
main() {
  local target="${1:-}"
  if [ -z "${target}" ]; then
    log_error "Usage: scheduler/run-qa.sh <target>"
    exit 2
  fi

  load_target "${target}"
  if [ "${TARGET_ENABLED}" != "true" ]; then
    log_info "run-qa: target '${target}' is disabled; exiting"
    exit 0
  fi

  log_init "qa" "${target}"
  run_stale_recovery "${target}" || log_warn "run-qa: stale recovery returned non-zero"

  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  local lbl_needs_qa lbl_qa_in_progress
  lbl_needs_qa="$(qa_label "${LABEL_NEEDS_QA}")"
  lbl_qa_in_progress="$(qa_label "${LABEL_QA_IN_PROGRESS}")"

  local cap="${TARGET_DEV_CONCURRENCY:-3}"
  case "${cap}" in
    ''|*[!0-9]*) cap=3 ;;
  esac

  local in_progress slots_left
  in_progress="$(count_in_progress "${repo}" "${lbl_qa_in_progress}" 2>/dev/null || echo "0")"
  slots_left=$(( cap - in_progress ))
  if [ "${slots_left}" -lt 1 ]; then
    slots_left=0
  fi

  log_info "run-qa: cap=${cap} in_progress=${in_progress} slots_left=${slots_left}"

  if [ "${slots_left}" -le 0 ]; then
    log_info "run-qa: no slots available this tick; exiting"
    exit 0
  fi

  local candidates
  candidates="$(issue_list_by_label "${repo}" "${lbl_needs_qa}" 2>/dev/null || true)"
  if [ -z "${candidates}" ]; then
    log_info "run-qa: no needs-qa issues; exiting"
    exit 0
  fi

  local spawned=0 issue_num
  local pids=()
  while IFS= read -r issue_num; do
    [ -n "${issue_num}" ] || continue
    if [ "${spawned}" -ge "${slots_left}" ]; then
      break
    fi
    process_one_issue "${target}" "${issue_num}" &
    pids+=("$!")
    spawned=$(( spawned + 1 ))
  done <<EOF
${candidates}
EOF

  log_info "run-qa: spawned ${spawned} workers; waiting"

  local pid
  for pid in "${pids[@]}"; do
    wait "${pid}" || true
  done

  log_info "run-qa: done (target=${target})"
}

main "$@"
