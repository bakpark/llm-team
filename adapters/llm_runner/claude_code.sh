#!/usr/bin/env bash
# adapters/llm_runner/claude_code.sh
#
# Concrete adapter for the llm_runner port using the Claude Code CLI.
# 환경변수:
#   LLM_TEAM_CLAUDE_CMD   기본: 'claude -p --output-format text'.
#                         테스트 시 fake binary 로 교체할 수 있다.
#
# 시그니처(#ARC-CALL-SEMANTICS, port I3): prompt 는 stdin 으로 들어온다.
#
# Exit codes (#ARC-EXIT-CLASSES via lr_classify_exit):
#   0       ok                     claude 정상 종료
#   64      transport_error        빈 prompt (port I2)
#   127     adapter_unavailable    claude 바이너리 미발견
#   기타     transport_error        claude 의 raw exit code (caller 흡수)
lr_invoke() {
  local prompt
  prompt="$(cat)"
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
