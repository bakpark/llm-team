#!/usr/bin/env bash
# lib/signals.sh - Human governance/input signal validation.

human_signal_validate() {
  local signal_file="$1"
  [ -f "${signal_file}" ] || {
    log_error "human_signal_validate: signal file not found: ${signal_file}"
    return 1
  }
  jq -e '
    (.signal_id | type == "string" and length > 0) and
    (.signal_type | IN("approve","reject","request_rework","request_recover","pause","resume","amendment_approve","stop")) and
    (.target_kind | type == "string" and length > 0) and
    (.target_id | type == "string" and length > 0) and
    (.actor | type == "string" and length > 0) and
    (.created_at | type == "string" and length > 0)
  ' "${signal_file}" >/dev/null
}

control_state_path() {
  printf '%s/workdir/control-state' "${LLM_TEAM_ROOT}"
}

control_state_get() {
  local path
  path="$(control_state_path)"
  if [ -f "${path}" ]; then
    cat "${path}"
  else
    printf 'RUNNING'
  fi
}

control_state_set() {
  local state="$1"
  case "${state}" in
    RUNNING|PAUSED) ;;
    *) log_error "control_state_set: invalid state '${state}'"; return 1 ;;
  esac
  mkdir -p "$(dirname "$(control_state_path)")" || return 1
  printf '%s\n' "${state}" >"$(control_state_path)"
}
