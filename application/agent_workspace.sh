#!/usr/bin/env bash
# application/agent_workspace.sh
#
# Resolve the working directory in which an agent (LLM) should be invoked.
# Caller (scheduler/runner.sh) wraps lr_invoke in `( cd "$path" && lr_invoke )`
# to keep target-repo edits inside the worktree and prevent accidental writes
# to the framework repo at LLM_TEAM_ROOT.
#
# Policy (workspace-spec-agent-strategy.md §1):
#   PO / PM / Planner          → workdir/<target>/agent-cwd/<role_lower>
#                                 (read-only context — created on demand)
#   Coder / Reviewer /
#   Integrator / QA            → ws_path_of("task-<unit_id>")
#                                 (caller must call ws_ensure beforehand)
#
# 사전조건:
#   • TARGET_NAME, LLM_TEAM_ROOT exported (load_target 후).
#   • Coder/Reviewer/Integrator/QA: ws_ensure "task-<unit_id>" 가 선행되어 있어야 한다.

# agent_workspace_for <role> <unit_id>
#   stdout: 절대 경로
#   return: 0 OK / 비0 (인자 누락, 정책 미해석, workspace 미준비)
agent_workspace_for() {
  local role_raw="${1:-}" unit_id="${2:-}" role role_lower path
  if [ -z "${role_raw}" ] || [ -z "${unit_id}" ]; then
    log_error "agent_workspace_for: role and unit_id are required"
    return 1
  fi
  role="$(role_normalize "${role_raw}")" || {
    log_error "agent_workspace_for: invalid role: ${role_raw}"
    return 1
  }
  if [ -z "${TARGET_NAME:-}" ] || [ -z "${LLM_TEAM_ROOT:-}" ]; then
    log_error "agent_workspace_for: TARGET_NAME and LLM_TEAM_ROOT must be set"
    return 1
  fi

  case "${role}" in
    Coder|Reviewer|Integrator|QA)
      path="$(ws_path_of "task-${unit_id}" 2>/dev/null || true)"
      if [ -z "${path}" ] || [ ! -d "${path}" ]; then
        log_error "agent_workspace_for: ${role} requires task workspace 'task-${unit_id}' (call ws_ensure first)"
        return 1
      fi
      printf '%s\n' "${path}"
      ;;
    PO|PM|Planner)
      role_lower="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
      path="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/agent-cwd/${role_lower}"
      mkdir -p "${path}" || {
        log_error "agent_workspace_for: failed to mkdir ${path}"
        return 1
      }
      printf '%s\n' "${path}"
      ;;
    *)
      log_error "agent_workspace_for: unsupported role: ${role}"
      return 1
      ;;
  esac
}
