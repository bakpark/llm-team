#!/usr/bin/env bash
# scripts/cli/_onboarding_gate.sh
#
# Hard gate helper used by run / run-once / daemon start. 정책:
#   - LLM_TEAM_SKIP_ONBOARDING_GATE=1 → 우회 (warn 만 출력).
#   - --allow-incomplete-onboarding flag → 우회 (warn 만 출력).
#   - --dry-run flag → 우회 (verify 자체를 건너뜀).
#   - 그 외에는 onboarding_verify 결과의 block FAIL 이 1+ 면 exit 2.
#
# Public API:
#   onboarding_gate_filter_args [args...]
#     stdout: 게이트 관련 flag 가 제거된 args 를 한 줄당 하나씩.
#     side-effect: 환경 변수 _ONB_GATE_ALLOW_INCOMPLETE / _ONB_GATE_DRY_RUN 설정.
#
#   onboarding_gate_check <target>
#     exit 0 = pass / 2 = block FAIL / 1 = internal.

if [ -n "${LLM_TEAM_ONBOARDING_GATE_LOADED:-}" ]; then
  return 0
fi
LLM_TEAM_ONBOARDING_GATE_LOADED=1

_ONB_GATE_ALLOW_INCOMPLETE=0
_ONB_GATE_DRY_RUN=0

# onboarding_gate_filter_args [args...]
# 게이트 전용 flag 만 골라내고 나머지를 stdout 으로 한 줄당 하나씩 출력한다.
# --dry-run 은 게이트 우회 신호인 동시에 runner 에도 전달되어야 하므로 stdout
# 에도 남긴다.
#
# 호출자는 이 함수의 stdout 을 process substitution 으로 읽지 말고,
# 임시 파일이나 command substitution 으로 받아 메인 쉘에서 다시 스캔하라.
# (process substitution 은 자식 쉘이라 환경 변수 갱신이 부모로 전파되지 않음.)
onboarding_gate_filter_args() {
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --allow-incomplete-onboarding) ;;
      *) printf '%s\n' "${arg}" ;;
    esac
  done
}

# onboarding_gate_detect_flags [args...]
# 입력 args 를 보고 게이트 관련 flag 를 감지하여 _ONB_GATE_* 를 설정한다.
# 메인 쉘에서 호출해야 환경 변수가 살아남는다.
onboarding_gate_detect_flags() {
  _ONB_GATE_ALLOW_INCOMPLETE=0
  _ONB_GATE_DRY_RUN=0
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --allow-incomplete-onboarding) _ONB_GATE_ALLOW_INCOMPLETE=1 ;;
      --dry-run) _ONB_GATE_DRY_RUN=1 ;;
    esac
  done
}

# stderr 에 게이트 결과를 표시. ${1} = target.
onboarding_gate_check() {
  local target="$1"
  if [ "${_ONB_GATE_DRY_RUN:-0}" -eq 1 ]; then
    return 0
  fi
  if [ "${LLM_TEAM_SKIP_ONBOARDING_GATE:-0}" = "1" ]; then
    printf 'WARN: onboarding gate bypassed (LLM_TEAM_SKIP_ONBOARDING_GATE=1) target=%s\n' \
      "${target}" >&2
    return 0
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=common.sh
  . "${script_dir}/common.sh"
  cli_source_runtime
  # shellcheck source=../../application/onboarding/verify.sh
  . "${LLM_TEAM_ROOT}/application/onboarding/verify.sh"

  local tmp rc
  tmp="$(mktemp "${TMPDIR:-/tmp}/onb-gate-XXXXXX")"
  set +e
  onboarding_verify "${target}" >"${tmp}" 2>/dev/null
  rc=$?
  set -e

  if [ "${rc}" = "0" ]; then
    rm -f "${tmp}"
    return 0
  fi

  # 실패 항목만 골라 stderr 에 한 줄씩.
  printf 'ERROR: onboarding gate FAILED for target=%s\n' "${target}" >&2
  awk -F'\t' '$1=="FAIL" {
    printf "  - %s: %s\n", $2, $4
    if ($5 != "") printf "      → %s\n", $5
  }' "${tmp}" >&2

  if [ "${_ONB_GATE_ALLOW_INCOMPLETE:-0}" -eq 1 ]; then
    printf 'WARN: onboarding gate bypassed (--allow-incomplete-onboarding) target=%s\n' \
      "${target}" >&2
    rm -f "${tmp}"
    return 0
  fi

  printf '\nFix the items above, or:\n' >&2
  printf '  • llm-team onboarding wizard %s\n' "${target}" >&2
  printf '  • re-run with --allow-incomplete-onboarding\n' >&2
  printf '  • or LLM_TEAM_SKIP_ONBOARDING_GATE=1 in env\n' >&2
  rm -f "${tmp}"
  return 2
}
