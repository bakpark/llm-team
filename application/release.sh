#!/usr/bin/env bash
# application/release.sh — Release publishing helpers (Plan Phase 4 / sub-phase4-release).
#
# Functions (port-only; AGC-CALL-BOUNDARY):
#   release_compute_tag <candidate>            → echo vX.Y.Z; nonzero on invalid
#   release_extract_notes <envelope_path>      → echo release_notes_md or summary
#   release_publish_from_milestone <repo> <ms_num> <envelope_path>
#       — combines compute_tag + extract_notes + it_release_create.
#         tag candidate sources (priority):
#           1. envelope.artifacts.release_tag
#           2. envelope.artifacts.tag
#           3. first semver-looking token in envelope.summary
#         target sha sources (priority):
#           1. envelope.artifacts.release_target
#           2. ws_get_branch_head of integration branch (envelope.artifacts.integration_branch.name)
#           3. literal "main"
#
# Contract anchors: SOC-OPERATIONS (Validate), I6 (it_release_create tag format
# validated by caller — vX.Y.Z), AGC-INVALID (no operational side-effect text in
# envelope; release publication is a Caller action).

if [ -z "${LLM_TEAM_ROOT:-}" ]; then
  LLM_TEAM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export LLM_TEAM_ROOT
fi

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# release_compute_tag <candidate> → echo vX.Y.Z (with leading v); nonzero if invalid.
release_compute_tag() {
  local candidate="${1:-}"
  if [ -z "${candidate}" ]; then
    log_error "release_compute_tag: candidate is empty"
    return 1
  fi
  # Accept "vX.Y.Z" or "X.Y.Z" with optional pre-release suffix.
  local re='^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'
  if [[ ! "${candidate}" =~ ${re} ]]; then
    log_error "release_compute_tag: '${candidate}' does not match semver"
    return 1
  fi
  case "${candidate}" in
    v*) printf '%s\n' "${candidate}" ;;
    *)  printf 'v%s\n' "${candidate}" ;;
  esac
}

# release_extract_notes <envelope_path> → echo release notes string.
release_extract_notes() {
  local env_path="${1:-}"
  if [ -z "${env_path}" ] || [ ! -f "${env_path}" ]; then
    log_error "release_extract_notes: envelope file not found: ${env_path}"
    return 1
  fi
  local notes
  notes="$(jq -r '.artifacts.release_notes_md // .release_notes_md // empty' "${env_path}" 2>/dev/null)" || notes=""
  if [ -z "${notes}" ] || [ "${notes}" = "null" ]; then
    notes="$(jq -r '.summary // empty' "${env_path}" 2>/dev/null)" || notes=""
  fi
  printf '%s' "${notes}"
}

# Internal: pick a tag candidate from the envelope.
_release_pick_tag_candidate() {
  local env_path="$1"
  local cand
  cand="$(jq -r '.artifacts.release_tag // .artifacts.tag // empty' "${env_path}" 2>/dev/null)" || cand=""
  if [ -n "${cand}" ] && [ "${cand}" != "null" ]; then
    printf '%s' "${cand}"
    return 0
  fi
  # Scan summary for first semver-looking token.
  local summary
  summary="$(jq -r '.summary // empty' "${env_path}" 2>/dev/null)" || summary=""
  if [ -n "${summary}" ]; then
    local token
    # shellcheck disable=SC2013
    for token in ${summary}; do
      if [[ "${token}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
        printf '%s' "${token}"
        return 0
      fi
    done
  fi
  return 1
}

# Internal: pick a release target (sha or branch).
_release_pick_target() {
  local env_path="$1" target_name="$2"
  local explicit
  explicit="$(jq -r '.artifacts.release_target // empty' "${env_path}" 2>/dev/null)" || explicit=""
  if [ -n "${explicit}" ] && [ "${explicit}" != "null" ]; then
    printf '%s' "${explicit}"
    return 0
  fi
  local branch
  branch="$(jq -r '.artifacts.integration_branch.name // empty' "${env_path}" 2>/dev/null)" || branch=""
  if [ -n "${branch}" ] && [ "${branch}" != "null" ] && declare -F ws_get_branch_head >/dev/null 2>&1; then
    local sha=""
    sha="$(ws_get_branch_head "${target_name}" "${branch}" 2>/dev/null)" || sha=""
    if [ -n "${sha}" ]; then
      printf '%s' "${sha}"
      return 0
    fi
    printf '%s' "${branch}"
    return 0
  fi
  printf 'main'
}

# release_publish_from_milestone <repo> <ms_num> <envelope_path>
release_publish_from_milestone() {
  local repo="${1:-}" ms_num="${2:-}" env_path="${3:-}"
  if [ -z "${repo}" ] || [ -z "${ms_num}" ] || [ -z "${env_path}" ]; then
    log_error "release_publish_from_milestone: repo, ms_num, env_path required"
    return 1
  fi
  if [ ! -f "${env_path}" ]; then
    log_error "release_publish_from_milestone: envelope not found: ${env_path}"
    return 1
  fi
  local cand
  if ! cand="$(_release_pick_tag_candidate "${env_path}")"; then
    log_error "release_publish_from_milestone: no release tag candidate in envelope"
    return 1
  fi
  local tag
  if ! tag="$(release_compute_tag "${cand}")"; then
    return 1
  fi
  local target_name="${LLM_TEAM_TARGET_NAME:-${TARGET_NAME:-}}"
  local target
  target="$(_release_pick_target "${env_path}" "${target_name}")"
  local notes
  notes="$(release_extract_notes "${env_path}")"
  local title
  title="$(jq -r '.artifacts.release_title // empty' "${env_path}" 2>/dev/null)" || title=""
  if [ -z "${title}" ] || [ "${title}" = "null" ]; then
    title="Milestone #${ms_num} ${tag}"
  fi
  it_release_create "${repo}" "${tag}" \
    --target "${target}" \
    --title "${title}" \
    --notes "${notes}" \
    || {
      log_error "release_publish_from_milestone: it_release_create failed (tag=${tag})"
      return 1
    }
  log_info "release_publish_from_milestone: published ${tag} (target=${target}, ms=${ms_num})"
}
