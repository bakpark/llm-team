#!/usr/bin/env bash
# Create/update GitHub labels used by the contract-state GitHub adapter.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <target> [--dry-run]
EOF
  exit 64
}

TARGET=""
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "${TARGET}" ] || usage

load_target "${TARGET}"
REPO="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
PREFIX="${TARGET_LABEL_PREFIX}"

color_for_label() {
  case "$1" in
    task:pending) printf 'd0d7de' ;;
    task:ready) printf '0e8a16' ;;
    task:in-progress) printf '1d76db' ;;
    task:review-ready) printf 'fbca04' ;;
    task:review-in-progress) printf 'c5def5' ;;
    task:integrated) printf '5319e7' ;;
    task:rejected) printf 'b60205' ;;
    task:escalated) printf 'd73a4a' ;;
    cp:*) printf '6f42c1' ;;
    feature-request) printf 'fbca04' ;;
    feature-request:accepted) printf '0e8a16' ;;
    feature-request:rejected) printf 'b60205' ;;
    human-gate:*) printf '8957e5' ;;
    paused) printf 'cccccc' ;;
    *) printf 'cccccc' ;;
  esac
}

ALL_BOOTSTRAP_LABELS=(
  "${ALL_TASK_LABELS[@]}"
  "${ALL_CP_LABELS[@]}"
  "${ALL_OPERATIONAL_LABELS[@]}"
)

count=0
for raw_label in "${ALL_BOOTSTRAP_LABELS[@]}"; do
  label="$(label_with_prefix "${PREFIX}" "${raw_label}")"
  color="$(color_for_label "${raw_label}")"
  desc="llm-team contract adapter label: ${raw_label}"
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '%-36s color=#%s desc=%s\n' "${label}" "${color}" "${desc}"
  else
    gh_with_retry gh label create "${label}" --repo "${REPO}" --color "${color}" --description "${desc}" --force >/dev/null
  fi
  count=$((count + 1))
done

if [ "${DRY_RUN}" -eq 1 ]; then
  printf '\nDry run: %d contract labels would be created/updated for target=%s\n' "${count}" "${TARGET}"
else
  printf 'Done: %d contract labels created/updated for target=%s repo=%s\n' "${count}" "${TARGET}" "${REPO}"
fi
