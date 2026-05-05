#!/usr/bin/env bash
# lib/ports/cycle_bundle.sh
#
# Port: cycle_bundle — RW 역할(Coder/Reviewer/Integrator/QA) cycle 의 진단
# 자료를 영속 보존하기 위한 추상화 (#ARC-PORT-SIGNATURE 동급).
#
# 책임:
#   • cycle 1회 실행 동안 발생하는 prompt/envelope/diagnostics/diff 6종/lr_meta
#     를 일관된 식별자(cycle_id) 아래 묶어 저장.
#   • 운영(filesystem) 와 테스트(in_memory) 어댑터를 같은 invariant 으로 구현해
#     test-double 의 의미적 등가성 보장.
#
# 컨벤션:
#   • 모든 cb_* 호출은 빈 handle("") 일 때 즉시 0 반환. 즉 caller 는 cb_open
#     반환값만 검사하면 됨 (LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 escape hatch 와
#     mkdir 실패 시 graceful degrade 가 둘 다 빈 handle 로 표현된다).
#   • 본 port 는 git/issue tracker 등 외부 의존이 없다. blob 을 받아 보관할 뿐.
#     "이 worktree 의 git diff 를 다오" 같은 요구는 workspace port 가 처리.

PORT_CYCLE_BUNDLE_NAME="cycle_bundle"

PORT_CYCLE_BUNDLE_REQUIRED_FUNCTIONS=(
  cb_open
  cb_capture_blob_text
  cb_capture_blob_file
  cb_capture_blob_stdin
  cb_capture_attempt
  cb_promote_to_full
  cb_finalize
  cb_get_path
  cb_collect_abandoned
)

PORT_CYCLE_BUNDLE_INVARIANTS=(
  "I1: cb_open 은 같은 cycle_id 에 대해 같은 handle 반환 (idempotent)."
  "I2: LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 또는 mkdir 실패 시 cb_open 빈 handle 반환 → 이후 cb_* 모두 즉시 return 0."
  "I3: cb_capture_blob_* 같은 name 재호출은 덮어쓰기 (idempotent re-capture)."
  "I4: 모든 capture 는 atomic — 임시 파일 → rename. 부분 쓰기 금지."
  "I5: cb_promote_to_full 두 번 이상 호출은 reason 을 배열에 누적 (idempotent additive)."
  "I6: promote 한 번이라도 호출됐으면 finalize(result=ok) 이어도 diagnostics/worktree-pre 보존."
  "I7: cb_finalize 는 cycle 당 정확히 1회. 두 번째 호출은 no-op (warn)."
  "I8: cb_open 은 다른 cycle dir 을 절대 수정하지 않는다 — abandoned stamp 는 cb_collect_abandoned 만 수행."
)
