#!/usr/bin/env bash
# application/recovery.sh — RGC-RECOVERY entry point (Plan Phase 8 / sub-phase8-recovery).
#
# Public:
#   recovery_scan <target> [repo]
#       Iterates expired leases (lease_expire_scan) and rolls each back per
#       RGC-RECOVERY:
#         • Planner    DECOMPOSE_IN_PROGRESS → DECOMPOSE_READY (milestone)
#         • Coder      TASK_IN_PROGRESS → TASK_READY (issue)
#         • Reviewer   TASK_REVIEW_IN_PROGRESS → TASK_REVIEW_READY (issue)
#         • Integrator REFACTOR_IN_PROGRESS → REFACTOR_READY (milestone)
#         • QA         VALIDATE_IN_PROGRESS → VALIDATE_READY (milestone)
#       PO/PM leases have no claim_transition; the lease file is removed without
#       state rollback. Each rollback records a ledger row with result=recovered.
#
#       PO_GATE / PM_GATE / CP_CLOSED / CP_STALE / CP_MERGED / DONE are NOT
#       auto-recovered (RGC-HUMAN-GATES) — those require human signals.
#
#       repo is optional: if absent, state rollback is skipped (lease file
#       removed only). This lets early-boot callers (when the issue tracker
#       repo isn't yet known) still expire leases without partial rollback.
#
# Caller boundary (AGC-CALL-BOUNDARY): port-only. lib/lease.sh, lib/ledger.sh,
# lib/ports/issue_tracker.sh.

if [ -z "${LLM_TEAM_ROOT:-}" ]; then
  LLM_TEAM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export LLM_TEAM_ROOT
fi

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# Internal: return "<object_kind>\t<from_state>\t<to_state>" for an operation,
# or empty if the operation has no claim_transition (PO/PM).
_recovery_rollback_for_operation() {
  local op="$1"
  case "${op}" in
    Decompose) printf 'milestone\tDECOMPOSE_IN_PROGRESS\tDECOMPOSE_READY' ;;
    Implement) printf 'issue\tTASK_IN_PROGRESS\tTASK_READY' ;;
    Review)    printf 'issue\tTASK_REVIEW_IN_PROGRESS\tTASK_REVIEW_READY' ;;
    Refactor)  printf 'milestone\tREFACTOR_IN_PROGRESS\tREFACTOR_READY' ;;
    Validate)  printf 'milestone\tVALIDATE_IN_PROGRESS\tVALIDATE_READY' ;;
    *)         return 1 ;;
  esac
}

# Internal: write a ledger row for a recovery action.
_recovery_ledger_write() {
  local target="$1" object_kind="$2" object_id="$3" from_state="$4" to_state="$5"
  local operation="$6" lease_id="$7" result="$8"
  local tmp
  tmp="$(mktemp -t recovery-ledger.XXXXXX)" || return 1
  jq -n \
    --arg transition_id "recovery-${result}-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}" \
    --arg object_kind "${object_kind}" \
    --arg object_id "${object_id}" \
    --arg from_state "${from_state}" \
    --arg to_state "${to_state}" \
    --arg operation "${operation}" \
    --arg caller_id "recovery_scan-$(hostname -s 2>/dev/null || echo nohost)-$$" \
    --arg idempotency_key "recovery-${lease_id:-${object_id}}-$(date -u +%s%N 2>/dev/null || date -u +%s)" \
    --arg manifest_id "" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg result "${result}" \
    '{
       transition_id: $transition_id,
       object_kind: $object_kind,
       object_id: $object_id,
       from_state: $from_state,
       to_state: $to_state,
       operation: $operation,
       caller_id: $caller_id,
       idempotency_key: $idempotency_key,
       manifest_id: $manifest_id,
       timestamp: $timestamp,
       result: $result,
       duplicate: false
     }' >"${tmp}" || { rm -f "${tmp}"; return 1; }
  transition_ledger_write "${target}" "${tmp}" || { rm -f "${tmp}"; return 1; }
  rm -f "${tmp}"
}

# recovery_scan <target> [repo]
recovery_scan() {
  local target="${1:-}" repo="${2:-}"
  if [ -z "${target}" ]; then
    log_error "recovery_scan: target is required"
    return 1
  fi
  local expired
  expired="$(lease_expire_scan "${target}" 2>/dev/null)" || expired=""
  [ -n "${expired}" ] || return 0

  local file lease_id object_id operation kind from_state to_state row
  while IFS= read -r file; do
    [ -n "${file}" ] && [ -f "${file}" ] || continue
    lease_id="$(jq -r '.lease_id // ""' "${file}" 2>/dev/null)"
    object_id="$(jq -r '.object_id // ""' "${file}" 2>/dev/null)"
    operation="$(jq -r '.operation // ""' "${file}" 2>/dev/null)"
    [ -n "${object_id}" ] || { rm -f "${file}"; continue; }

    if row="$(_recovery_rollback_for_operation "${operation}")"; then
      kind="$(printf '%s' "${row}" | awk -F'\t' '{print $1}')"
      from_state="$(printf '%s' "${row}" | awk -F'\t' '{print $2}')"
      to_state="$(printf '%s' "${row}" | awk -F'\t' '{print $3}')"
      if [ -n "${repo}" ]; then
        case "${kind}" in
          milestone)
            it_milestone_set_state "${repo}" "${object_id}" "${to_state}" "${from_state}" 2>/dev/null \
              || log_warn "recovery_scan: milestone ${object_id} ${from_state}→${to_state} failed"
            ;;
          issue)
            it_issue_set_state "${repo}" "${object_id}" "${to_state}" "${from_state}" 2>/dev/null \
              || log_warn "recovery_scan: issue ${object_id} ${from_state}→${to_state} failed"
            ;;
        esac
      fi
      _recovery_ledger_write "${target}" "${kind}" "${object_id}" \
        "${from_state}" "${to_state}" "${operation}" "${lease_id}" "recovered" \
        || log_warn "recovery_scan: ledger write failed for ${object_id}"
    else
      # PO/PM (no claim transition) — release the lease without state rollback.
      _recovery_ledger_write "${target}" "lease" "${object_id}" \
        "(expired)" "(released)" "${operation:-unknown}" "${lease_id}" "recovered" \
        || log_warn "recovery_scan: ledger write failed for ${object_id}"
    fi
    rm -f "${file}" 2>/dev/null || true
  done <<<"${expired}"
}
