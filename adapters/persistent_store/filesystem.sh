#!/usr/bin/env bash
# adapters/persistent_store/filesystem.sh
#
# Concrete adapter for the persistent_store port using the local filesystem.
#
# 디렉토리 규약:
#   namespace 는 슬래시(/) 를 포함할 수 있는 경로 컴포넌트.
#   실제 저장 위치는 ${LLM_TEAM_ROOT}/workdir/<namespace> 아래.
#   • 객체 (ps_put/get/delete/list_ids/exists)         → <namespace>/<id>.json
#   • 추가 전용 로그 (ps_append_log/read_log)          → <namespace>.jsonl
#   • 락 (ps_lock_acquire/release)                     → <namespace>/<id>.lockd  (mkdir 으로 atomic)
#
# 본 adapter 는 atomic write (tempfile + mv), atomic mkdir lock 을 사용해
# multi-writer 안전성을 확보한다.

# Internal: namespace path resolver.
_filesystem_namespace_dir() {
  printf '%s/workdir/%s' "${LLM_TEAM_ROOT}" "$1"
}
_filesystem_log_path() {
  printf '%s/workdir/%s.jsonl' "${LLM_TEAM_ROOT}" "$1"
}

# ----------------------------------------------------------------------------
# 객체 CRUD
# ----------------------------------------------------------------------------

# ps_namespace_init <namespace>
ps_namespace_init() {
  local ns="$1"
  if [ -z "${ns}" ]; then
    log_error "ps_namespace_init: namespace is required"
    return 1
  fi
  mkdir -p "$(_filesystem_namespace_dir "${ns}")" || return 1
}

# ps_put <namespace> <id> <json_string>
# Atomic: write to tempfile + rename.
ps_put() {
  local ns="$1" id="$2" payload="$3"
  if [ -z "${ns}" ] || [ -z "${id}" ]; then
    log_error "ps_put: namespace and id are required"
    return 1
  fi
  if ! printf '%s' "${payload}" | jq -e . >/dev/null 2>&1; then
    log_error "ps_put: payload is not valid JSON (ns=${ns} id=${id})"
    return 1
  fi
  local dir path tmp
  dir="$(_filesystem_namespace_dir "${ns}")"
  mkdir -p "${dir}" || return 1
  path="${dir}/${id}.json"
  tmp="${path}.tmp.$$"
  printf '%s' "${payload}" >"${tmp}" || return 1
  mv "${tmp}" "${path}" || { rm -f "${tmp}" 2>/dev/null || true; return 1; }
}

# ps_get <namespace> <id>  → echo json or empty
# return: 0 if found, 1 if missing, 2 on argument error
ps_get() {
  local ns="$1" id="$2"
  if [ -z "${ns}" ] || [ -z "${id}" ]; then
    log_error "ps_get: namespace and id are required"
    return 2
  fi
  local path
  path="$(_filesystem_namespace_dir "${ns}")/${id}.json"
  if [ ! -f "${path}" ]; then
    return 1
  fi
  cat "${path}"
}

# ps_delete <namespace> <id>  (best-effort: 0 even if missing)
ps_delete() {
  local ns="$1" id="$2"
  if [ -z "${ns}" ] || [ -z "${id}" ]; then
    log_error "ps_delete: namespace and id are required"
    return 1
  fi
  local path
  path="$(_filesystem_namespace_dir "${ns}")/${id}.json"
  rm -f "${path}" 2>/dev/null || true
  return 0
}

# ps_list_ids <namespace>  → ids (created order, oldest first)
ps_list_ids() {
  local ns="$1"
  if [ -z "${ns}" ]; then
    log_error "ps_list_ids: namespace is required"
    return 1
  fi
  local dir
  dir="$(_filesystem_namespace_dir "${ns}")"
  [ -d "${dir}" ] || return 0
  # mtime 오름차순 정렬 — find -newer 대신 stat ordering.
  ls -1tr "${dir}" 2>/dev/null \
    | grep -E '\.json$' \
    | sed 's/\.json$//'
}

# ps_exists <namespace> <id>  → 0 if exists, 1 otherwise
ps_exists() {
  local ns="$1" id="$2"
  [ -n "${ns}" ] && [ -n "${id}" ] || {
    log_error "ps_exists: namespace and id are required"
    return 2
  }
  [ -f "$(_filesystem_namespace_dir "${ns}")/${id}.json" ]
}

# ----------------------------------------------------------------------------
# Append-only log
# ----------------------------------------------------------------------------

# ps_append_log <namespace> <json_line>
# multi-writer 안전: open file 의 append mode 는 POSIX 적으로 atomic at line size.
ps_append_log() {
  local ns="$1" line="$2"
  if [ -z "${ns}" ]; then
    log_error "ps_append_log: namespace is required"
    return 1
  fi
  if ! printf '%s' "${line}" | jq -e . >/dev/null 2>&1; then
    log_error "ps_append_log: line is not valid JSON (ns=${ns})"
    return 1
  fi
  local path
  path="$(_filesystem_log_path "${ns}")"
  mkdir -p "$(dirname "${path}")" || return 1
  # jq -c 로 한 줄 보장.
  printf '%s' "${line}" | jq -c '.' >>"${path}" || return 1
}

# ps_read_log <namespace>  → all log lines (created order)
ps_read_log() {
  local ns="$1"
  if [ -z "${ns}" ]; then
    log_error "ps_read_log: namespace is required"
    return 1
  fi
  local path
  path="$(_filesystem_log_path "${ns}")"
  [ -f "${path}" ] || return 0
  cat "${path}"
}

# ----------------------------------------------------------------------------
# Atomic lock (lock-dir 방식)
# ----------------------------------------------------------------------------

_filesystem_lock_path() {
  printf '%s/workdir/%s/%s.lockd' "${LLM_TEAM_ROOT}" "$1" "$2"
}

# ps_lock_acquire <namespace> <id>  → 0 acquired, 1 contended
# atomic mkdir 를 사용해 race-free.
ps_lock_acquire() {
  local ns="$1" id="$2"
  if [ -z "${ns}" ] || [ -z "${id}" ]; then
    log_error "ps_lock_acquire: namespace and id are required"
    return 2
  fi
  local lock
  lock="$(_filesystem_lock_path "${ns}" "${id}")"
  mkdir -p "$(dirname "${lock}")" || return 1
  if mkdir "${lock}" 2>/dev/null; then
    return 0
  fi
  return 1
}

# ps_lock_release <namespace> <id>
ps_lock_release() {
  local ns="$1" id="$2"
  if [ -z "${ns}" ] || [ -z "${id}" ]; then
    log_error "ps_lock_release: namespace and id are required"
    return 1
  fi
  local lock
  lock="$(_filesystem_lock_path "${ns}" "${id}")"
  rm -rf "${lock}" 2>/dev/null || true
  return 0
}
