#!/usr/bin/env bash
# lib/ledger.sh - transition ledger JSONL writer.

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
  jq -e '
    (.transition_id | type == "string" and length > 0) and
    (.object_id | type == "string" and length > 0) and
    (.object_kind | type == "string" and length > 0) and
    (.from_state | type == "string") and
    (.to_state | type == "string" and length > 0) and
    (.operation | type == "string" and length > 0) and
    (.caller_id | type == "string" and length > 0) and
    (.idempotency_key | type == "string" and length > 0) and
    (.timestamp | type == "string" and length > 0)
  ' "${entry_file}" >/dev/null || {
    log_error "transition_ledger_write: invalid ledger entry"
    return 1
  }

  local path
  path="$(transition_ledger_path "${target}")"
  mkdir -p "$(dirname "${path}")" || return 1
  jq -c '.' "${entry_file}" >>"${path}"
}
