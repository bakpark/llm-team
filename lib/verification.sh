#!/usr/bin/env bash
# lib/verification.sh - Caller-owned deterministic verification helpers.

verification_run_create() {
  local target="$1" target_id="$2" target_revision="$3"
  local dir run_id path
  [ -n "${target}" ] && [ -n "${target_id}" ] && [ -n "${target_revision}" ] || {
    log_error "verification_run_create: target, target_id, target_revision are required"
    return 1
  }
  dir="${LLM_TEAM_ROOT}/workdir/${target}/verification"
  mkdir -p "${dir}" || return 1
  run_id="verification-${target_id}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  path="${dir}/${run_id}.json"
  jq -n \
    --arg verification_run_id "${run_id}" \
    --arg target_id "${target_id}" \
    --arg target_revision "${target_revision}" \
    --arg environment_fingerprint "$(uname -a)" \
    --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      verification_run_id: $verification_run_id,
      target_id: $target_id,
      target_revision: $target_revision,
      commands_or_checks: [],
      environment_fingerprint: $environment_fingerprint,
      started_at: $started_at,
      finished_at: null,
      result: "NOT_RUN",
      log_ref: null
    }' >"${path}"
  printf '%s\n' "${path}"
}

verification_log_store() {
  local run_file="$1" result="$2" log_ref="$3"
  [ -f "${run_file}" ] || {
    log_error "verification_log_store: run file not found: ${run_file}"
    return 1
  }
  local tmp
  tmp="${run_file}.tmp.$$"
  jq \
    --arg result "${result}" \
    --arg log_ref "${log_ref}" \
    --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.result = $result | .log_ref = $log_ref | .finished_at = $finished_at' \
    "${run_file}" >"${tmp}" && mv "${tmp}" "${run_file}"
}
