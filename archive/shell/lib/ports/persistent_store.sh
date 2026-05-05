#!/usr/bin/env bash
# lib/ports/persistent_store.sh
#
# Port: persistent_store
# 책임: lease / ledger / human-signal / context-manifest / agent-output /
#       change-proposal / verification 등 Caller 측 영속 객체의 저장과 조회.
#
# 기본 adapter: filesystem (workdir/<target>/<namespace>/<id>.json|jsonl).
# 테스트 adapter: in_memory (mktemp -d).
#
# Caller 규칙:
#   • 도메인 검증(envelope 필드 검사 등)은 lib/output.sh / lib/context.sh /
#     lib/signals.sh 등이 담당한다 (port 의 책임 외).
#   • adapter 는 raw key-value 저장만 책임진다.
#
# 본 port 는 "객체 저장" 추상화이며, 현재 lease/ledger 등 모듈이 직접 파일
# I/O 를 하는 코드를 점진적으로 이쪽으로 이전한다.

PORT_PERSISTENT_STORE_NAME="persistent_store"

PORT_PERSISTENT_STORE_REQUIRED_FUNCTIONS=(
  # 객체 (1 namespace : N id : 1 value)
  ps_put              # namespace id json_string
  ps_get              # namespace id                       → echo json | empty
  ps_delete           # namespace id
  ps_list_ids         # namespace                          → echo ids (created order)
  ps_exists           # namespace id                       → 0 if exists, 1 otherwise

  # 추가 전용 로그 (1 namespace : append-only JSONL)
  ps_append_log       # namespace json_line
  ps_read_log         # namespace                          → echo all lines

  # 락 (atomic mkdir 등)
  ps_lock_acquire     # namespace id                       → 0 acquired, 1 contended
  ps_lock_release     # namespace id

  # 정리
  ps_namespace_init   # namespace                          (디렉토리 생성 등 1회 작업)
)

PORT_PERSISTENT_STORE_INVARIANTS=(
  "I1: ps_put 은 atomic — 중간 실패 시 이전 값이 보존되어야 한다 (write-then-rename)."
  "I2: ps_lock_acquire 는 동일 namespace+id 에 대해 동시 호출 시 단 한 호출만 0 을 반환."
  "I3: ps_append_log 는 multi-writer 안전 (line-level atomicity)."
  "I4: ps_get 은 부재 시 비0 반환, 빈 stdout."
)
