#!/usr/bin/env bash
# lib/notifier.sh - push-only Notifier owned by Caller.
#
# Public API:
#   notify_review_needed <target> <kind> <object_type> <object_num> <github_url> <summary>
#     <kind>        arbitrary notification kind, e.g. po-gate or escalated
#     <object_type> ∈ issue | milestone   (PR uses 'issue': issues and PRs share comment endpoint)
#
# Behaviour:
#   1. Idempotency check via comments_have_marker — if the notify marker is
#      already on the target object, return 0 without sending.
#   2. Branch on TARGET_NOTIFIER_CHANNEL: discord | slack | none.
#   3. On send success, append the notify marker so subsequent calls are no-ops.
#   4. Notifier failures never abort the main flow. Blocking is represented by
#      workflow state, not by waiting for a notification response.

# notify_review_needed <target> <kind> <object_type> <object_num> <github_url> <summary>
notify_review_needed() {
  local target="$1" kind="$2" object_type="$3" object_num="$4" gh_url="$5" summary="$6"

  if [ -z "${target}" ] || [ -z "${kind}" ] || [ -z "${object_type}" ] || [ -z "${object_num}" ]; then
    log_error "notify_review_needed: target/kind/object_type/object_num are required"
    return 0
  fi

  # Make sure the target's TARGET_* env is loaded.
  if [ "${TARGET_NAME:-}" != "${target}" ]; then
    if ! load_target "${target}"; then
      log_error "notify_review_needed: failed to load target '${target}'"
      return 0
    fi
  fi

  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"

  # Idempotency.
  if comments_have_marker "${object_type}" "${repo}" "${object_num}" "${kind}"; then
    log_info "notify_review_needed: marker already present (${kind} on ${object_type}#${object_num}); skipping"
    return 0
  fi

  local channel="${TARGET_NOTIFIER_CHANNEL:-none}"
  local sent=0
  case "${channel}" in
    none)
      log_info "notify_review_needed: channel=none for ${kind} ${object_type}#${object_num}; no send"
      sent=1
      ;;
    discord)
      if _notifier_send_discord "${target}" "${kind}" "${gh_url}" "${summary}"; then
        sent=1
      fi
      ;;
    slack)
      if _notifier_send_slack "${target}" "${kind}" "${gh_url}" "${summary}"; then
        sent=1
      fi
      ;;
    *)
      log_warn "notify_review_needed: unknown channel '${channel}'"
      ;;
  esac

  if [ "${sent}" -eq 1 ]; then
    _notifier_write_marker "${object_type}" "${repo}" "${object_num}" "${kind}" || true
  fi
  return 0
}

# Internal: append a notify marker to the appropriate text surface.
_notifier_write_marker() {
  local object_type="$1" repo="$2" num="$3" kind="$4"
  local marker
  marker="$(marker_notified "${kind}")"
  case "${object_type}" in
    issue|pr)
      gh_with_retry gh api -X POST "repos/${repo}/issues/${num}/comments" \
        -f "body=${marker}" >/dev/null 2>&1 \
        || log_warn "notifier: failed to add marker comment on ${object_type}#${num}"
      ;;
    milestone)
      local cur new
      cur="$(gh_with_retry gh api "repos/${repo}/milestones/${num}" --jq '.description // ""' 2>/dev/null || echo "")"
      new="${cur}"$'\n'"${marker}"
      gh_with_retry gh api -X PATCH "repos/${repo}/milestones/${num}" \
        -f "description=${new}" >/dev/null 2>&1 \
        || log_warn "notifier: failed to write marker into milestone #${num} description"
      ;;
    *)
      log_warn "notifier: cannot write marker for object_type='${object_type}'"
      ;;
  esac
}

# Internal: Discord webhook delivery. Returns 0 only on confirmed POST success.
_notifier_send_discord() {
  local target="$1" kind="$2" url="$3" summary="$4"
  local webhook
  if ! webhook="$(resolve_secret "${TARGET_NOTIFIER_REF}" 2>/dev/null)"; then
    log_warn "notifier: discord webhook secret '${TARGET_NOTIFIER_REF}' missing; skipping send"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "notifier: curl not available; skipping discord send"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log_warn "notifier: jq not available; skipping discord send"
    return 1
  fi
  local payload
  payload="$(jq -n \
    --arg t "${target}" \
    --arg k "${kind}" \
    --arg u "${url}" \
    --arg s "${summary}" \
    '{embeds: [{title: ("[" + $t + "] " + $k + " — Human Review Required"), url: $u, description: $s, color: 15158332}]}')"
  if curl -s --fail -X POST -H "Content-Type: application/json" -d "${payload}" "${webhook}" >/dev/null; then
    return 0
  fi
  log_warn "notifier: discord webhook POST failed"
  return 1
}

# Internal: Slack webhook delivery.
_notifier_send_slack() {
  local target="$1" kind="$2" url="$3" summary="$4"
  local webhook
  if ! webhook="$(resolve_secret "${TARGET_NOTIFIER_REF}" 2>/dev/null)"; then
    log_warn "notifier: slack webhook secret '${TARGET_NOTIFIER_REF}' missing; skipping send"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "notifier: curl not available; skipping slack send"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log_warn "notifier: jq not available; skipping slack send"
    return 1
  fi
  local payload
  payload="$(jq -n \
    --arg t "${target}" \
    --arg k "${kind}" \
    --arg u "${url}" \
    --arg s "${summary}" \
    '{blocks: [
       {type: "header", text: {type: "plain_text", text: ("[" + $t + "] " + $k + " — Human Review Required")}},
       {type: "section", text: {type: "mrkdwn", text: ("<" + $u + "|GitHub Link>\n\n" + $s)}}
     ]}')"
  if curl -s --fail -X POST -H "Content-Type: application/json" -d "${payload}" "${webhook}" >/dev/null; then
    return 0
  fi
  log_warn "notifier: slack webhook POST failed"
  return 1
}
