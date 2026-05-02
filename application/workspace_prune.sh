#!/usr/bin/env bash
# application/workspace_prune.sh
#
# Single entry point that turns "this unit's worktree is no longer useful"
# into the side effects required to free disk without leaving stale state
# behind. NOTE: branch cleanup (local/remote `llm-team/<unit>`) is intentionally
# NOT performed here — see follow-up issue. Used by:
#   • Integrator dispatch end (PR merged → cleanup the unit's worktree).
#   • recovery_scan (lease expired → drop the half-applied workspace before
#     a future cycle reuses it via ws_ensure).
#   • runner.sh on lr_invoke failure (worktree may hold a partially-applied
#     patch from a prior cycle).
#   • CLI 진입점 (향후 `llm-team workspace prune` 등) — application 함수로
#     두어 caller-only 규약을 유지한다.
#
# Caller boundary (AGC-CALL-BOUNDARY): port-only — ws_destroy / ws_list 만
# 사용한다. git/gh 직접 호출 금지.

if [ -z "${LLM_TEAM_ROOT:-}" ]; then
  LLM_TEAM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export LLM_TEAM_ROOT
fi

# workspace_prune_unit <target> <unit_id>
# unit 의 worktree 를 제거(idempotent). adapter 가 ws_destroy 를 best-effort 로
# 처리하므로 미존재/이미 삭제 케이스에서도 0 반환. caller 는 결과를 재시도하지
# 않는다.
workspace_prune_unit() {
  local target="$1" unit_id="$2"
  if [ -z "${target}" ] || [ -z "${unit_id}" ]; then
    log_error "workspace_prune_unit: target and unit_id are required"
    return 1
  fi
  if ! declare -F ws_destroy >/dev/null 2>&1; then
    log_warn "workspace_prune_unit: ws_destroy not bound; skipping"
    return 0
  fi
  TARGET_NAME="${target}" ws_destroy "${unit_id}" >/dev/null 2>&1 || true
  return 0
}

# workspace_prune_units <target> <unit_id>...
# 다중 unit 일괄 정리(부분 실패에 관계없이 모든 unit 시도).
workspace_prune_units() {
  local target="$1"; shift || true
  if [ -z "${target}" ] || [ "$#" -eq 0 ]; then
    log_error "workspace_prune_units: target and at least one unit_id are required"
    return 1
  fi
  local u
  for u in "$@"; do
    workspace_prune_unit "${target}" "${u}"
  done
  return 0
}
