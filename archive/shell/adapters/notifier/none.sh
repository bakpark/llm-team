#!/usr/bin/env bash
# adapters/notifier/none.sh
#
# No-op notifier adapter. 채널이 'none' 이거나 미설정일 때 사용.
# 알림 내용을 stderr 에 INFO 로깅만 하고 0 을 반환한다.

# nt_send <kind> <url> <summary>
nt_send() {
  local kind="$1" url="$2" summary="$3"
  log_info "nt_send(none): kind=${kind} url=${url} summary='${summary}' — channel disabled, no-op"
  return 0
}
