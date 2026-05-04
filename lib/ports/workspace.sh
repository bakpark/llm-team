#!/usr/bin/env bash
# lib/ports/workspace.sh
#
# Port: workspace
# 책임: target 작업 단위(Task 등)별 격리된 작업공간 제공 + patch 적용 + branch publish.
#
# 기본 adapter: git_worktree (target repo 에 git worktree add).
# 테스트 adapter: in_memory (mktemp -d 격리).
#
# Caller 규칙:
#   • application/ 코드는 ws_path_of 로 경로를 받아 그 디렉토리 안에서만 작업.
#   • git/clone/push 등 외부 명령 직접 호출 금지.

PORT_WORKSPACE_NAME="workspace"

PORT_WORKSPACE_REQUIRED_FUNCTIONS=(
  ws_ensure_clone     # target                           (1회 clone, 이후 fetch)
  ws_ensure           # unit_id [base_branch]             → echo path
  ws_refresh          # unit_id                           (origin/<branch> tip 으로 worktree sync)
  ws_path_of          # unit_id                           → echo path | empty
  ws_apply_patch      # unit_id patch_text_or_file [commit_message]
  ws_publish_branch   # unit_id branch_name
  ws_destroy          # unit_id
  ws_list             # target                            → echo unit_ids
  ws_get_branch_head  # repo branch                       → echo sha
  ws_get_branch_base  # repo branch                       → echo sha (분기 base; integration 기준)
  ws_ensure_ro_tree   # target                          → echo ro_path (read-only code tree)
  ws_ro_tree_revision_pin # target                          → echo sha (current RO tree pin)
)

PORT_WORKSPACE_INVARIANTS=(
  "I1: ws_ensure 는 멱등 — 이미 존재하면 reuse."
  "I2: ws_apply_patch 는 실패 시 워크스페이스를 변경하지 않은 상태로 롤백해야 한다."
  "I3: ws_destroy 는 best-effort. 이미 삭제된 unit 에 대해서도 성공 반환."
  "I4: 모든 함수는 unit_id 로 격리. unit 간 상태 공유 없음."
  "I5: ws_apply_patch 성공 후 ws_publish_branch 호출 시 origin tip 이 변경되어야 한다 — 패치는 publish 가능한 형태로 영속화된다."
  "I6: ws_refresh 는 멱등이며 origin/<branch> 가 존재하면 worktree 를 그 tip 으로 재동기화한다."
)
