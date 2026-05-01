#!/usr/bin/env bash
# adapters/issue_tracker/in_memory.sh
#
# In-memory test adapter for the issue_tracker port.
# 모든 상태는 ${LLM_TEAM_INMEM_IT_DIR} (기본 mktemp -d) 아래의 JSON 파일로 영
# 속한다. 외부 의존(gh/curl/네트워크) 없이 결정적이며, 단일 프로세스 테스트를
# 가정한다 (atomic write 는 mktemp + mv).
#
# 디렉토리 레이아웃:
#   ${LLM_TEAM_INMEM_IT_DIR}/
#     _counters.json           (next num/id 카운터)
#     milestones/<num>.json
#     issues/<num>.json
#     prs/<num>.json
#     releases/<tag>.json
#     comments/issue-<num>.jsonl   (issue + pr 공유 — gh REST 와 동일)
#     comments/milestone-<num>.jsonl  (스캔용; description 에도 append)
#
# 가시성:
#   • it_*           — port API.
#   • _in_memory_*   — adapter 내부 헬퍼.
#
# 의미 호환:
#   • 상태 marker / cp-state encoding 은 github adapter 와 동일 문자열을
#     사용한다 (lib/state.sh state_marker / lib/labels.sh task_state_to_label).
#     → SOC 상태명을 그대로 저장.

# ----------------------------------------------------------------------------
# Root 확보
# ----------------------------------------------------------------------------
if [ -z "${LLM_TEAM_INMEM_IT_DIR:-}" ]; then
  LLM_TEAM_INMEM_IT_DIR="$(mktemp -d -t llm-team-inmem-it.XXXXXX 2>/dev/null \
    || mktemp -d "${TMPDIR:-/tmp}/llm-team-inmem-it.XXXXXX")"
  export LLM_TEAM_INMEM_IT_DIR
fi
mkdir -p "${LLM_TEAM_INMEM_IT_DIR}/milestones" \
         "${LLM_TEAM_INMEM_IT_DIR}/issues" \
         "${LLM_TEAM_INMEM_IT_DIR}/prs" \
         "${LLM_TEAM_INMEM_IT_DIR}/releases" \
         "${LLM_TEAM_INMEM_IT_DIR}/comments" 2>/dev/null || true

# ----------------------------------------------------------------------------
# Internal helpers
# ----------------------------------------------------------------------------

_in_memory_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

_in_memory_actor() { printf '%s' "${LLM_TEAM_INMEM_IT_ACTOR:-test-actor}"; }

_in_memory_counters_path() { printf '%s/_counters.json' "${LLM_TEAM_INMEM_IT_DIR}"; }

_in_memory_atomic_write() {
  # _in_memory_atomic_write <dest> <stdin-content>
  local dest="$1"
  local tmp
  tmp="$(mktemp "${dest}.tmp.XXXXXX")" || return 1
  cat >"${tmp}" || { rm -f "${tmp}"; return 1; }
  mv "${tmp}" "${dest}"
}

_in_memory_next_id() {
  # _in_memory_next_id <key>  → echo next int (and persist)
  local key="$1"
  local path next
  path="$(_in_memory_counters_path)"
  if [ ! -f "${path}" ]; then
    printf '{}\n' >"${path}"
  fi
  next="$(jq -r --arg k "${key}" '(.[$k] // 0) + 1' "${path}")"
  jq --arg k "${key}" --argjson v "${next}" '.[$k] = $v' "${path}" \
    | _in_memory_atomic_write "${path}"
  printf '%s' "${next}"
}

_in_memory_milestone_path()  { printf '%s/milestones/%s.json' "${LLM_TEAM_INMEM_IT_DIR}" "$1"; }
_in_memory_issue_path()      { printf '%s/issues/%s.json'     "${LLM_TEAM_INMEM_IT_DIR}" "$1"; }
_in_memory_pr_path()         { printf '%s/prs/%s.json'        "${LLM_TEAM_INMEM_IT_DIR}" "$1"; }
_in_memory_release_path()    { printf '%s/releases/%s.json'   "${LLM_TEAM_INMEM_IT_DIR}" "$1"; }
_in_memory_comments_path() {
  # _in_memory_comments_path <kind> <num>
  local kind="$1" num="$2"
  case "${kind}" in
    issue|pr)  printf '%s/comments/issue-%s.jsonl'     "${LLM_TEAM_INMEM_IT_DIR}" "${num}" ;;
    milestone) printf '%s/comments/milestone-%s.jsonl' "${LLM_TEAM_INMEM_IT_DIR}" "${num}" ;;
  esac
}

_in_memory_milestone_exists()  { [ -f "$(_in_memory_milestone_path "$1")" ]; }
_in_memory_issue_exists()      { [ -f "$(_in_memory_issue_path "$1")" ]; }
_in_memory_pr_exists()         { [ -f "$(_in_memory_pr_path "$1")" ]; }

_in_memory_milestone_set_field() {
  # <num> <jq-expression-with-args>  — applies to milestones/<num>.json
  local num="$1"; shift
  local path
  path="$(_in_memory_milestone_path "${num}")"
  jq "$@" "${path}" | _in_memory_atomic_write "${path}"
}

_in_memory_issue_set_field() {
  local num="$1"; shift
  local path
  path="$(_in_memory_issue_path "${num}")"
  jq "$@" "${path}" | _in_memory_atomic_write "${path}"
}

_in_memory_pr_set_field() {
  local num="$1"; shift
  local path
  path="$(_in_memory_pr_path "${num}")"
  jq "$@" "${path}" | _in_memory_atomic_write "${path}"
}

# Replace cp-state marker line in a body (mimics _github_replace_cp_state_marker).
_in_memory_replace_cp_state_marker() {
  local body="$1" new_marker="$2"
  body="$(printf '%s\n' "${body}" | grep -Ev '<!-- llm-team:cp-state:[A-Z_]+ -->' || true)"
  printf '%s\n%s' "${body}" "${new_marker}"
}

# Deterministic fake SHA — branch + pr_num + role.
_in_memory_fake_sha() {
  local branch="$1" pr_num="$2" role="$3"
  printf 'sha-inmem-%s-%s-%s' "${role}" "${branch}" "${pr_num}"
}

# ============================================================================
# Port API: Milestone
# ============================================================================

it_milestone_create() {
  local repo="$1" title="$2" body="$3"
  if [ -z "${repo}" ] || [ -z "${title}" ]; then
    log_error "it_milestone_create: repo and title are required"
    return 1
  fi
  local num path
  num="$(_in_memory_next_id milestone_next)"
  path="$(_in_memory_milestone_path "${num}")"
  jq -n \
    --arg repo "${repo}" \
    --argjson number "${num}" \
    --arg title "${title}" \
    --arg description "${body}" \
    --arg state "open" \
    --arg creator "$(_in_memory_actor)" \
    --arg created_at "$(_in_memory_now)" \
    '{
       repo: $repo, number: $number, title: $title,
       description: $description, state: $state,
       creator: { login: $creator },
       open_issues: 0, closed_issues: 0,
       created_at: $created_at, updated_at: $created_at
     }' >"${path}"
  printf '%s\n' "${num}"
}

it_milestone_update() {
  local repo="$1" num="$2"; shift 2 || true
  local title="" body="" have_title=0 have_body=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --title) title="$2"; have_title=1; shift 2 ;;
      --body)  body="$2";  have_body=1;  shift 2 ;;
      *) log_error "it_milestone_update: unknown flag '$1'"; return 1 ;;
    esac
  done
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_milestone_update: repo and num are required"
    return 1
  }
  _in_memory_milestone_exists "${num}" || {
    log_error "it_milestone_update: milestone #${num} not found"
    return 1
  }
  if [ "${have_title}" -eq 1 ]; then
    _in_memory_milestone_set_field "${num}" --arg t "${title}" --arg ts "$(_in_memory_now)" \
      '.title = $t | .updated_at = $ts'
  fi
  if [ "${have_body}" -eq 1 ]; then
    _in_memory_milestone_set_field "${num}" --arg d "${body}" --arg ts "$(_in_memory_now)" \
      '.description = $d | .updated_at = $ts'
  fi
}

it_milestone_set_state() {
  local repo="$1" num="$2" new_state="$3" old_state="${4:-}"
  if [ -z "${repo}" ] || [ -z "${num}" ] || [ -z "${new_state}" ]; then
    log_error "it_milestone_set_state: repo, num, and new_state are required"
    return 1
  fi
  state_is_valid milestone "${new_state}" || {
    log_error "it_milestone_set_state: invalid milestone state '${new_state}'"
    return 1
  }
  if [ -n "${old_state}" ]; then
    state_is_valid milestone "${old_state}" || {
      log_error "it_milestone_set_state: invalid old milestone state '${old_state}'"
      return 1
    }
  fi
  _in_memory_milestone_exists "${num}" || {
    log_error "it_milestone_set_state: milestone #${num} not found"
    return 1
  }
  local path desc new_marker old_marker
  path="$(_in_memory_milestone_path "${num}")"
  desc="$(jq -r '.description // ""' "${path}")"
  new_marker="$(state_marker milestone "${new_state}")"
  if ! printf '%s' "${desc}" | grep -Fq "${new_marker}"; then
    desc="${desc}"$'\n'"${new_marker}"
  fi
  if [ -n "${old_state}" ]; then
    old_marker="$(state_marker milestone "${old_state}")"
    desc="$(printf '%s\n' "${desc}" | grep -Fv "${old_marker}" || true)"
  fi
  _in_memory_milestone_set_field "${num}" --arg d "${desc}" --arg ts "$(_in_memory_now)" \
    '.description = $d | .updated_at = $ts'
}

it_milestone_get_state() {
  local repo="$1" num="$2"
  _in_memory_milestone_exists "${num}" || return 1
  local path desc
  path="$(_in_memory_milestone_path "${num}")"
  desc="$(jq -r '.description // ""' "${path}")"
  printf '%s\n' "${desc}" \
    | grep -oE '<!-- llm-team:milestone-state:[A-Z_]+ -->' \
    | head -1 \
    | sed -E 's/<!-- llm-team:milestone-state:([A-Z_]+) -->/\1/'
}

it_milestone_close() {
  local repo="$1" num="$2"
  _in_memory_milestone_exists "${num}" || {
    log_error "it_milestone_close: milestone #${num} not found"
    return 1
  }
  _in_memory_milestone_set_field "${num}" --arg ts "$(_in_memory_now)" \
    '.state = "closed" | .updated_at = $ts'
}

it_milestone_get_progress() {
  local repo="$1" num="$2"
  _in_memory_milestone_exists "${num}" || {
    log_error "it_milestone_get_progress: milestone #${num} not found"
    return 1
  }
  local path open_count closed_count
  path="$(_in_memory_milestone_path "${num}")"
  # Compute live counts from issues store.
  open_count=0
  closed_count=0
  local f st ms
  for f in "${LLM_TEAM_INMEM_IT_DIR}/issues"/*.json; do
    [ -f "${f}" ] || continue
    ms="$(jq -r '.milestone // empty' "${f}")"
    [ "${ms}" = "${num}" ] || continue
    st="$(jq -r '.state // "open"' "${f}")"
    case "${st}" in
      closed) closed_count=$((closed_count + 1)) ;;
      *)      open_count=$((open_count + 1)) ;;
    esac
  done
  printf 'open=%s closed=%s\n' "${open_count}" "${closed_count}"
}

it_milestone_list_open() {
  local repo="$1"
  local f
  for f in "${LLM_TEAM_INMEM_IT_DIR}/milestones"/*.json; do
    [ -f "${f}" ] || continue
    jq -r 'select(.state != "closed") | "\(.created_at)\t\(.number)"' "${f}"
  done | sort | awk -F'\t' '{print $2}'
}

it_milestone_list_in_state() {
  local repo="$1" state="$2"
  state_is_valid milestone "${state}" || {
    log_error "it_milestone_list_in_state: invalid state '${state}'"
    return 1
  }
  local marker f desc
  marker="$(state_marker milestone "${state}")"
  for f in "${LLM_TEAM_INMEM_IT_DIR}/milestones"/*.json; do
    [ -f "${f}" ] || continue
    desc="$(jq -r 'select(.state != "closed") | .description // ""' "${f}")"
    if printf '%s' "${desc}" | grep -Fq "${marker}"; then
      jq -r '"\(.created_at)\t\(.number)"' "${f}"
    fi
  done | sort | awk -F'\t' '{print $2}'
}

# ============================================================================
# Port API: Issue
# ============================================================================

it_issue_create() {
  local repo="$1"; shift || true
  local title="" body="" labels="" milestone=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --title)     title="$2"; shift 2 ;;
      --body)      body="$2"; shift 2 ;;
      --labels)    labels="$2"; shift 2 ;;
      --milestone) milestone="$2"; shift 2 ;;
      *) log_error "it_issue_create: unknown flag '$1'"; return 1 ;;
    esac
  done
  [ -n "${repo}" ] && [ -n "${title}" ] || {
    log_error "it_issue_create: repo and --title are required"
    return 1
  }
  local num path label_arr_json
  num="$(_in_memory_next_id issue_next)"
  path="$(_in_memory_issue_path "${num}")"
  if [ -n "${labels}" ]; then
    # split CSV and emit JSON array
    label_arr_json="$(printf '%s' "${labels}" | tr ',' '\n' \
      | jq -R 'select(length > 0)' | jq -s '.')"
  else
    label_arr_json='[]'
  fi
  jq -n \
    --arg repo "${repo}" \
    --argjson number "${num}" \
    --arg title "${title}" \
    --arg body "${body}" \
    --argjson labels "${label_arr_json}" \
    --arg milestone "${milestone}" \
    --arg state "open" \
    --arg created_at "$(_in_memory_now)" \
    '{
       repo: $repo, number: $number, title: $title, body: $body,
       labels: $labels,
       milestone: ($milestone | select(. != "") // null),
       state: $state, blocked_by: [],
       created_at: $created_at, updated_at: $created_at
     }' >"${path}"
  printf '%s\n' "${num}"
}

it_issue_set_state() {
  local repo="$1" num="$2" new_state="$3" old_state="${4:-}"
  if [ -z "${repo}" ] || [ -z "${num}" ] || [ -z "${new_state}" ]; then
    log_error "it_issue_set_state: repo, num, new_state are required"
    return 1
  fi
  state_is_valid task "${new_state}" || {
    log_error "it_issue_set_state: invalid task state '${new_state}'"
    return 1
  }
  _in_memory_issue_exists "${num}" || {
    log_error "it_issue_set_state: issue #${num} not found"
    return 1
  }
  local new_label old_label
  new_label="$(task_state_to_label "${new_state}")" || {
    log_error "it_issue_set_state: cannot map state '${new_state}' to label"
    return 1
  }
  new_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${new_label}")"
  _in_memory_issue_set_field "${num}" --arg lbl "${new_label}" --arg ts "$(_in_memory_now)" \
    '.labels = ((.labels // []) + [$lbl] | unique) | .updated_at = $ts'
  if [ -n "${old_state}" ]; then
    state_is_valid task "${old_state}" || {
      log_error "it_issue_set_state: invalid old state '${old_state}'"
      return 1
    }
    old_label="$(task_state_to_label "${old_state}")" || return 1
    old_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${old_label}")"
    _in_memory_issue_set_field "${num}" --arg lbl "${old_label}" \
      '.labels = ((.labels // []) | map(select(. != $lbl)))'
  fi
}

it_issue_get_state() {
  local repo="$1" num="$2"
  _in_memory_issue_exists "${num}" || return 1
  local path labels label state prefix="${TARGET_LABEL_PREFIX:-}"
  path="$(_in_memory_issue_path "${num}")"
  labels="$(jq -r '.labels[]? // empty' "${path}")"
  while IFS= read -r label; do
    [ -n "${label}" ] || continue
    if [ -n "${prefix}" ] && [ "${label#${prefix}}" != "${label}" ]; then
      label="${label#${prefix}}"
    fi
    state="$(label_to_task_state "${label}" 2>/dev/null)" && {
      printf '%s\n' "${state}"
      return 0
    }
  done <<<"${labels}"
}

it_issue_link_to_milestone() {
  local repo="$1" issue_num="$2" ms_num="$3"
  [ -n "${repo}" ] && [ -n "${issue_num}" ] && [ -n "${ms_num}" ] || {
    log_error "it_issue_link_to_milestone: repo, issue_num, milestone_num are required"
    return 1
  }
  _in_memory_issue_exists "${issue_num}" || {
    log_error "it_issue_link_to_milestone: issue #${issue_num} not found"
    return 1
  }
  _in_memory_milestone_exists "${ms_num}" || {
    log_error "it_issue_link_to_milestone: milestone #${ms_num} not found"
    return 1
  }
  _in_memory_issue_set_field "${issue_num}" --arg m "${ms_num}" --arg ts "$(_in_memory_now)" \
    '.milestone = $m | .updated_at = $ts'
}

it_issue_set_blocked_by() {
  local repo="$1" num="$2"; shift 2 || true
  [ -n "${repo}" ] && [ -n "${num}" ] && [ "$#" -ge 1 ] || {
    log_error "it_issue_set_blocked_by: repo, num, and at least one blocker are required"
    return 1
  }
  _in_memory_issue_exists "${num}" || {
    log_error "it_issue_set_blocked_by: issue #${num} not found"
    return 1
  }
  local b
  for b in "$@"; do
    _in_memory_issue_set_field "${num}" --arg b "${b}" --arg ts "$(_in_memory_now)" \
      '.blocked_by = ((.blocked_by // []) + [$b] | unique) | .updated_at = $ts'
  done
}

it_issue_get_blocked_by() {
  local repo="$1" num="$2"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_issue_get_blocked_by: repo and num are required"
    return 1
  }
  _in_memory_issue_exists "${num}" || return 0
  jq -r '(.blocked_by // [])[]' "$(_in_memory_issue_path "${num}")"
}

it_issue_close_with_note() {
  local repo="$1" num="$2" note="$3"
  _in_memory_issue_exists "${num}" || {
    log_error "it_issue_close_with_note: issue #${num} not found"
    return 1
  }
  if [ -n "${note}" ]; then
    it_comment_post "${repo}" issue "${num}" "${note}" >/dev/null \
      || log_warn "it_issue_close_with_note: comment failed on #${num}"
  fi
  _in_memory_issue_set_field "${num}" --arg ts "$(_in_memory_now)" \
    '.state = "closed" | .updated_at = $ts'
}

it_issue_clear_state_labels() {
  local repo="$1" num="$2"
  local prefix="${3:-${TARGET_LABEL_PREFIX:-}}"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_issue_clear_state_labels: repo and num are required"
    return 1
  }
  _in_memory_issue_exists "${num}" || return 0
  local label prefixed
  for label in "${ALL_ISSUE_LABELS[@]}"; do
    prefixed="$(label_with_prefix "${prefix}" "${label}")"
    _in_memory_issue_set_field "${num}" --arg lbl "${prefixed}" \
      '.labels = ((.labels // []) | map(select(. != $lbl)))'
  done
}

it_issue_add_label() {
  local repo="$1" num="$2" label="$3"
  [ -n "${repo}" ] && [ -n "${num}" ] && [ -n "${label}" ] || {
    log_error "it_issue_add_label: repo, num, label are required"
    return 1
  }
  _in_memory_issue_exists "${num}" || {
    log_error "it_issue_add_label: issue #${num} not found"
    return 1
  }
  _in_memory_issue_set_field "${num}" --arg lbl "${label}" --arg ts "$(_in_memory_now)" \
    '.labels = ((.labels // []) + [$lbl] | unique) | .updated_at = $ts'
}

it_issue_remove_label() {
  local repo="$1" num="$2" label="$3"
  [ -n "${repo}" ] && [ -n "${num}" ] && [ -n "${label}" ] || {
    log_error "it_issue_remove_label: repo, num, label are required"
    return 1
  }
  _in_memory_issue_exists "${num}" || {
    log_error "it_issue_remove_label: issue #${num} not found"
    return 1
  }
  _in_memory_issue_set_field "${num}" --arg lbl "${label}" --arg ts "$(_in_memory_now)" \
    '.labels = ((.labels // []) | map(select(. != $lbl))) | .updated_at = $ts'
}

it_issue_list_in_state() {
  local repo="$1" state="$2"
  state_is_valid task "${state}" || {
    log_error "it_issue_list_in_state: invalid task state '${state}'"
    return 1
  }
  local label prefixed f
  label="$(task_state_to_label "${state}")" || return 1
  prefixed="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${label}")"
  for f in "${LLM_TEAM_INMEM_IT_DIR}/issues"/*.json; do
    [ -f "${f}" ] || continue
    jq -r --arg lbl "${prefixed}" '
      select(.state != "closed")
      | select((.labels // []) | index($lbl))
      | "\(.created_at)\t\(.number)"
    ' "${f}"
  done | sort | awk -F'\t' '{print $2}'
}

it_issue_list_with_label() {
  local repo="$1" label="$2"; shift 2 || true
  local no_ms=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-milestone) no_ms=1; shift ;;
      *) log_error "it_issue_list_with_label: unknown flag '$1'"; return 1 ;;
    esac
  done
  local f
  for f in "${LLM_TEAM_INMEM_IT_DIR}/issues"/*.json; do
    [ -f "${f}" ] || continue
    if [ "${no_ms}" -eq 1 ]; then
      jq -r --arg lbl "${label}" '
        select(.state != "closed")
        | select((.labels // []) | index($lbl))
        | select(.milestone == null)
        | "\(.created_at)\t\(.number)"
      ' "${f}"
    else
      jq -r --arg lbl "${label}" '
        select(.state != "closed")
        | select((.labels // []) | index($lbl))
        | "\(.created_at)\t\(.number)"
      ' "${f}"
    fi
  done | sort | awk -F'\t' '{print $2}'
}

it_issue_get_milestone() {
  local repo="$1" num="$2"
  _in_memory_issue_exists "${num}" || return 0
  local path
  path="$(_in_memory_issue_path "${num}")"
  jq -r '.milestone // empty' "${path}"
}

# ============================================================================
# Port API: Pull Request
# ============================================================================

it_pr_create() {
  local repo="$1"; shift || true
  local head="" base="" title="" body="" draft=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --head)  head="$2"; shift 2 ;;
      --base)  base="$2"; shift 2 ;;
      --title) title="$2"; shift 2 ;;
      --body)  body="$2"; shift 2 ;;
      --draft) draft=1; shift ;;
      *) log_error "it_pr_create: unknown flag '$1'"; return 1 ;;
    esac
  done
  [ -n "${repo}" ] && [ -n "${head}" ] && [ -n "${base}" ] && [ -n "${title}" ] || {
    log_error "it_pr_create: repo, --head, --base, --title are required"
    return 1
  }
  local num path head_sha base_sha
  num="$(_in_memory_next_id pr_next)"
  head_sha="$(_in_memory_fake_sha "${head}" "${num}" head)"
  # If the in_memory workspace adapter is bound and the base branch is
  # tracked there, use the live head so SOC-MERGE-POLICY (Reviewer approve)
  # can compare PR.base_sha against ws_get_branch_head consistently.
  base_sha=""
  if declare -F ws_get_branch_head >/dev/null 2>&1 && [ -n "${TARGET_NAME:-}" ]; then
    base_sha="$(ws_get_branch_head "${TARGET_NAME}" "${base}" 2>/dev/null)" || base_sha=""
  fi
  [ -n "${base_sha}" ] || base_sha="$(_in_memory_fake_sha "${base}" "${num}" base)"
  path="$(_in_memory_pr_path "${num}")"
  jq -n \
    --arg repo "${repo}" \
    --argjson number "${num}" \
    --arg head "${head}" \
    --arg head_sha "${head_sha}" \
    --arg base "${base}" \
    --arg base_sha "${base_sha}" \
    --arg title "${title}" \
    --arg body "${body}" \
    --argjson draft "${draft}" \
    --arg state "open" \
    --arg created_at "$(_in_memory_now)" \
    '{
       repo: $repo, number: $number,
       head: { ref: $head, sha: $head_sha },
       base: { ref: $base, sha: $base_sha },
       title: $title, body: $body,
       draft: ($draft != 0),
       state: $state,
       merge_commit_sha: null,
       labels: [],
       created_at: $created_at, updated_at: $created_at
     }' >"${path}"
  printf '%s\n' "${num}"
}

it_pr_set_cp_state() {
  local repo="$1" num="$2" new_state="$3" old_state="${4:-}"
  [ -n "${repo}" ] && [ -n "${num}" ] && [ -n "${new_state}" ] || {
    log_error "it_pr_set_cp_state: repo, num, new_state are required"
    return 1
  }
  state_is_valid change_proposal "${new_state}" || {
    log_error "it_pr_set_cp_state: invalid CP state '${new_state}'"
    return 1
  }
  if [ -n "${old_state}" ]; then
    state_is_valid change_proposal "${old_state}" || {
      log_error "it_pr_set_cp_state: invalid old CP state '${old_state}'"
      return 1
    }
  fi
  _in_memory_pr_exists "${num}" || {
    log_error "it_pr_set_cp_state: PR #${num} not found"
    return 1
  }
  local path body new_marker
  path="$(_in_memory_pr_path "${num}")"
  body="$(jq -r '.body // ""' "${path}")"
  new_marker="$(state_marker change_proposal "${new_state}")"
  body="$(_in_memory_replace_cp_state_marker "${body}" "${new_marker}")"
  _in_memory_pr_set_field "${num}" --arg b "${body}" --arg ts "$(_in_memory_now)" \
    '.body = $b | .updated_at = $ts'

  # Optional label sync.
  local new_label old_label
  new_label="$(cp_state_to_label "${new_state}" 2>/dev/null || true)"
  if [ -n "${new_label}" ]; then
    new_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${new_label}")"
    _in_memory_pr_set_field "${num}" --arg lbl "${new_label}" \
      '.labels = ((.labels // []) + [$lbl] | unique)'
  fi
  if [ -n "${old_state}" ]; then
    old_label="$(cp_state_to_label "${old_state}" 2>/dev/null || true)"
    if [ -n "${old_label}" ]; then
      old_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${old_label}")"
      _in_memory_pr_set_field "${num}" --arg lbl "${old_label}" \
        '.labels = ((.labels // []) | map(select(. != $lbl)))'
    fi
  fi
}

it_pr_get_cp_state() {
  local repo="$1" num="$2"
  _in_memory_pr_exists "${num}" || return 1
  local path body
  path="$(_in_memory_pr_path "${num}")"
  body="$(jq -r '.body // ""' "${path}")"
  printf '%s\n' "${body}" \
    | grep -oE '<!-- llm-team:cp-state:[A-Z_]+ -->' \
    | head -1 \
    | sed -E 's/<!-- llm-team:cp-state:([A-Z_]+) -->/\1/'
}

it_pr_merge() {
  local repo="$1" num="$2" mode="$3"
  case "${mode}" in
    --squash|--merge|--rebase) ;;
    *) log_error "it_pr_merge: mode must be --squash, --merge, or --rebase"; return 1 ;;
  esac
  _in_memory_pr_exists "${num}" || {
    log_error "it_pr_merge: PR #${num} not found"
    return 1
  }
  local path state head_sha base_sha merge_count merge_sha
  path="$(_in_memory_pr_path "${num}")"
  state="$(jq -r '.state // "open"' "${path}")"
  if [ "${state}" = "merged" ]; then
    # idempotent: return existing merge sha
    jq -r '.merge_commit_sha // empty' "${path}"
    return 0
  fi
  if [ "${state}" = "closed" ]; then
    log_error "it_pr_merge: PR #${num} is closed (not merged); refuse to merge"
    return 1
  fi
  head_sha="$(jq -r '.head.sha // ""' "${path}")"
  base_sha="$(jq -r '.base.sha // ""' "${path}")"
  merge_count="$(_in_memory_next_id merge_next)"
  merge_sha="merge-${head_sha}-${base_sha}-${merge_count}"
  _in_memory_pr_set_field "${num}" \
    --arg s "merged" --arg msha "${merge_sha}" --arg ts "$(_in_memory_now)" \
    '.state = $s | .merge_commit_sha = $msha | .updated_at = $ts'
  printf '%s\n' "${merge_sha}"
}

it_pr_request_changes() {
  local repo="$1" num="$2" reason="$3"
  [ -n "${repo}" ] && [ -n "${num}" ] && [ -n "${reason}" ] || {
    log_error "it_pr_request_changes: repo, num, reason are required"
    return 1
  }
  _in_memory_pr_exists "${num}" || {
    log_error "it_pr_request_changes: PR #${num} not found"
    return 1
  }
  it_comment_post "${repo}" pr "${num}" "${reason}" >/dev/null \
    || log_warn "it_pr_request_changes: comment failed on PR #${num}"
  it_pr_set_cp_state "${repo}" "${num}" CP_REQUEST_CHANGES
}

it_pr_close() {
  local repo="$1" num="$2"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_pr_close: repo and num are required"
    return 1
  }
  _in_memory_pr_exists "${num}" || {
    log_error "it_pr_close: PR #${num} not found"
    return 1
  }
  local path state
  path="$(_in_memory_pr_path "${num}")"
  state="$(jq -r '.state // "open"' "${path}")"
  if [ "${state}" = "closed" ] || [ "${state}" = "merged" ]; then
    return 0
  fi
  _in_memory_pr_set_field "${num}" --arg ts "$(_in_memory_now)" \
    '.state = "closed" | .updated_at = $ts'
}

it_pr_get_head_sha() {
  local repo="$1" num="$2"
  _in_memory_pr_exists "${num}" || {
    log_error "it_pr_get_head_sha: PR #${num} not found"
    return 1
  }
  jq -r '.head.sha // empty' "$(_in_memory_pr_path "${num}")"
}

it_pr_get_base_branch() {
  local repo="$1" num="$2"
  _in_memory_pr_exists "${num}" || {
    log_error "it_pr_get_base_branch: PR #${num} not found"
    return 1
  }
  jq -r '.base.ref // empty' "$(_in_memory_pr_path "${num}")"
}

it_pr_get_base_sha() {
  local repo="$1" num="$2"
  _in_memory_pr_exists "${num}" || {
    log_error "it_pr_get_base_sha: PR #${num} not found"
    return 1
  }
  jq -r '.base.sha // empty' "$(_in_memory_pr_path "${num}")"
}

# ============================================================================
# Port API: Release
# ============================================================================

it_release_create() {
  local repo="$1" tag="$2"; shift 2 || true
  local target="" title="" notes=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --target) target="$2"; shift 2 ;;
      --title)  title="$2"; shift 2 ;;
      --notes)  notes="$2"; shift 2 ;;
      *) log_error "it_release_create: unknown flag '$1'"; return 1 ;;
    esac
  done
  [ -n "${repo}" ] && [ -n "${tag}" ] && [ -n "${target}" ] || {
    log_error "it_release_create: repo, tag, --target are required"
    return 1
  }
  local path
  path="$(_in_memory_release_path "${tag}")"
  if [ -f "${path}" ]; then
    log_error "it_release_create: tag '${tag}' already exists"
    return 1
  fi
  jq -n \
    --arg repo "${repo}" \
    --arg tag "${tag}" \
    --arg target "${target}" \
    --arg title "${title}" \
    --arg notes "${notes}" \
    --arg created_at "$(_in_memory_now)" \
    '{
       repo: $repo, tag: $tag, target: $target,
       title: $title, notes: $notes, created_at: $created_at
     }' >"${path}"
}

# ============================================================================
# Port API: Comments / markers / signals
# ============================================================================

it_comment_post() {
  local repo="$1" kind="$2" num="$3" body="$4"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] && [ -n "${body}" ] || {
    log_error "it_comment_post: repo, kind, num, body are required"
    return 1
  }
  case "${kind}" in
    issue)
      _in_memory_issue_exists "${num}" || {
        log_error "it_comment_post: issue #${num} not found"
        return 1
      }
      ;;
    pr)
      _in_memory_pr_exists "${num}" || {
        log_error "it_comment_post: PR #${num} not found"
        return 1
      }
      ;;
    milestone)
      _in_memory_milestone_exists "${num}" || {
        log_error "it_comment_post: milestone #${num} not found"
        return 1
      }
      ;;
    *) log_error "it_comment_post: invalid kind '${kind}'"; return 1 ;;
  esac

  local cid actor posted_at comments_path
  cid="$(_in_memory_next_id comment_next)"
  actor="$(_in_memory_actor)"
  posted_at="$(_in_memory_now)"
  comments_path="$(_in_memory_comments_path "${kind}" "${num}")"
  jq -n \
    --arg actor "${actor}" \
    --argjson comment_id "${cid}" \
    --arg body "${body}" \
    --arg posted_at "${posted_at}" \
    '{actor: $actor, comment_id: $comment_id, body: $body, posted_at: $posted_at}' \
    >>"${comments_path}"
  if [ "${kind}" = "milestone" ]; then
    # Append to description as well so collect_signals/has_marker can scan it.
    local path desc
    path="$(_in_memory_milestone_path "${num}")"
    desc="$(jq -r '.description // ""' "${path}")"
    desc="${desc}"$'\n'"${body}"
    _in_memory_milestone_set_field "${num}" --arg d "${desc}" --arg ts "$(_in_memory_now)" \
      '.description = $d | .updated_at = $ts'
  fi
}

it_comment_collect_signals() {
  local repo="$1" kind="$2" num="$3"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] || {
    log_error "it_comment_collect_signals: repo, kind, num are required"
    return 1
  }
  case "${kind}" in
    issue|pr)
      local comments_path
      comments_path="$(_in_memory_comments_path "${kind}" "${num}")"
      [ -f "${comments_path}" ] || return 0
      jq -c '
        select(.body | test("<!-- llm-team:human-signal[[:space:]]+\\{.*\\}[[:space:]]*-->"))
        | {
            actor:      (.actor      // ""),
            comment_id: (.comment_id // null),
            body:       ((.body | capture("<!-- llm-team:human-signal[[:space:]]+(?<json>\\{.*\\})[[:space:]]*-->") | .json) // ""),
            posted_at:  (.posted_at  // "")
          }
      ' "${comments_path}"
      ;;
    milestone)
      _in_memory_milestone_exists "${num}" || return 0
      jq -c '
        . as $m
        | (.description // "")
        | [scan("<!-- llm-team:human-signal[[:space:]]+(\\{[^}]*\\})[[:space:]]*-->")]
        | .[]
        | {
            actor:      ($m.creator.login // ""),
            comment_id: ($m.number        // null),
            body:       (.[0]             // ""),
            posted_at:  ($m.updated_at    // "")
          }
      ' "$(_in_memory_milestone_path "${num}")"
      ;;
    *) log_error "it_comment_collect_signals: invalid kind '${kind}'"; return 1 ;;
  esac
}

it_comment_has_marker() {
  local repo="$1" kind="$2" num="$3" marker_kind="$4"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] && [ -n "${marker_kind}" ] || {
    log_error "it_comment_has_marker: repo, kind, num, marker_kind are required"
    return 2
  }
  local marker comments_path
  marker="$(marker_notified "${marker_kind}")"
  case "${kind}" in
    issue|pr)
      comments_path="$(_in_memory_comments_path "${kind}" "${num}")"
      [ -f "${comments_path}" ] || return 1
      jq -r '.body' "${comments_path}" | grep -Fq "${marker}"
      ;;
    milestone)
      _in_memory_milestone_exists "${num}" || return 1
      jq -r '.description // ""' "$(_in_memory_milestone_path "${num}")" \
        | grep -Fq "${marker}"
      ;;
    *) log_error "it_comment_has_marker: invalid kind '${kind}'"; return 2 ;;
  esac
}

# ============================================================================
# Port API: Revision pin
# ============================================================================

it_revision_pin_get() {
  local repo="$1" kind="$2" num="$3" scope="${4:-metadata}"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] || {
    log_error "it_revision_pin_get: repo, kind, num are required"
    return 1
  }
  case "${kind}" in
    issue)
      _in_memory_issue_exists "${num}" || return 1
      jq -r '.updated_at // empty' "$(_in_memory_issue_path "${num}")"
      ;;
    pr)
      _in_memory_pr_exists "${num}" || return 1
      jq -r '.updated_at // empty' "$(_in_memory_pr_path "${num}")"
      ;;
    milestone)
      _in_memory_milestone_exists "${num}" || return 1
      jq -r '.updated_at // empty' "$(_in_memory_milestone_path "${num}")"
      ;;
    *) log_error "it_revision_pin_get: invalid kind '${kind}'"; return 1 ;;
  esac
}
