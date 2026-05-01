#!/usr/bin/env bash
# lib/gh.sh - gh CLI wrapper and GitHub adapter helpers.
#
# Public API:
#   gh_with_retry <args...>                                  — exponential backoff (3 attempts).
#   issue_set_label <repo> <num> <new> <old>                 — atomic add → remove transition.
#   milestone_set_label <repo> <num> <new> <old>             — same pattern, encoded in description.
#   milestone_get_progress <repo> <num>                      — print "open=N closed=M".
#   milestone_close <repo> <num>                             — PATCH state=closed.
#   issue_list_by_label <repo> <label>                       — issue numbers, oldest first.
#   milestone_list_by_label <repo> <label>                   — milestone numbers, oldest first.
#   issue_list_open_milestones <repo>                        — all open milestone numbers.
#   issue_get_milestone <repo> <issue_num>                   — milestone number for an issue.
#
# Backoff intervals are overridable via env (used by the smoke tests):
#   GH_RETRY_DELAY_1, GH_RETRY_DELAY_2, GH_RETRY_DELAY_3 (defaults: 2, 8, 30 seconds).
#
# GitHub Milestones do not natively support labels. Contract state should be
# encoded with `<!-- llm-team:milestone-state:<STATE> -->` markers. Legacy
# label markers remain supported only for migration helpers.

: "${GH_RETRY_DELAY_1:=2}"
: "${GH_RETRY_DELAY_2:=8}"
: "${GH_RETRY_DELAY_3:=30}"

# gh_with_retry <command> [args...]
# Runs the given command. On non-zero exit, retries up to 3 total attempts with
# back-off delays GH_RETRY_DELAY_{1,2,3}. Returns the final command's exit code.
gh_with_retry() {
  local attempt=1
  local rc=0
  local delay
  while [ "${attempt}" -le 3 ]; do
    "$@"
    rc=$?
    if [ "${rc}" -eq 0 ]; then
      return 0
    fi
    if [ "${attempt}" -lt 3 ]; then
      case "${attempt}" in
        1) delay="${GH_RETRY_DELAY_1}" ;;
        2) delay="${GH_RETRY_DELAY_2}" ;;
        *) delay="${GH_RETRY_DELAY_3}" ;;
      esac
      log_warn "gh_with_retry: attempt ${attempt} failed (rc=${rc}); retrying in ${delay}s — cmd: $*"
      sleep "${delay}"
    else
      log_error "gh_with_retry: attempt ${attempt} failed (rc=${rc}); giving up — cmd: $*"
    fi
    attempt=$((attempt+1))
  done
  return "${rc}"
}

# --- Issue label transition --------------------------------------------------

# issue_set_label <repo> <num> <new_label> <old_label>
# Atomic transition: ADD <new_label> first, then REMOVE <old_label>.
# Lease records remain the authoritative concurrency control.
issue_set_label() {
  local repo="$1" num="$2" new_label="$3" old_label="$4"
  if [ -z "${repo}" ] || [ -z "${num}" ]; then
    log_error "issue_set_label: repo and num are required"
    return 1
  fi
  if [ -n "${new_label}" ]; then
    gh_with_retry gh issue edit "${num}" --repo "${repo}" --add-label "${new_label}" >/dev/null \
      || { log_error "issue_set_label: add ${new_label} failed on issue #${num}"; return 1; }
  fi
  if [ -n "${old_label}" ]; then
    gh_with_retry gh issue edit "${num}" --repo "${repo}" --remove-label "${old_label}" >/dev/null \
      || { log_error "issue_set_label: remove ${old_label} failed on issue #${num}"; return 1; }
  fi
}

# issue_clear_state_labels <repo> <num> [<prefix>]
# Terminal cleanup: remove every framework Issue-state label from an issue.
# This is NOT a state transition (no "next" label) — it is the end-of-life
# operation called by QA after PR merge / Issue close. Keeping it in lib
# preserves the rule that scheduler scripts never invoke `gh issue edit
# --remove-label` directly.
issue_clear_state_labels() {
  local repo="$1" num="$2"
  local prefix="${3:-${TARGET_LABEL_PREFIX:-}}"
  if [ -z "${repo}" ] || [ -z "${num}" ]; then
    log_error "issue_clear_state_labels: repo and num are required"
    return 1
  fi
  local label prefixed
  for label in "${ALL_ISSUE_LABELS[@]}"; do
    prefixed="$(label_with_prefix "${prefix}" "${label}")"
    gh_with_retry gh issue edit "${num}" --repo "${repo}" \
      --remove-label "${prefixed}" >/dev/null 2>&1 || true
  done
}

# issue_list_by_label <repo> <label>
# Print issue numbers (one per line, oldest first) carrying the given label.
issue_list_by_label() {
  local repo="$1" label="$2"
  gh_with_retry gh issue list --repo "${repo}" --label "${label}" --state open \
    --json number,createdAt --jq 'sort_by(.createdAt) | .[].number'
}

# issue_get_milestone <repo> <issue_num>
issue_get_milestone() {
  local repo="$1" num="$2"
  gh_with_retry gh api "repos/${repo}/issues/${num}" --jq '.milestone.number // empty'
}

# --- Milestone helpers (description-encoded labels) --------------------------

# Internal: produce the marker string used to encode a milestone-label.
_milestone_label_marker() {
  printf '<!-- llm-team:milestone-label:%s -->' "$1"
}

# Internal: print the current description of a milestone (or empty string).
_milestone_get_description() {
  local repo="$1" num="$2"
  gh_with_retry gh api "repos/${repo}/milestones/${num}" --jq '.description // ""'
}

# Internal: PATCH the milestone description.
_milestone_patch_description() {
  local repo="$1" num="$2" desc="$3"
  gh_with_retry gh api -X PATCH "repos/${repo}/milestones/${num}" -f "description=${desc}" >/dev/null
}

# milestone_set_label <repo> <num> <new_label> <old_label>
# Atomic transition (add → remove). Implemented by appending a marker for
# <new_label> and stripping the marker for <old_label> from the description.
milestone_set_label() {
  local repo="$1" num="$2" new_label="$3" old_label="$4"
  if [ -z "${repo}" ] || [ -z "${num}" ]; then
    log_error "milestone_set_label: repo and num are required"
    return 1
  fi
  local desc
  desc="$(_milestone_get_description "${repo}" "${num}")" || return 1

  if [ -n "${new_label}" ]; then
    local new_marker
    new_marker="$(_milestone_label_marker "${new_label}")"
    if ! printf '%s' "${desc}" | grep -Fq "${new_marker}"; then
      desc="${desc}"$'\n'"${new_marker}"
      _milestone_patch_description "${repo}" "${num}" "${desc}" \
        || { log_error "milestone_set_label: add ${new_label} failed on milestone #${num}"; return 1; }
    fi
  fi

  if [ -n "${old_label}" ]; then
    local old_marker
    old_marker="$(_milestone_label_marker "${old_label}")"
    desc="$(printf '%s\n' "${desc}" | grep -Fv "${old_marker}" || true)"
    _milestone_patch_description "${repo}" "${num}" "${desc}" \
      || { log_error "milestone_set_label: remove ${old_label} failed on milestone #${num}"; return 1; }
  fi
}

# milestone_set_state <repo> <num> <new_state> [<old_state>]
# Contract-state version of milestone_set_label. New code should prefer this.
milestone_set_state() {
  local repo="$1" num="$2" new_state="$3" old_state="${4:-}"
  if [ -z "${repo}" ] || [ -z "${num}" ] || [ -z "${new_state}" ]; then
    log_error "milestone_set_state: repo, num, and new_state are required"
    return 1
  fi
  state_is_valid milestone "${new_state}" || {
    log_error "milestone_set_state: invalid milestone state '${new_state}'"
    return 1
  }
  if [ -n "${old_state}" ]; then
    state_is_valid milestone "${old_state}" || {
      log_error "milestone_set_state: invalid old milestone state '${old_state}'"
      return 1
    }
  fi

  local desc new_marker old_marker
  desc="$(_milestone_get_description "${repo}" "${num}")" || return 1
  new_marker="$(state_marker milestone "${new_state}")"
  if ! printf '%s' "${desc}" | grep -Fq "${new_marker}"; then
    desc="${desc}"$'\n'"${new_marker}"
  fi
  if [ -n "${old_state}" ]; then
    old_marker="$(state_marker milestone "${old_state}")"
    desc="$(printf '%s\n' "${desc}" | grep -Fv "${old_marker}" || true)"
  fi
  _milestone_patch_description "${repo}" "${num}" "${desc}"
}

# milestone_list_by_label <repo> <label>
# Print open milestone numbers (oldest first) whose description contains the
# label marker.
milestone_list_by_label() {
  local repo="$1" label="$2"
  local marker
  marker="$(_milestone_label_marker "${label}")"
  gh_with_retry gh api "repos/${repo}/milestones?state=open&sort=created_at&direction=asc" \
    --jq '.[] | "\(.number)\t\(.description // "")"' \
    | while IFS=$'\t' read -r num desc; do
        [ -n "${num}" ] || continue
        if printf '%s' "${desc}" | grep -Fq "${marker}"; then
          printf '%s\n' "${num}"
        fi
      done
}

# milestone_get_progress <repo> <num>
# Print "open=N closed=M" (counts of issues attached to the milestone).
milestone_get_progress() {
  local repo="$1" num="$2"
  local data open_count closed_count
  data="$(gh_with_retry gh api "repos/${repo}/milestones/${num}" \
            --jq '{open: .open_issues, closed: .closed_issues}')" || return 1
  open_count="$(printf '%s' "${data}" | jq -r '.open // 0')"
  closed_count="$(printf '%s' "${data}" | jq -r '.closed // 0')"
  printf 'open=%s closed=%s\n' "${open_count}" "${closed_count}"
}

# milestone_close <repo> <num>
milestone_close() {
  local repo="$1" num="$2"
  gh_with_retry gh api -X PATCH "repos/${repo}/milestones/${num}" -f state=closed >/dev/null
}

# issue_list_open_milestones <repo>
# Print all open milestone numbers (oldest first).
issue_list_open_milestones() {
  local repo="$1"
  gh_with_retry gh api "repos/${repo}/milestones?state=open&sort=created_at&direction=asc" \
    --jq '.[].number'
}
