#!/usr/bin/env bash
# lib/ports/notifier.sh
#
# Port: notifier
# 책임: 사람이 봐야 하는 시점에 외부 채널(웹훅 등)로 push 알림을 보낸다.
# 멱등성은 issue_tracker port 의 marker (it_comment_has_marker / it_comment_post)
# 로 보장되며, notifier 자체는 배달만 책임진다.
#
# Caller 규칙:
#   • application/ 코드는 nt_send 를 호출하기 전에 it_comment_has_marker 로
#     이미 알림이 갔는지 확인한다.
#   • notifier 실패는 워크플로우를 중단시키지 않는다 (로그 후 무시).

PORT_NOTIFIER_NAME="notifier"

PORT_NOTIFIER_REQUIRED_FUNCTIONS=(
  nt_send         # kind url summary  → 0 on confirmed delivery, non-zero otherwise
)

PORT_NOTIFIER_INVARIANTS=(
  "I1: nt_send 는 채널이 'none' 인 경우에도 0 을 반환해야 한다 (no-op)."
  "I2: nt_send 는 secret 이 누락되어도 프로세스를 abort 시키면 안 된다 (warn 후 비0)."
  "I3: nt_send 는 동일 인자로 반복 호출되어도 안전해야 한다 — 멱등성은 caller 가 marker 로 보장하지만, adapter 자체도 retry-safe 해야 한다."
)
