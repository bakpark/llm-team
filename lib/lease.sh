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
  # P1-17 / RGC-SIGNALS: a `stop` signal at system scope (or a `pause` signal)
  # blocks NEW lease claims. Defense in depth — runner.sh also checks at the
  # top, but enforcing here means any caller path goes through one gate.
  if declare -F control_state_blocks_new_leases >/dev/null 2>&1 \
     && control_state_blocks_new_leases; then
    log_warn "lease_claim: control state forbids new lease claims (object=${object_id})"
    return 1
  fi
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

  # Per RGC-LEASE: lease_token must be unique per lease and monotonically
  # increasing per object_id. We persist a per-object sequence file and
  # combine it with target + object_id to produce a deterministic, sortable
  # token string.
  local seq_file token_seq lease_token
  seq_file="${dir}/${object_id}.seq"
  if [ -f "${seq_file}" ]; then
    token_seq="$(cat "${seq_file}" 2>/dev/null || echo 0)"
    case "${token_seq}" in
      ''|*[!0-9]*) token_seq=0 ;;
    esac
  else
    token_seq=0
  fi
  token_seq=$((token_seq + 1))
  printf '%s\n' "${token_seq}" >"${seq_file}.tmp" \
    && mv "${seq_file}.tmp" "${seq_file}" \
    || { rm -rf "${lock}" 2>/dev/null || true; return 1; }
  # Zero-pad so lexicographic compare matches numeric compare up to 1e10 leases.
  lease_token="$(printf '%s-lt-%010d' "${object_id}" "${token_seq}")"

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
    --arg lease_token "${lease_token}" \
    '{
      lease_id: $lease_id,
      object_id: $object_id,
      operation: $operation,
      worker_id: $worker_id,
      claimed_at: $claimed_at,
      expires_at: $expires_at,
      expires_epoch: $expires_epoch,
      input_revision_pins: $input_revision_pins,
      lease_token: $lease_token
    }' >"${lease_file}" || {
      rm -rf "${lock}" 2>/dev/null || true
      return 1
    }
  rm -rf "${lock}" 2>/dev/null || true
  printf '%s\n' "${lease_id}"
}

# lease_get_token <target> <object_id>
# Echoes the lease_token of the current active lease for object_id, or empty
# (rc=1) if no active lease exists. Best-effort — does not check expiry, since
# Caller writes inside an in-flight lease should still cite even on the edge of
# expiry (split-brain detection is the ledger's concern).
lease_get_token() {
  local target="$1" object_id="$2"
  if [ -z "${target}" ] || [ -z "${object_id}" ]; then
    return 1
  fi
  local lease_file
  lease_file="$(lease_dir "${target}")/${object_id}.json"
  [ -f "${lease_file}" ] || return 1
  local token
  token="$(jq -r '.lease_token // ""' "${lease_file}" 2>/dev/null || echo "")"
  [ -n "${token}" ] || return 1
  printf '%s\n' "${token}"
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
