#!/usr/bin/env bash
# adapters/cycle_bundle/in_memory.sh
#
# Filesystem 어댑터의 의미적 등가물. backing store 는 LLM_TEAM_INMEM_CB_DIR
# 아래의 디렉토리들 — 즉 "사실상 filesystem" 이지만 LLM_TEAM_ROOT/workdir 와
# 격리된 별도 root 를 쓰므로 테스트에서 cleanup 이 자명하다.

_cb_inmem_root() {
  printf '%s' "${LLM_TEAM_INMEM_CB_DIR:-/tmp/llm-team-inmem-cb-default}"
}

cb_open() {
  local cycle_id="$1" target="$2" role="$3" manifest_id="$4" lease_token="${5:-}"
  if [ "${LLM_TEAM_CYCLE_BUNDLE_DISABLED:-0}" = "1" ]; then
    return 0
  fi
  if [ -z "${cycle_id}" ] || [ -z "${target}" ] || [ -z "${role}" ]; then
    return 0
  fi
  local root path
  root="$(_cb_inmem_root)"
  path="${root}/${target}/cycles/${cycle_id}"
  if ! mkdir -p "${path}/diff" "${path}/attempts" 2>/dev/null; then
    return 0
  fi
  if [ ! -f "${path}/pidfile.json" ]; then
    jq -cn \
      --arg pid "$$" \
      --arg host "$(hostname 2>/dev/null || echo unknown)" \
      --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg manifest_id "${manifest_id}" \
      --arg lease_token "${lease_token}" \
      '{pid:$pid, hostname:$host, started_at:$started_at, manifest_id:$manifest_id, lease_token:(if $lease_token=="" then null else $lease_token end)}' \
      > "${path}/pidfile.json.tmp" \
      && mv "${path}/pidfile.json.tmp" "${path}/pidfile.json"
  fi
  printf '%s' "${path}"
}

cb_get_path() {
  local handle="${1:-}"
  [ -n "${handle}" ] && [ -d "${handle}" ] && printf '%s' "${handle}"
}

# 내부: atomic write 헬퍼 (I4). target 디렉토리 자동 생성.
_cb_inmem_atomic_write() {
  local handle="$1" name="$2" src="$3"   # src 는 파일 경로 또는 '-' (stdin)
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  local dst="${handle}/${name}"
  mkdir -p "$(dirname "${dst}")" 2>/dev/null
  local tmp="${dst}.tmp.$$"
  if [ "${src}" = "-" ]; then
    cat > "${tmp}" || { rm -f "${tmp}"; return 1; }
  else
    cp "${src}" "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 1; }
  fi
  mv "${tmp}" "${dst}"
}

cb_capture_blob_text() {
  local handle="$1" name="$2" text="${3:-}"
  [ -n "${handle}" ] || return 0
  printf '%s' "${text}" | _cb_inmem_atomic_write "${handle}" "${name}" "-"
}

cb_capture_blob_file() {
  local handle="$1" name="$2" path="$3"
  [ -n "${handle}" ] || return 0
  [ -f "${path}" ] || return 0
  _cb_inmem_atomic_write "${handle}" "${name}" "${path}"
}

cb_capture_blob_stdin() {
  local handle="$1" name="$2"
  [ -n "${handle}" ] || { cat >/dev/null; return 0; }
  _cb_inmem_atomic_write "${handle}" "${name}" "-"
}
cb_capture_attempt() {
  local handle="$1" idx="$2" envelope_ref="$3" diagnostics_ref="$4" meta_json="$5"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  local dir="${handle}/attempts/${idx}"
  mkdir -p "${dir}" 2>/dev/null
  if [ -f "${envelope_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/envelope.json" "${envelope_ref}"
  fi
  if [ -f "${diagnostics_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/diagnostics.txt" "${diagnostics_ref}"
  fi
  cb_capture_blob_text "${handle}" "attempts/${idx}/lr_meta.json" "${meta_json}"
}
# Internal: promote 상태를 disk 마커로 표현 (in_memory 도 결국 fs 백엔드).
_cb_inmem_promoted() { [ -f "$1/.promoted" ]; }

cb_promote_to_full() {
  local handle="$1" reason="${2:-}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  : > "${handle}/.promoted" 2>/dev/null
  # reason 누적 — JSON Lines 로 파일에 append (finalize 시 array 로 변환).
  if [ -n "${reason}" ]; then
    printf '%s\n' "${reason}" >> "${handle}/.failure_reasons"
  fi
}

cb_finalize() {
  local handle="$1" result="${2:-error}" extra_json="${3:-{\}}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  if [ -f "${handle}/.finalized" ]; then
    log_warn "cb_finalize: already finalized at ${handle} (I7)"
    return 0
  fi
  # Slim tier: ok 결과 + promote 이력 없음 → diagnostics.txt 삭제.
  if [ "${result}" = "ok" ] && ! _cb_inmem_promoted "${handle}"; then
    rm -f "${handle}/diagnostics.txt" 2>/dev/null
    rm -f "${handle}/diff/pre.dirty.diff" 2>/dev/null
  fi
  # failure_reasons 배열 구성.
  local reasons_json='[]'
  if [ -f "${handle}/.failure_reasons" ]; then
    reasons_json="$(jq -R . "${handle}/.failure_reasons" | jq -s .)"
  fi
  jq -cn \
    --arg result "${result}" \
    --arg finalized_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson failure_reasons "${reasons_json}" \
    --argjson extra "${extra_json}" \
    '$extra + {result:$result, finalized_at:$finalized_at, failure_reasons:$failure_reasons}' \
    > "${handle}/summary.json.tmp" \
    && mv "${handle}/summary.json.tmp" "${handle}/summary.json"
  # 마감 표식.
  : > "${handle}/.finalized"
  rm -f "${handle}/pidfile.json" 2>/dev/null
}

cb_collect_abandoned() {
  local target="$1"
  [ -n "${target}" ] || return 0
  local root cycles_dir
  root="$(_cb_inmem_root)"
  cycles_dir="${root}/${target}/cycles"
  [ -d "${cycles_dir}" ] || return 0
  local d pid
  for d in "${cycles_dir}"/*/; do
    [ -d "${d}" ] || continue
    [ -f "${d}/summary.json" ] && continue   # already finalized
    [ -f "${d}/pidfile.json" ] || continue
    pid="$(jq -r '.pid // empty' "${d}/pidfile.json" 2>/dev/null)"
    if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
      # pid 죽었음 — abandoned stamp.
      cb_finalize "${d%/}" "abandoned" "$(jq -n '{abandoned_detected_at: now | todateiso8601}')"
    fi
    # alive pid 는 보호 (no-op).
  done
}
