#!/usr/bin/env bash
# adapters/llm_runner/fake.sh
#
# Test adapter for the llm_runner port. Replaces `claude` CLI with a
# deterministic fixture lookup, used by Phase 5 / 9 의 결정적 파이프라인 검증.
#
# 시그니처(#ARC-CALL-SEMANTICS, port I3): prompt 는 stdin 으로 들어온다.
#
# Fixture key 도출 (lr_invoke 가 prompt 본문만 받으므로 콘텐츠 기반):
#   prompt 의 첫 ~10줄에서 다음 세 헤더를 grep 으로 추출한다:
#     # Role: <role>
#     # Operation: <operation>
#     # Manifest-id: <manifest_id>
#   세 헤더 중 하나라도 없으면 비0 + stderr "no role/operation/manifest header in prompt".
#
# Lookup 우선 순위 (fixture 디렉토리 = $LLM_TEAM_FAKE_FIXTURE_DIR):
#   1. <dir>/<role>-<operation>-<manifest_id>.json   (시나리오별 정확 매칭, 파일)
#   2. <dir>/<role>-<operation>-<manifest_id>        (시나리오별 정확 매칭, 시퀀스 디렉토리)
#   3. <dir>/<role>-<operation>.json                 (기본, 파일)
#   4. <dir>/<role>-<operation>                      (기본, 시퀀스 디렉토리)
#   5. <dir>/<role>.json                             (최후 fallback, 파일)
#   6. <dir>/<role>                                  (최후 fallback, 시퀀스 디렉토리)
#   미존재 시 비0 + stderr "no fixture for ...".
#
# 시퀀스 fixture (반복 호출 시 다른 envelope 반환):
#   매칭 결과가 디렉토리이면 그 안의 0.json, 1.json, 2.json ... 을 호출 순서대로
#   반환한다. 호출 카운터는 ps_put 으로 namespace=llm_runner_seq 에 영속화한다 —
#   카운터 키는 매칭 디렉토리 경로를 기반으로 안정적으로 도출되며, 동일 fixture
#   를 반복 호출하면 시퀀스가 재개된다 (결정적).
#
# Envelope wrapping 정책 (LLM_TEAM_FAKE_WRAP_FENCED):
#   • 미설정 / "auto" (기본): fixture 가 순수 JSON 이면 ```json fenced block 으로
#     wrapping 후 출력 — 후속 agent_output_parse 가 fenced block 에서 envelope
#     를 추출한다. 이미 fenced block 형식이면 그대로 출력.
#   • "1" / "true" / "yes": 항상 fenced block 으로 wrapping (raw fixture 가 이미
#     fenced 이면 wrapping 으로 인해 invalid 가 될 수 있다).
#   • "0" / "false" / "no": wrapping 하지 않고 그대로 출력.
#
# 환경변수 요약:
#   LLM_TEAM_FAKE_FIXTURE_DIR     필수. fixture 파일/디렉토리 루트.
#   LLM_TEAM_FAKE_WRAP_FENCED     선택. 기본 "auto".
#   LLM_TEAM_FAKE_PWD_LOG         선택. 설정 시 호출 시점의 pwd 한 줄을 append.
#                                 cwd 격리 검증 테스트용.

# Internal: prompt 의 첫 N줄에서 헤더 값 추출. echo value or empty.
_fake_extract_header() {
  local prompt="$1" key="$2"
  printf '%s\n' "${prompt}" \
    | head -n 10 \
    | grep -m1 "^# ${key}:" \
    | sed -E "s/^# ${key}:[[:space:]]*//"
}

# Internal: 매칭 디렉토리를 안정적인 ps_put 키로 변환.
_fake_seq_key() {
  printf '%s' "$1" | tr '/' '_' | sed 's/[^A-Za-z0-9_-]/_/g'
}

# Internal: 다음 호출 인덱스를 반환하고 카운터를 1 증가시켜 ps_put 으로 영속화.
# 출력: 0,1,2,... (현재 호출 번호)
_fake_seq_next() {
  local key="$1"
  local current=0
  if ps_exists "llm_runner_seq" "${key}" 2>/dev/null; then
    current="$(ps_get "llm_runner_seq" "${key}" 2>/dev/null | jq -r '.count // 0')"
    case "${current}" in
      ''|*[!0-9]*) current=0 ;;
    esac
  fi
  local next=$((current + 1))
  ps_put "llm_runner_seq" "${key}" "{\"count\":${next}}" >/dev/null 2>&1 || true
  printf '%s' "${current}"
}

# Internal: fixture 파일 경로를 lookup 우선순위에 따라 결정. echo path or empty.
_fake_lookup_fixture() {
  local dir="$1" role="$2" op="$3" manifest="$4"
  local cand
  for cand in \
      "${dir}/${role}-${op}-${manifest}.json" \
      "${dir}/${role}-${op}-${manifest}" \
      "${dir}/${role}-${op}.json" \
      "${dir}/${role}-${op}" \
      "${dir}/${role}.json" \
      "${dir}/${role}"; do
    if [ -e "${cand}" ]; then
      printf '%s' "${cand}"
      return 0
    fi
  done
  return 1
}

# Internal: 콘텐츠 wrapping 정책 적용 후 stdout 에 출력.
_fake_emit() {
  local content="$1"
  local mode="${LLM_TEAM_FAKE_WRAP_FENCED:-auto}"
  case "${mode}" in
    1|true|yes|TRUE|YES)
      printf '```json\n%s\n```\n' "${content}"
      return 0
      ;;
    0|false|no|FALSE|NO)
      printf '%s\n' "${content}"
      return 0
      ;;
  esac
  # auto: wrap if pure JSON and not already fenced.
  if printf '%s' "${content}" | grep -q '^[[:space:]]*```'; then
    printf '%s\n' "${content}"
    return 0
  fi
  if printf '%s' "${content}" | jq -e . >/dev/null 2>&1; then
    printf '```json\n%s\n```\n' "${content}"
  else
    printf '%s\n' "${content}"
  fi
}

# lr_invoke
#   stdin: prompt 본문 (port I3)
#   stdout: fixture 콘텐츠 (정책에 따라 fenced wrapping)
#   stderr: 어댑터 진단/에러
#   return (#ARC-EXIT-CLASSES via lr_classify_exit):
#     0   ok
#     64  transport_error      빈 prompt (port I2)
#     65  malformed_output     헤더(Role/Operation/Manifest-id) 누락
#     66  adapter_unavailable  LLM_TEAM_FAKE_FIXTURE_DIR 미설정/부재
#     67  malformed_output     매칭 fixture 부재
lr_invoke() {
  local prompt
  prompt="$(cat)"
  if [ -z "${prompt}" ]; then
    log_error "lr_invoke: empty prompt"
    return 64
  fi

  if [ -n "${LLM_TEAM_FAKE_PWD_LOG:-}" ]; then
    pwd >>"${LLM_TEAM_FAKE_PWD_LOG}" 2>/dev/null || true
  fi

  local role op manifest
  role="$(_fake_extract_header "${prompt}" "Role")"
  op="$(_fake_extract_header "${prompt}" "Operation")"
  manifest="$(_fake_extract_header "${prompt}" "Manifest-id")"
  if [ -z "${role}" ] || [ -z "${op}" ] || [ -z "${manifest}" ]; then
    log_error "lr_invoke: no role/operation/manifest header in prompt (role='${role}' op='${op}' manifest='${manifest}')"
    return 65
  fi

  local dir="${LLM_TEAM_FAKE_FIXTURE_DIR:-}"
  if [ -z "${dir}" ]; then
    log_error "lr_invoke: LLM_TEAM_FAKE_FIXTURE_DIR is not set"
    return 66
  fi
  if [ ! -d "${dir}" ]; then
    log_error "lr_invoke: LLM_TEAM_FAKE_FIXTURE_DIR not a directory: ${dir}"
    return 66
  fi

  local match
  match="$(_fake_lookup_fixture "${dir}" "${role}" "${op}" "${manifest}")" || {
    log_error "lr_invoke: no fixture for role='${role}' operation='${op}' manifest='${manifest}' (dir=${dir})"
    return 67
  }

  local content_path="${match}"
  if [ -d "${match}" ]; then
    local seq_key idx
    seq_key="$(_fake_seq_key "${match}")"
    idx="$(_fake_seq_next "${seq_key}")"
    content_path="${match}/${idx}.json"
    if [ ! -f "${content_path}" ]; then
      log_error "lr_invoke: sequence fixture missing: ${content_path} (call_index=${idx}, dir=${match})"
      return 67
    fi
  fi

  local content
  content="$(cat "${content_path}")" || {
    log_error "lr_invoke: failed to read fixture: ${content_path}"
    return 67
  }

  # __MANIFEST_ID__ 를 prompt 에서 추출한 실제 manifest_id 로 치환한다.
  # agent_prompt_assemble 가 prompt 헤더의 __MANIFEST_ID__ 를 실제 id 로 치환하는
  # 것과 대칭 — fixture 가 envelope 의 manifest_id 필드를 placeholder 로 비워두면
  # runtime 에 자동으로 맞춰져 manifest 참조 검증을 통과한다.
  case "${content}" in
    *__MANIFEST_ID__*)
      content="$(printf '%s' "${content}" | awk -v mid="${manifest}" '{ gsub(/__MANIFEST_ID__/, mid); print }')"
      ;;
  esac

  # __PIN__ → 첫 entry 의 revision_pin (manifest fenced block 에서 추출).
  # __PIN_<object_id>__ → 해당 object_id 의 revision_pin.
  # revision_pin_revalidate 가 envelope pin 을 현재 live pin 과 비교하므로,
  # claim_transition 으로 pin 이 mutate 된 시점에도 fixture 가 자동으로 맞춰진다.
  case "${content}" in
    *__PIN__*|*__PIN_*)
      local manifest_json first_pin
      # Extract every ```json fenced block from the prompt and pick the first
      # one whose JSON has a non-empty `.entries` array (= Context Manifest).
      local _fake_blocks_dir _fake_block_idx=0 _fake_in_block=0 _fake_buf="" _fake_line
      _fake_blocks_dir="$(mktemp -d -t llm-team-fakelr-mfprobe.XXXXXX)"
      while IFS= read -r _fake_line || [ -n "${_fake_line}" ]; do
        if [ "${_fake_in_block}" -eq 0 ]; then
          case "${_fake_line}" in
            '```json'*) _fake_in_block=1; _fake_buf="" ;;
          esac
        else
          case "${_fake_line}" in
            '```'*)
              printf '%s' "${_fake_buf}" >"${_fake_blocks_dir}/${_fake_block_idx}.json"
              _fake_block_idx=$((_fake_block_idx + 1))
              _fake_in_block=0
              _fake_buf=""
              ;;
            *)
              _fake_buf="${_fake_buf}${_fake_line}"$'\n'
              ;;
          esac
        fi
      done <<<"${prompt}"
      manifest_json=""
      local _f
      for _f in "${_fake_blocks_dir}"/*.json; do
        [ -f "${_f}" ] || continue
        if jq -e 'select(.entries != null and (.entries|length) > 0)' "${_f}" >/dev/null 2>&1; then
          manifest_json="$(cat "${_f}")"
          break
        fi
      done
      rm -rf "${_fake_blocks_dir}"
      if [ -n "${manifest_json}" ]; then
        first_pin="$(printf '%s' "${manifest_json}" | jq -r '.entries[0].revision_pin // ""' 2>/dev/null)"
        if [ -n "${first_pin}" ]; then
          content="$(printf '%s' "${content}" | awk -v p="${first_pin}" '{ gsub(/__PIN__/, p); print }')"
        fi
        # __PIN_<object_id>__ — per-entry substitution.
        local entries_json
        entries_json="$(printf '%s' "${manifest_json}" | jq -c '.entries')"
        local idx oid pin_v
        idx=0
        while :; do
          oid="$(printf '%s' "${entries_json}" | jq -r ".[${idx}].object_id // empty" 2>/dev/null)"
          [ -n "${oid}" ] || break
          pin_v="$(printf '%s' "${entries_json}" | jq -r ".[${idx}].revision_pin // empty" 2>/dev/null)"
          if [ -n "${pin_v}" ]; then
            content="$(printf '%s' "${content}" | awk -v ph="__PIN_${oid}__" -v v="${pin_v}" '{ gsub(ph, v); print }')"
          fi
          idx=$((idx + 1))
        done
      fi
      ;;
  esac

  _fake_emit "${content}"
}
