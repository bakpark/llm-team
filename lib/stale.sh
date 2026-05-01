#!/usr/bin/env bash
# lib/stale.sh - contract-era recovery entry points.

recover_stale_leases() {
  local target="$1"
  lease_expire_scan "${target}"
}

run_stale_recovery() {
  local target="$1"
  recover_stale_leases "${target}" || log_warn "run_stale_recovery: recover_stale_leases returned non-zero"
}
