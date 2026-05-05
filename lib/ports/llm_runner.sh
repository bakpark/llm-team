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
#   • lr_call <role> <operation> <manifest_id> <prompt_ref> <agent_cwd>
#            <timeout_sec> <idempotency_key>
#     port-level wrapper that satisfies the full ARC contract: validates the
#     prompt headers vs args, exports LR_* env (manifest_id/role/operation/
#     timeout_sec/idempotency_key) for the adapter, invokes the adapter via
#     stdin, captures stdout to envelope_ref and stderr to diagnostics_ref,
#     records consumed_at, classifies exit, and emits a single JSON metadata
#     line on stdout: {exit_status, envelope_ref, diagnostics_ref, consumed_at,
#     error_reason, role, operation, manifest_id, idempotency_key,
#     timeout_enforced}. Returns 0 if the call was *classified* (regardless of
#     enum), non-0 only for infrastructure failure (e.g. cannot read prompt_ref).
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

# lr_classify_diagnostic_reason <exit_status> <diagnostics_ref> → prints one of:
#   5xx | 4xx | network | timeout | unknown
#
# transport_error 의 세부 원인을 diagnostics 파일에서 첫 매칭으로 추출. retry
# 정책 결정에 사용 (B-3): 5xx/network/timeout 은 transient → backoff retry,
# 4xx/unknown 은 persistent → 즉시 실패.
lr_classify_diagnostic_reason() {
  local exit_status="${1:-}" diag_ref="${2:-}"
  if [ "${exit_status}" = "timeout" ]; then
    printf 'timeout'
    return 0
  fi
  if [ -z "${diag_ref}" ] || [ ! -f "${diag_ref}" ]; then
    printf 'unknown'
    return 0
  fi
  # 우선순위: 5xx → 4xx → network → unknown.
  if grep -Eqi '\b50[0-9]\b|internal server error|bad gateway|service unavailable|gateway timeout' "${diag_ref}" 2>/dev/null; then
    printf '5xx'; return 0
  fi
  if grep -Eqi '\b(429|401|403|400)\b|too many requests|unauthorized|forbidden|bad request' "${diag_ref}" 2>/dev/null; then
    printf '4xx'; return 0
  fi
  if grep -Eqi 'connection refused|no route to host|could not resolve|name resolution|network is unreachable|temporary failure|connection reset' "${diag_ref}" 2>/dev/null; then
    printf 'network'; return 0
  fi
  printf 'unknown'
}

# lr_call <role> <operation> <manifest_id> <prompt_ref> <agent_cwd> <timeout_sec> <idempotency_key>
#   role, operation, manifest_id: 7-항목 #ARC-PORT-SIGNATURE 입력 중 4개를 자리
#     인자로 명시. 어댑터는 prompt 헤더(`# Role:` `# Operation:` `# Manifest-id:`)
#     로도 같은 값을 본다. wrapper 가 둘의 일치를 검증해 헤더-인자 불일치를
#     silent skip 하지 않도록 한다 (불일치 시 adapter_unavailable=66).
#   prompt_ref: path to a regular file containing the prompt body.
#   agent_cwd:  optional path; if non-empty, lr_invoke runs with this cwd.
#   timeout_sec: 0 또는 양의 정수. 0 이면 timeout 미적용. 양수이면 어댑터가
#     LR_TIMEOUT_SEC env 를 읽어 외부 명령을 `timeout` 로 wrap 해야 한다
#     (wrapper 는 sourced bash function 인 lr_invoke 를 직접 wrap 할 수 없음).
#   idempotency_key: caller 가 deterministic 하게 산출한 키. 비어있으면 적합
#     하지 않은 호출로 간주하지 않고(테스트 호환), env 만 빈 값으로 export.
#
#   stdout: a single-line JSON object:
#     {"exit_status":"<enum>","envelope_ref":"<path>",
#      "diagnostics_ref":"<path>","consumed_at":"<iso8601>",
#      "error_reason":"<reason|null>",
#      "role":"<role>","operation":"<op>","manifest_id":"<id>",
#      "idempotency_key":"<key>","timeout_enforced":<bool>}
#     timeout_enforced 는 wrapper 의 *의도* 만 표기 (LR_TIMEOUT_SEC>0). adapter
#     가 실제 wrap 했는지는 별도 신호(exit 124 → timeout enum) 로 caller 가
#     확인한다.
#   stderr: caller-side diagnostics (the adapter's own stderr is captured to
#           diagnostics_ref, not echoed here).
#   return: 0 on classification (any enum), non-0 only on infrastructure
#           failure (prompt_ref missing, mktemp fail).
lr_call() {
  local role="${1:-}" operation="${2:-}" manifest_id="${3:-}"
  local prompt_ref="${4:-}" agent_cwd="${5:-}"
  local timeout_sec="${6:-0}" idempotency_key="${7:-}"
  if [ -z "${prompt_ref}" ] || [ ! -f "${prompt_ref}" ]; then
    log_error "lr_call: prompt_ref missing or not a regular file: '${prompt_ref}'"
    return 1
  fi
  local envelope_ref diagnostics_ref consumed_at raw_code exit_status
  envelope_ref="$(mktemp -t lr-envelope.XXXXXX)" || return 1
  diagnostics_ref="$(mktemp -t lr-diagnostics.XXXXXX)" || { rm -f "${envelope_ref}"; return 1; }

  # Header consistency check (gpt5.5 G5): prompt 헤더와 wrapper 인자가 다르면
  # adapter 가 헤더 기반으로 다른 fixture 를 잡는 등 silent divergence 가 생긴다.
  # 헤더가 ground truth (#ARC-CALL-SEMANTICS / I3) 이므로 인자가 헤더와 다르면
  # 어댑터를 호출하지 않고 바로 adapter_unavailable 로 분류. role 은 prompt
  # 파일이 canonically 소문자(`po`/`pm`/`planner`/...) 이므로 비교 시 양쪽을
  # 소문자로 정규화 (caller 는 `PO` 등 normalize 결과를 그대로 넘겨도 통과).
  local hdr_role hdr_op hdr_mid
  hdr_role="$(head -n 10 "${prompt_ref}" | grep -m1 '^# Role:' | sed -E 's/^# Role:[[:space:]]*//')"
  hdr_op="$(head -n 10 "${prompt_ref}" | grep -m1 '^# Operation:' | sed -E 's/^# Operation:[[:space:]]*//')"
  hdr_mid="$(head -n 10 "${prompt_ref}" | grep -m1 '^# Manifest-id:' | sed -E 's/^# Manifest-id:[[:space:]]*//')"
  local role_lc hdr_role_lc
  role_lc="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
  hdr_role_lc="$(printf '%s' "${hdr_role}" | tr '[:upper:]' '[:lower:]')"
  if [ "${hdr_role_lc}" != "${role_lc}" ] || [ "${hdr_op}" != "${operation}" ] || [ "${hdr_mid}" != "${manifest_id}" ]; then
    log_error "lr_call: prompt header/arg mismatch (header role='${hdr_role}' op='${hdr_op}' manifest_id='${hdr_mid}'; arg role='${role}' op='${operation}' manifest_id='${manifest_id}')"
    consumed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    exit_status="adapter_unavailable"
    : >"${envelope_ref}"
    printf 'lr_call: prompt header/arg mismatch (role/operation/manifest_id)\n' >"${diagnostics_ref}"
    _lr_call_emit_meta "${exit_status}" "${envelope_ref}" "${diagnostics_ref}" "${consumed_at}" \
      "header_arg_mismatch" "${role}" "${operation}" "${manifest_id}" \
      "${idempotency_key}" "${timeout_sec}"
    return 0
  fi

  # Export #ARC-PORT-SIGNATURE 입력 중 prompt 외부 채널로 어댑터에 전달되는 값.
  export LR_ROLE="${role}"
  export LR_OPERATION="${operation}"
  export LR_MANIFEST_ID="${manifest_id}"
  export LR_TIMEOUT_SEC="${timeout_sec}"
  export LR_IDEMPOTENCY_KEY="${idempotency_key}"

  if [ -n "${agent_cwd}" ]; then
    ( cd "${agent_cwd}" && lr_invoke <"${prompt_ref}" ) \
      >"${envelope_ref}" 2>"${diagnostics_ref}"
  else
    lr_invoke <"${prompt_ref}" >"${envelope_ref}" 2>"${diagnostics_ref}"
  fi
  raw_code=$?
  consumed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit_status="$(lr_classify_exit "${raw_code}")"
  local error_reason=""
  if [ "${exit_status}" != "ok" ]; then
    error_reason="$(lr_classify_diagnostic_reason "${exit_status}" "${diagnostics_ref}")"
  fi

  _lr_call_emit_meta "${exit_status}" "${envelope_ref}" "${diagnostics_ref}" "${consumed_at}" \
    "${error_reason}" "${role}" "${operation}" "${manifest_id}" \
    "${idempotency_key}" "${timeout_sec}"
}

# Internal: lr_call JSON metadata emitter (positional args mirror lr_call output schema).
_lr_call_emit_meta() {
  local exit_status="$1" envelope_ref="$2" diagnostics_ref="$3" consumed_at="$4"
  local error_reason="$5" role="$6" operation="$7" manifest_id="$8"
  local idempotency_key="$9" timeout_sec="${10}"
  local timeout_enforced="false"
  if [ "${timeout_sec}" -gt 0 ] 2>/dev/null; then
    timeout_enforced="true"
  fi
  jq -cn \
    --arg exit_status "${exit_status}" \
    --arg envelope_ref "${envelope_ref}" \
    --arg diagnostics_ref "${diagnostics_ref}" \
    --arg consumed_at "${consumed_at}" \
    --arg error_reason "${error_reason}" \
    --arg role "${role}" \
    --arg operation "${operation}" \
    --arg manifest_id "${manifest_id}" \
    --arg idempotency_key "${idempotency_key}" \
    --argjson timeout_enforced "${timeout_enforced}" \
    '{exit_status:$exit_status, envelope_ref:$envelope_ref, diagnostics_ref:$diagnostics_ref, consumed_at:$consumed_at, error_reason:(if $error_reason == "" then null else $error_reason end), role:$role, operation:$operation, manifest_id:$manifest_id, idempotency_key:$idempotency_key, timeout_enforced:$timeout_enforced}'
}
