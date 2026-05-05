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
#   TARGET_DEV_CONCURRENCY, TARGET_STALE_THRESHOLD_MIN, TARGET_ENABLED,
#   TARGET_VERIFICATION_COMMANDS_JSON,
#   # TCC-IDENTITY (P1-10):
#   TARGET_ID, TARGET_PERSISTENT_STORE_REF,
#   # TCC-LEASE-CONFIG (P1-9):
#   TARGET_LEASE_TTL_DEFAULT, TARGET_LEASE_TTL_BY_ROLE_JSON,
#   # TCC-AGENT-RUNNER-MAP (P1-9):
#   TARGET_AGENT_RUNNER_DEFAULT, TARGET_AGENT_RUNNER_BY_ROLE_JSON.
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
  # H4: dev_concurrency 는 향후 cycle 내 fan-out parallelism 용으로 예약된
  # 필드다. 현재 dispatcher 는 cycle 당 target 하나당 task 하나를 처리한다 —
  # 실제 병렬도는 (role 데몬 수 × target 수) 다. 값이 1 보다 크면 노이즈를
  # 내지 않기 위해 INFO 만 한 번 남긴다.
  TARGET_DEV_CONCURRENCY="$(yq -r '.dev_concurrency // 3' "${yaml_file}")"
  if [ "${TARGET_DEV_CONCURRENCY}" -gt 1 ] 2>/dev/null \
     && [ "${LLM_TEAM_DEV_CONCURRENCY_NOTICE:-0}" = "0" ]; then
    log_info "config: dev_concurrency=${TARGET_DEV_CONCURRENCY} 는 아직 dispatcher 에 반영되지 않습니다 (현재 병렬도: role × target)"
    export LLM_TEAM_DEV_CONCURRENCY_NOTICE=1
  fi
  TARGET_STALE_THRESHOLD_MIN="$(yq -r '.stale_threshold_minutes // 60' "${yaml_file}")"
  TARGET_ENABLED="$(yq -r '.enabled // false' "${yaml_file}")"
  # RGC-VERIFICATION commands as compact JSON array. Default `["true"]` (PASS).
  TARGET_VERIFICATION_COMMANDS_JSON="$(yq -o=json '.verification.commands // ["true"]' "${yaml_file}" \
                                          | jq -c '.')"

  # TCC-IDENTITY (P1-10): target_id 는 시스템 식별자(라벨/큐/ledger 분기 기준).
  # persistent_store_ref 는 영속 저장소 바인딩(github 어댑터에서는 owner/repo).
  # 둘 다 누락 시 기존 (name, owner/repo) 로 폴백 — 마이그레이션 grace.
  TARGET_ID="$(yq -r '.target_id // ""' "${yaml_file}")"
  [ -n "${TARGET_ID}" ] || TARGET_ID="${TARGET_NAME}"
  TARGET_PERSISTENT_STORE_REF="$(yq -r '.persistent_store_ref // ""' "${yaml_file}")"
  if [ -z "${TARGET_PERSISTENT_STORE_REF}" ]; then
    if [ -n "${TARGET_GH_OWNER}" ] && [ -n "${TARGET_GH_REPO}" ]; then
      TARGET_PERSISTENT_STORE_REF="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
    fi
  fi

  # TCC-LEASE-CONFIG (P1-9): ttl_default 단위는 초. Invalid (≤0) 인 경우 시스템
  # 기본 3600 으로 폴백한다 (TCC-PRECEDENCE 단계 3).
  TARGET_LEASE_TTL_DEFAULT="$(yq -r '.lease.ttl_default // 0' "${yaml_file}")"
  if ! [ "${TARGET_LEASE_TTL_DEFAULT}" -gt 0 ] 2>/dev/null; then
    TARGET_LEASE_TTL_DEFAULT=3600
  fi
  TARGET_LEASE_TTL_BY_ROLE_JSON="$(yq -o=json '.lease.ttl_by_role // {}' "${yaml_file}" \
                                       | jq -c '.')"

  # TCC-AGENT-RUNNER-MAP (P1-9): default + by_role. default 미지정 시 환경변수
  # LLM_TEAM_ADAPTER_LLM_RUNNER 기본값으로 폴백, 그것도 없으면 claude_code.
  TARGET_AGENT_RUNNER_DEFAULT="$(yq -r '.agent_runner.default // ""' "${yaml_file}")"
  [ -n "${TARGET_AGENT_RUNNER_DEFAULT}" ] \
    || TARGET_AGENT_RUNNER_DEFAULT="${LLM_TEAM_ADAPTER_LLM_RUNNER:-claude_code}"
  TARGET_AGENT_RUNNER_BY_ROLE_JSON="$(yq -o=json '.agent_runner.by_role // {}' "${yaml_file}" \
                                          | jq -c '.')"

  export TARGET_NAME TARGET_GH_OWNER TARGET_GH_REPO TARGET_DEFAULT_BRANCH \
    TARGET_CLONE_PATH TARGET_INPUTS_DIR TARGET_LABEL_PREFIX \
    TARGET_NOTIFIER_CHANNEL TARGET_NOTIFIER_REF TARGET_DEV_CONCURRENCY \
    TARGET_STALE_THRESHOLD_MIN TARGET_ENABLED TARGET_VERIFICATION_COMMANDS_JSON \
    TARGET_ID TARGET_PERSISTENT_STORE_REF \
    TARGET_LEASE_TTL_DEFAULT TARGET_LEASE_TTL_BY_ROLE_JSON \
    TARGET_AGENT_RUNNER_DEFAULT TARGET_AGENT_RUNNER_BY_ROLE_JSON
}

# config_lease_ttl_for_role <role> [target_lease_ttl_by_role_json]
# Returns the TTL (seconds) for `role`. Resolution order (TCC-PRECEDENCE):
#   1. explicit env override LLM_TEAM_LEASE_TTL (if set, used directly)
#   2. .lease.ttl_by_role[<role>] from target.yaml (case-insensitive role lookup)
#   3. .lease.ttl_default
# Caller must have load_target'd the target so TARGET_LEASE_* are populated, OR
# pass the by_role JSON explicitly as $2.
config_lease_ttl_for_role() {
  local role="${1:-}" by_role="${2:-${TARGET_LEASE_TTL_BY_ROLE_JSON:-{\}}}"
  if [ -n "${LLM_TEAM_LEASE_TTL:-}" ]; then
    printf '%s' "${LLM_TEAM_LEASE_TTL}"
    return 0
  fi
  local ttl=""
  if [ -n "${role}" ] && [ -n "${by_role}" ]; then
    # Try the role as given, then lower-case fallback.
    ttl="$(printf '%s' "${by_role}" | jq -r --arg k "${role}" '.[$k] // empty' 2>/dev/null)"
    if [ -z "${ttl}" ]; then
      local lower
      lower="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
      ttl="$(printf '%s' "${by_role}" | jq -r --arg k "${lower}" '.[$k] // empty' 2>/dev/null)"
    fi
  fi
  if [ -n "${ttl}" ] && [ "${ttl}" -gt 0 ] 2>/dev/null; then
    printf '%s' "${ttl}"
  else
    printf '%s' "${TARGET_LEASE_TTL_DEFAULT:-3600}"
  fi
}

# config_agent_runner_for_role <role> [target_by_role_json] [default]
# Returns the agent_runner adapter id for `role` per TCC-AGENT-RUNNER-MAP.
config_agent_runner_for_role() {
  local role="${1:-}"
  local by_role="${2:-${TARGET_AGENT_RUNNER_BY_ROLE_JSON:-{\}}}"
  local default="${3:-${TARGET_AGENT_RUNNER_DEFAULT:-claude_code}}"
  local adapter=""
  if [ -n "${role}" ] && [ -n "${by_role}" ]; then
    adapter="$(printf '%s' "${by_role}" | jq -r --arg k "${role}" '.[$k] // empty' 2>/dev/null)"
    if [ -z "${adapter}" ]; then
      local lower
      lower="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
      adapter="$(printf '%s' "${by_role}" | jq -r --arg k "${lower}" '.[$k] // empty' 2>/dev/null)"
    fi
  fi
  printf '%s' "${adapter:-${default}}"
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
