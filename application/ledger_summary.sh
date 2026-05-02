#!/usr/bin/env bash
# application/ledger_summary.sh
#
# Read-only aggregation helpers over the per-target transition ledger.
# Used by `llm-team dashboard` (and optionally other read paths) to avoid
# duplicating group-by / window logic in multiple scripts.
#
# Public:
#   ledger_pipeline_summary <target>            → JSON array (one row per
#       (object_kind, object_id) group) with the latest entry's
#       {object_kind, object_id, from_state, to_state, result, timestamp,
#        operation, manifest_id}.
#   ledger_caller_window <target> <since_iso>   → JSON object
#       {applied, invalid, duplicate, error, total} counted across rows whose
#       timestamp >= since_iso.
#   ledger_recent <target> <limit>              → last N raw JSONL entries
#       (newest last, preserving file order).
#
# All functions return 0 with an empty/zeroed result when the ledger does not
# exist. Malformed lines are skipped silently (jq -c parse errors swallowed).

# Path helper is provided by lib/ledger.sh::transition_ledger_path.

# Internal: stream valid JSON objects from the ledger (one per line).
_ledger_summary_stream() {
  local target="$1" path
  path="$(transition_ledger_path "${target}")"
  [ -f "${path}" ] || return 0
  # `jq -c` per-line tolerates partial garbage by erroring; instead read via
  # `jq --slurpfile` style would buffer everything. Use a per-line jq with
  # `2>/dev/null` so a single bad row does not abort the stream.
  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    printf '%s\n' "${line}" | jq -c '.' 2>/dev/null
  done <"${path}"
}

ledger_pipeline_summary() {
  local target="$1"
  if [ -z "${target}" ]; then
    log_error "ledger_pipeline_summary: target is required"
    return 1
  fi
  local stream
  stream="$(_ledger_summary_stream "${target}")"
  if [ -z "${stream}" ]; then
    printf '[]'
    return 0
  fi
  printf '%s\n' "${stream}" | jq -s '
    map(select(
      (.object_kind | type == "string" and length > 0) and
      (.object_id   | type == "string" and length > 0) and
      (.timestamp   | type == "string" and length > 0)
    ))
    | group_by([.object_kind, .object_id])
    | map(
        sort_by(.timestamp) | last |
        {
          object_kind, object_id,
          from_state: (.from_state // ""),
          to_state:   (.to_state   // ""),
          result:     (.result     // "applied"),
          operation:  (.operation  // ""),
          manifest_id:(.manifest_id // ""),
          timestamp:  .timestamp
        }
      )
    | sort_by(.timestamp) | reverse
  '
}

ledger_caller_window() {
  local target="$1" since="$2"
  if [ -z "${target}" ] || [ -z "${since}" ]; then
    log_error "ledger_caller_window: target and since_iso are required"
    return 1
  fi
  local stream
  stream="$(_ledger_summary_stream "${target}")"
  if [ -z "${stream}" ]; then
    printf '{"applied":0,"invalid":0,"duplicate":0,"error":0,"total":0}'
    return 0
  fi
  printf '%s\n' "${stream}" | jq -s --arg since "${since}" '
    map(select((.timestamp // "") >= $since))
    | {
        applied:   map(select((.result // "applied") == "applied"))   | length,
        invalid:   map(select((.result // "")        == "invalid"))   | length,
        duplicate: map(select((.result // "")        == "duplicate")) | length,
        error:     map(select((.result // "")        == "error"))     | length,
        total:     length
      }
  '
}

ledger_recent() {
  local target="$1" limit="${2:-20}"
  if [ -z "${target}" ]; then
    log_error "ledger_recent: target is required"
    return 1
  fi
  case "${limit}" in
    ''|*[!0-9]*) log_error "ledger_recent: limit must be a non-negative integer"; return 1 ;;
  esac
  local path
  path="$(transition_ledger_path "${target}")"
  [ -f "${path}" ] || return 0
  tail -n "${limit}" "${path}"
}
