#!/usr/bin/env bash
# adapters/workspace/in_memory.sh
#
# In-memory test adapter for the workspace port.
# 외부 git/network 의존 없이 결정적으로 격리된 작업 단위 디렉토리, patch 적용,
# branch publish 흉내, 그리고 SOC-MERGE-POLICY 의 base/HEAD 비교를 위한
# branch → sha 기록을 제공한다.
#
# 디렉토리 레이아웃 (격리: ${LLM_TEAM_INMEM_WS_DIR}):
#   <ROOT>/<target>/repo/                        # canonical clone (빈 디렉토리)
#   <ROOT>/<target>/wt/<unit_id>/                # unit workspace
#   <ROOT>/<target>/wt/<unit_id>/.inmem-meta.json
#       {branch, base_branch, base_sha}          # ws_ensure 시 기록
#   <ROOT>/<target>/wt/<unit_id>/.published      # ws_publish_branch 마커
#   <ROOT>/<target>/branches/<safe-branch>/head  # head sha (publish 시 갱신)
#   <ROOT>/<target>/branches/<safe-branch>/base  # base sha (publish 시 기록)
#
# Patch 형식 (in_memory 한정):
#   JSON 배열 [{ "path": "rel/path", "content": "..." }, ...]
#   git_worktree 의 unified diff 와 의도적으로 다름 — fixture 단순화 목적.
#
# Sha 결정성:
#   head_sha = sha1( "PATH:<rel>\n<content>\n" 을 모든 파일에 대해 LC_ALL=C
#               sort 후 concat ) — 동일한 내용 + 동일한 파일 집합이면 동일 sha.
#   base_sha = ws_ensure 시점에 base_branch 의 head 를 스냅샷.
#   integration 초기 head = sha1("init:<target>") — ws_ensure_clone 시 1회.
#
# 환경변수:
#   LLM_TEAM_INMEM_WS_DIR        루트 디렉토리. 미설정 시 source 시점에
#                                mktemp -d 후 export.
#   LLM_TEAM_INTEGRATION_BRANCH  통합 브랜치 이름 (기본 'integration').
#   TARGET_NAME                  현재 target. 대부분의 함수가 implicit context
#                                로 참조 (git_worktree adapter 와 동일 규약).

# 루트 확보: 미설정이면 mktemp -d 후 export. (lazy init 은 path-resolver 가
# command substitution 안에서 호출되어 export 가 부모 셸에 전파되지 않으므로
# eager init 사용. persistent_store/in_memory.sh 와 동일 패턴.)
if [ -z "${LLM_TEAM_INMEM_WS_DIR:-}" ]; then
  LLM_TEAM_INMEM_WS_DIR="$(mktemp -d -t llm-team-inmem-ws.XXXXXX 2>/dev/null \
    || mktemp -d "${TMPDIR:-/tmp}/llm-team-inmem-ws.XXXXXX")"
  export LLM_TEAM_INMEM_WS_DIR
fi

# ----------------------------------------------------------------------------
# Internal helpers (_in_memory_*)
# ----------------------------------------------------------------------------

# Resolve target name: explicit arg → TARGET_NAME → fail.
_in_memory_ws_resolve_target() {
  if [ -n "${1:-}" ]; then
    printf '%s' "$1"
  elif [ -n "${TARGET_NAME:-}" ]; then
    printf '%s' "${TARGET_NAME}"
  else
    return 1
  fi
}

_in_memory_ws_target_dir() {
  local t
  t="$(_in_memory_ws_resolve_target "${1:-}")" || return 1
  printf '%s/%s' "${LLM_TEAM_INMEM_WS_DIR}" "${t}"
}

_in_memory_ws_clone_dir() {
  local td
  td="$(_in_memory_ws_target_dir "${1:-}")" || return 1
  printf '%s/repo' "${td}"
}

_in_memory_ws_unit_dir() {
  local unit_id="$1" target="${2:-}"
  local td
  td="$(_in_memory_ws_target_dir "${target}")" || return 1
  printf '%s/wt/%s' "${td}" "${unit_id}"
}

# Branch dir: branch 이름의 '/' 를 '__' 로 치환해 안전한 디렉토리명으로.
_in_memory_ws_safe_branch() {
  local b="$1"
  printf '%s' "${b//\//__}"
}

_in_memory_ws_branch_dir() {
  local target="$1" branch="$2"
  local td safe
  td="$(_in_memory_ws_target_dir "${target}")" || return 1
  safe="$(_in_memory_ws_safe_branch "${branch}")"
  printf '%s/branches/%s' "${td}" "${safe}"
}

# Initialize a branch's head/base if not yet set. Deterministic seed sha.
_in_memory_ws_init_branch() {
  local target="$1" branch="$2"
  local bdir
  bdir="$(_in_memory_ws_branch_dir "${target}" "${branch}")" || return 1
  if [ -f "${bdir}/head" ] && [ -f "${bdir}/base" ]; then
    return 0
  fi
  mkdir -p "${bdir}" || return 1
  local sha
  sha="$(printf 'init:%s:%s' "${target}" "${branch}" | shasum -a 1 | awk '{print $1}')"
  printf '%s' "${sha}" >"${bdir}/head"
  printf '%s' "${sha}" >"${bdir}/base"
}

# Compute deterministic sha from the contents of a unit workspace.
# 메타 파일(.inmem-meta.json, .published) 은 제외 — sha 는 "코드 내용" 만 반영.
_in_memory_ws_compute_unit_sha() {
  local dir="$1"
  if [ ! -d "${dir}" ]; then
    # sha1 of empty input.
    printf 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
    return 0
  fi
  (
    cd "${dir}" || exit 1
    find . -type f \
      \! -name '.inmem-meta.json' \
      \! -name '.published' \
      | LC_ALL=C sort \
      | while IFS= read -r f; do
          printf 'PATH:%s\n' "${f}"
          cat "${f}"
          printf '\n'
        done
  ) | shasum -a 1 | awk '{print $1}'
}

# ----------------------------------------------------------------------------
# Public port functions (PORT_WORKSPACE_REQUIRED_FUNCTIONS)
# ----------------------------------------------------------------------------

# ws_ensure_clone <target>
# canonical clone 디렉토리 mkdir + integration 브랜치 초기 sha 기록.
# stdout: clone path.
ws_ensure_clone() {
  local target
  target="$(_in_memory_ws_resolve_target "${1:-}")" || {
    log_error "ws_ensure_clone: target name is required (arg or TARGET_NAME)"
    return 1
  }
  local clone_dir
  clone_dir="$(_in_memory_ws_target_dir "${target}")/repo"
  mkdir -p "${clone_dir}" || return 1
  _in_memory_ws_init_branch "${target}" "${LLM_TEAM_INTEGRATION_BRANCH:-integration}" \
    || return 1
  printf '%s\n' "${clone_dir}"
}

# ws_ensure <unit_id> [base_branch=integration]  → echo workspace path
# 멱등: 두 번째 호출은 같은 경로 반환.
ws_ensure() {
  local unit_id="$1"
  local base_branch="${2:-${LLM_TEAM_INTEGRATION_BRANCH:-integration}}"
  if [ -z "${unit_id}" ]; then
    log_error "ws_ensure: unit_id is required"
    return 1
  fi
  if [ -z "${TARGET_NAME:-}" ]; then
    log_error "ws_ensure: TARGET_NAME must be set (call load_target first)"
    return 1
  fi
  local clone_dir
  clone_dir="$(_in_memory_ws_clone_dir "")" || return 1
  if [ ! -d "${clone_dir}" ]; then
    log_error "ws_ensure: canonical clone missing at ${clone_dir}; call ws_ensure_clone first"
    return 1
  fi
  local wt_dir
  wt_dir="$(_in_memory_ws_unit_dir "${unit_id}")" || return 1
  if [ -f "${wt_dir}/.inmem-meta.json" ]; then
    # Reuse — idempotent.
    printf '%s\n' "${wt_dir}"
    return 0
  fi
  mkdir -p "${wt_dir}" || return 1
  # base_branch 가 아직 없으면 결정적 seed 로 초기화.
  _in_memory_ws_init_branch "${TARGET_NAME}" "${base_branch}" || return 1
  local base_bdir base_sha meta
  base_bdir="$(_in_memory_ws_branch_dir "" "${base_branch}")" || return 1
  base_sha="$(cat "${base_bdir}/head")"
  meta="$(jq -nc \
    --arg branch "llm-team/${unit_id}" \
    --arg base_branch "${base_branch}" \
    --arg base_sha "${base_sha}" \
    '{branch: $branch, base_branch: $base_branch, base_sha: $base_sha}')" || {
      log_error "ws_ensure: failed to compose meta JSON"
      rm -rf "${wt_dir}" 2>/dev/null || true
      return 1
    }
  printf '%s' "${meta}" >"${wt_dir}/.inmem-meta.json" || {
    rm -rf "${wt_dir}" 2>/dev/null || true
    return 1
  }
  printf '%s\n' "${wt_dir}"
}

# ws_path_of <unit_id>  → echo path | empty
ws_path_of() {
  local unit_id="$1"
  if [ -z "${unit_id}" ] || [ -z "${TARGET_NAME:-}" ]; then
    return 0
  fi
  local wt_dir
  wt_dir="$(_in_memory_ws_unit_dir "${unit_id}")" || return 0
  if [ -f "${wt_dir}/.inmem-meta.json" ]; then
    printf '%s\n' "${wt_dir}"
  fi
}

# ws_apply_patch <unit_id> <patch_text_or_file>
# in_memory 한정 형식: JSON 배열 [{"path","content"}, ...].
# 멱등: 동일 entry 두 번 적용 → 같은 결과 (overwrite).
# 실패 시 워크스페이스를 변경하지 않음 (entry 적용 전 검증, staging 후 mv).
ws_apply_patch() {
  local unit_id="$1" patch_arg="$2"
  if [ -z "${unit_id}" ] || [ -z "${patch_arg}" ]; then
    log_error "ws_apply_patch: unit_id and patch are required"
    return 1
  fi
  local wt_dir
  wt_dir="$(_in_memory_ws_unit_dir "${unit_id}")" || return 1
  if [ ! -f "${wt_dir}/.inmem-meta.json" ]; then
    log_error "ws_apply_patch: workspace not found for unit '${unit_id}'"
    return 1
  fi
  local payload
  if [ -f "${patch_arg}" ]; then
    payload="$(cat "${patch_arg}")"
  else
    payload="${patch_arg}"
  fi
  if ! printf '%s' "${payload}" \
       | jq -e 'type == "array" and (all(.[]; type == "object" and has("path") and has("content") and (.path | type == "string") and (.content | type == "string")))' \
       >/dev/null 2>&1; then
    log_error "ws_apply_patch: in_memory adapter expects JSON array of {path:string, content:string}"
    return 1
  fi
  # Pre-validate every path BEFORE writing anything (I2: 실패 시 롤백).
  local count i path
  count="$(printf '%s' "${payload}" | jq 'length')"
  i=0
  while [ "${i}" -lt "${count}" ]; do
    path="$(printf '%s' "${payload}" | jq -r ".[${i}].path")"
    if [ -z "${path}" ]; then
      log_error "ws_apply_patch: entry ${i} has empty path"
      return 1
    fi
    case "${path}" in
      /*|*..*|.*)
        log_error "ws_apply_patch: path '${path}' must be a relative path without '..' or leading '.'"
        return 1
        ;;
    esac
    i=$((i + 1))
  done
  # Apply — overwrite 가 idempotent 함을 보장한다.
  # jq -j (raw, no trailing newline) + 직접 파일 redirect — `$()` round-trip 은
  # trailing newline 을 strip 하므로 사용 금지.
  i=0
  local tmp_path
  while [ "${i}" -lt "${count}" ]; do
    path="$(printf '%s' "${payload}" | jq -r ".[${i}].path")"
    mkdir -p "${wt_dir}/$(dirname "${path}")" || return 1
    tmp_path="${wt_dir}/${path}.tmp.$$"
    if ! printf '%s' "${payload}" | jq -j ".[${i}].content" >"${tmp_path}"; then
      rm -f "${tmp_path}" 2>/dev/null
      return 1
    fi
    mv "${tmp_path}" "${wt_dir}/${path}" || { rm -f "${tmp_path}" 2>/dev/null; return 1; }
    i=$((i + 1))
  done
}

# ws_publish_branch <unit_id> [branch_name=llm-team/<unit_id>]
# unit 의 현재 contents 로 head sha 를 계산해 branch 메타에 기록.
ws_publish_branch() {
  local unit_id="$1"
  local branch="${2:-llm-team/${unit_id}}"
  if [ -z "${unit_id}" ]; then
    log_error "ws_publish_branch: unit_id is required"
    return 1
  fi
  if [ -z "${TARGET_NAME:-}" ]; then
    log_error "ws_publish_branch: TARGET_NAME must be set"
    return 1
  fi
  local wt_dir
  wt_dir="$(_in_memory_ws_unit_dir "${unit_id}")" || return 1
  if [ ! -f "${wt_dir}/.inmem-meta.json" ]; then
    log_error "ws_publish_branch: workspace not found for unit '${unit_id}'"
    return 1
  fi
  local head_sha bdir base_sha
  head_sha="$(_in_memory_ws_compute_unit_sha "${wt_dir}")" || return 1
  bdir="$(_in_memory_ws_branch_dir "" "${branch}")" || return 1
  mkdir -p "${bdir}" || return 1
  printf '%s' "${head_sha}" >"${bdir}/head" || return 1
  base_sha="$(jq -r '.base_sha' "${wt_dir}/.inmem-meta.json")"
  printf '%s' "${base_sha}" >"${bdir}/base" || return 1
  printf '%s\n%s\n' "${branch}" "${head_sha}" >"${wt_dir}/.published"
}

# ws_destroy <unit_id>  (best-effort: 0 even if missing)
ws_destroy() {
  local unit_id="$1"
  if [ -z "${unit_id}" ] || [ -z "${TARGET_NAME:-}" ]; then
    return 0
  fi
  local wt_dir
  wt_dir="$(_in_memory_ws_unit_dir "${unit_id}" 2>/dev/null)" || return 0
  rm -rf "${wt_dir}" 2>/dev/null || true
  return 0
}

# ws_list <target>  → unit_ids (one per line)
ws_list() {
  local target
  target="$(_in_memory_ws_resolve_target "${1:-}")" || {
    log_error "ws_list: target is required (arg or TARGET_NAME)"
    return 1
  }
  local td="$(_in_memory_ws_target_dir "${target}")"
  local wt_dir="${td}/wt"
  if [ -d "${wt_dir}" ]; then
    ls -1 "${wt_dir}" 2>/dev/null || true
  fi
}

# ws_get_branch_head <repo> <branch>  → echo head sha
# `repo` 는 contract 시그니처 호환용 — in_memory 는 TARGET_NAME 컨텍스트의
# branch 메타에서 조회 (git_worktree adapter 와 동일 규약).
ws_get_branch_head() {
  local repo="$1" branch="$2"
  if [ -z "${repo}" ] || [ -z "${branch}" ]; then
    log_error "ws_get_branch_head: repo and branch are required"
    return 1
  fi
  local bdir
  bdir="$(_in_memory_ws_branch_dir "" "${branch}")" || return 1
  if [ ! -f "${bdir}/head" ]; then
    log_error "ws_get_branch_head: branch '${branch}' not found in in-memory workspace"
    return 1
  fi
  cat "${bdir}/head"
}

# ws_get_branch_base <repo> <branch>  → echo base sha
ws_get_branch_base() {
  local repo="$1" branch="$2"
  if [ -z "${repo}" ] || [ -z "${branch}" ]; then
    log_error "ws_get_branch_base: repo and branch are required"
    return 1
  fi
  local bdir
  bdir="$(_in_memory_ws_branch_dir "" "${branch}")" || return 1
  if [ ! -f "${bdir}/base" ]; then
    log_error "ws_get_branch_base: branch '${branch}' not found in in-memory workspace"
    return 1
  fi
  cat "${bdir}/base"
}
