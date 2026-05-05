#!/usr/bin/env bash
# application/feature_request.sh
#
# Feature-request intake → milestone PO_DRAFT 승격.
#
# 책임:
#   • feature-request 라벨이 붙은 (그리고 milestone 미연결) issue 중 가장 오래된
#     1건을 선택해 milestone(PO_DRAFT) 으로 승격하고, issue 라벨을
#     feature-request → feature-request:accepted 로 전이한다.
#   • 한 호출당 최대 1건만 처리 (oldest-first). 추가 처리는 caller 가 반복 호출.
#
# 호출 경계 (AGC-CALL-BOUNDARY):
#   • gh / git / curl / claude 직접 호출 금지. issue_tracker port (it_*) 만 사용.
#
# 멱등성:
#   • promote 직후의 issue 는 라벨이 feature-request:accepted 로 바뀌어 있어
#     it_issue_list_with_label feature-request --no-milestone 결과에서 빠진다.
#   • 동일 issue 가 어떤 사유로 다시 promote 되면(수동 라벨 복원 등) milestone 이
#     중복 생성될 수 있다. 호출자 측 사전 필터(라벨 또는 milestone 링크)에 의존.

# feature_request_promote <repo>
# 성공: 0 (1건 처리). echo 출력 형식: "<issue_num> <milestone_num>".
# 처리할 issue 가 없을 때: 비0 (그리고 stdout 비어있음).
# 실패: 비0 + log_error.
feature_request_promote() {
  local repo="$1"
  if [ -z "${repo}" ]; then
    log_error "feature_request_promote: repo is required"
    return 2
  fi

  local issue_num
  # oldest-first: it_issue_list_with_label 은 created_at 기준 정렬을 보장한다.
  issue_num="$(it_issue_list_with_label "${repo}" "${LABEL_FEATURE_REQUEST}" --no-milestone | head -1)"
  if [ -z "${issue_num}" ]; then
    return 1
  fi

  # Issue body 인용 + title 은 "draft: <issue title>" 형태.
  # B-1 fix: title 에 issue updated_at 을 suffix 로 붙여 e2e 반복 / 잔존 closed
  # milestone 과의 title 충돌(GitHub 422 Validation Failed: title already_exists)
  # 을 회피한다. issue 내용이 안 바뀐 같은 cycle 내 재시도는 동일 suffix 로
  # idempotent. it_revision_pin_get 가 updated_at(ISO timestamp) 을 반환.
  # 어댑터가 pin 을 못 주면(in_memory 일부 케이스) suffix 없이 기존 동작 유지.
  local issue_title issue_body issue_snapshot issue_updated_at
  issue_updated_at="$(it_revision_pin_get "${repo}" issue "${issue_num}" 2>/dev/null || true)"
  if [ -n "${issue_updated_at}" ]; then
    issue_title="draft: feature-request #${issue_num} @${issue_updated_at}"
  else
    issue_title="draft: feature-request #${issue_num}"
  fi
  # Source issue 본문을 milestone description 에 임베드하여 후속 PO Compose-PO
  # 가 it_object_get_snapshot(milestone) 으로 본문을 받을 때 source issue 본문이
  # 노출되도록 한다. snapshot 미가용 시(어댑터 미지원/네트워크 실패) 안전한
  # placeholder 로 폴백 — 기존 동작 보존.
  issue_snapshot="$(it_object_get_snapshot "${repo}" issue "${issue_num}" 2>/dev/null || true)"
  if [ -n "${issue_snapshot}" ]; then
    issue_body="$(printf 'Promoted from feature-request issue #%s.\n\nSource: %s issue #%s.\n\n## Source content (issue #%s)\n\n%s\n' \
      "${issue_num}" "${repo}" "${issue_num}" "${issue_num}" "${issue_snapshot}")"
  else
    issue_body="$(printf 'Promoted from feature-request issue #%s.\n\nSource: %s issue #%s.\n' \
      "${issue_num}" "${repo}" "${issue_num}")"
  fi

  local ms_num
  ms_num="$(it_milestone_create "${repo}" "${issue_title}" "${issue_body}")" || {
    log_error "feature_request_promote: it_milestone_create failed for issue #${issue_num}"
    return 3
  }
  if [ -z "${ms_num}" ]; then
    log_error "feature_request_promote: it_milestone_create returned empty for issue #${issue_num}"
    return 3
  fi

  it_milestone_set_state "${repo}" "${ms_num}" PO_DRAFT || {
    log_error "feature_request_promote: it_milestone_set_state PO_DRAFT failed (milestone #${ms_num})"
    return 4
  }

  it_issue_link_to_milestone "${repo}" "${issue_num}" "${ms_num}" || {
    log_error "feature_request_promote: it_issue_link_to_milestone failed (issue #${issue_num} → ms #${ms_num})"
    return 5
  }

  # Label transition: feature-request → feature-request:accepted (port helpers only).
  local prefix="${TARGET_LABEL_PREFIX:-}"
  local accepted_label
  accepted_label="$(label_with_prefix "${prefix}" "${LABEL_FEATURE_REQUEST_ACCEPTED}")"
  it_issue_add_label "${repo}" "${issue_num}" "${accepted_label}" || {
    log_error "feature_request_promote: add label '${accepted_label}' failed on issue #${issue_num}"
    return 6
  }
  local pending_label
  pending_label="$(label_with_prefix "${prefix}" "${LABEL_FEATURE_REQUEST}")"
  it_issue_remove_label "${repo}" "${issue_num}" "${pending_label}" || {
    log_error "feature_request_promote: remove label '${pending_label}' failed on issue #${issue_num}"
    return 7
  }

  printf '%s %s\n' "${issue_num}" "${ms_num}"
}
