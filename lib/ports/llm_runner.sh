#!/usr/bin/env bash
# lib/ports/llm_runner.sh
#
# Port: llm_runner — agent runner port boundary (#ARC-PORT-SIGNATURE).
#
# Conceptual contract per docs/contracts/agent-runner-port-contract.md:
#   inputs:  role, operation, manifest_id, prompt_ref, agent_cwd, timeout,
#            idempotency_key
#   outputs: exit_status (enum), envelope_ref, diagnostics_ref, consumed_at
#
# Realization in this codebase:
#
#   • lr_invoke (adapter primitive)  — adapter-supplied function. Reads prompt
#     from stdin (#ARC-CALL-SEMANTICS / I3, ARG_MAX 회피), writes envelope body
#     to stdout, diagnostics to stderr, returns a raw exit code.
#
#   • lr_classify_exit <raw_code>   — port helper. Maps raw exit codes to the
#     #ARC-EXIT-CLASSES enum. Adapter exit-code conventions are documented in
#     each adapter; unknown / non-enum codes fall back to "transport_error"
#     (#ARC-FAILURE-MODES line 98).
#
#   • lr_call <prompt_ref> [agent_cwd] — port-level wrapper that satisfies the
#     full ARC contract: reads prompt from prompt_ref, invokes the adapter via
#     stdin, captures stdout to envelope_ref and stderr to diagnostics_ref,
#     records consumed_at, classifies exit, and emits a single JSON metadata
#     line on stdout: {exit_status, envelope_ref, diagnostics_ref, consumed_at}.
#     Returns 0 if the call was *classified* (regardless of enum), non-0 only
#     for infrastructure failure (e.g. cannot read prompt_ref).
#
# Default adapter: claude_code (claude -p --output-format text).
# Test adapter:    fake (deterministic fixture lookup).

PORT_LLM_RUNNER_NAME="llm_runner"

PORT_LLM_RUNNER_REQUIRED_FUNCTIONS=(
  lr_invoke   # stdin=prompt → stdout=response, stderr=diagnostics, return=raw exit code
)

PORT_LLM_RUNNER_INVARIANTS=(
  "I1: lr_invoke 는 stateless. 이전 호출의 컨텍스트를 보존하지 않는다."
  "I2: 빈 prompt 는 비0 반환 (의미 없는 호출 방지)."
  "I3: prompt 는 stdin 으로 어댑터에 전달 (ARG_MAX 회피)."
  "I4: stdout 은 LLM 의 응답 본문만 포함한다 (어댑터 진단은 stderr)."
)

# lr_classify_exit <raw_code> → prints one of:
#   ok | timeout | transport_error | adapter_unavailable | malformed_output
# Mapping (#ARC-EXIT-CLASSES):
#   0    → ok
#   64   → transport_error    (empty prompt / pre-call rejection)
#   65   → malformed_output   (prompt header / shape rejected by adapter)
#   66   → adapter_unavailable (adapter misconfigured / unusable)
#   67   → malformed_output   (no matching fixture / shape mismatch)
#   124  → timeout            (POSIX `timeout` command exit code)
#   127  → adapter_unavailable (binary not found)
#   *    → transport_error    (caller fallback, #ARC-FAILURE-MODES)
lr_classify_exit() {
  local code="${1:-}"
  case "${code}" in
    0)   printf 'ok' ;;
    64)  printf 'transport_error' ;;
    65)  printf 'malformed_output' ;;
    66)  printf 'adapter_unavailable' ;;
    67)  printf 'malformed_output' ;;
    124) printf 'timeout' ;;
    127) printf 'adapter_unavailable' ;;
    *)   printf 'transport_error' ;;
  esac
}

# lr_call <prompt_ref> [agent_cwd]
#   prompt_ref: path to a regular file containing the prompt body.
#   agent_cwd:  optional path; if non-empty, lr_invoke runs with this cwd.
#
#   stdout: a single-line JSON object:
#     {"exit_status":"<enum>","envelope_ref":"<path>",
#      "diagnostics_ref":"<path>","consumed_at":"<iso8601>"}
#   stderr: caller-side diagnostics (the adapter's own stderr is captured to
#           diagnostics_ref, not echoed here).
#   return: 0 on classification (any enum), non-0 only on infrastructure
#           failure (prompt_ref missing, mktemp fail).
lr_call() {
  local prompt_ref="${1:-}" agent_cwd="${2:-}"
  if [ -z "${prompt_ref}" ] || [ ! -f "${prompt_ref}" ]; then
    log_error "lr_call: prompt_ref missing or not a regular file: '${prompt_ref}'"
    return 1
  fi
  local envelope_ref diagnostics_ref consumed_at raw_code exit_status
  envelope_ref="$(mktemp -t lr-envelope.XXXXXX)" || return 1
  diagnostics_ref="$(mktemp -t lr-diagnostics.XXXXXX)" || { rm -f "${envelope_ref}"; return 1; }

  if [ -n "${agent_cwd}" ]; then
    ( cd "${agent_cwd}" && lr_invoke <"${prompt_ref}" ) \
      >"${envelope_ref}" 2>"${diagnostics_ref}"
  else
    lr_invoke <"${prompt_ref}" >"${envelope_ref}" 2>"${diagnostics_ref}"
  fi
  raw_code=$?
  consumed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit_status="$(lr_classify_exit "${raw_code}")"

  jq -cn \
    --arg exit_status "${exit_status}" \
    --arg envelope_ref "${envelope_ref}" \
    --arg diagnostics_ref "${diagnostics_ref}" \
    --arg consumed_at "${consumed_at}" \
    '{exit_status:$exit_status, envelope_ref:$envelope_ref, diagnostics_ref:$diagnostics_ref, consumed_at:$consumed_at}'
}
