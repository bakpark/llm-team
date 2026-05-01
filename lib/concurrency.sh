#!/usr/bin/env bash
# lib/concurrency.sh - small queue-count helper.
#
# Lease helpers in lib/lease.sh are the authoritative concurrency mechanism.
# This helper remains for GitHub adapter code that wants to count visible queue
# labels for dashboards or throttling.

count_in_progress() {
  local repo="$1" label="$2"
  if [ -z "${repo}" ] || [ -z "${label}" ]; then
    log_error "count_in_progress: repo and label are required"
    return 1
  fi
  local count
  count="$(gh_with_retry gh issue list --repo "${repo}" --label "${label}" \
            --state open --json number --jq 'length' 2>/dev/null || echo "0")"
  [ -n "${count}" ] || count="0"
  printf '%s' "${count}"
}
