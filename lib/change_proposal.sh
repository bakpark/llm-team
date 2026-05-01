#!/usr/bin/env bash
# lib/change_proposal.sh - local Change Proposal artifact helpers.

change_proposal_dir() {
  local target="$1"
  printf '%s/workdir/%s/change-proposals' "${LLM_TEAM_ROOT}" "${target}"
}

change_proposal_create() {
  local target="$1" cp_kind="$2" source_role="$3" operation="$4" target_id="$5" artifact_ref="$6"
  [ -n "${target}" ] && [ -n "${cp_kind}" ] && [ -n "${source_role}" ] && [ -n "${operation}" ] && [ -n "${target_id}" ] || {
    log_error "change_proposal_create: missing required argument"
    return 1
  }
  local dir cp_id path
  dir="$(change_proposal_dir "${target}")"
  mkdir -p "${dir}" || return 1
  cp_id="cp-${cp_kind}-${target_id}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  path="${dir}/${cp_id}.json"
  jq -n \
    --arg change_proposal_id "${cp_id}" \
    --arg cp_kind "${cp_kind}" \
    --arg source_role "${source_role}" \
    --arg operation "${operation}" \
    --arg target_id "${target_id}" \
    --arg state "CP_DRAFT" \
    --arg artifact_ref "${artifact_ref}" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      change_proposal_id: $change_proposal_id,
      cp_kind: $cp_kind,
      source_role: $source_role,
      operation: $operation,
      target_id: $target_id,
      state: $state,
      artifact_ref: $artifact_ref,
      created_at: $created_at
    }' >"${path}"
  printf '%s\n' "${path}"
}

# change_proposal_load <path>  → echo JSON body (validated via jq)
change_proposal_load() {
  local path="$1"
  if [ -z "${path}" ]; then
    log_error "change_proposal_load: path is required"
    return 1
  fi
  if [ ! -f "${path}" ]; then
    log_error "change_proposal_load: file not found: ${path}"
    return 1
  fi
  jq '.' "${path}"
}

# change_proposal_get_state <path>  → echo current state (e.g. CP_DRAFT)
# Returns non-zero with empty stdout if state field absent or file missing.
change_proposal_get_state() {
  local path="$1"
  if [ -z "${path}" ]; then
    log_error "change_proposal_get_state: path is required"
    return 1
  fi
  if [ ! -f "${path}" ]; then
    log_error "change_proposal_get_state: file not found: ${path}"
    return 1
  fi
  local state
  state="$(jq -r '.state // empty' "${path}")" || return 1
  if [ -z "${state}" ]; then
    return 1
  fi
  printf '%s\n' "${state}"
}

# change_proposal_set_state <path> <new_state> [<old_state>]
# • Validates new_state via lib/state.sh state_is_valid (CP whitelist).
# • Atomic write (mktemp + mv).
# • If <old_state> is provided, current state must match it (rejects when not).
#   Idempotent: when current state already equals new_state, returns 0 no-op
#   even if old_state mismatches (the transition is already complete).
change_proposal_set_state() {
  local path="$1" new_state="$2" old_state="${3:-}"
  if [ -z "${path}" ] || [ -z "${new_state}" ]; then
    log_error "change_proposal_set_state: path and new_state are required"
    return 1
  fi
  if [ ! -f "${path}" ]; then
    log_error "change_proposal_set_state: file not found: ${path}"
    return 1
  fi
  state_is_valid change_proposal "${new_state}" || {
    log_error "change_proposal_set_state: invalid CP state '${new_state}'"
    return 1
  }
  if [ -n "${old_state}" ]; then
    state_is_valid change_proposal "${old_state}" || {
      log_error "change_proposal_set_state: invalid old CP state '${old_state}'"
      return 1
    }
  fi
  local current
  current="$(jq -r '.state // empty' "${path}")" || {
    log_error "change_proposal_set_state: cannot read state from ${path}"
    return 1
  }
  # Idempotent: same state → no-op (allowed even if old_state mismatches).
  if [ "${current}" = "${new_state}" ]; then
    return 0
  fi
  if [ -n "${old_state}" ] && [ "${current}" != "${old_state}" ]; then
    log_error "change_proposal_set_state: state mismatch — current='${current}', expected='${old_state}'"
    return 1
  fi
  local tmp
  tmp="$(mktemp "${path}.tmp.XXXXXX")" || {
    log_error "change_proposal_set_state: mktemp failed"
    return 1
  }
  if jq --arg s "${new_state}" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.state = $s | .updated_at = $ts' \
        "${path}" >"${tmp}"; then
    mv "${tmp}" "${path}"
  else
    rm -f "${tmp}"
    log_error "change_proposal_set_state: jq update failed for ${path}"
    return 1
  fi
}

# change_proposal_set_pr_link <path> <pr_num>
# Sets .pr_number on the CP artifact. Atomic write. Idempotent.
change_proposal_set_pr_link() {
  local path="$1" pr_num="$2"
  if [ -z "${path}" ] || [ -z "${pr_num}" ]; then
    log_error "change_proposal_set_pr_link: path and pr_num are required"
    return 1
  fi
  if [ ! -f "${path}" ]; then
    log_error "change_proposal_set_pr_link: file not found: ${path}"
    return 1
  fi
  local tmp
  tmp="$(mktemp "${path}.tmp.XXXXXX")" || {
    log_error "change_proposal_set_pr_link: mktemp failed"
    return 1
  }
  if jq --arg pr "${pr_num}" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.pr_number = ($pr | tonumber? // $pr) | .updated_at = $ts' \
        "${path}" >"${tmp}"; then
    mv "${tmp}" "${path}"
  else
    rm -f "${tmp}"
    log_error "change_proposal_set_pr_link: jq update failed for ${path}"
    return 1
  fi
}
