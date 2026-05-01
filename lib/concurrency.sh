#!/usr/bin/env bash
# lib/concurrency.sh - small queue-count helper.
#
# Lease helpers in lib/lease.sh are the authoritative concurrency mechanism.
# This helper exists for application code that wants to count visible queue
# labels for dashboards or throttling.
#
# 본 함수는 issue_tracker port 만 호출 — `gh` 직접 결합 없음.

count_in_progress() {
  local repo="$1" label="$2"
  if [ -z "${repo}" ] || [ -z "${label}" ]; then
    log_error "count_in_progress: repo and label are required"
    return 1
  fi
  local lines
  lines="$(it_issue_list_with_label "${repo}" "${label}" 2>/dev/null || true)"
  if [ -z "${lines}" ]; then
    printf '0'
  else
    printf '%s' "$(printf '%s\n' "${lines}" | grep -c '^[0-9]')"
  fi
}
