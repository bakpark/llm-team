#!/usr/bin/env bash
# lib/concurrency.sh — DEV/QA parallel-slot accounting.
#
# Per the MVP simplification in sub-common-lib §A.10, we do NOT provide a
# `with_concurrency_limit` wrapper. Callers (scheduler/run-dev.sh,
# scheduler/run-qa.sh) spawn child processes with `&` + `wait` directly. This
# module only exposes a query helper used to throttle pickup decisions.
#
# Public API:
#   count_in_progress <repo> <label>  — print count of open issues with the label.

# count_in_progress <repo> <label>
count_in_progress() {
  local repo="$1" label="$2"
  if [ -z "${repo}" ] || [ -z "${label}" ]; then
    log_error "count_in_progress: repo and label are required"
    return 1
  fi
  local count
  count="$(gh_with_retry gh issue list --repo "${repo}" --label "${label}" \
            --state open --json number --jq 'length' 2>/dev/null || echo "0")"
  if [ -z "${count}" ]; then
    count="0"
  fi
  printf '%s' "${count}"
}
