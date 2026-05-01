#!/usr/bin/env bash
# lib/stale.sh — Stale recovery (memory/state-machine.md §5).
#
# Run inline at every cron entry. Each PO/PM/DEV/QA scheduler script sources
# common.sh and calls `run_stale_recovery <target>` before its primary work.
#
# Public API:
#   recover_stale_milestones <target>  — po:in-progress / pm:in-progress regression.
#   recover_stale_issues     <target>  — dev:in-progress / qa:in-progress regression.
#   recover_orphan_milestones <target> — open milestone with NO state label → Notifier.
#   run_stale_recovery <target>        — runs the three above in sequence.

# Internal: returns 0 if ISO-8601 timestamp $1 is older than
# ${TARGET_STALE_THRESHOLD_MIN:-60} minutes from now.
_is_stale() {
  local ts="$1"
  [ -n "${ts}" ] || return 1
  local now_epoch ts_epoch
  now_epoch="$(date -u +%s)"
  # GNU date first, BSD date as fallback.
  ts_epoch="$(date -u -d "${ts}" +%s 2>/dev/null \
              || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "${ts}" +%s 2>/dev/null \
              || echo "")"
  [ -n "${ts_epoch}" ] && [ "${ts_epoch}" != "0" ] || return 1
  local age_min=$(( (now_epoch - ts_epoch) / 60 ))
  local threshold="${TARGET_STALE_THRESHOLD_MIN:-60}"
  [ "${age_min}" -ge "${threshold}" ]
}

# recover_stale_milestones <target>
recover_stale_milestones() {
  local target="$1"
  if [ "${TARGET_NAME:-}" != "${target}" ]; then
    load_target "${target}" || return 1
  fi
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"

  local label prefixed nums num updated next_label next_prefixed
  for label in "${LABEL_PO_IN_PROGRESS}" "${LABEL_PM_IN_PROGRESS}"; do
    prefixed="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${label}")"
    nums="$(milestone_list_by_label "${repo}" "${prefixed}" 2>/dev/null || true)"
    [ -n "${nums}" ] || continue
    while IFS= read -r num; do
      [ -n "${num}" ] || continue
      updated="$(gh_with_retry gh api "repos/${repo}/milestones/${num}" --jq '.updated_at // ""' 2>/dev/null || echo "")"
      _is_stale "${updated}" || continue
      log_warn "stale milestone #${num} with label ${prefixed}; recovering"
      case "${label}" in
        "${LABEL_PO_IN_PROGRESS}")
          milestone_set_label "${repo}" "${num}" "" "${prefixed}" || true
          gh_with_retry gh api -X POST "repos/${repo}/milestones/${num}" \
            >/dev/null 2>&1 || true
          # Append a milestone description note for the human/QA trail.
          local cur new
          cur="$(_milestone_get_description "${repo}" "${num}" 2>/dev/null || echo "")"
          new="${cur}"$'\n'"## PO Agent crashed"$'\n\n'"Stale recovery removed ${LABEL_PO_IN_PROGRESS} label. The next PO cron will retry."
          _milestone_patch_description "${repo}" "${num}" "${new}" || true
          ;;
        "${LABEL_PM_IN_PROGRESS}")
          next_label="${LABEL_NEEDS_SCENARIOS}"
          next_prefixed="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${next_label}")"
          milestone_set_label "${repo}" "${num}" "${next_prefixed}" "${prefixed}" || true
          ;;
      esac
    done <<EOF
${nums}
EOF
  done
}

# recover_stale_issues <target>
recover_stale_issues() {
  local target="$1"
  if [ "${TARGET_NAME:-}" != "${target}" ]; then
    load_target "${target}" || return 1
  fi
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"

  local label prefixed nums num updated next_prefixed branch
  for label in "${LABEL_DEV_IN_PROGRESS}" "${LABEL_QA_IN_PROGRESS}"; do
    prefixed="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${label}")"
    nums="$(issue_list_by_label "${repo}" "${prefixed}" 2>/dev/null || true)"
    [ -n "${nums}" ] || continue
    while IFS= read -r num; do
      [ -n "${num}" ] || continue
      updated="$(gh_with_retry gh api "repos/${repo}/issues/${num}" --jq '.updated_at // ""' 2>/dev/null || echo "")"
      _is_stale "${updated}" || continue
      log_warn "stale issue #${num} with label ${prefixed}; recovering"
      case "${label}" in
        "${LABEL_DEV_IN_PROGRESS}")
          next_prefixed="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${LABEL_NEEDS_DEV}")"
          ;;
        "${LABEL_QA_IN_PROGRESS}")
          next_prefixed="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${LABEL_NEEDS_QA}")"
          ;;
      esac
      issue_set_label "${repo}" "${num}" "${next_prefixed}" "${prefixed}" || true
      # Best-effort worktree cleanup using the linked PR's branch (if any).
      branch="$(gh_with_retry gh api "repos/${repo}/issues/${num}" \
                  --jq '.pull_request.url // ""' 2>/dev/null \
                  | sed -E 's|.*/pulls/([0-9]+).*|\1|')"
      if [ -n "${branch}" ]; then
        local pr_branch
        pr_branch="$(gh_with_retry gh api "repos/${repo}/pulls/${branch}" --jq '.head.ref // ""' 2>/dev/null || echo "")"
        if [ -n "${pr_branch}" ]; then
          worktree_remove "${target}" "${pr_branch}" || true
        fi
      fi
    done <<EOF
${nums}
EOF
  done
}

# recover_orphan_milestones <target>
# Open milestone whose description carries NONE of the 5 milestone-state
# markers and whose updated_at is older than the threshold → Notifier-only.
# (No automatic deletion: human investigates.)
recover_orphan_milestones() {
  local target="$1"
  if [ "${TARGET_NAME:-}" != "${target}" ]; then
    load_target "${target}" || return 1
  fi
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  local nums num desc updated has_label label prefixed marker
  nums="$(issue_list_open_milestones "${repo}" 2>/dev/null || true)"
  [ -n "${nums}" ] || return 0
  while IFS= read -r num; do
    [ -n "${num}" ] || continue
    desc="$(_milestone_get_description "${repo}" "${num}" 2>/dev/null || echo "")"
    updated="$(gh_with_retry gh api "repos/${repo}/milestones/${num}" --jq '.updated_at // ""' 2>/dev/null || echo "")"
    has_label=0
    for label in "${ALL_MILESTONE_LABELS[@]}"; do
      prefixed="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${label}")"
      marker="$(_milestone_label_marker "${prefixed}")"
      if printf '%s' "${desc}" | grep -Fq "${marker}"; then
        has_label=1
        break
      fi
    done
    if [ "${has_label}" -eq 0 ] && _is_stale "${updated}"; then
      log_warn "orphan milestone #${num} (no state label, stale); notifying"
      notify_review_needed "${target}" "milestone" "milestone" "${num}" \
        "https://github.com/${repo}/milestone/${num}" \
        "Orphan Milestone: no state label and last update ${updated}. Manual cleanup required."
    fi
  done <<EOF
${nums}
EOF
}

# run_stale_recovery <target>
# Convenience wrapper executed at the top of every scheduler/run-*.sh.
run_stale_recovery() {
  local target="$1"
  recover_stale_milestones "${target}"  || log_warn "run_stale_recovery: recover_stale_milestones returned non-zero"
  recover_stale_issues     "${target}"  || log_warn "run_stale_recovery: recover_stale_issues returned non-zero"
  recover_orphan_milestones "${target}" || log_warn "run_stale_recovery: recover_orphan_milestones returned non-zero"
}
