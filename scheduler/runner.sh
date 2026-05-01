#!/usr/bin/env bash
# Contract-era Caller runner.
#
# Usage:
#   scheduler/runner.sh <role> <target> [--dry-run]
#
# This runner owns operational work. Agents only receive a Context Manifest and
# return content-only output envelopes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <role> <target> [--dry-run]

role must be one of: po | pm | planner | coder | reviewer | integrator | qa
EOF
  exit 64
}

ROLE_RAW="${1:-}"
TARGET="${2:-}"
DRY_RUN=0
shift $(( $# >= 2 ? 2 : $# ))
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "${ROLE_RAW}" ] && [ -n "${TARGET}" ] || usage
ROLE="$(role_normalize "${ROLE_RAW}")" || usage
OPERATION="$(role_operation "${ROLE}")"
PROMPT_FILE="$(role_prompt_path "${ROLE}")"

load_target "${TARGET}"
if [ "${TARGET_ENABLED}" != "true" ]; then
  log_info "runner: target '${TARGET}' is disabled; exiting"
  exit 0
fi

if [ "${DRY_RUN}" -eq 0 ]; then
  log_init "${ROLE}" "${TARGET}"
fi

log_info "runner: role=${ROLE} operation=${OPERATION} target=${TARGET} dry_run=${DRY_RUN}"

if [ "$(control_state_get)" = "PAUSED" ]; then
  log_info "runner: control state is PAUSED; no lease will be claimed"
  exit 0
fi

run_stale_recovery "${TARGET}" || log_warn "runner: stale recovery returned non-zero"

if [ ! -f "${PROMPT_FILE}" ]; then
  log_error "runner: prompt file missing: ${PROMPT_FILE}"
  exit 1
fi

# The concrete GitHub queue adapter is intentionally small at this stage:
# it verifies the role wiring and creates a manifest scaffold for the next
# adapter step. No Agent is invoked without a real ready object and revision pin.
TARGET_OBJECT_KIND="${LLM_TEAM_RUN_OBJECT_KIND:-system}"
TARGET_OBJECT_ID="${LLM_TEAM_RUN_OBJECT_ID:-dry-run}"
TARGET_REVISION_PIN="${LLM_TEAM_RUN_REVISION_PIN:-local}"

MANIFEST_FILE="$(context_manifest_create "${TARGET}" "${OPERATION}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}")"
context_manifest_add_entry "${MANIFEST_FILE}" "${TARGET_OBJECT_KIND}" "${TARGET_OBJECT_ID}" "metadata" "${TARGET_REVISION_PIN}" true "runner scaffold target"
context_manifest_validate "${MANIFEST_FILE}"

if [ "${DRY_RUN}" -eq 1 ]; then
  log_info "runner: dry-run manifest=${MANIFEST_FILE}"
  log_info "runner: prompt=${PROMPT_FILE}"
  exit 0
fi

log_info "runner: no ready-object adapter is enabled yet; scaffold completed without Agent invocation"
exit 0
