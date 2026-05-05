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
#   66      adapter_unavailable    LR_TIMEOUT_SEC>0 인데 `timeout` 부재 (fail-fast)
#   124     timeout                LR_TIMEOUT_SEC 도달
#   127     adapter_unavailable    claude 바이너리 미발견
#   기타     transport_error        claude 의 raw exit code (caller 흡수)
#
# Timeout 정책 (#ARC-CALL-SEMANTICS / "adapter 가 timeout 도달 시 호출 중단"):
# wrapper(`lr_call`) 가 sourced bash function 인 lr_invoke 를 외부 `timeout` 로
# wrap 할 수 없으므로(PATH 에 없음), adapter 가 *외부 명령 호출 시점에* 자체
# wrap 한다. LR_TIMEOUT_SEC>0 인데 `timeout` cmd 가 PATH 에 없으면 silent skip
# 하지 않고 66(adapter_unavailable) 으로 fail-fast 한다 (#ARC-ADAPTER-SUBSTITUTION
# 의 "동일 timeout 입력에 대해 timeout 동작이 동일" 보장).
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

  local timeout_sec="${LR_TIMEOUT_SEC:-0}"
  case "${timeout_sec}" in
    ''|*[!0-9]*) timeout_sec=0 ;;
  esac
  if [ "${timeout_sec}" -gt 0 ]; then
    if ! command -v timeout >/dev/null 2>&1; then
      log_error "lr_invoke: LR_TIMEOUT_SEC=${timeout_sec} but 'timeout' cmd not found in PATH (fail-fast per #ARC-ADAPTER-SUBSTITUTION)"
      return 66
    fi
    # stdin pipe + word-split된 cmd 호출. eval/bash -c 회피 (인용 문제 차단).
    printf '%s' "${prompt}" | timeout "${timeout_sec}" ${cmd}
  else
    printf '%s' "${prompt}" | ${cmd}
  fi
}
