#!/usr/bin/env bash
# lib/lease.sh - local lease artifact implementation for Caller runners.

lease_dir() {
  local target="$1"
  printf '%s/workdir/%s/leases' "${LLM_TEAM_ROOT}" "${target}"
}

lease_claim() {
  local target="$1" object_id="$2" operation="$3" worker_id="$4" ttl_seconds="${5:-900}" pins_json="${6:-[]}"
  [ -n "${target}" ] && [ -n "${object_id}" ] && [ -n "${operation}" ] && [ -n "${worker_id}" ] || {
    log_error "lease_claim: target, object_id, operation, worker_id are required"
    return 1
  }
  case "${ttl_seconds}" in
    ''|*[!0-9]*) log_error "lease_claim: ttl_seconds must be a positive integer"; return 1 ;;
  esac
  local dir lock lease_file now expires lease_id
  dir="$(lease_dir "${target}")"
  mkdir -p "${dir}" || return 1
  lock="${dir}/${object_id}.lockd"
  lease_file="${dir}/${object_id}.json"

  if ! mkdir "${lock}" 2>/dev/null; then
    log_warn "lease_claim: active claim lock exists for ${object_id}"
    return 1
  fi

  now="$(date -u +%s)"
  if [ -f "${lease_file}" ]; then
    expires="$(jq -r '.expires_epoch // 0' "${lease_file}" 2>/dev/null || echo 0)"
    if [ "${expires}" -gt "${now}" ]; then
      log_warn "lease_claim: active lease exists for ${object_id}"
      rm -rf "${lock}" 2>/dev/null || true
      return 1
    fi
  fi

  lease_id="${operation}-${object_id}-${now}-$$"
  local expires_epoch expires_at
  expires_epoch=$((now + ttl_seconds))
  expires_at="$(date -u -r "${expires_epoch}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@${expires_epoch}" +%Y-%m-%dT%H:%M:%SZ)"
  jq -n \
    --arg lease_id "${lease_id}" \
    --arg object_id "${object_id}" \
    --arg operation "${operation}" \
    --arg worker_id "${worker_id}" \
    --arg claimed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg expires_at "${expires_at}" \
    --argjson expires_epoch "${expires_epoch}" \
    --argjson input_revision_pins "${pins_json}" \
    '{
      lease_id: $lease_id,
      object_id: $object_id,
      operation: $operation,
      worker_id: $worker_id,
      claimed_at: $claimed_at,
      expires_at: $expires_at,
      expires_epoch: $expires_epoch,
      input_revision_pins: $input_revision_pins
    }' >"${lease_file}" || {
      rm -rf "${lock}" 2>/dev/null || true
      return 1
    }
  rm -rf "${lock}" 2>/dev/null || true
  printf '%s\n' "${lease_id}"
}

lease_release() {
  local target="$1" object_id="$2" lease_id="$3"
  local lease_file
  lease_file="$(lease_dir "${target}")/${object_id}.json"
  [ -f "${lease_file}" ] || return 0
  if [ -n "${lease_id}" ]; then
    local current
    current="$(jq -r '.lease_id // ""' "${lease_file}" 2>/dev/null || echo "")"
    [ "${current}" = "${lease_id}" ] || {
      log_warn "lease_release: lease id mismatch for ${object_id}"
      return 1
    }
  fi
  rm -f "${lease_file}"
}

lease_expire_scan() {
  local target="$1"
  local dir now file expires
  dir="$(lease_dir "${target}")"
  [ -d "${dir}" ] || return 0
  now="$(date -u +%s)"
  for file in "${dir}"/*.json; do
    [ -f "${file}" ] || continue
    expires="$(jq -r '.expires_epoch // 0' "${file}" 2>/dev/null || echo 0)"
    if [ "${expires}" -le "${now}" ]; then
      printf '%s\n' "${file}"
    fi
  done
}
