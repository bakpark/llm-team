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

_cb_fs_atomic_write() {
  local handle="$1" name="$2" src="$3"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  local dst="${handle}/${name}"
  ( umask 077 && mkdir -p "$(dirname "${dst}")" ) 2>/dev/null
  local tmp="${dst}.tmp.$$"
  if [ "${src}" = "-" ]; then
    cat > "${tmp}" || { rm -f "${tmp}"; return 1; }
  else
    cp "${src}" "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 1; }
  fi
  chmod 0600 "${tmp}" 2>/dev/null || true
  mv "${tmp}" "${dst}"
}

cb_capture_blob_text() {
  local handle="$1" name="$2" text="${3:-}"
  [ -n "${handle}" ] || return 0
  printf '%s' "${text}" | _cb_fs_atomic_write "${handle}" "${name}" "-"
}

cb_capture_blob_file() {
  local handle="$1" name="$2" path="$3"
  [ -n "${handle}" ] || return 0
  [ -f "${path}" ] || return 0
  _cb_fs_atomic_write "${handle}" "${name}" "${path}"
}

cb_capture_blob_stdin() {
  local handle="$1" name="$2"
  [ -n "${handle}" ] || { cat >/dev/null; return 0; }
  _cb_fs_atomic_write "${handle}" "${name}" "-"
}

cb_capture_attempt() {
  local handle="$1" idx="$2" envelope_ref="$3" diagnostics_ref="$4" meta_json="$5"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  if [ -f "${envelope_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/envelope.json" "${envelope_ref}"
  fi
  if [ -f "${diagnostics_ref}" ]; then
    cb_capture_blob_file "${handle}" "attempts/${idx}/diagnostics.txt" "${diagnostics_ref}"
  fi
  cb_capture_blob_text "${handle}" "attempts/${idx}/lr_meta.json" "${meta_json}"
}

_cb_fs_promoted() { [ -f "$1/.promoted" ]; }

cb_promote_to_full() {
  local handle="$1" reason="${2:-}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  : > "${handle}/.promoted" 2>/dev/null
  chmod 0600 "${handle}/.promoted" 2>/dev/null || true
  if [ -n "${reason}" ]; then
    printf '%s\n' "${reason}" >> "${handle}/.failure_reasons"
    chmod 0600 "${handle}/.failure_reasons" 2>/dev/null || true
  fi
}

cb_finalize() {
  local handle="$1" result="${2:-error}" extra_json="${3:-{\}}"
  [ -n "${handle}" ] || return 0
  [ -d "${handle}" ] || return 0
  if [ -f "${handle}/.finalized" ]; then
    log_warn "cb_finalize: already finalized at ${handle}"
    return 0
  fi
  if [ "${result}" = "ok" ] && ! _cb_fs_promoted "${handle}"; then
    rm -f "${handle}/diagnostics.txt" "${handle}/diff/pre.dirty.diff" 2>/dev/null
  fi
  local reasons_json='[]'
  if [ -f "${handle}/.failure_reasons" ]; then
    reasons_json="$(jq -R . "${handle}/.failure_reasons" | jq -s .)"
  fi
  local tmp="${handle}/summary.json.tmp.$$"
  jq -cn \
    --arg result "${result}" \
    --arg finalized_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson failure_reasons "${reasons_json}" \
    --argjson extra "${extra_json}" \
    '$extra + {result:$result, finalized_at:$finalized_at, failure_reasons:$failure_reasons}' \
    > "${tmp}" \
    && chmod 0600 "${tmp}" \
    && mv "${tmp}" "${handle}/summary.json"
  : > "${handle}/.finalized"
  rm -f "${handle}/pidfile.json" 2>/dev/null
}

cb_collect_abandoned() {
  local target="$1"
  [ -n "${target}" ] || return 0
  local cycles_dir
  cycles_dir="$(_cb_fs_cycles_dir "${target}")"
  [ -d "${cycles_dir}" ] || return 0
  local d pid
  for d in "${cycles_dir}"/*/; do
    [ -d "${d}" ] || continue
    [ -f "${d}/summary.json" ] && continue
    [ -f "${d}/pidfile.json" ] || continue
    pid="$(jq -r '.pid // empty' "${d}/pidfile.json" 2>/dev/null)"
    if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
      cb_finalize "${d%/}" "abandoned" "$(jq -n '{abandoned_detected_at: now | todateiso8601}')"
    fi
  done
}
