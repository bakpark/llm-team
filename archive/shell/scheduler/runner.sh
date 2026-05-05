#!/usr/bin/env bash
# scheduler/runner.sh — Contract-era Caller runner pipeline.
#
# Usage:
#   scheduler/runner.sh <role> <target> [--dry-run]
#
# Pipeline (sub-phase5-runner-pipeline.md):
#   load_target → registry_rebind → PAUSED 검사 →
#   recovery_scan (TODO Phase 8) → human_signal_drain (TODO Phase 6) →
#   feature_request_promote (role=PO 전용) →
#   ready_object_pick → lease_claim → claim_transition →
#   manifest 빌드 → verification (reviewer/integrator/qa 한정) →
#   agent_prompt_assemble → lr_invoke → agent_output_parse →
#   agent_output_validate_extended → revision_pin_revalidate →
#   caller_apply_output → lease_release.
#
# 호출 경계 (AGC-CALL-BOUNDARY): port (it_*/ws_*/lr_*/nt_*/ps_*) + lib/* helpers
# + application/* 모듈만 사용. gh/git/curl/claude 직접 호출 0건.
#
# Lease: lib/lease.sh 단일 경로 — ps_lock_* 사용 금지.
#
# Ledger: 모든 종료 분기는 RGC-LEDGER 한 줄을 기록한다 — caller_apply_output 이
# applied 라인을, _runner_ledger_write 가 claim_failed/invalid/stale/error/
# duplicate 라인을 담당한다 (duplicate 은 caller_apply_output 내부에서 처리).
#
# Dry-run: ready_object 픽업 + manifest 스캐폴드까지만 수행. lease/transition/
# verification/lr_invoke/caller_apply_output 모두 skip.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# Application layer (port-only callers).
# shellcheck source=../application/agent_io.sh
. "${LLM_TEAM_ROOT}/application/agent_io.sh"
# shellcheck source=../application/ready_object.sh
. "${LLM_TEAM_ROOT}/application/ready_object.sh"
# shellcheck source=../application/feature_request.sh
. "${LLM_TEAM_ROOT}/application/feature_request.sh"
# shellcheck source=../application/caller_dispatch.sh
. "${LLM_TEAM_ROOT}/application/caller_dispatch.sh"
# shellcheck source=../application/release.sh
. "${LLM_TEAM_ROOT}/application/release.sh"
# shellcheck source=../application/verification_runner.sh
. "${LLM_TEAM_ROOT}/application/verification_runner.sh"
# shellcheck source=../application/human_signal.sh
. "${LLM_TEAM_ROOT}/application/human_signal.sh"
# shellcheck source=../application/recovery.sh
. "${LLM_TEAM_ROOT}/application/recovery.sh"
# shellcheck source=../application/workspace_prune.sh
. "${LLM_TEAM_ROOT}/application/workspace_prune.sh"
# shellcheck source=../application/knowledge.sh
. "${LLM_TEAM_ROOT}/application/knowledge.sh"
# shellcheck source=../application/agent_workspace.sh
. "${LLM_TEAM_ROOT}/application/agent_workspace.sh"

# ============================================================================
# Argument parsing
# ============================================================================

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <role> <target> [--dry-run]

role must be one of: po | pm | planner | coder | reviewer | integrator | qa
EOF
  exit 64
}

ROLE_RAW="${1:-}"
TARGET="${2:-}"
DRY_RUN=0
shift $(( $# >= 2 ? 2 : $# ))
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "${ROLE_RAW}" ] && [ -n "${TARGET}" ] || usage
ROLE="$(role_normalize "${ROLE_RAW}")" || usage
OPERATION="$(role_operation "${ROLE}")"
PROMPT_FILE="$(role_prompt_path "${ROLE}")"

load_target "${TARGET}"
if [ "${TARGET_ENABLED}" != "true" ]; then
  log_info "runner: target '${TARGET}' is disabled; exiting"
  exit 0
fi

if [ "${DRY_RUN}" -eq 0 ]; then
  log_init "${ROLE}" "${TARGET}"
fi

TARGET_REPO="${TARGET_GH_OWNER:-}/${TARGET_GH_REPO:-}"
TARGET_REPO="${TARGET_REPO#/}"   # strip leading slash if owner empty
TARGET_REPO="${TARGET_REPO%/}"   # strip trailing slash if repo empty

WORKER_ID="${LLM_TEAM_WORKER_ID:-${USER:-anonymous}-$(hostname -s 2>/dev/null || echo nohost)-$$}"
LEASE_TTL="${LLM_TEAM_LEASE_TTL:-600}"

log_info "runner: role=${ROLE} operation=${OPERATION} target=${TARGET} repo=${TARGET_REPO} dry_run=${DRY_RUN}"

# Operational gates ---------------------------------------------------------

_RUNNER_CONTROL_STATE="$(control_state_get)"
case "${_RUNNER_CONTROL_STATE}" in
  PAUSED|STOPPED)
    log_info "runner: control state is ${_RUNNER_CONTROL_STATE}; no lease will be claimed"
    exit 0
    ;;
esac

# Phase 8: recovery_scan — expired leases get state-rollback per RGC-RECOVERY.
# run_stale_recovery now delegates to application/recovery.sh.recovery_scan.
run_stale_recovery "${TARGET}" "${TARGET_REPO}" \
  || log_warn "runner: stale recovery returned non-zero"

# Phase 6: drain pending human governance signals before picking ready object.
# Best-effort — transient collect errors are warned but do not abort the runner.
# Skipped on dry-run (no live signal traffic should be consumed during smoke).
if [ "${DRY_RUN}" -eq 0 ] && [ -n "${TARGET_REPO}" ]; then
  human_signal_drain "${TARGET_REPO}" >/dev/null 2>&1 \
    || log_warn "runner: human_signal_drain returned non-zero"
fi

if [ ! -f "${PROMPT_FILE}" ]; then
  log_error "runner: prompt file missing: ${PROMPT_FILE}"
  exit 1
fi

# ============================================================================
# Helpers
# ============================================================================

# Resolve revision_pin for a picked object via port.
_runner_pin_for() {
  local repo="$1" obj_kind="$2" obj_id="$3"
  local kind
  case "${obj_kind}" in
    milestone)                    kind=milestone ;;
    issue|feature_request_issue)  kind=issue ;;
    pr)                           kind=pr ;;
    *)                            kind="${obj_kind}" ;;
  esac
  it_revision_pin_get "${repo}" "${kind}" "${obj_id}" 2>/dev/null \
    || printf 'unknown'
}

# Apply READY → IN_PROGRESS claim transition based on role.
_runner_claim_transition() {
  local role="$1" repo="$2" obj_kind="$3" obj_id="$4"
  case "${role}" in
    Planner)    it_milestone_set_state "${repo}" "${obj_id}" DECOMPOSE_IN_PROGRESS DECOMPOSE_READY ;;
    Coder)      it_issue_set_state     "${repo}" "${obj_id}" TASK_IN_PROGRESS TASK_READY ;;
    Reviewer)   it_issue_set_state     "${repo}" "${obj_id}" TASK_REVIEW_IN_PROGRESS TASK_REVIEW_READY ;;
    Integrator) it_milestone_set_state "${repo}" "${obj_id}" REFACTOR_IN_PROGRESS REFACTOR_READY ;;
    QA)         it_milestone_set_state "${repo}" "${obj_id}" VALIDATE_IN_PROGRESS VALIDATE_READY ;;
    PO|PM)      return 0 ;;
  esac
}

# Reverse of _runner_claim_transition (used on invalid/stale envelope).
_runner_claim_rollback() {
  local role="$1" repo="$2" obj_kind="$3" obj_id="$4"
  case "${role}" in
    Planner)    it_milestone_set_state "${repo}" "${obj_id}" DECOMPOSE_READY DECOMPOSE_IN_PROGRESS ;;
    Coder)      it_issue_set_state     "${repo}" "${obj_id}" TASK_READY TASK_IN_PROGRESS ;;
    Reviewer)   it_issue_set_state     "${repo}" "${obj_id}" TASK_REVIEW_READY TASK_REVIEW_IN_PROGRESS ;;
    Integrator) it_milestone_set_state "${repo}" "${obj_id}" REFACTOR_READY REFACTOR_IN_PROGRESS ;;
    QA)         it_milestone_set_state "${repo}" "${obj_id}" VALIDATE_READY VALIDATE_IN_PROGRESS ;;
    PO|PM)      return 0 ;;
  esac
}

# Map role → from_state of the role's input (for ledger annotation).
_runner_input_state_for() {
  local role="$1"
  case "${role}" in
    PO)         printf 'PO_DRAFT' ;;
    PM)         printf 'PM_DRAFT' ;;
    Planner)    printf 'DECOMPOSE_IN_PROGRESS' ;;
    Coder)      printf 'TASK_IN_PROGRESS' ;;
    Reviewer)   printf 'TASK_REVIEW_IN_PROGRESS' ;;
    Integrator) printf 'REFACTOR_IN_PROGRESS' ;;
    QA)         printf 'VALIDATE_IN_PROGRESS' ;;
    *)          printf 'unknown' ;;
  esac
}

# Write a non-applied RGC-LEDGER entry (claim_failed / invalid / stale / error).
# reason 은 옵셔널 (10번째 인자). 비어있으면 row 에서 null 로 기록되며, 기존
# reason-인자 없는 호출자와 호환된다.
_runner_ledger_write() {
  local target="$1" obj_kind="$2" obj_id="$3" from_state="$4" to_state="$5"
  local operation="$6" idempotency_key="$7" manifest_id="$8" result="$9"
  local reason="${10:-}"
  local cycle_bundle_ref="${11:-}"
  local tmp
  tmp="$(mktemp -t runner-ledger.XXXXXX)" || return 1
  local lease_token
  lease_token="$(lease_get_token "${target}" "${obj_id}" 2>/dev/null || true)"
  jq -n \
    --arg transition_id "runner-${result}-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}" \
    --arg target_id "${target}" \
    --arg object_kind "${obj_kind}" \
    --arg object_id "${obj_id}" \
    --arg from_state "${from_state}" \
    --arg to_state "${to_state}" \
    --arg operation "${operation}" \
    --arg caller_id "${WORKER_ID}" \
    --arg idempotency_key "${idempotency_key:-runner-${result}-${obj_id}-$(date -u +%s%N 2>/dev/null || date -u +%s)-$$}" \
    --arg manifest_id "${manifest_id:-}" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg result "${result}" \
    --arg lease_token "${lease_token}" \
    --arg reason "${reason}" \
    --arg cycle_bundle_ref "${cycle_bundle_ref}" \
    '{
      transition_id: $transition_id,
      target_id: $target_id,
      object_kind: $object_kind,
      object_id: $object_id,
      from_state: $from_state,
      to_state: $to_state,
      operation: $operation,
      caller_id: $caller_id,
      idempotency_key: $idempotency_key,
      manifest_id: $manifest_id,
      timestamp: $timestamp,
      lease_token: (if $lease_token == "" then null else $lease_token end),
      result: $result,
      reason: (if $reason == "" then null else $reason end),
      cycle_bundle_ref: (if $cycle_bundle_ref == "" then null else $cycle_bundle_ref end),
      duplicate: false
    }' >"${tmp}" || { rm -f "${tmp}"; return 1; }
  transition_ledger_write "${target}" "${tmp}" || { rm -f "${tmp}"; return 1; }
  rm -f "${tmp}"
}

# ============================================================================
# PO 진입점: feature-request → milestone(PO_DRAFT)
# ============================================================================

# Dry-run shortcut: scaffold a manifest from env-override defaults without
# touching the issue tracker (smoke test compatibility — no live calls).
if [ "${DRY_RUN}" -eq 1 ]; then
  TARGET_OBJECT_KIND="${LLM_TEAM_RUN_OBJECT_KIND:-system}"
  TARGET_OBJECT_ID="${LLM_TEAM_RUN_OBJECT_ID:-dry-run}"
  TARGET_REVISION_PIN="${LLM_TEAM_RUN_REVISION_PIN:-local}"
  MANIFEST_FILE="$(context_manifest_create "${TARGET}" "${OPERATION}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}")"
  context_manifest_add_entry "${MANIFEST_FILE}" \
    "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" "metadata" \
    "${TARGET_REVISION_PIN}" true "runner scaffold (dry-run)"
  context_manifest_validate "${MANIFEST_FILE}"
  log_info "runner: dry-run manifest=${MANIFEST_FILE}"
  log_info "runner: prompt=${PROMPT_FILE}"
  exit 0
fi

if [ "${ROLE}" = "PO" ]; then
  # B-1 fix: 이전엔 `>/dev/null 2>&1 || true` 로 모든 promote 실패가 silent
  # swallow 됐다 (title 중복 / API 에러 모두 흔적 없음). 이제 stderr 는 흐르도록
  # 두고, 실패 시 ledger 에 error row 를 남겨 운영 가시성을 확보한다. 처리할
  # feature-request issue 가 없어 비0 종료(rc=1)인 정상 케이스는 silent (rc 1
  # 만 흡수). 그 외 비0 (it_milestone_create / set_state / link 실패 등) 은 기록.
  _fr_rc=0
  feature_request_promote "${TARGET_REPO}" >/dev/null 2>&1 || _fr_rc=$?
  if [ "${_fr_rc}" -ne 0 ] && [ "${_fr_rc}" -ne 1 ]; then
    log_error "runner: feature_request_promote failed (rc=${_fr_rc})"
    _runner_ledger_write "${TARGET}" "system" "po-promote" \
      "(failed)" "(failed)" "Promote" "" "" "error" \
      "feature_request_promote rc=${_fr_rc}" || true
  fi
fi

# ============================================================================
# Ready object pickup
# ============================================================================

PICK="$(ready_object_pick "${ROLE}" "${TARGET_REPO}" 2>/dev/null || true)"
if [ -z "${PICK}" ]; then
  log_info "runner: no ready object for role=${ROLE}"
  exit 0
fi
TARGET_OBJECT_KIND="$(printf '%s' "${PICK}" | awk -F'\t' '{print $1}')"
TARGET_OBJECT_ID="$(printf '%s' "${PICK}" | awk -F'\t' '{print $2}')"
TARGET_REVISION_PIN="$(_runner_pin_for "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}")"

PINS_JSON="$(jq -nc \
  --arg kind "${TARGET_OBJECT_KIND}" \
  --arg id "${TARGET_OBJECT_ID}" \
  --arg pin "${TARGET_REVISION_PIN}" \
  '[{object_kind: $kind, object_id: $id, revision_pin: $pin}]')"

# ============================================================================
# Dry-run path: build manifest scaffold and exit
# ============================================================================

if [ "${DRY_RUN}" -eq 1 ]; then
  MANIFEST_FILE="$(context_manifest_create "${TARGET}" "${OPERATION}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}")"
  context_manifest_add_entry "${MANIFEST_FILE}" \
    "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" "metadata" \
    "${TARGET_REVISION_PIN}" true "runner pickup (dry-run)"
  context_manifest_validate "${MANIFEST_FILE}"
  log_info "runner: dry-run manifest=${MANIFEST_FILE}"
  log_info "runner: prompt=${PROMPT_FILE}"
  log_info "runner: dry-run pick ${TARGET_OBJECT_KIND}/${TARGET_OBJECT_ID}"
  exit 0
fi

# ============================================================================
# Lease claim (single-source: lib/lease.sh)
# ============================================================================

LEASE_ID=""
if ! LEASE_ID="$(lease_claim "${TARGET}" "${TARGET_OBJECT_ID}" "${OPERATION}" "${WORKER_ID}" "${LEASE_TTL}" "${PINS_JSON}" 2>/dev/null)"; then
  log_info "runner: lease busy for ${TARGET_OBJECT_KIND}/${TARGET_OBJECT_ID}"
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "(busy)" "(busy)" "${OPERATION}" "" "" "claim_failed" || true
  exit 0
fi

# Trap: lease release on any exit (success or failure).
_runner_release_lease() {
  if [ -n "${LEASE_ID:-}" ]; then
    lease_release "${TARGET}" "${TARGET_OBJECT_ID}" "${LEASE_ID}" 2>/dev/null || true
    LEASE_ID=""
  fi
}
trap _runner_release_lease EXIT

# ============================================================================
# Claim transition (READY → IN_PROGRESS)
# ============================================================================

if ! _runner_claim_transition "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null; then
  log_error "runner: claim_transition failed for ${ROLE} ${TARGET_OBJECT_ID}"
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "(claim_failed)" "(claim_failed)" "${OPERATION}" "" "" "claim_failed" || true
  exit 1
fi

# Retry guard (B-2): 같은 (object_kind, object_id, operation) 가 최근 N회 모두
# error 였으면 ESCALATED 로 격상 + cycle 종료. claim_transition 직후에 검사하는
# 이유는 ESCALATED 로의 직접 전이가 *_IN_PROGRESS 상태에서만 매트릭스로 허용
# (lib/state.sh state_transition_allowed) 되기 때문이다.
RETRY_GUARD_MAX="${LLM_TEAM_RETRY_GUARD_MAX_ERRORS:-3}"
if [ "${LLM_TEAM_RETRY_GUARD_DISABLE:-0}" != "1" ] && [ "${RETRY_GUARD_MAX}" -gt 0 ]; then
  RECENT_ERRORS="$(ledger_count_recent_errors "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" "${OPERATION}" 200 2>/dev/null || echo 0)"
  if [ "${RECENT_ERRORS}" -ge "${RETRY_GUARD_MAX}" ]; then
    log_error "runner: retry guard triggered (${RECENT_ERRORS} consecutive errors) — escalating ${TARGET_OBJECT_KIND}/${TARGET_OBJECT_ID} ${OPERATION}"
    case "${TARGET_OBJECT_KIND}" in
      issue|task)
        it_issue_set_state "${TARGET_REPO}" "${TARGET_OBJECT_ID}" ESCALATED 2>/dev/null \
          || log_warn "runner: it_issue_set_state ESCALATED failed (continuing to ledger)" ;;
      milestone)
        it_milestone_set_state "${TARGET_REPO}" "${TARGET_OBJECT_ID}" ESCALATED 2>/dev/null \
          || log_warn "runner: it_milestone_set_state ESCALATED failed (continuing to ledger)" ;;
    esac
    _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
      "$(_runner_input_state_for "${ROLE}")" "ESCALATED" \
      "${OPERATION}" "" "" "escalated" \
      "retry_guard:${RECENT_ERRORS} consecutive errors"
    exit 0
  fi
fi

# Re-capture revision_pin after claim_transition: the *_IN_PROGRESS state is
# what the agent sees as input, so manifest entries and revalidate compare
# against the post-transition pin (otherwise revalidate sees a self-stale pin).
TARGET_REVISION_PIN="$(_runner_pin_for "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}")"

# code_tree: PO/PM/Planner RO tree pre-manifest guarantee (plan §Step 5)
RO_PATH=""
CODE_TREE_PIN=""
case "${ROLE}" in
  PO|PM|Planner)
    ws_ensure_clone "${TARGET}" >/dev/null 2>&1 || {
      log_error "runner: ws_ensure_clone failed (${ROLE}) — skipping cycle"
      _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
      _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
        "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
        "${OPERATION}" "" "" "error" \
        "ws_ensure_clone failed" || true
      exit 1
    }
    RO_PATH="$(ws_ensure_ro_tree "${TARGET}" 2>/dev/null)" || {
      log_error "runner: ws_ensure_ro_tree failed (${ROLE}) — skipping cycle"
      _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
      _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
        "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
        "${OPERATION}" "" "" "error" \
        "ws_ensure_ro_tree failed" || true
      exit 1
    }
    CODE_TREE_PIN="$(ws_ro_tree_revision_pin "${TARGET}" 2>/dev/null)" || {
      log_error "runner: ws_ro_tree_revision_pin failed (${ROLE}) — skipping cycle"
      _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
      _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
        "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
        "${OPERATION}" "" "" "error" \
        "ws_ro_tree_revision_pin failed" || true
      exit 1
    }
    export TARGET_RO_TREE_PATH="${RO_PATH}"
    ;;
esac


# ============================================================================
# Manifest build (primary entry)
# ============================================================================

MANIFEST_FILE="$(context_manifest_create "${TARGET}" "${OPERATION}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}")"
context_manifest_add_entry "${MANIFEST_FILE}" \
  "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" "metadata" \
  "${TARGET_REVISION_PIN}" true "runner pickup"

# KAC-CONTEXT-SUMMARY auto-inject (P1-7): for PO/PM manifest builds, attach the
# most recent prior milestone's QA-stamped summary so spec composition can
# reference completed-milestone outcomes without re-fetching them. Skipped if
# no prior summary exists (first milestone of a target). Excludes the current
# milestone id so PM Compose-PM does not self-reference.
case "${ROLE}" in
  PO|PM)
    if declare -F knowledge_latest_prior_summary >/dev/null 2>&1; then
      _prior_row="$(knowledge_latest_prior_summary "${TARGET}" "${TARGET_OBJECT_ID}" 2>/dev/null || true)"
      if [ -n "${_prior_row}" ]; then
        _prior_id="$(printf '%s' "${_prior_row}" | awk -F'\t' '{print $1}')"
        _prior_pin="$(printf '%s' "${_prior_row}" | awk -F'\t' '{print $3}')"
        context_manifest_add_entry "${MANIFEST_FILE}" \
          "knowledge_summary" "${_prior_id}" "body" \
          "${_prior_pin}" false "prior milestone context summary (KAC-CONTEXT-SUMMARY auto-inject)" \
          || log_warn "runner: failed to inject prior summary for milestone ${_prior_id}"
      fi
    fi
    ;;
esac


# code_tree manifest entry inject (plan §Step 5) — before context_manifest_validate
if [[ "${ROLE}" == "PO" || "${ROLE}" == "PM" || "${ROLE}" == "Planner" ]]; then
  if [ -n "${CODE_TREE_PIN}" ]; then
    context_manifest_add_entry \
      "${MANIFEST_FILE}" \
      "code_tree" \
      "${TARGET_GH_OWNER}/${TARGET_GH_REPO}" \
      "tree" \
      "${CODE_TREE_PIN}" \
      "true" \
      "read-only target codebase for grounded reasoning"
  fi
fi

context_manifest_validate "${MANIFEST_FILE}" || {
  log_error "runner: manifest validate failed"
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" "" "" "error" || true
  exit 1
}

# ============================================================================
# Cycle bundle (RW 4 역할만): cb_open + 단일 cleanup trap.
# ============================================================================

CB_HANDLE=""
_runner_cycle_result=""
case "${ROLE}" in
  Coder|Reviewer|Integrator|QA)
    _manifest_id_full="$(context_manifest_id "${MANIFEST_FILE}")"
    _manifest_hash12="$(printf '%s' "${_manifest_id_full}" | shasum -a 256 | cut -c1-12)"
    _cycle_id="${ROLE}-${TARGET_OBJECT_ID}-${_manifest_hash12}"
    if declare -F cb_open >/dev/null 2>&1; then
      CB_HANDLE="$(cb_open "${_cycle_id}" "${TARGET}" "${ROLE}" \
                            "${_manifest_id_full}" "${LEASE_ID:-}")"
    fi
    ;;
esac

_runner_cycle_finalize_if_open() {
  if [ -n "${CB_HANDLE:-}" ] && declare -F cb_finalize >/dev/null 2>&1; then
    cb_finalize "${CB_HANDLE}" "${_runner_cycle_result:-error}" "{}"
  fi
}

# Early trap — envelope 단계 도달 전에 exit 해도 cb_finalize 보장.
trap '_runner_cycle_finalize_if_open' EXIT

# ============================================================================
# Workspace pre-setup (Coder needs ws before caller_apply_output → ws_apply_patch)
# ============================================================================

case "${ROLE}" in
  Coder)
    ws_ensure_clone "${TARGET}" >/dev/null 2>&1 || log_warn "runner: ws_ensure_clone failed (Coder)"
    ws_ensure "task-${TARGET_OBJECT_ID}" >/dev/null 2>&1 \
      || log_warn "runner: ws_ensure failed for task-${TARGET_OBJECT_ID} (Coder)"
    # L2: 이전 cycle 의 lr_invoke 또는 dispatch 실패로 worktree 에 잔여 변경이
    # 남아 있을 수 있다. origin/<branch> 가 존재하면 그 tip 으로 재설정,
    # 없으면 no-op (첫 cycle 이라 정상). idempotent.
    if declare -F ws_refresh >/dev/null 2>&1; then
      ws_refresh "task-${TARGET_OBJECT_ID}" >/dev/null 2>&1 \
        || log_warn "runner: ws_refresh failed for task-${TARGET_OBJECT_ID} (Coder)"
    fi
    ;;
esac

# ============================================================================
# Verification pre-action (Reviewer/Integrator/QA)
# ============================================================================

case "${ROLE}" in
  Reviewer|Integrator|QA)
    ws_ensure_clone "${TARGET}" >/dev/null 2>&1 || log_warn "runner: ws_ensure_clone failed"
    WS_PATH=""
    WS_PATH="$(ws_ensure "task-${TARGET_OBJECT_ID}" 2>/dev/null || true)"
    if [ -n "${WS_PATH}" ] && [ -d "${WS_PATH}" ]; then
      # H2: reuse 된 worktree 가 origin tip 과 동기화되어 있도록 강제.
      # Coder 가 다른 cycle 에서 push 한 새 commit 을 Reviewer/Integrator/QA
      # 가 보지 못하는 일을 방지한다.
      if declare -F ws_refresh >/dev/null 2>&1; then
        ws_refresh "task-${TARGET_OBJECT_ID}" >/dev/null 2>&1 \
          || log_warn "runner: ws_refresh failed for task-${TARGET_OBJECT_ID}"
      fi
      VCMDS="${TARGET_VERIFICATION_COMMANDS_JSON:-["true"]}"
      V_RUN_PATH=""
      if V_RUN_PATH="$(verification_run_for "${TARGET}" "${TARGET_OBJECT_ID}" "${TARGET_REVISION_PIN}" "${WS_PATH}" "${VCMDS}" 2>/dev/null)"; then
        verification_attach_to_manifest "${MANIFEST_FILE}" "${V_RUN_PATH}" \
          || log_warn "runner: verification_attach_to_manifest failed"
      else
        # FAIL on verification still attaches the run envelope for agent visibility.
        if [ -n "${V_RUN_PATH}" ] && [ -f "${V_RUN_PATH}" ]; then
          verification_attach_to_manifest "${MANIFEST_FILE}" "${V_RUN_PATH}" \
            || log_warn "runner: verification_attach_to_manifest failed (FAIL run)"
        fi
      fi
    else
      log_warn "runner: verification skipped (no workspace for task-${TARGET_OBJECT_ID})"
    fi
    ;;
esac

# Cycle bundle: pre-snapshot (RW 역할만, cb handle 있을 때만).
if [ -n "${CB_HANDLE:-}" ] && declare -F ws_head_sha >/dev/null 2>&1; then
  ws_head_sha "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/pre.head"
  ws_diff_head "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/pre.dirty.diff"
fi

# ============================================================================
# Agent invocation
# ============================================================================

# Build a context snapshot for the primary manifest entry. Without this, the
# manifest only carries object_id+revision_pin and the LLM has no way to read
# the actual milestone description / issue body, leading to placeholder output
# (e.g. "no AC available, returning bootstrap task"). The snapshot is added as
# Caller Notes and is read-only — the contract still mandates output via the
# envelope, not via direct mutation.
#
# Fetched via the issue_tracker port (`it_object_get_snapshot`) rather than a
# direct `gh` call: scheduler/runner must not couple to the GitHub adapter, or
# in_memory and future adapters silently lose snapshot enrichment.
CONTEXT_SNAPSHOT="$(it_object_get_snapshot "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true)"
EXTRA_INSTRUCTION=""
if [ -n "${CONTEXT_SNAPSHOT}" ]; then
  EXTRA_INSTRUCTION="## Context Snapshot (read-only)
The primary manifest entry resolves to the following live content. Use this as
authoritative context — do NOT emit placeholder/bootstrap output when this is
populated.

${CONTEXT_SNAPSHOT}"
fi

PROMPT_TEXT="$(agent_prompt_assemble "${ROLE}" "${MANIFEST_FILE}" "${EXTRA_INSTRUCTION}")" || {
  log_error "runner: agent_prompt_assemble failed"
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" "" "$(context_manifest_id "${MANIFEST_FILE}")" "error" \
    "" "${CB_HANDLE:-}" || true
  exit 1
}

# Resolve role-scoped agent cwd (workspace-spec-agent-strategy.md §1).
# lr_invoke runs in this directory so target-repo edits never leak into
# LLM_TEAM_ROOT. Coder/Reviewer/Integrator/QA require ws_ensure beforehand
# (already done above for Coder and the Reviewer/Integrator/QA verification block).
AGENT_CWD=""
if ! AGENT_CWD="$(agent_workspace_for "${ROLE}" "${TARGET_OBJECT_ID}" 2>/dev/null)"; then
  log_error "runner: agent_workspace_for failed for ${ROLE} ${TARGET_OBJECT_ID}"
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" "" "$(context_manifest_id "${MANIFEST_FILE}")" "error" \
    "" "${CB_HANDLE:-}" || true
  exit 1
fi
log_info "runner: agent_cwd=${AGENT_CWD} role=${ROLE}"

# ARC port boundary: write prompt to a ref, call lr_call wrapper. lr_call
# pipes prompt via stdin to the adapter (#ARC-CALL-SEMANTICS / I3), captures
# stdout to envelope_ref, stderr to diagnostics_ref, classifies exit code into
# #ARC-EXIT-CLASSES, and emits {exit_status, envelope_ref, diagnostics_ref,
# consumed_at} JSON metadata.
PROMPT_REF="$(mktemp -t runner-prompt.XXXXXX)"
printf '%s' "${PROMPT_TEXT}" >"${PROMPT_REF}"
_runner_cleanup_prompt() { rm -f "${PROMPT_REF:-}" 2>/dev/null || true; }

# Cycle bundle: prompt capture (D).
if [ -n "${CB_HANDLE:-}" ]; then
  cb_capture_blob_file "${CB_HANDLE}" "prompt.txt" "${PROMPT_REF}"
fi

# B-3: lr_invoke retry loop. transient transport error (5xx | network | timeout)
# 만 같은 cycle 내 backoff 후 재시도. 4xx / malformed_output / adapter_unavailable
# / unknown 은 retry 무의미 → 즉시 break. 같은 cycle 내 retry 이므로 lease 유지
# (다음 cycle 까지 ~120s 기다리지 않음 → 비용 ↓).
LR_MAX_ATTEMPTS="${LLM_TEAM_LR_MAX_ATTEMPTS:-3}"
LR_BACKOFF_BASE="${LLM_TEAM_LR_BACKOFF_BASE:-5}"
LR_BACKOFF_MAX="${LLM_TEAM_LR_BACKOFF_MAX:-60}"
LR_TIMEOUT_SEC="${LLM_TEAM_LR_TIMEOUT_SEC:-600}"
LR_ATTEMPT=0
LR_META=""
LR_EXIT_STATUS=""
LR_ENVELOPE_REF=""
LR_DIAGNOSTICS_REF=""
LR_ERROR_REASON=""
LR_MANIFEST_ID="$(context_manifest_id "${MANIFEST_FILE}")"

_runner_cleanup_lr_refs() {
  rm -f "${LR_ENVELOPE_REF:-}" "${LR_DIAGNOSTICS_REF:-}" 2>/dev/null || true
}

# Deterministic idempotency_key plumbing (#ARC-IDEMPOTENCY scope, review 반영):
# 같은 (role, operation, manifest_id, attempt) 호출은 같은 key. cycle 내 retry
# 는 attempt 가 달라 자연히 다른 key 를 받는다 (재시도 방지가 아닌 *멱등성
# detection 가능* 보장). 단, 본 key 는 wrapper meta 에 echo 되고 LR_* env 로만
# 노출되며, ledger 멱등성 검증은 여전히 envelope `.idempotency_key` 기준으로
# application/caller_dispatch.sh 가 수행한다 (lr_call key ↔ envelope key 의
# 통합과 ledger pre-check 은 별 라운드 의제).
_runner_lr_idem_key() {
  local attempt="$1"
  printf '%s|%s|%s|%s' \
    "${ROLE}" "${OPERATION}" "${LR_MANIFEST_ID}" "${attempt}" \
    | shasum -a 256 | cut -c1-16
}

while :; do
  LR_IDEMPOTENCY_KEY="$(_runner_lr_idem_key "${LR_ATTEMPT}")"
  if ! LR_META="$(lr_call "${ROLE}" "${OPERATION}" "${LR_MANIFEST_ID}" \
                          "${PROMPT_REF}" "${AGENT_CWD}" \
                          "${LR_TIMEOUT_SEC}" "${LR_IDEMPOTENCY_KEY}" 2>/dev/null)"; then
    log_error "runner: lr_call infrastructure failure"
    _runner_cleanup_prompt
    _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
    _runner_cycle_result="error"
    [ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "lr_call_infra_failure"
    _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
      "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
      "${OPERATION}" "" "$(context_manifest_id "${MANIFEST_FILE}")" "error" \
      "lr_call_infra_failure" "${CB_HANDLE:-}" || true
    exit 1
  fi
  LR_EXIT_STATUS="$(printf '%s' "${LR_META}" | jq -r '.exit_status // ""')"
  LR_ENVELOPE_REF="$(printf '%s' "${LR_META}" | jq -r '.envelope_ref // ""')"
  LR_DIAGNOSTICS_REF="$(printf '%s' "${LR_META}" | jq -r '.diagnostics_ref // ""')"
  LR_ERROR_REASON="$(printf '%s' "${LR_META}" | jq -r '.error_reason // ""')"
  log_info "runner: lr_call exit_status=${LR_EXIT_STATUS} reason=${LR_ERROR_REASON:-none} attempt=$((LR_ATTEMPT+1))/${LR_MAX_ATTEMPTS}"

  # Cycle bundle: per-attempt capture + promote on lr fail (E).
  if [ -n "${CB_HANDLE:-}" ]; then
    cb_capture_attempt "${CB_HANDLE}" "$((LR_ATTEMPT+1))" \
      "${LR_ENVELOPE_REF}" "${LR_DIAGNOSTICS_REF}" "${LR_META}"
    if [ "${LR_EXIT_STATUS}" != "ok" ]; then
      cb_promote_to_full "${CB_HANDLE}" "lr:${LR_EXIT_STATUS}:${LR_ERROR_REASON:-}"
    fi
  fi

  if [ "${LR_EXIT_STATUS}" = "ok" ]; then
    break
  fi

  case "${LR_EXIT_STATUS}:${LR_ERROR_REASON}" in
    transport_error:5xx|transport_error:network|timeout:*)
      LR_ATTEMPT=$((LR_ATTEMPT + 1))
      if [ "${LR_ATTEMPT}" -ge "${LR_MAX_ATTEMPTS}" ]; then
        log_error "runner: lr_invoke gave up after ${LR_ATTEMPT} attempt(s) (${LR_EXIT_STATUS}/${LR_ERROR_REASON})"
        break
      fi
      log_warn "runner: lr_invoke transient failure (${LR_EXIT_STATUS}/${LR_ERROR_REASON}); backoff before retry ${LR_ATTEMPT}/${LR_MAX_ATTEMPTS}"
      _runner_cleanup_lr_refs
      backoff_sleep "${LR_ATTEMPT}" "${LR_BACKOFF_BASE}" "${LR_BACKOFF_MAX}"
      continue
      ;;
    *)
      log_error "runner: lr_invoke non-retriable (${LR_EXIT_STATUS}/${LR_ERROR_REASON:-none})"
      break
      ;;
  esac
done
_runner_cleanup_prompt

# Cycle bundle: 마지막 attempt 의 envelope/diagnostics/meta 를 cycle 루트로 승격.
if [ -n "${CB_HANDLE:-}" ]; then
  if [ -f "${LR_ENVELOPE_REF}" ]; then
    cb_capture_blob_file "${CB_HANDLE}" "envelope.json" "${LR_ENVELOPE_REF}"
  fi
  if [ -f "${LR_DIAGNOSTICS_REF}" ]; then
    cb_capture_blob_file "${CB_HANDLE}" "diagnostics.txt" "${LR_DIAGNOSTICS_REF}"
  fi
  cb_capture_blob_text "${CB_HANDLE}" "lr_meta.json" "${LR_META}"
fi

# Cycle bundle: after-lr.dirty.diff (F).
if [ -n "${CB_HANDLE:-}" ] && declare -F ws_diff_head >/dev/null 2>&1; then
  ws_diff_head "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/after-lr.dirty.diff"
fi

if [ "${LR_EXIT_STATUS}" != "ok" ]; then
  log_error "runner: lr_invoke final failure (${LR_EXIT_STATUS}/${LR_ERROR_REASON:-none}); diagnostics=${LR_DIAGNOSTICS_REF}"
  _runner_cleanup_lr_refs
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_cycle_result="error"
  [ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "lr_exhausted:${LR_EXIT_STATUS}"
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" "" "$(context_manifest_id "${MANIFEST_FILE}")" "error" \
    "lr_invoke:${LR_EXIT_STATUS}:${LR_ERROR_REASON:-none}" "${CB_HANDLE:-}" || true
  exit 1
fi

LLM_OUT="$(cat "${LR_ENVELOPE_REF}" 2>/dev/null || true)"
_runner_cleanup_lr_refs

ENVELOPE_JSON=""
if ! ENVELOPE_JSON="$(agent_output_parse "${LLM_OUT}" 2>/dev/null)"; then
  log_error "runner: agent_output_parse failed"
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_cycle_result="invalid"
  [ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "agent_output_parse"
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" "" "$(context_manifest_id "${MANIFEST_FILE}")" "invalid" \
    "" "${CB_HANDLE:-}" || true
  exit 1
fi

ENVELOPE_FILE="$(mktemp -t runner-envelope.XXXXXX)"
printf '%s' "${ENVELOPE_JSON}" >"${ENVELOPE_FILE}"

_runner_cleanup_envelope() {
  rm -f "${ENVELOPE_FILE:-}" 2>/dev/null || true
}
# Compose trap with lease release.
_runner_full_cleanup() {
  _runner_cleanup_envelope
  _runner_release_lease
}
trap '_runner_cycle_finalize_if_open; _runner_full_cleanup' EXIT

# ----- envelope validation (extended) -----
if ! agent_output_validate_extended "${ENVELOPE_FILE}" "${ROLE}" 2>/dev/null; then
  log_error "runner: envelope failed extended validation"
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_cycle_result="invalid"
  [ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "envelope_invalid_extended"
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" \
    "$(jq -r '.idempotency_key // empty' "${ENVELOPE_FILE}" 2>/dev/null)" \
    "$(jq -r '.manifest_id // empty' "${ENVELOPE_FILE}" 2>/dev/null)" \
    "invalid" "" "${CB_HANDLE:-}" || true
  exit 1
fi

# ----- revision pin re-check -----
if ! revision_pin_revalidate "${ENVELOPE_FILE}" "${TARGET_REPO}" 2>/dev/null; then
  log_error "runner: envelope revision pins are stale"
  # DEBUG (e2e): preserve envelope for postmortem when stale.
  if [ "${LLM_TEAM_DEBUG_KEEP_STALE_ENVELOPE:-0}" = "1" ]; then
    _stale_dump="${LLM_TEAM_ROOT}/workdir/${TARGET}/manifests/$(context_manifest_id "${MANIFEST_FILE}")-stale-envelope.json"
    cp "${ENVELOPE_FILE}" "${_stale_dump}" 2>/dev/null && log_error "runner: stale envelope preserved at ${_stale_dump}" || true
    revision_pin_revalidate "${ENVELOPE_FILE}" "${TARGET_REPO}" >&2 || true
  fi
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_cycle_result="stale"
  [ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "revision_pin_stale"
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" \
    "$(jq -r '.idempotency_key // empty' "${ENVELOPE_FILE}")" \
    "$(jq -r '.manifest_id // empty' "${ENVELOPE_FILE}")" \
    "stale" "" "${CB_HANDLE:-}" || true
  exit 1
fi

# ============================================================================
# caller_apply_output: state transitions + CP transitions + ledger applied row
# ============================================================================

export CYCLE_BUNDLE_REF="${CB_HANDLE:-}"
if ! caller_apply_output "${TARGET_REPO}" "${ROLE}" "${ENVELOPE_FILE}" "${MANIFEST_FILE}"; then
  log_error "runner: caller_apply_output failed"
  _runner_claim_rollback "${ROLE}" "${TARGET_REPO}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" 2>/dev/null || true
  _runner_cycle_result="error"
  [ -n "${CB_HANDLE:-}" ] && cb_promote_to_full "${CB_HANDLE}" "caller_apply_output"
  _runner_ledger_write "${TARGET}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" \
    "$(_runner_input_state_for "${ROLE}")" "$(_runner_input_state_for "${ROLE}")" \
    "${OPERATION}" \
    "$(jq -r '.idempotency_key // empty' "${ENVELOPE_FILE}")" \
    "$(jq -r '.manifest_id // empty' "${ENVELOPE_FILE}")" \
    "error" "" "${CB_HANDLE:-}" || true
  exit 1
fi

# Cycle bundle: applied.diff + post.head + post.dirty.diff (G).
if [ -n "${CB_HANDLE:-}" ] && declare -F ws_head_sha >/dev/null 2>&1; then
  _post_head="$(ws_head_sha "task-${TARGET_OBJECT_ID}")"
  printf '%s' "${_post_head}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/post.head"
  _pre_head="$(cat "${CB_HANDLE}/diff/pre.head" 2>/dev/null)"
  if [ -n "${_pre_head}" ] && [ -n "${_post_head}" ]; then
    ws_diff_range "task-${TARGET_OBJECT_ID}" "${_pre_head}" "${_post_head}" \
      | cb_capture_blob_stdin "${CB_HANDLE}" "diff/applied.diff"
  fi
  ws_diff_head "task-${TARGET_OBJECT_ID}" \
    | cb_capture_blob_stdin "${CB_HANDLE}" "diff/post.dirty.diff"
  _runner_cycle_result="ok"
fi

# Success: trap releases lease and removes envelope file.
log_info "runner: applied envelope for ${ROLE} ${TARGET_OBJECT_KIND}/${TARGET_OBJECT_ID}"
exit 0
