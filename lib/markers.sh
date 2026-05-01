#!/usr/bin/env bash
# lib/markers.sh - hidden HTML marker helpers for GitHub adapter artifacts.

marker_notified() {
  printf '<!-- llm-team:notified:%s -->' "$1"
}

marker_human_signal_open() {
  printf '<!-- llm-team:human-signal'
}

marker_human_signal_close() {
  printf '%s' '-->'
}

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
