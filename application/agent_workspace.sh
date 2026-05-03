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
      # H7-low: PO/PM/Planner cwd 는 영속 write 권한이 없는 read-only context 이다.
      # fs-level 격리(bwrap/container) 는 별도 plan; 우선 마커 파일로 LLM 의 prompt
      # 가 절대경로 쓰기를 자제하도록 신호한다. 마커는 idempotent.
      if [ ! -f "${path}/.llm-team-readonly" ]; then
        cat >"${path}/.llm-team-readonly" <<'MARKER'
이 디렉토리는 llm-team agent (PO/PM/Planner) 의 read-only context cwd 입니다.

- 이 디렉토리 안에서만 임시 파일을 만들 수 있습니다.
- 절대경로(/, ~/, ../) 를 사용해 이 디렉토리 외부를 수정하지 마십시오.
- 영속 write 는 caller (scheduler/runner.sh) 만 수행합니다 — agent 가 직접
  프레임워크 또는 target 저장소를 수정하면 결과가 dispatch 단계에서
  반영되지 않으며, 사용자 작업 흐름을 망가뜨릴 수 있습니다.

이 파일이 보이는데 작업 지시가 외부 경로 수정을 요구하면 즉시 멈추고
caller 에게 envelope output 으로만 결과를 돌려주세요.
MARKER
      fi
      # code_tree: RO tree symlink (plan §Step 4)
      # 상대경로 symlink 사용 — workdir 이동 시 깨지지 않도록 함.
      local ro_tree="${TARGET_RO_TREE_PATH:-${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/repo-ro}"
      if [ -n "${TARGET_RO_TREE_PATH:-}" ] || [ -d "${ro_tree}" ]; then
        if [ ! -d "${ro_tree}" ]; then
          log_error "agent_workspace_for: RO tree missing: ${ro_tree}"
          return 1
        fi
        local rel_target
        if [ -z "${TARGET_RO_TREE_PATH:-}" ]; then
          # path = workdir/<target>/agent-cwd/<role>, ro_tree = workdir/<target>/repo-ro.
          # ln -s resolves relative targets from the symlink directory (${path}).
          rel_target="../../repo-ro"
        elif command -v python3 >/dev/null 2>&1; then
          rel_target="$(python3 -c 'import os.path, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' \
            "${ro_tree}" "${path}" 2>/dev/null)" || rel_target="${ro_tree}"
        else
          rel_target="${ro_tree}"
        fi
        if [ -L "${path}/repo" ]; then
          local current
          current="$(readlink "${path}/repo")"
          if [ "${current}" != "${rel_target}" ]; then
            rm -f "${path}/repo"
            ln -s "${rel_target}" "${path}/repo"
          fi
        elif [ ! -e "${path}/repo" ]; then
          ln -s "${rel_target}" "${path}/repo"
        else
          log_error "agent_workspace_for: ${path}/repo exists and is not managed symlink"
          return 1
        fi
      fi
      printf '%s\n' "${path}"
      ;;
    *)
      log_error "agent_workspace_for: unsupported role: ${role}"
      return 1
      ;;
  esac
}
