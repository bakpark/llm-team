#!/usr/bin/env bash
# scripts/bootstrap-labels.sh — create or refresh the framework's 12 GitHub
# labels for a target.
#
# Usage:
#   scripts/bootstrap-labels.sh <target> [--dry-run]
#
# Behaviour:
#   • Reads `labels.prefix` from targets/<target>.yaml (or, if missing, falls
#     back to tests/lib/fixtures/<target>.yaml; otherwise empty prefix).
#   • Creates / updates each label via `gh label create --force` with the
#     mandated colour mapping (sub-common-lib §B):
#         po:*                  → #8957e5  (보라)
#         pm:*                  → #0e8a16  (파랑 per spec)
#         dev:*                 → #d4c5f9  (노랑 per spec)
#         qa:*                  → #1d76db  (청록 per spec)
#         needs-human-review:*  → #d73a4a  (빨강)
#         needs-*               → #0e8a16  (초록)
#   • `--dry-run` prints the labels and colours WITHOUT calling the GitHub API
#     (useful for smoke testing without an authenticated gh CLI or yq).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT
# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <target> [--dry-run]

Create or update the 12 framework labels for the given target.
With --dry-run, prints the labels and colours without calling GitHub.
EOF
}

DRY_RUN=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

if [ -z "${TARGET}" ]; then
  usage
  exit 2
fi

# Resolve label_prefix and (for non-dry-run) repo. We deliberately tolerate a
# missing yq when --dry-run is set so the smoke test remains executable on a
# bare developer machine.
LABEL_PREFIX=""
REPO=""

YAML_REAL="${LLM_TEAM_ROOT}/targets/${TARGET}.yaml"
YAML_FIXTURE="${LLM_TEAM_ROOT}/tests/lib/fixtures/${TARGET}.yaml"

YAML=""
if [ -f "${YAML_REAL}" ]; then
  YAML="${YAML_REAL}"
elif [ -f "${YAML_FIXTURE}" ]; then
  YAML="${YAML_FIXTURE}"
  log_warn "bootstrap-labels: targets/${TARGET}.yaml missing; using fixture ${YAML_FIXTURE}"
else
  if [ "${DRY_RUN}" -eq 0 ]; then
    log_error "bootstrap-labels: no yaml found for target '${TARGET}'"
    exit 1
  fi
  log_warn "bootstrap-labels: no yaml available for '${TARGET}'; defaulting prefix to empty"
fi

if [ -n "${YAML}" ]; then
  if command -v yq >/dev/null 2>&1; then
    LABEL_PREFIX="$(yq -r '.labels.prefix // ""' "${YAML}")"
  elif [ "${DRY_RUN}" -eq 1 ]; then
    # Heuristic prefix extraction without yq: read `labels.prefix:` line.
    LABEL_PREFIX="$(awk '
      /^labels:[[:space:]]*$/        { in_labels=1; next }
      /^[^[:space:]]/                 { in_labels=0 }
      in_labels && /^[[:space:]]+prefix:/ {
        sub(/^[[:space:]]+prefix:[[:space:]]*/, "")
        gsub(/^"|"$/, "")
        gsub(/^'\''|'\''$/, "")
        print
        exit
      }
    ' "${YAML}")"
  else
    log_error "bootstrap-labels: 'yq' is required for non-dry-run runs"
    exit 1
  fi
fi

if [ "${DRY_RUN}" -eq 0 ]; then
  load_target "${TARGET}" || exit 1
  REPO="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  if [ -z "${TARGET_GH_OWNER}" ] || [ -z "${TARGET_GH_REPO}" ]; then
    log_error "bootstrap-labels: github.owner / github.repo missing in ${YAML}"
    exit 1
  fi
fi

# Color and description tables.
_color_for() {
  case "$1" in
    po:*)                   printf '8957e5' ;;
    pm:*)                   printf '0e8a16' ;;
    dev:*)                  printf 'd4c5f9' ;;
    qa:*)                   printf '1d76db' ;;
    needs-human-review:*)   printf 'd73a4a' ;;
    needs-*)                printf '0e8a16' ;;
    *)                      printf 'cccccc' ;;
  esac
}

_desc_for() {
  case "$1" in
    po:in-progress)                printf 'PO Agent is creating Milestone' ;;
    needs-human-review:milestone)  printf 'PO output ready; awaiting human review (Notifier triggered)' ;;
    needs-scenarios)               printf 'Human-approved Milestone; PM pickup queue' ;;
    pm:in-progress)                printf 'PM Agent decomposing scenarios' ;;
    pm:done)                       printf 'PM finished; all Issues created' ;;
    needs-human-review:scenario)   printf 'Issue (scenario) awaiting human review (Notifier triggered)' ;;
    needs-dev)                     printf 'Human-approved scenario; DEV pickup queue' ;;
    dev:in-progress)               printf 'DEV Agent implementing' ;;
    needs-qa)                      printf 'PR pushed; QA pickup queue' ;;
    qa:in-progress)                printf 'QA Agent verifying' ;;
    qa:changes-requested)          printf 'QA failed (1st attempt); DEV re-pickup queue' ;;
    needs-human-review:dev-failure) printf 'QA 2nd failure or DEV git failure; human escalation (Notifier triggered)' ;;
    *)                             printf '' ;;
  esac
}

ALL_LABELS=("${ALL_MILESTONE_LABELS[@]}" "${ALL_ISSUE_LABELS[@]}")

CREATED=0
UPDATED=0
FAILED=0
PRINTED=0

for raw_label in "${ALL_LABELS[@]}"; do
  full_label="$(label_with_prefix "${LABEL_PREFIX}" "${raw_label}")"
  color="$(_color_for "${raw_label}")"
  desc="$(_desc_for "${raw_label}")"

  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '%-40s color=#%s desc=%s\n' "${full_label}" "${color}" "${desc}"
    PRINTED=$((PRINTED+1))
  else
    if gh_with_retry gh label create "${full_label}" --repo "${REPO}" \
        --color "${color}" --description "${desc}" --force >/dev/null; then
      CREATED=$((CREATED+1))
    else
      FAILED=$((FAILED+1))
      log_error "bootstrap-labels: failed for label '${full_label}'"
    fi
  fi
done

if [ "${DRY_RUN}" -eq 1 ]; then
  printf '\nDry run: %d labels would be created/updated for target=%s prefix=%q\n' \
    "${PRINTED}" "${TARGET}" "${LABEL_PREFIX}"
else
  printf '\nDone: %d labels created/updated, %d failed (target=%s repo=%s)\n' \
    "${CREATED}" "${FAILED}" "${TARGET}" "${REPO}"
  if [ "${FAILED}" -gt 0 ]; then
    exit 1
  fi
fi
