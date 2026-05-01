#!/usr/bin/env bash
# lib/ports/issue_tracker.sh
#
# Port: issue_tracker
# 책임: Milestone / Issue / PR / Release / Comment 의 CRUD와 상태 전이.
# 본 파일은 함수 시그니처와 invariant 명세만 가진다. 실제 구현은
# adapters/issue_tracker/<tech>.sh 가 제공한다 (예: github.sh, in_memory.sh).
#
# Caller 규칙:
#   • application/ 또는 scheduler/ 코드는 본 port 함수만 호출한다.
#   • `gh`, `git`, `curl` 등 외부 명령을 직접 호출해서는 안 된다.
#   • adapter 내부 헬퍼는 `_<adapter>_…` 접두사를 사용한다.
#
# Idempotency 규칙:
#   • 모든 상태 전이 함수는 동일 입력 반복 호출 시 부작용이 추가되지 않아야 한다.
#   • marker(state_marker / marker_notified)는 중복 삽입되지 않는다.

PORT_ISSUE_TRACKER_NAME="issue_tracker"

# 모든 adapter 가 반드시 정의해야 하는 함수 목록.
# registry_verify_port 가 declare -F 로 존재 여부를 검사한다.
PORT_ISSUE_TRACKER_REQUIRED_FUNCTIONS=(
  # --- Milestone ---
  it_milestone_create            # repo title body                     → echo number
  it_milestone_update            # repo num [--title T] [--body B]
  it_milestone_set_state         # repo num new_state [old_state]
  it_milestone_get_state         # repo num                            → echo state | empty
  it_milestone_close             # repo num
  it_milestone_get_progress      # repo num                            → echo "open=N closed=M"
  it_milestone_list_open         # repo                                → echo numbers (oldest first)
  it_milestone_list_in_state     # repo state                          → echo numbers

  # --- Issue ---
  it_issue_create                # repo --title T --body B [--labels L,L] [--milestone N] → echo number
  it_issue_set_state             # repo num new_state [old_state]
  it_issue_get_state             # repo num                            → echo state | empty
  it_issue_link_to_milestone     # repo issue_num milestone_num
  it_issue_set_blocked_by        # repo num blocker_num...
  it_issue_close_with_note       # repo num note
  it_issue_list_in_state         # repo state                          → echo numbers (oldest first)
  it_issue_list_with_label       # repo label [--no-milestone]         → echo numbers
  it_issue_get_milestone         # repo num                            → echo milestone_number | empty
  it_issue_clear_state_labels    # repo num [prefix]                   (terminal cleanup)

  # --- Pull Request ---
  it_pr_create                   # repo --head H --base B --title T --body B [--draft] → echo number
  it_pr_set_cp_state             # repo num new_state [old_state]
  it_pr_get_cp_state             # repo num                            → echo state | empty
  it_pr_merge                    # repo num --squash|--merge|--rebase  → echo merge_sha
  it_pr_request_changes          # repo num reason

  # --- Release ---
  it_release_create              # repo tag --target sha|branch --title T --notes N

  # --- Comments / markers / signals ---
  it_comment_post                # repo kind num body                  (kind ∈ issue|pr|milestone)
  it_comment_collect_signals     # repo kind num                       → echo JSONL of unprocessed human-signals
  it_comment_has_marker          # repo kind num marker_kind           (returns 0/1)

  # --- Revision pin ---
  it_revision_pin_get            # repo kind num scope                 → echo etag/sha
)

# Invariant 명세 (텍스트, 검사용 아닌 문서용).
PORT_ISSUE_TRACKER_INVARIANTS=(
  "I1: 상태 전이 함수는 멱등이어야 한다 (반복 호출 시 부작용 무증가)."
  "I2: 모든 상태값은 lib/state.sh 의 state_is_valid 를 통과해야 한다."
  "I3: 모든 함수는 transport 실패 시 비0 반환. partial-success 금지."
  "I4: it_comment_post 는 동일 marker 중복 삽입을 일으키지 않는다 (caller 가 it_comment_has_marker 로 사전 체크)."
  "I5: it_pr_merge 는 CP_APPROVED 상태에서만 호출 가능 (caller 가 사전 검증)."
  "I6: it_release_create 의 tag 형식은 caller 가 검증 (vX.Y.Z)."
)
