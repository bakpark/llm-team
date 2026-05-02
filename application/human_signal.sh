#!/usr/bin/env bash
# application/human_signal.sh
#
# Human governance signal pipeline.
# (RGC-SIGNALS / RGC-HUMAN-GATES)
#
# 책임:
#   • 미처리 governance signal 수집 (it_comment_collect_signals 의 wrapper JSONL).
#   • envelope 스키마 + actor 일치 검증 (human_signal_validate + extended check).
#   • 8 종 signal_type 처리:
#       approve / reject / request_rework / request_recover /
#       pause / resume / amendment_approve / stop
#   • signal_id 멱등 — 동일 signal_id 로 두 번 호출돼도 1회만 적용.
#
# 호출 경계 (AGC-CALL-BOUNDARY):
#   • gh / git / curl / claude 직접 호출 금지.
#   • 외부 시스템 상호작용은 lib/ports/* (it_*) 와 lib/signals.sh / lib/ledger.sh
#     / persistent_store(ps_*) 만 사용한다.
#
# 멱등성 저장소:
#   • persistent_store namespace `signals/${TARGET_NAME:-default}` 에 signal_id
#     를 키로 처리 결과 (status: applied|rejected|failed|stale|duplicate) 저장.
#   • 두 번째 호출 시 ps_exists 가 true → skip.

# ============================================================================
# Internal helpers
# ============================================================================

_human_signal_ns() {
  printf 'signals/%s' "${TARGET_NAME:-default}"
}

_human_signal_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Marshal the body string of a wrapper to a temp file so lib/signals.sh
# validators can run on it.
_human_signal_body_to_tmp() {
  local body="$1"
  local tmp
  tmp="$(mktemp -t llm-team-sig.XXXXXX)" || return 1
  printf '%s' "${body}" >"${tmp}"
  printf '%s' "${tmp}"
}

# Record a signal-processing outcome (applied/rejected/failed/stale/duplicate).
_human_signal_record() {
  local signal_id="$1" comment_id="$2" status="$3" reason="${4:-}"
  local ns
  ns="$(_human_signal_ns)"
  ps_namespace_init "${ns}" >/dev/null 2>&1 || true
  local payload
  payload="$(jq -nc \
    --arg sid "${signal_id}" \
    --arg cid "${comment_id}" \
    --arg st "${status}" \
    --arg rs "${reason}" \
    --arg ts "$(_human_signal_now)" \
    '{signal_id:$sid, comment_id:$cid, status:$st, reason:$rs, processed_at:$ts}')"
  ps_put "${ns}" "${signal_id}" "${payload}" >/dev/null
}

# ============================================================================
# Public API
# ============================================================================

# human_signal_collect <repo>
# stdout: 한 줄당 wrapper JSON `{actor, comment_id, body, posted_at}`.
# 본 함수는 *모든* 후보 (open milestones + active issues) 를 스캔한다.
# PR 스캔은 port 에 it_pr_list_* 가 도입되면 확장한다 (현재 port gap).
human_signal_collect() {
  local repo="$1"
  if [ -z "${repo}" ]; then
    log_error "human_signal_collect: repo is required"
    return 1
  fi

  local ms
  while IFS= read -r ms; do
    [ -n "${ms}" ] || continue
    it_comment_collect_signals "${repo}" milestone "${ms}" 2>/dev/null || true
  done < <(it_milestone_list_open "${repo}")

  local state issue
  for state in TASK_READY TASK_IN_PROGRESS TASK_REVIEW_READY \
               TASK_REVIEW_IN_PROGRESS TASK_INTEGRATED TASK_REJECTED ESCALATED; do
    while IFS= read -r issue; do
      [ -n "${issue}" ] || continue
      it_comment_collect_signals "${repo}" issue "${issue}" 2>/dev/null || true
    done < <(it_issue_list_in_state "${repo}" "${state}" 2>/dev/null)
  done
}

# human_signal_validate_extended <wrapper_json>
# 0 = wrapper.body 가 RGC-SIGNALS envelope 이고, wrapper.actor == envelope.actor.
# 비0 = 실패 (stderr 에 사유).
human_signal_validate_extended() {
  local wrapper="$1"
  if [ -z "${wrapper}" ]; then
    log_error "human_signal_validate_extended: wrapper is required"
    return 1
  fi
  local body actor_wrap actor_body tmp
  body="$(jq -r '.body // ""' <<<"${wrapper}")"
  actor_wrap="$(jq -r '.actor // ""' <<<"${wrapper}")"
  if [ -z "${body}" ]; then
    log_error "human_signal_validate_extended: empty body"
    return 1
  fi
  tmp="$(_human_signal_body_to_tmp "${body}")" || return 1
  if ! human_signal_validate "${tmp}" 2>/dev/null; then
    rm -f "${tmp}"
    log_error "human_signal_validate_extended: envelope schema invalid"
    return 1
  fi
  actor_body="$(jq -r '.actor // ""' "${tmp}")"
  rm -f "${tmp}"
  if [ "${actor_wrap}" != "${actor_body}" ]; then
    log_error "human_signal_validate_extended: actor mismatch (wrapper='${actor_wrap}' envelope='${actor_body}')"
    return 1
  fi
}

# human_signal_apply <repo> <wrapper_json>
# signal_type 분기. 0 = 적용 성공. 비0 = 적용 실패.
human_signal_apply() {
  local repo="$1" wrapper="$2"
  if [ -z "${repo}" ] || [ -z "${wrapper}" ]; then
    log_error "human_signal_apply: repo and wrapper are required"
    return 1
  fi
  local body sig_type target_kind target_id pin
  body="$(jq -r '.body // ""' <<<"${wrapper}")"
  sig_type="$(  jq -r ' .signal_type // ""'           <<<"${body}")"
  target_kind="$(jq -r ' .target_kind // ""'          <<<"${body}")"
  target_id="$(  jq -r ' .target_id // ""'            <<<"${body}")"
  pin="$(        jq -r ' .target_revision_pin // ""'  <<<"${body}")"

  case "${sig_type}" in
    approve)
      _human_signal_check_pin "${repo}" "${target_kind}" "${target_id}" "${pin}" || return 2
      _human_signal_apply_approve "${repo}" "${target_kind}" "${target_id}"
      ;;
    reject)
      _human_signal_apply_reject "${repo}" "${target_kind}" "${target_id}"
      ;;
    request_rework)
      _human_signal_apply_rework "${repo}" "${target_kind}" "${target_id}"
      ;;
    request_recover)
      _human_signal_apply_recover "${repo}" "${target_kind}" "${target_id}"
      ;;
    pause)
      control_state_set PAUSED
      ;;
    resume)
      control_state_set RUNNING
      ;;
    amendment_approve)
      # MVP scope 외 — 처리 결과는 _human_signal_record 가 ps_put 으로 기록한다.
      return 0
      ;;
    stop)
      _human_signal_apply_stop "${repo}" "${target_kind}" "${target_id}"
      ;;
    *)
      log_error "human_signal_apply: unknown signal_type '${sig_type}'"
      return 1
      ;;
  esac
}

# human_signal_drain <repo>
# collect → 각 wrapper validate + apply + ps idempotency record.
# 처리 건수 echo (정수). collect 중 transient error 는 warn 만 로깅.
human_signal_drain() {
  local repo="$1"
  if [ -z "${repo}" ]; then
    log_error "human_signal_drain: repo is required"
    return 1
  fi

  local ns
  ns="$(_human_signal_ns)"
  ps_namespace_init "${ns}" >/dev/null 2>&1 || true

  local count=0
  local wrappers
  wrappers="$(human_signal_collect "${repo}")" || true

  local wrapper signal_id comment_id body
  while IFS= read -r wrapper; do
    [ -n "${wrapper}" ] || continue
    body="$(jq -r '.body // ""' <<<"${wrapper}")"
    signal_id="$(jq -r ' .signal_id // ""' <<<"${body}")"
    comment_id="$(jq -r '.comment_id // ""' <<<"${wrapper}")"
    if [ -z "${signal_id}" ]; then
      log_warn "human_signal_drain: missing signal_id; skip"
      continue
    fi

    if ps_exists "${ns}" "${signal_id}" 2>/dev/null; then
      # Do NOT overwrite the original outcome — preserve the first decision.
      # A second sighting is logged only.
      log_info "human_signal_drain: signal '${signal_id}' already processed; skip"
      continue
    fi

    if ! human_signal_validate_extended "${wrapper}" 2>/dev/null; then
      _human_signal_record "${signal_id}" "${comment_id}" "rejected" "validate failed"
      continue
    fi

    if human_signal_apply "${repo}" "${wrapper}"; then
      _human_signal_record "${signal_id}" "${comment_id}" "applied"
      count=$((count + 1))
    else
      local rc=$?
      if [ "${rc}" -eq 2 ]; then
        _human_signal_record "${signal_id}" "${comment_id}" "stale" "revision pin mismatch"
      else
        _human_signal_record "${signal_id}" "${comment_id}" "failed" "apply rc=${rc}"
      fi
    fi
  done <<<"${wrappers}"

  printf '%s\n' "${count}"
}

# ============================================================================
# Per-signal-type internal handlers
# ============================================================================

_human_signal_check_pin() {
  local repo="$1" kind="$2" id="$3" pin="$4"
  [ -n "${pin}" ] || return 0   # signals without pin are accepted as-is.
  local current
  current="$(it_revision_pin_get "${repo}" "${kind}" "${id}" 2>/dev/null)" || return 0
  if [ -n "${current}" ] && [ "${pin}" != "${current}" ]; then
    log_warn "_human_signal_check_pin: stale pin (signal='${pin}' current='${current}')"
    return 2
  fi
  return 0
}

_human_signal_apply_approve() {
  local repo="$1" kind="$2" id="$3"
  case "${kind}" in
    milestone)
      local cur next
      cur="$(it_milestone_get_state "${repo}" "${id}")"
      # Per RGC: approve target = milestone in PO_GATE / PM_GATE only.
      # VALIDATE_READY → DONE is driven by Validate operation (QA verdict), not human signal.
      case "${cur}" in
        PO_GATE) next="PM_DRAFT" ;;
        PM_GATE) next="DECOMPOSE_READY" ;;
        *)
          log_error "approve: milestone #${id} not in a gate state (current='${cur}')"
          return 1
          ;;
      esac
      it_milestone_set_state "${repo}" "${id}" "${next}" "${cur}"
      ;;
    *)
      log_error "approve: target_kind '${kind}' not supported"
      return 1
      ;;
  esac
}

_human_signal_apply_reject() {
  local repo="$1" kind="$2" id="$3"
  case "${kind}" in
    milestone)
      local cur next
      cur="$(it_milestone_get_state "${repo}" "${id}")"
      case "${cur}" in
        PO_GATE) next="PO_DRAFT" ;;
        PM_GATE) next="PM_DRAFT" ;;
        *)
          log_error "reject: milestone #${id} not in a gate state (current='${cur}')"
          return 1
          ;;
      esac
      it_milestone_set_state "${repo}" "${id}" "${next}" "${cur}"
      ;;
    *)
      log_error "reject: target_kind '${kind}' not supported"
      return 1
      ;;
  esac
}

_human_signal_apply_rework() {
  local repo="$1" kind="$2" id="$3"
  # Per RGC: request_rework target = task or change_proposal.
  # Task allowed-state: ESCALATED → TASK_READY. CP allowed-state: CP_REQUEST_CHANGES, CP_CLOSED
  # (acknowledged-only; closed CP must not be reopened, new CP creation is a downstream concern).
  case "${kind}" in
    issue|task)
      local cur
      cur="$(it_issue_get_state "${repo}" "${id}")"
      case "${cur}" in
        ESCALATED) ;;
        *)
          log_error "request_rework: task #${id} not in ESCALATED state (current='${cur}')"
          return 1
          ;;
      esac
      it_issue_set_state "${repo}" "${id}" TASK_READY "${cur}"
      ;;
    change_proposal|cp)
      log_warn "request_rework: change_proposal target #${id} acknowledged (no state transition; create a new CP downstream)"
      ;;
    *)
      log_error "request_rework: target_kind '${kind}' not supported"
      return 1
      ;;
  esac
}

_human_signal_apply_recover() {
  local repo="$1" kind="$2" id="$3"
  case "${kind}" in
    milestone)
      local cur next
      cur="$(it_milestone_get_state "${repo}" "${id}")"
      case "${cur}" in
        PO_GATE)                                  next="PO_DRAFT" ;;
        PM_DRAFT|PM_GATE)                         next="PO_DRAFT" ;;
        DECOMPOSE_READY|DECOMPOSE_IN_PROGRESS)    next="PM_DRAFT" ;;
        IMPLEMENTING|REFACTOR_READY|REFACTOR_IN_PROGRESS) next="DECOMPOSE_READY" ;;
        VALIDATE_READY|VALIDATE_IN_PROGRESS)      next="REFACTOR_READY" ;;
        *)
          log_error "request_recover: milestone #${id} not recoverable (current='${cur}')"
          return 1
          ;;
      esac
      it_milestone_set_state "${repo}" "${id}" "${next}" "${cur}"
      ;;
    issue|task)
      local cur
      cur="$(it_issue_get_state "${repo}" "${id}")"
      it_issue_set_state "${repo}" "${id}" TASK_READY "${cur}"
      ;;
    *)
      log_error "request_recover: target_kind '${kind}' not supported"
      return 1
      ;;
  esac
}

_human_signal_apply_stop() {
  local repo="$1" kind="$2" id="$3"
  case "${kind}" in
    milestone)
      local cur
      cur="$(it_milestone_get_state "${repo}" "${id}")"
      it_milestone_set_state "${repo}" "${id}" ESCALATED "${cur}"
      ;;
    issue|task)
      local cur
      cur="$(it_issue_get_state "${repo}" "${id}")"
      it_issue_set_state "${repo}" "${id}" ESCALATED "${cur}"
      ;;
    *)
      log_error "stop: target_kind '${kind}' not supported"
      return 1
      ;;
  esac
}
