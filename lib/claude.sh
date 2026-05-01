#!/usr/bin/env bash
# lib/claude.sh — Claude Code CLI invocation helper.
#
# Public API:
#   claude_invoke <prompt_string>
#     stdin: 사용 안 함 (prompt는 매개변수)
#     stdout: claude의 응답 본문
#     stderr: claude의 진단/에러 출력 + 본 helper 자체의 로그
#     return: claude의 exit code
#
# Usage pattern (4개 scheduler 공통):
#   if ! claude_invoke "${PROMPT}" >"${OUTPUT_FILE}" 2>>"${OUTPUT_FILE}.err"; then
#     log_error "claude invocation failed (rc=$?)"
#     ...
#   fi
#
# Implementation:
#   - prompt는 항상 stdin으로 전달 (argv 한계 ARG_MAX 회피).
#   - 호출 명령은 환경변수 LLM_TEAM_CLAUDE_CMD로 오버라이드 가능 (테스트/대체용).
#     기본값: `claude -p --output-format text` (stdin에서 prompt 읽음).
#   - command -v 사전 체크로 친절한 에러 메시지 제공.
#
# 본 helper는 scheduler들이 직접 `claude` 명령을 호출하지 않게 하기 위한 단일
# 진입점이다. claude CLI 인터페이스가 변경되면 본 파일만 수정하면 된다.

claude_invoke() {
  local prompt="$1"
  if [ -z "${prompt}" ]; then
    log_error "claude_invoke: empty prompt"
    return 64
  fi

  local cmd="${LLM_TEAM_CLAUDE_CMD:-claude -p --output-format text}"

  # cmd의 첫 토큰이 실제로 PATH에 있는지 확인 (override 시에도 동작).
  local first_token="${cmd%% *}"
  if ! command -v "${first_token}" >/dev/null 2>&1; then
    log_error "claude_invoke: '${first_token}' not found in PATH (cmd='${cmd}')"
    return 127
  fi

  # stdin pipe + word-split된 cmd 호출. eval/bash -c 회피 (인용 문제 차단).
  printf '%s' "${prompt}" | ${cmd}
}
