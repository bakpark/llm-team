#!/usr/bin/env bash
# lib/markers.sh — hidden HTML marker helpers (memory/state-machine.md §6).
#
# Two marker families:
#   • Notifier idempotency markers — `<!-- llm-team:notified:<kind> -->`.
#     Stored as a comment on the target Issue/PR or appended to the
#     Milestone description (milestones lack comments).
#   • QA attempt markers — `<!-- llm-team:qa-attempts:N -->`.
#     Stored on the LAST line of the PR body. DEV writes :1 on first PR,
#     updates to :2 on re-pickup. QA reads the latest value.

# marker_notified <kind>
# Returns the canonical Notifier marker string for <kind>.
marker_notified() {
  printf '<!-- llm-team:notified:%s -->' "$1"
}

# marker_qa_attempts <n>
# Returns the canonical QA-attempts marker string for value <n>.
marker_qa_attempts() {
  printf '<!-- llm-team:qa-attempts:%s -->' "$1"
}

# comments_have_marker <type> <repo> <num> <kind>
#   <type> ∈ issue | pr | milestone
# Returns 0 if a notify marker for <kind> is already present, non-zero
# otherwise. For issue/pr we scan all comments. For milestone we inspect the
# milestone description (the only addressable text surface for milestones).
comments_have_marker() {
  local type="$1" repo="$2" num="$3" kind="$4"
  if [ -z "${type}" ] || [ -z "${repo}" ] || [ -z "${num}" ] || [ -z "${kind}" ]; then
    log_error "comments_have_marker: type, repo, num, kind are required"
    return 2
  fi
  local marker body
  marker="$(marker_notified "${kind}")"
  case "${type}" in
    issue|pr)
      body="$(gh_with_retry gh api "repos/${repo}/issues/${num}/comments" \
                --jq '.[].body' 2>/dev/null || true)"
      ;;
    milestone)
      body="$(gh_with_retry gh api "repos/${repo}/milestones/${num}" \
                --jq '.description // ""' 2>/dev/null || true)"
      ;;
    *)
      log_error "comments_have_marker: invalid type '${type}'"
      return 2
      ;;
  esac
  printf '%s' "${body}" | grep -Fq "${marker}"
}

# pr_body_get_attempts <repo> <pr_num>
# Print the integer N from the LAST `<!-- llm-team:qa-attempts:N -->` marker in
# the PR body. Defaults to "0" if no marker is present.
pr_body_get_attempts() {
  local repo="$1" pr_num="$2"
  local body n
  body="$(gh_with_retry gh api "repos/${repo}/pulls/${pr_num}" --jq '.body // ""' 2>/dev/null || true)"
  n="$(printf '%s' "${body}" | grep -oE '<!-- llm-team:qa-attempts:[0-9]+ -->' \
        | tail -n 1 | sed -E 's/.*qa-attempts:([0-9]+).*/\1/')"
  if [ -z "${n}" ]; then
    printf '0'
  else
    printf '%s' "${n}"
  fi
}

# pr_body_set_attempts <repo> <pr_num> <n>
# Replace any existing qa-attempts marker(s) in the PR body with `:n` appended
# at the end of the body, separated by a blank line. Calls `gh pr edit --body`.
pr_body_set_attempts() {
  local repo="$1" pr_num="$2" n="$3"
  if [ -z "${repo}" ] || [ -z "${pr_num}" ] || [ -z "${n}" ]; then
    log_error "pr_body_set_attempts: repo, pr_num, n are required"
    return 1
  fi
  local body new_marker
  body="$(gh_with_retry gh api "repos/${repo}/pulls/${pr_num}" --jq '.body // ""')" || return 1
  new_marker="$(marker_qa_attempts "${n}")"
  # Strip any prior qa-attempts markers and trailing whitespace.
  body="$(printf '%s' "${body}" | sed -E '/<!-- llm-team:qa-attempts:[0-9]+ -->/d')"
  body="$(printf '%s' "${body}" | sed -e 's/[[:space:]]*$//')"
  body="${body}"$'\n\n'"${new_marker}"
  gh_with_retry gh pr edit "${pr_num}" --repo "${repo}" --body "${body}" >/dev/null
}
