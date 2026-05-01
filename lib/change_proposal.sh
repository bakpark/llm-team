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
