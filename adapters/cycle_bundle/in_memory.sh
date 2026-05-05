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

# 나머지 함수는 후속 task 에서 구현 (현 단계는 stub 유지).
cb_capture_blob_text() { :; }
cb_capture_blob_file() { :; }
cb_capture_blob_stdin() { :; }
cb_capture_attempt() { :; }
cb_promote_to_full() { :; }
cb_finalize() { :; }
cb_collect_abandoned() { :; }
