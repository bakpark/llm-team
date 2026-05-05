#!/usr/bin/env bash
# adapters/cycle_bundle/filesystem.sh
#
# 운영 어댑터. 디렉토리: ${LLM_TEAM_ROOT}/workdir/<target>/cycles/<cycle_id>/
# (또는 LLM_TEAM_ROOT_FS_OVERRIDE 가 설정된 경우 그 아래 — 테스트용).
# 권한: dir 0700, file 0600 (umask 077). workdir/ 는 이미 .gitignore.

_cb_fs_root() {
  printf '%s' "${LLM_TEAM_ROOT_FS_OVERRIDE:-${LLM_TEAM_ROOT}}"
}

_cb_fs_cycles_dir() {
  local target="$1"
  printf '%s/workdir/%s/cycles' "$(_cb_fs_root)" "${target}"
}

cb_open() {
  local cycle_id="$1" target="$2" role="$3" manifest_id="$4" lease_token="${5:-}"
  if [ "${LLM_TEAM_CYCLE_BUNDLE_DISABLED:-0}" = "1" ]; then
    return 0
  fi
  if [ -z "${cycle_id}" ] || [ -z "${target}" ] || [ -z "${role}" ]; then
    return 0
  fi
  local cycles path
  cycles="$(_cb_fs_cycles_dir "${target}")"
  path="${cycles}/${cycle_id}"
  # umask 077 → mkdir 후 chmod 0700 (umask 만으로는 macOS 에서 일관성 안 보장).
  ( umask 077 && mkdir -p "${path}/diff" "${path}/attempts" ) 2>/dev/null \
    || { log_warn "cb_open: mkdir failed for ${path}"; return 0; }
  chmod 0700 "${path}" 2>/dev/null || true
  # pidfile.json — atomic write + 0600.
  if [ ! -f "${path}/pidfile.json" ]; then
    local tmp="${path}/pidfile.json.tmp.$$"
    jq -cn \
      --arg pid "$$" \
      --arg host "$(hostname 2>/dev/null || echo unknown)" \
      --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg manifest_id "${manifest_id}" \
      --arg lease_token "${lease_token}" \
      '{pid:$pid, hostname:$host, started_at:$started_at, manifest_id:$manifest_id, lease_token:(if $lease_token=="" then null else $lease_token end)}' \
      > "${tmp}" \
      && chmod 0600 "${tmp}" \
      && mv "${tmp}" "${path}/pidfile.json"
  fi
  # Warn 임계 (디스크 안전망).
  local n_dirs
  n_dirs="$(find "${cycles}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  if [ -n "${n_dirs}" ] && [ "${n_dirs}" -gt "${LLM_TEAM_CYCLE_BUNDLE_WARN_THRESHOLD:-1000}" ]; then
    log_warn "cb_open: cycles/ dir count=${n_dirs} exceeds threshold; consider prune"
  fi
  printf '%s' "${path}"
}

cb_get_path() {
  local handle="${1:-}"
  [ -n "${handle}" ] && [ -d "${handle}" ] && printf '%s' "${handle}"
}

# 나머지는 후속 task.
cb_capture_blob_text() { :; }
cb_capture_blob_file() { :; }
cb_capture_blob_stdin() { :; }
cb_capture_attempt() { :; }
cb_promote_to_full() { :; }
cb_finalize() { :; }
cb_collect_abandoned() { :; }
