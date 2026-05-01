#!/usr/bin/env bash
# lib/ports/llm_runner.sh
#
# Port: llm_runner
# 책임: LLM 한 번 호출 (1 prompt → 1 response).
# Stateless 계약을 유지: 호출 사이에 상태 공유가 없어야 한다.
#
# 기본 adapter: claude_code (claude -p --output-format text).
# 테스트 adapter: fake (미리 준비한 envelope 출력).

PORT_LLM_RUNNER_NAME="llm_runner"

PORT_LLM_RUNNER_REQUIRED_FUNCTIONS=(
  lr_invoke   # prompt_string  →  stdout=response, stderr=diagnostics, return=adapter exit code
)

PORT_LLM_RUNNER_INVARIANTS=(
  "I1: lr_invoke 는 stateless. 이전 호출의 컨텍스트를 보존하지 않는다."
  "I2: 빈 prompt 는 비0 반환 (의미 없는 호출 방지)."
  "I3: prompt 는 stdin 으로 전달 (ARG_MAX 회피)."
  "I4: stdout 은 LLM 의 응답 본문만 포함한다 (어댑터 진단은 stderr)."
)
