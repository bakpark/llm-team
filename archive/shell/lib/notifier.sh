#!/usr/bin/env bash
# lib/notifier.sh - Caller-owned notification helper.
#
# 본 파일은 application 레이어(아직 분리 전)의 멱등 알림 헬퍼다. 채널-별
# 배달 로직은 adapters/notifier/<channel>.sh 의 nt_send 가 담당하고, 본 함수는:
#   1. it_comment_has_marker 로 idempotency check
#   2. nt_send 로 push delivery
#   3. it_comment_post 로 marker 부착 (멱등성 추적)
#
# 향후 application/ 디렉토리로 이전 예정.

# notify_review_needed <target> <kind> <object_type> <object_num> <github_url> <summary>
#   <object_type> ∈ issue | pr | milestone
notify_review_needed() {
  local target="$1" kind="$2" object_type="$3" object_num="$4" gh_url="$5" summary="$6"

  if [ -z "${target}" ] || [ -z "${kind}" ] || [ -z "${object_type}" ] || [ -z "${object_num}" ]; then
    log_error "notify_review_needed: target/kind/object_type/object_num are required"
    return 0
  fi

  # target 환경 로드 (이미 로드되어 있으면 재실행하지 않음).
  if [ "${TARGET_NAME:-}" != "${target}" ]; then
    if ! load_target "${target}"; then
      log_error "notify_review_needed: failed to load target '${target}'"
      return 0
    fi
  fi

  # target yaml 의 채널 설정에 맞춰 notifier adapter rebind.
  registry_rebind_for_target

  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"

  # Idempotency check (issue_tracker port).
  if it_comment_has_marker "${repo}" "${object_type}" "${object_num}" "${kind}"; then
    log_info "notify_review_needed: marker already present (${kind} on ${object_type}#${object_num}); skipping"
    return 0
  fi

  # Push delivery (notifier port — none/discord/slack 중 하나).
  if ! nt_send "${kind}" "${gh_url}" "${summary}"; then
    log_warn "notify_review_needed: delivery did not confirm (channel=${TARGET_NOTIFIER_CHANNEL:-none}); marker NOT written"
    return 0
  fi

  # Marker 기록 (issue_tracker port).
  local marker
  marker="$(marker_notified "${kind}")"
  it_comment_post "${repo}" "${object_type}" "${object_num}" "${marker}" \
    || log_warn "notify_review_needed: failed to write marker for ${kind} on ${object_type}#${object_num}"

  return 0
}
