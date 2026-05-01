#!/usr/bin/env bash
# lib/registry.sh — port/adapter registry.
#
# 책임:
#   1. 각 port 명세 파일을 source 한다 (PORT_*_REQUIRED_FUNCTIONS 배열 로드).
#   2. 환경변수에 따라 어떤 adapter 를 쓸지 결정해 source 한다.
#   3. adapter 가 모든 required function 을 제공하는지 declare -F 로 검증한다.
#
# 환경변수 (target yaml 의 adapters.* 또는 직접 export):
#   LLM_TEAM_ADAPTER_ISSUE_TRACKER     기본: github
#   LLM_TEAM_ADAPTER_NOTIFIER          기본: TARGET_NOTIFIER_CHANNEL 값(none|discord|slack)
#   LLM_TEAM_ADAPTER_LLM_RUNNER        기본: claude_code
#   LLM_TEAM_ADAPTER_WORKSPACE         기본: git_worktree
#   LLM_TEAM_ADAPTER_PERSISTENT_STORE  기본: filesystem
#
# Caller 흐름:
#   . "${LLM_TEAM_ROOT}/lib/common.sh"   # 내부에서 registry_load_default 호출
#   load_target "$target"                # TARGET_* 설정
#   registry_rebind_for_target           # target.yaml 의 adapter 지정을 반영

# ----------------------------------------------------------------------------
# Port 명세 source
# ----------------------------------------------------------------------------
registry_source_ports() {
  local p
  for p in issue_tracker notifier llm_runner workspace persistent_store; do
    # shellcheck disable=SC1090
    . "${LLM_TEAM_ROOT}/lib/ports/${p}.sh"
  done
}

# ----------------------------------------------------------------------------
# 한 port 가 모든 required function 을 가지는지 검증
# 사용:  registry_verify_port issue_tracker
# 반환:  0 = 모두 정의됨, 1 = 누락 있음 (stderr 에 누락 함수명 출력)
# ----------------------------------------------------------------------------
registry_verify_port() {
  local port="$1"
  local arr_name fn missing_count
  case "${port}" in
    issue_tracker)     arr_name="PORT_ISSUE_TRACKER_REQUIRED_FUNCTIONS" ;;
    notifier)          arr_name="PORT_NOTIFIER_REQUIRED_FUNCTIONS" ;;
    llm_runner)        arr_name="PORT_LLM_RUNNER_REQUIRED_FUNCTIONS" ;;
    workspace)         arr_name="PORT_WORKSPACE_REQUIRED_FUNCTIONS" ;;
    persistent_store)  arr_name="PORT_PERSISTENT_STORE_REQUIRED_FUNCTIONS" ;;
    *)
      log_error "registry_verify_port: unknown port '${port}'"
      return 2
      ;;
  esac

  # bash 3.2 호환: nameref 대신 eval 로 배열 복사.
  local -a required=()
  eval "required=( \"\${${arr_name}[@]}\" )"
  missing_count=0
  for fn in "${required[@]}"; do
    if ! declare -F "${fn}" >/dev/null 2>&1; then
      log_error "registry_verify_port: port='${port}' missing function: ${fn}"
      missing_count=$((missing_count + 1))
    fi
  done
  if [ "${missing_count}" -gt 0 ]; then
    log_error "registry_verify_port: port='${port}' is missing ${missing_count} function(s)"
    return 1
  fi
  return 0
}

# ----------------------------------------------------------------------------
# 한 port 의 adapter 를 선택해 source 하고 검증한다.
# ----------------------------------------------------------------------------
registry_load_adapter() {
  local port="$1" adapter="$2"
  if [ -z "${port}" ] || [ -z "${adapter}" ]; then
    log_error "registry_load_adapter: port and adapter are required"
    return 1
  fi
  local file="${LLM_TEAM_ROOT}/adapters/${port}/${adapter}.sh"
  if [ ! -f "${file}" ]; then
    log_error "registry_load_adapter: adapter file not found: ${file}"
    return 1
  fi
  # shellcheck disable=SC1090
  . "${file}" || {
    log_error "registry_load_adapter: failed to source ${file}"
    return 1
  }
  registry_verify_port "${port}" || return 1
  # 활성 adapter 이름을 추적 (디버깅·테스트용).
  local var_name
  var_name="LLM_TEAM_ACTIVE_$(printf '%s' "${port}" | tr '[:lower:]' '[:upper:]')_ADAPTER"
  printf -v "${var_name}" '%s' "${adapter}"
  export "${var_name?}"
  return 0
}

# ----------------------------------------------------------------------------
# 기본값으로 모든 마이그레이션된 port 의 adapter 를 로드.
#
# 점진 이전 정책:
#   • 본 함수는 "현재 시점에 adapter 가 존재하는 port" 만 로드한다.
#   • 아직 lib/<file>.sh 본문에 머물러 있는 port (notifier/llm_runner/workspace/
#     persistent_store) 는 lib/common.sh 가 직접 source 해서 동작을 유지한다.
#   • 한 port 가 adapters/ 로 완전히 이전되면 본 함수에 등록한다.
# ----------------------------------------------------------------------------
registry_load_default() {
  registry_source_ports

  local rc=0
  registry_load_adapter issue_tracker     "${LLM_TEAM_ADAPTER_ISSUE_TRACKER:-github}"          || rc=1
  registry_load_adapter notifier          "${LLM_TEAM_ADAPTER_NOTIFIER:-none}"                 || rc=1
  registry_load_adapter llm_runner        "${LLM_TEAM_ADAPTER_LLM_RUNNER:-claude_code}"        || rc=1
  registry_load_adapter workspace         "${LLM_TEAM_ADAPTER_WORKSPACE:-git_worktree}"        || rc=1
  registry_load_adapter persistent_store  "${LLM_TEAM_ADAPTER_PERSISTENT_STORE:-filesystem}"   || rc=1
  return "${rc}"
}

# ----------------------------------------------------------------------------
# 마이그레이션 완료된 port 의 활성 adapter 이름을 출력 (디버깅용).
# ----------------------------------------------------------------------------
registry_active_adapters() {
  printf 'issue_tracker=%s\n' "${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-<not loaded>}"
  printf 'notifier=%s\n' "${LLM_TEAM_ACTIVE_NOTIFIER_ADAPTER:-<not loaded>}"
  printf 'llm_runner=%s\n' "${LLM_TEAM_ACTIVE_LLM_RUNNER_ADAPTER:-<not loaded>}"
  printf 'workspace=%s\n' "${LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER:-<not loaded>}"
  printf 'persistent_store=%s\n' "${LLM_TEAM_ACTIVE_PERSISTENT_STORE_ADAPTER:-<not loaded>}"
}

# ----------------------------------------------------------------------------
# load_target 후 호출 — target yaml 이 adapter 를 명시했으면 다시 바인딩.
# ----------------------------------------------------------------------------
registry_rebind_for_target() {
  # 추후 target yaml 에 `adapters.*` 키를 추가하면 여기서 yq 로 읽어
  # registry_load_adapter 를 다시 호출한다.
  # 현재는 TARGET_NOTIFIER_CHANNEL 만 notifier adapter 선택에 영향을 준다.
  if [ -n "${TARGET_NOTIFIER_CHANNEL:-}" ] \
     && [ "${TARGET_NOTIFIER_CHANNEL}" != "${LLM_TEAM_ACTIVE_NOTIFIER_ADAPTER:-}" ]; then
    registry_load_adapter notifier "${TARGET_NOTIFIER_CHANNEL}" \
      || log_warn "registry_rebind_for_target: failed to bind notifier=${TARGET_NOTIFIER_CHANNEL}"
  fi
  return 0
}
