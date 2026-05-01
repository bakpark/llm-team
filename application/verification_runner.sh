#!/usr/bin/env bash
# application/verification_runner.sh
#
# Caller-owned deterministic verification runner (RGC-VERIFICATION).
#
# 책임 (sub-phase7-verification.md):
#   • verification_run_for          — target.yaml 의 verification.commands 를
#                                     워크스페이스 안에서 실행하고 결과를 RGC
#                                     verification run envelope 로 영속화.
#   • verification_attach_to_manifest — 그 envelope 를 Context Manifest 에
#                                     `object_kind=verification_log` entry 로 첨부.
#
# 호출 위치 (SOC-CALLER-ORDER): runner.sh 의 manifest 빌드 단계 직후, 즉
# agent_prompt_assemble 직전. caller_dispatch 는 verification 을 직접 실행하지
# 않으며, verdict 처리 시 manifest 의 verification_log entry 를 참조만 한다.
#
# 호출 경계 (AGC-CALL-BOUNDARY):
#   • gh / git / curl / claude 직접 호출 금지.
#   • 사용자가 정의한 verification 명령은 `bash -c` 로 ws_path 안에서 실행한다
#     (이는 운영 동사가 아닌 read-only 검증 명령의 실행이므로 경계 위반이 아니다).
#   • 결과 영속화는 lib/verification.sh 헬퍼 + ps_put port 만 사용.
#
# 재사용:
#   • lib/verification.sh   verification_run_create / verification_log_store
#   • lib/context.sh        context_manifest_add_entry
#   • lib/ports/persistent_store  ps_put / ps_namespace_init
#
# Envelope 9 필드 (RGC-VERIFICATION 그대로):
#   verification_run_id, target_id, target_revision, commands_or_checks,
#   environment_fingerprint, started_at, finished_at, result, log_ref.
#   본 모듈은 commands_or_checks 를 `[{command, exit_code}, ...]` 객체 배열로
#   채워 실행 결과 추적성을 확보한다.

# ============================================================================
# Public API
# ============================================================================

# verification_run_for <target> <object_id> <object_revision> <ws_path> <commands_json>
#   commands_json: JSON 배열. 예: '["go test ./...","shellcheck lib/*.sh"]'.
#                  비어있거나 미지정이면 호출자가 ["true"] 등 기본값을 전달.
#   ws_path:       명령을 실행할 격리 워크스페이스 경로 (port `ws_*` 가 발급).
#   stdout:        생성된 verification run JSON 파일의 절대경로.
#   return:        0 PASS / 1 FAIL / 2 인자 오류 / 3 실행 환경 오류.
verification_run_for() {
  local target="$1" object_id="$2" object_revision="$3" ws_path="$4" commands_json="$5"

  if [ -z "${target}" ] || [ -z "${object_id}" ] || [ -z "${object_revision}" ] \
     || [ -z "${ws_path}" ] || [ -z "${commands_json}" ]; then
    log_error "verification_run_for: target, object_id, object_revision, ws_path, commands_json are required"
    return 2
  fi
  if [ ! -d "${ws_path}" ]; then
    log_error "verification_run_for: ws_path is not a directory: ${ws_path}"
    return 3
  fi
  if ! printf '%s' "${commands_json}" \
       | jq -e 'type == "array" and (all(.[]; type == "string"))' >/dev/null 2>&1; then
    log_error "verification_run_for: commands_json must be a JSON array of strings (got '${commands_json}')"
    return 2
  fi

  # ----- run envelope 생성 (lib/verification.sh 재사용) -----
  local run_path
  run_path="$(verification_run_create "${target}" "${object_id}" "${object_revision}")" || {
    log_error "verification_run_for: verification_run_create failed"
    return 3
  }

  local run_id
  run_id="$(jq -r '.verification_run_id' "${run_path}")"
  if [ -z "${run_id}" ] || [ "${run_id}" = "null" ]; then
    log_error "verification_run_for: cannot read verification_run_id from ${run_path}"
    return 3
  fi

  # ----- 명령 실행 + 로그 캡처 -----
  local log_file
  log_file="$(mktemp -t llm-team-vrun-log.XXXXXX)" || {
    log_error "verification_run_for: mktemp for log failed"
    return 3
  }

  local result="PASS"
  local cmds_jsonl=""  # JSON-lines for {command, exit_code}; later collected.
  local cmd ec
  while IFS= read -r cmd; do
    [ -n "${cmd}" ] || continue
    printf '\n=== CMD: %s\n' "${cmd}" >>"${log_file}"
    # `|| ec=$?` short-circuits 비0 종료라 set -e 와 무관하게 다음 명령으로 진행.
    ec=0
    ( cd "${ws_path}" && bash -c "${cmd}" ) >>"${log_file}" 2>&1 || ec=$?
    printf '=== EXIT: %s\n' "${ec}" >>"${log_file}"
    if [ "${ec}" -ne 0 ]; then
      result="FAIL"
    fi
    cmds_jsonl+="$(jq -nc --arg c "${cmd}" --argjson e "${ec}" '{command: $c, exit_code: $e}')"$'\n'
  done < <(printf '%s' "${commands_json}" | jq -r '.[]')

  # ----- 로그 ps_put 영속화 -----
  ps_namespace_init "verification_log" 2>/dev/null || true
  local log_payload
  log_payload="$(jq -nc \
                  --arg run_id "${run_id}" \
                  --arg content "$(cat "${log_file}")" \
                  '{verification_run_id: $run_id, log: $content}')" || {
    log_error "verification_run_for: failed to compose log payload JSON"
    rm -f "${log_file}" 2>/dev/null || true
    return 3
  }
  ps_put "verification_log" "${run_id}" "${log_payload}" >/dev/null 2>&1 || {
    log_error "verification_run_for: ps_put log persist failed (run_id=${run_id})"
    rm -f "${log_file}" 2>/dev/null || true
    return 3
  }

  # ----- run envelope 의 commands_or_checks 갱신 -----
  local cmds_array
  cmds_array="$(printf '%s' "${cmds_jsonl}" | jq -s '.')" || cmds_array='[]'
  local tmp_run="${run_path}.tmp.$$"
  jq --argjson c "${cmds_array}" '.commands_or_checks = $c' "${run_path}" >"${tmp_run}" \
    && mv "${tmp_run}" "${run_path}" || {
    log_error "verification_run_for: failed to update commands_or_checks"
    rm -f "${tmp_run}" "${log_file}" 2>/dev/null || true
    return 3
  }

  # ----- result + log_ref 마무리 (lib/verification.sh) -----
  local log_ref="ps://verification_log/${run_id}"
  verification_log_store "${run_path}" "${result}" "${log_ref}" || {
    log_error "verification_run_for: verification_log_store failed"
    rm -f "${log_file}" 2>/dev/null || true
    return 3
  }

  rm -f "${log_file}" 2>/dev/null || true
  printf '%s\n' "${run_path}"

  if [ "${result}" = "PASS" ]; then
    return 0
  fi
  return 1
}

# verification_attach_to_manifest <manifest_path> <run_path>
#   manifest_path: context_manifest_create 가 만든 manifest 파일.
#   run_path:      verification_run_for 가 출력한 run envelope 파일 경로.
#   stdout:        없음.
#   return:        0 ok / 비0 실패.
verification_attach_to_manifest() {
  local manifest_path="$1" run_path="$2"
  if [ -z "${manifest_path}" ] || [ -z "${run_path}" ]; then
    log_error "verification_attach_to_manifest: manifest_path and run_path are required"
    return 1
  fi
  if [ ! -f "${manifest_path}" ]; then
    log_error "verification_attach_to_manifest: manifest not found: ${manifest_path}"
    return 1
  fi
  if [ ! -f "${run_path}" ]; then
    log_error "verification_attach_to_manifest: run file not found: ${run_path}"
    return 1
  fi
  local run_id result log_ref revision_pin
  run_id="$(jq -r '.verification_run_id // empty' "${run_path}")"
  result="$(jq -r '.result // empty' "${run_path}")"
  log_ref="$(jq -r '.log_ref // empty' "${run_path}")"
  if [ -z "${run_id}" ]; then
    log_error "verification_attach_to_manifest: run file missing verification_run_id"
    return 1
  fi
  # revision_pin: 결정적 — run envelope 파일 내용의 sha1.
  revision_pin="$(shasum -a 1 "${run_path}" | awk '{print $1}')"
  context_manifest_add_entry "${manifest_path}" \
    "verification_log" \
    "${run_id}" \
    "${log_ref}" \
    "${revision_pin}" \
    true \
    "Caller-deterministic verification result (${result}) for agent verdict"
}
