#!/usr/bin/env bash
# application/onboarding/verify.sh — onboarding checklist 검증 엔진.
#
# Public API:
#   onboarding_verify <target>
#     stdout: 한 항목당 한 줄 "<status>\t<id>\t<severity>\t<message>\t<remediation>"
#       status   ∈ PASS / FAIL / WARN / SKIP
#       severity ∈ block / warn
#     exit 0  → 모든 block 항목 PASS (또는 SKIP/WARN). 게이트 통과.
#     exit 2  → 1 개 이상의 block 항목이 FAIL. 게이트 차단.
#     exit 1  → 내부 오류 (preset 누락, target.yaml 누락 등).
#
#   onboarding_preset_load <schema_id>
#     preset 함수들 (preset_items, _check_*, preset_remediation) 을 source.
#
# preset contract (checklists/<id>.sh 가 정의):
#   preset_items                 — TSV 행을 stdout 으로 출력. 칼럼:
#                                  id\tkind\tseverity\tself_hosting_only\tauto_fn\tack_key\tsummary
#                                  kind ∈ auto / ack / auto_or_ack
#                                  severity ∈ block / warn
#                                  self_hosting_only ∈ 0 / 1
#   _check_<id>                  — auto/auto_or_ack 항목 검증 함수.
#                                  stdout 에 메시지 출력, exit 0=PASS / non-zero=FAIL.
#   preset_remediation <id>      — 한 줄 안내 (FAIL 시 노출).

if [ -n "${LLM_TEAM_ONBOARDING_VERIFY_LOADED:-}" ]; then
  return 0
fi
LLM_TEAM_ONBOARDING_VERIFY_LOADED=1

if [ -z "${LLM_TEAM_ROOT:-}" ]; then
  _onb_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  LLM_TEAM_ROOT="$(cd "${_onb_dir}/../.." && pwd)"
  export LLM_TEAM_ROOT
  unset _onb_dir
fi

# Preset registry. 새 preset 을 추가할 때 이 맵에 등록한다.
_onboarding_preset_path() {
  local schema="$1"
  case "${schema}" in
    github-pipeline/v1) printf '%s/application/onboarding/checklists/github_pipeline_v1.sh' "${LLM_TEAM_ROOT}" ;;
    *) return 1 ;;
  esac
}

onboarding_list_schemas() {
  printf '%s\n' "github-pipeline/v1"
}

onboarding_preset_load() {
  local schema="$1" path
  if [ -z "${schema}" ]; then
    printf 'onboarding_preset_load: schema id required\n' >&2
    return 1
  fi
  if ! path="$(_onboarding_preset_path "${schema}")"; then
    printf 'onboarding_preset_load: unknown schema: %s\n' "${schema}" >&2
    return 1
  fi
  if [ ! -f "${path}" ]; then
    printf 'onboarding_preset_load: preset file missing: %s\n' "${path}" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  . "${path}"
}

# yq 로 target.yaml 의 onboarding.acks.<key>.value 가 true 인지 확인.
# 0 = ack true, 1 = ack false / 없음.
_onboarding_ack_is_true() {
  local yaml="$1" key="$2" val
  val="$(yq -r ".onboarding.acks.\"${key}\".value // false" "${yaml}" 2>/dev/null)"
  [ "${val}" = "true" ]
}

# target.yaml 의 onboarding.self_hosting 가 true 인지.
_onboarding_self_hosting() {
  local yaml="$1" val
  val="$(yq -r '.onboarding.self_hosting // false' "${yaml}" 2>/dev/null)"
  [ "${val}" = "true" ]
}

# target.yaml 의 onboarding.preset (TCC-ONBOARDING) — 기본값 github-pipeline/v1.
# Backward-compat: legacy `.onboarding.schema` 를 fallback 으로 받는다.
_onboarding_preset_id() {
  local yaml="$1" val
  val="$(yq -r '.onboarding.preset // .onboarding.schema // ""' "${yaml}" 2>/dev/null)"
  [ -n "${val}" ] || val="github-pipeline/v1"
  printf '%s' "${val}"
}

# target.yaml 의 onboarding.skip_flags 배열 (TCC-ONBOARDING / P2-5). 한 줄 1
# 항목으로 출력. 빈 배열/누락 시 무출력.
_onboarding_skip_flags() {
  local yaml="$1"
  yq -r '.onboarding.skip_flags // [] | .[]' "${yaml}" 2>/dev/null \
    | grep -v '^null$' \
    || true
}

# Internal: 주어진 preset item id 가 target 의 skip_flags 안에 있는지.
_onboarding_id_in_skip_flags() {
  local yaml="$1" id="$2" flag
  while IFS= read -r flag; do
    [ -n "${flag}" ] || continue
    if [ "${flag}" = "${id}" ]; then
      return 0
    fi
  done < <(_onboarding_skip_flags "${yaml}")
  return 1
}

# 한 줄 TSV emit. 메시지/remediation 의 탭/개행은 공백으로 평탄화.
_onboarding_emit() {
  local status="$1" id="$2" severity="$3" message="$4" remediation="$5"
  message="$(printf '%s' "${message}" | tr '\t\n' '  ')"
  remediation="$(printf '%s' "${remediation}" | tr '\t\n' '  ')"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "${status}" "${id}" "${severity}" "${message}" "${remediation}"
}

# onboarding_verify <target>
onboarding_verify() {
  local target="${1:-}"
  if [ -z "${target}" ]; then
    printf 'onboarding_verify: target required\n' >&2
    return 1
  fi
  local yaml="${LLM_TEAM_ROOT}/targets/${target}.yaml"
  if [ ! -f "${yaml}" ]; then
    printf 'onboarding_verify: target file missing: %s\n' "${yaml}" >&2
    return 1
  fi
  if ! command -v yq >/dev/null 2>&1; then
    printf 'onboarding_verify: yq required\n' >&2
    return 1
  fi
  # load_target 가 TARGET_* 를 export — preset check 에서 사용.
  if ! command -v load_target >/dev/null 2>&1; then
    # shellcheck source=../../lib/common.sh
    . "${LLM_TEAM_ROOT}/lib/common.sh"
  fi
  load_target "${target}" >/dev/null 2>&1 \
    || { printf 'onboarding_verify: load_target %s failed\n' "${target}" >&2; return 1; }

  local preset
  preset="$(_onboarding_preset_id "${yaml}")"
  onboarding_preset_load "${preset}" || return 1

  local self_hosting=0
  _onboarding_self_hosting "${yaml}" && self_hosting=1

  local block_fail=0
  local line id kind severity sh_only auto_fn ack_key summary
  while IFS=$'\t' read -r id kind severity sh_only auto_fn ack_key summary; do
    [ -n "${id}" ] || continue
    case "${id}" in '#'*) continue ;; esac
    [ "${auto_fn}" = "-" ] && auto_fn=""
    [ "${ack_key}" = "-" ] && ack_key=""

    if [ "${sh_only}" = "1" ] && [ "${self_hosting}" -ne 1 ]; then
      _onboarding_emit "SKIP" "${id}" "${severity}" \
        "self_hosting=false (skipped)" ""
      continue
    fi

    # TCC-ONBOARDING.skip_flags (P2-5): 명시적으로 합의된 항목만 점검을 건너뛴다.
    # SKIP 으로 emit 하되 message 에 사유를 남긴다.
    if _onboarding_id_in_skip_flags "${yaml}" "${id}"; then
      _onboarding_emit "SKIP" "${id}" "${severity}" \
        "skip_flags=true (operator-acknowledged)" ""
      continue
    fi

    local auto_status="" auto_msg=""
    if [ "${kind}" = "auto" ] || [ "${kind}" = "auto_or_ack" ]; then
      if [ -z "${auto_fn}" ]; then
        auto_status="FAIL"
        auto_msg="preset error: auto_fn empty"
      elif ! command -v "${auto_fn}" >/dev/null 2>&1; then
        auto_status="FAIL"
        auto_msg="preset error: ${auto_fn} not defined"
      else
        if auto_msg="$("${auto_fn}" 2>&1)"; then
          auto_status="PASS"
        else
          auto_status="FAIL"
        fi
      fi
    fi

    local ack_true=0
    if [ "${kind}" = "ack" ] || [ "${kind}" = "auto_or_ack" ]; then
      _onboarding_ack_is_true "${yaml}" "${ack_key}" && ack_true=1
    fi

    local final_status="" final_msg="${summary}"
    case "${kind}" in
      auto)
        final_status="${auto_status}"
        final_msg="${auto_msg:-${summary}}"
        ;;
      ack)
        if [ "${ack_true}" -eq 1 ]; then
          final_status="PASS"
          final_msg="ack ${ack_key} = true"
        else
          final_status="FAIL"
          final_msg="no ack recorded for ${ack_key}"
        fi
        ;;
      auto_or_ack)
        if [ "${auto_status}" = "PASS" ]; then
          final_status="PASS"
          final_msg="${auto_msg:-${summary}}"
        elif [ "${ack_true}" -eq 1 ]; then
          final_status="PASS"
          final_msg="ack ${ack_key} = true (auto check failed: ${auto_msg})"
        else
          final_status="FAIL"
          final_msg="${auto_msg:-${summary}}"
        fi
        ;;
      *)
        final_status="FAIL"
        final_msg="preset error: unknown kind '${kind}'"
        ;;
    esac

    local remediation=""
    if [ "${final_status}" = "FAIL" ]; then
      if command -v preset_remediation >/dev/null 2>&1; then
        remediation="$(preset_remediation "${id}" 2>/dev/null || true)"
      fi
    fi

    if [ "${final_status}" = "FAIL" ] && [ "${severity}" = "warn" ]; then
      final_status="WARN"
    fi

    _onboarding_emit "${final_status}" "${id}" "${severity}" \
      "${final_msg}" "${remediation}"

    if [ "${final_status}" = "FAIL" ]; then
      block_fail=$((block_fail + 1))
    fi
  done < <(preset_items)

  if [ "${block_fail}" -gt 0 ]; then
    return 2
  fi
  return 0
}
