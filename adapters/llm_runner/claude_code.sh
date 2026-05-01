#!/usr/bin/env bash
# adapters/llm_runner/claude_code.sh
#
# Concrete adapter for the llm_runner port using the Claude Code CLI.
# 환경변수:
#   LLM_TEAM_CLAUDE_CMD   기본: 'claude -p --output-format text'.
#                         테스트 시 fake binary 로 교체할 수 있다.

# lr_invoke <prompt_string>
#   stdin: 사용 안 함 (prompt 는 매개변수)
#   stdout: claude 의 응답 본문
#   stderr: claude 의 진단/에러 + adapter 자체 로그
#   return: claude 의 exit code, 또는 64 (empty prompt) / 127 (cmd not found)
lr_invoke() {
  local prompt="$1"
  if [ -z "${prompt}" ]; then
    log_error "lr_invoke: empty prompt"
    return 64
  fi

  local cmd="${LLM_TEAM_CLAUDE_CMD:-claude -p --output-format text}"
  local first_token="${cmd%% *}"
  if ! command -v "${first_token}" >/dev/null 2>&1; then
    log_error "lr_invoke: '${first_token}' not found in PATH (cmd='${cmd}')"
    return 127
  fi

  # stdin pipe + word-split된 cmd 호출. eval/bash -c 회피 (인용 문제 차단).
  printf '%s' "${prompt}" | ${cmd}
}
