#!/usr/bin/env bash
# lib/config.sh — yaml target loader and secret resolver.
#
# Public API:
#   load_target <name>       — parse targets/<name>.yaml; export TARGET_* vars.
#   resolve_secret <ref>     — print secret value from .env files; exit 1 if missing (fail-fast).
#   list_active_targets      — print names of targets/*.yaml whose enabled is true.
#
# `TARGET_*` export names are implementation adapter inputs. The yaml key to
# variable mapping should stay stable across runner and helper code.

# load_target <name>
# Reads targets/<name>.yaml via `yq` and exports the following:
#   TARGET_NAME, TARGET_GH_OWNER, TARGET_GH_REPO, TARGET_DEFAULT_BRANCH,
#   TARGET_CLONE_PATH, TARGET_INPUTS_DIR, TARGET_LABEL_PREFIX,
#   TARGET_NOTIFIER_CHANNEL, TARGET_NOTIFIER_REF,
#   TARGET_DEV_CONCURRENCY, TARGET_STALE_THRESHOLD_MIN, TARGET_ENABLED.
load_target() {
  local name="$1"
  if [ -z "${name}" ]; then
    log_error "load_target: target name is required"
    return 1
  fi
  local yaml_file="${LLM_TEAM_ROOT}/targets/${name}.yaml"
  if [ ! -f "${yaml_file}" ]; then
    log_error "load_target: yaml file not found: ${yaml_file}"
    return 1
  fi
  if ! command -v yq >/dev/null 2>&1; then
    log_error "load_target: 'yq' is required but not installed"
    return 1
  fi

  TARGET_NAME="$(yq -r '.name // ""' "${yaml_file}")"
  TARGET_GH_OWNER="$(yq -r '.github.owner // ""' "${yaml_file}")"
  TARGET_GH_REPO="$(yq -r '.github.repo // ""' "${yaml_file}")"
  TARGET_DEFAULT_BRANCH="$(yq -r '.github.default_branch // "main"' "${yaml_file}")"
  TARGET_CLONE_PATH="$(yq -r '.local.clone_path // ""' "${yaml_file}")"
  case "${TARGET_CLONE_PATH}" in
    "~"*) TARGET_CLONE_PATH="${HOME}${TARGET_CLONE_PATH#\~}" ;;
  esac
  TARGET_INPUTS_DIR="$(yq -r '.inputs_dir // ""' "${yaml_file}")"
  TARGET_LABEL_PREFIX="$(yq -r '.labels.prefix // ""' "${yaml_file}")"
  TARGET_NOTIFIER_CHANNEL="$(yq -r '.notifier.channel // "none"' "${yaml_file}")"
  TARGET_NOTIFIER_REF="$(yq -r '.notifier.webhook_or_id // ""' "${yaml_file}")"
  TARGET_DEV_CONCURRENCY="$(yq -r '.dev_concurrency // 3' "${yaml_file}")"
  TARGET_STALE_THRESHOLD_MIN="$(yq -r '.stale_threshold_minutes // 60' "${yaml_file}")"
  TARGET_ENABLED="$(yq -r '.enabled // false' "${yaml_file}")"
  # RGC-VERIFICATION commands as compact JSON array. Default `["true"]` (PASS).
  TARGET_VERIFICATION_COMMANDS_JSON="$(yq -o=json '.verification.commands // ["true"]' "${yaml_file}" \
                                          | jq -c '.')"

  export TARGET_NAME TARGET_GH_OWNER TARGET_GH_REPO TARGET_DEFAULT_BRANCH \
    TARGET_CLONE_PATH TARGET_INPUTS_DIR TARGET_LABEL_PREFIX \
    TARGET_NOTIFIER_CHANNEL TARGET_NOTIFIER_REF TARGET_DEV_CONCURRENCY \
    TARGET_STALE_THRESHOLD_MIN TARGET_ENABLED TARGET_VERIFICATION_COMMANDS_JSON
}

# resolve_secret <ref>
# Searches .env files in priority order:
#   1. ${LLM_TEAM_ROOT}/.env
#   2. ${HOME}/.llm-team/.env
# Falls back to the process environment. **On miss, exits 1 (fail-fast).**
# The fail-fast behaviour is the documented contract — callers that do not want
# to abort the process must invoke resolve_secret in a subshell, e.g.
#   webhook="$(resolve_secret REF 2>/dev/null)" || …
resolve_secret() {
  local ref="$1"
  if [ -z "${ref}" ]; then
    log_error "resolve_secret: ref key is required"
    exit 1
  fi

  local candidates=(
    "${LLM_TEAM_ROOT}/.env"
    "${HOME}/.llm-team/.env"
  )

  local value=""
  local f
  for f in "${candidates[@]}"; do
    [ -f "${f}" ] || continue
    # Source the file in an isolated subshell so we do not pollute the caller's
    # environment, then read the requested key by indirect expansion.
    local v
    v="$(
      set +u
      # shellcheck disable=SC1090
      . "${f}" >/dev/null 2>&1 || true
      printf '%s' "${!ref-}"
    )"
    if [ -n "${v}" ]; then
      value="${v}"
    fi
  done

  if [ -z "${value}" ]; then
    local env_val
    env_val="$(printenv "${ref}" 2>/dev/null || true)"
    if [ -n "${env_val}" ]; then
      value="${env_val}"
    fi
  fi

  if [ -z "${value}" ]; then
    log_error "resolve_secret: secret '${ref}' not found in .env, ~/.llm-team/.env, or process environment"
    exit 1
  fi

  printf '%s' "${value}"
}

# list_active_targets
# Print (one per line, stdout) the `name` of every targets/*.yaml whose
# `enabled` field is true.
list_active_targets() {
  local dir="${LLM_TEAM_ROOT}/targets"
  [ -d "${dir}" ] || return 0
  if ! command -v yq >/dev/null 2>&1; then
    log_error "list_active_targets: 'yq' is required but not installed"
    return 1
  fi
  local f enabled name
  for f in "${dir}"/*.yaml; do
    [ -f "${f}" ] || continue
    enabled="$(yq -r '.enabled // false' "${f}" 2>/dev/null || echo "false")"
    if [ "${enabled}" = "true" ]; then
      name="$(yq -r '.name // ""' "${f}")"
      [ -n "${name}" ] || name="$(basename "${f}" .yaml)"
      printf '%s\n' "${name}"
    fi
  done
}
