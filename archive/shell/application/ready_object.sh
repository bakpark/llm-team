#!/usr/bin/env bash
# application/ready_object.sh
#
# Role 별 다음 ready object 한 개를 oldest-ready-first 로 픽업한다 (RGC-FAIRNESS).
#
# 출력: stdout 에 `<object_kind>\t<object_id>` 단일 라인.
#       후보가 없으면 stdout 비어있음 + 비0 반환.
#
# 호출 경계 (AGC-CALL-BOUNDARY):
#   • port (it_*) 함수만 사용. gh / git / curl / claude 직접 호출 금지.
#
# Role × pickup 규칙 (sub-phase3-ready_object.md):
#   PO         : feature-request 라벨 + milestone 미연결 issue (oldest)
#                또는 milestone state=PO_DRAFT 의 oldest 1건
#                → object_kind = "feature_request_issue" | "milestone"
#   PM         : milestone state=PM_DRAFT (oldest)         → "milestone"
#   Planner    : milestone state=DECOMPOSE_READY (oldest)  → "milestone"
#   Coder      : issue state=TASK_READY 이고 모든 blocker 가 TASK_INTEGRATED
#                인 oldest 1건                              → "issue"
#   Reviewer   : issue state=TASK_REVIEW_READY (oldest)    → "issue"
#                Phase 4 caller_dispatch 가 issue → PR 정밀 매칭 수행.
#   Integrator : milestone state=REFACTOR_READY (oldest)   → "milestone"
#   QA         : milestone state=VALIDATE_READY (oldest)   → "milestone"
#
# oldest-first 정렬은 port 의 `it_*_list_*` 가 보장한다 (Phase 2 어댑터 계약).

# ============================================================================
# Public API
# ============================================================================

# ready_object_pick <role> <repo>
#   stdout: `<object_kind>\t<object_id>` | empty
#   return: 0 if found, 1 if no candidate, 2 on argument/role error
ready_object_pick() {
  local role="$1" repo="$2"
  if [ -z "${role}" ] || [ -z "${repo}" ]; then
    log_error "ready_object_pick: role and repo are required"
    return 2
  fi
  local normalized
  normalized="$(role_normalize "${role}" 2>/dev/null)" || {
    log_error "ready_object_pick: invalid role '${role}'"
    return 2
  }
  case "${normalized}" in
    PO)         _ready_object_pick_po "${repo}" ;;
    PM)         _ready_object_pick_milestone "${repo}" PM_DRAFT ;;
    Planner)    _ready_object_pick_milestone "${repo}" DECOMPOSE_READY ;;
    Coder)      _ready_object_pick_coder "${repo}" ;;
    Reviewer)   _ready_object_pick_reviewer "${repo}" ;;
    Integrator) _ready_object_pick_milestone "${repo}" REFACTOR_READY ;;
    QA)         _ready_object_pick_milestone "${repo}" VALIDATE_READY ;;
    *)
      log_error "ready_object_pick: role '${normalized}' has no pickup rule"
      return 2
      ;;
  esac
}

# ============================================================================
# Internal pickers (one per role group)
# ============================================================================

# PO: PO_DRAFT milestone (post-promote).
# 이전 구현은 unaccepted feature_request_issue 도 후보로 반환했으나, 그 경로는
# _caller_apply_spec_proposal 가 milestone target 을 가정하므로 항상 apply
# 실패로 귀결되었다 (it_milestone_update on issue#N 시도). Promote 가 같은
# cycle 내에서 PO 데몬에 의해 우선 실행되므로 (scheduler/runner.sh:
# feature_request_promote → ready_object_pick), pick 시점에는 PO_DRAFT
# milestone 이 적재되어 있다. Promote 가 실패해도 다음 cycle 의 promote 가
# 흡수하므로 PO 가 idle 사이클을 돌더라도 데이터 손실 없음.
_ready_object_pick_po() {
  local repo="$1"
  _ready_object_pick_milestone "${repo}" PO_DRAFT
}

# Milestone in given state: pick oldest.
_ready_object_pick_milestone() {
  local repo="$1" state="$2"
  local num
  num="$(it_milestone_list_in_state "${repo}" "${state}" 2>/dev/null | head -n 1)"
  if [ -z "${num}" ]; then
    return 1
  fi
  printf 'milestone\t%s\n' "${num}"
}

# Coder: oldest TASK_READY issue whose blockers are all TASK_INTEGRATED.
_ready_object_pick_coder() {
  local repo="$1"
  local nums
  nums="$(it_issue_list_in_state "${repo}" TASK_READY 2>/dev/null)" || return 1
  if [ -z "${nums}" ]; then
    return 1
  fi
  local num
  while IFS= read -r num; do
    [ -n "${num}" ] || continue
    if _ready_object_blockers_satisfied "${repo}" "${num}"; then
      printf 'issue\t%s\n' "${num}"
      return 0
    fi
  done <<<"${nums}"
  return 1
}

# True if every blocker of <issue_num> is TASK_INTEGRATED (or has no detectable
# state, which we treat as "not blocking" — issue gone / migrated).
_ready_object_blockers_satisfied() {
  local repo="$1" num="$2"
  local blockers blocker bstate
  blockers="$(it_issue_get_blocked_by "${repo}" "${num}" 2>/dev/null || true)"
  [ -n "${blockers}" ] || return 0
  while IFS= read -r blocker; do
    [ -n "${blocker}" ] || continue
    bstate="$(it_issue_get_state "${repo}" "${blocker}" 2>/dev/null || true)"
    if [ "${bstate}" != "TASK_INTEGRATED" ]; then
      return 1
    fi
  done <<<"${blockers}"
  return 0
}

# Reviewer (Phase 3 placeholder): oldest issue in TASK_REVIEW_READY.
# Phase 4 caller_dispatch will resolve issue → PR (CP_READY_FOR_REVIEW) precisely.
_ready_object_pick_reviewer() {
  local repo="$1"
  local num
  num="$(it_issue_list_in_state "${repo}" TASK_REVIEW_READY 2>/dev/null | head -n 1)"
  if [ -z "${num}" ]; then
    return 1
  fi
  printf 'issue\t%s\n' "${num}"
}
