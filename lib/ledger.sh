#!/usr/bin/env bash
# lib/ledger.sh - transition ledger JSONL writer.
#
# `result` 필드 enum (자유 문자열이지만 운영 통계는 아래 값을 가정한다):
#   applied   — 정상 transition.
#   recovered — recovery_scan 이 expired lease 의 상태를 정상 회수함.
#   escalated — recovery_scan 이 회수 시도 중 REST 실패 → ESCALATED 로 격상
#               (BUG-1 fix: 과거에는 silent log_warn 후 'recovered' 로 잘못 기록).
#   stale     — revision pin mismatch 등으로 신호가 무시됨.
#   duplicate — 동일 idempotency_key 로 두 번째 호출.
#   rejected  — 신호 검증 실패 (envelope schema / actor mismatch).
#   failed    — 일반 적용 실패 (rc 정보는 별도 reason 필드).

transition_ledger_path() {
  local target="$1"
  printf '%s/workdir/%s/ledger/transitions.jsonl' "${LLM_TEAM_ROOT}" "${target}"
}

transition_ledger_write() {
  local target="$1" entry_file="$2"
  if [ -z "${target}" ] || [ ! -f "${entry_file}" ]; then
    log_error "transition_ledger_write: target and entry_file are required"
    return 1
  fi
  # RGC-LEDGER required fields. lease_token must be present (string|null).
  jq -e '
    (.transition_id | type == "string" and length > 0) and
    (.target_id | type == "string" and length > 0) and
    (.object_id | type == "string" and length > 0) and
    (.object_kind | type == "string" and length > 0) and
    (.from_state | type == "string") and
    (.to_state | type == "string" and length > 0) and
    (.operation | type == "string" and length > 0) and
    (.caller_id | type == "string" and length > 0) and
    (.idempotency_key | type == "string" and length > 0) and
    (.timestamp | type == "string" and length > 0) and
    (has("lease_token") and (.lease_token | type == "string" or type == "null"))
  ' "${entry_file}" >/dev/null || {
    log_error "transition_ledger_write: invalid ledger entry"
    return 1
  }

  local path
  path="$(transition_ledger_path "${target}")"
  mkdir -p "$(dirname "${path}")" || return 1

  # Split-brain guard (#RGC-LEASE): if this entry cites a lease_token, reject
  # writes that cite a strictly older token for the same object_id. Both tokens
  # must be non-null to compare. Null lease_token (e.g., recovery, signals,
  # legacy) is exempt — only a younger non-null write is bounded.
  if [ -f "${path}" ]; then
    local incoming_obj incoming_tok max_seen
    incoming_obj="$(jq -r '.object_id // ""' "${entry_file}")"
    incoming_tok="$(jq -r '.lease_token // ""' "${entry_file}")"
    if [ -n "${incoming_obj}" ] && [ -n "${incoming_tok}" ]; then
      max_seen="$(jq -r --arg oid "${incoming_obj}" '
        select(.object_id == $oid) | .lease_token // empty
      ' "${path}" 2>/dev/null | LC_ALL=C sort | tail -1)"
      if [ -n "${max_seen}" ] && [ "${max_seen}" \> "${incoming_tok}" ]; then
        log_error "transition_ledger_write: stale lease_token '${incoming_tok}' < latest '${max_seen}' for object_id=${incoming_obj}"
        return 1
      fi
    fi
  fi

  jq -c '.' "${entry_file}" >>"${path}"
}
