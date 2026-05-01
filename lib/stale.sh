#!/usr/bin/env bash
# lib/stale.sh - contract-era recovery entry points.
#
# run_stale_recovery delegates to application/recovery.sh.recovery_scan when
# available (RGC-RECOVERY: full rollback per role table). Falls back to the
# legacy lease-expiry-only behaviour when application/recovery.sh hasn't been
# sourced.

recover_stale_leases() {
  local target="$1"
  lease_expire_scan "${target}"
}

run_stale_recovery() {
  local target="$1" repo="${2:-}"
  if [ -z "${repo}" ] && [ -n "${TARGET_GH_OWNER:-}" ] && [ -n "${TARGET_GH_REPO:-}" ]; then
    repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  fi
  if declare -F recovery_scan >/dev/null 2>&1; then
    recovery_scan "${target}" "${repo}" \
      || log_warn "run_stale_recovery: recovery_scan returned non-zero"
  else
    recover_stale_leases "${target}" \
      || log_warn "run_stale_recovery: recover_stale_leases returned non-zero"
  fi
}
