#!/usr/bin/env bash
# adapters/issue_tracker/github.sh
#
# Concrete adapter for the issue_tracker port using GitHub via the `gh` CLI.
# 모든 port 함수(it_*) 의 구현체. private helper 는 _github_* 접두사.
#
# 가시성:
#   • gh_with_retry — cross-lib 헬퍼들이 직접 사용하므로 글로벌 이름 유지
#                     (lib/markers.sh, lib/concurrency.sh, lib/notifier.sh,
#                      scripts/bootstrap-labels.sh, tests/lib/test-gh-retry.sh).
#                     이는 점진 이전 단계의 임시 결합이며, 향후 모두 it_*
#                     port 호출로 치환되면 _github_with_retry 로 비공개화한다.
#   • _github_*     — adapter 내부에서만 호출되는 헬퍼.
#   • it_*          — port API. application/scheduler 만 호출.

# ----------------------------------------------------------------------------
# 환경변수 (기본값) — gh_with_retry 의 backoff 지연
# ----------------------------------------------------------------------------
: "${GH_RETRY_DELAY_1:=2}"
: "${GH_RETRY_DELAY_2:=8}"
: "${GH_RETRY_DELAY_3:=30}"

# gh_with_retry <command> [args...]
# 비0 종료 시 최대 3회 재시도. 지연은 GH_RETRY_DELAY_{1,2,3} (기본 2/8/30s).
gh_with_retry() {
  local attempt=1
  local rc=0
  local delay
  while [ "${attempt}" -le 3 ]; do
    "$@"
    rc=$?
    if [ "${rc}" -eq 0 ]; then
      return 0
    fi
    if [ "${attempt}" -lt 3 ]; then
      case "${attempt}" in
        1) delay="${GH_RETRY_DELAY_1}" ;;
        2) delay="${GH_RETRY_DELAY_2}" ;;
        *) delay="${GH_RETRY_DELAY_3}" ;;
      esac
      log_warn "gh_with_retry: attempt ${attempt} failed (rc=${rc}); retrying in ${delay}s — cmd: $*"
      sleep "${delay}"
    else
      log_error "gh_with_retry: attempt ${attempt} failed (rc=${rc}); giving up — cmd: $*"
    fi
    attempt=$((attempt+1))
  done
  return "${rc}"
}

# ============================================================================
# Internal helpers (_github_*)
# ============================================================================

_github_milestone_label_marker() {
  printf '<!-- llm-team:milestone-label:%s -->' "$1"
}

_github_milestone_get_description() {
  local repo="$1" num="$2"
  gh_with_retry gh api "repos/${repo}/milestones/${num}" --jq '.description // ""'
}

_github_milestone_patch_description() {
  local repo="$1" num="$2" desc="$3"
  gh_with_retry gh api -X PATCH "repos/${repo}/milestones/${num}" -f "description=${desc}" >/dev/null
}

_github_issue_get_body() {
  local repo="$1" num="$2"
  gh_with_retry gh api "repos/${repo}/issues/${num}" --jq '.body // ""'
}

_github_issue_set_body() {
  local repo="$1" num="$2" body="$3"
  local payload; payload="$(jq -nc --arg b "${body}" '{body:$b}')"
  gh_with_retry gh api -X PATCH "repos/${repo}/issues/${num}" --input - <<<"${payload}" >/dev/null
}

# Label mutation helpers — REST equivalents of `gh issue edit --add-label /
# --remove-label`. Use these instead of the gh CLI: the CLI mutates labels via
# GraphQL, which has a separate (smaller) rate-limit pool that is easy to
# exhaust during a daemon retry storm. REST issues/N/labels share the larger
# core pool. (Per GitHub API: PR labels live on the same /issues/N/labels
# endpoint — PRs are issues at the API layer.)
_github_issue_add_label() {
  local repo="$1" num="$2" label="$3"
  local payload; payload="$(jq -nc --arg l "${label}" '{labels:[$l]}')"
  gh_with_retry gh api -X POST "repos/${repo}/issues/${num}/labels" --input - <<<"${payload}" >/dev/null
}

_github_issue_remove_label() {
  local repo="$1" num="$2" label="$3"
  local enc; enc="$(jq -rn --arg l "${label}" '$l|@uri')"
  # Idempotent removal: REST `DELETE /issues/{n}/labels/{name}` returns 404
  # when the issue does not have that label. The post-condition ("label is
  # not on the issue") already holds, so treat 404 as success. Without this,
  # state transitions like add-new → remove-old break under retry whenever
  # the old label was already absent (e.g., add succeeded on a previous run
  # but remove failed transiently, or another process cleared the label).
  local err rc
  err="$(gh api -X DELETE "repos/${repo}/issues/${num}/labels/${enc}" 2>&1 >/dev/null)"
  rc=$?
  if [ "${rc}" -eq 0 ]; then
    return 0
  fi
  case "${err}" in
    *"HTTP 404"*) return 0 ;;
  esac
  # Other failure (network, 5xx, auth) — fall back to gh_with_retry so
  # transient errors still recover.
  gh_with_retry gh api -X DELETE "repos/${repo}/issues/${num}/labels/${enc}" >/dev/null 2>&1
}

_github_pr_get_body() {
  local repo="$1" num="$2"
  gh_with_retry gh api "repos/${repo}/pulls/${num}" --jq '.body // ""'
}

_github_pr_set_body() {
  local repo="$1" num="$2" body="$3"
  local payload; payload="$(jq -nc --arg b "${body}" '{body:$b}')"
  gh_with_retry gh api -X PATCH "repos/${repo}/pulls/${num}" --input - <<<"${payload}" >/dev/null
}

# Replace the cp-state marker line in a PR body.
# Strategy: strip any existing `<!-- llm-team:cp-state:* -->` and append the new one.
_github_replace_cp_state_marker() {
  local body="$1" new_marker="$2"
  # Remove any existing cp-state marker line.
  body="$(printf '%s\n' "${body}" | grep -Ev '<!-- llm-team:cp-state:[A-Z_]+ -->' || true)"
  # Append the new marker.
  printf '%s\n%s' "${body}" "${new_marker}"
}

# ============================================================================
# Port API: Milestone
# ============================================================================

# it_milestone_create <repo> <title> <body>
# stdout: milestone number on success.
it_milestone_create() {
  local repo="$1" title="$2" body="$3"
  if [ -z "${repo}" ] || [ -z "${title}" ]; then
    log_error "it_milestone_create: repo and title are required"
    return 1
  fi
  gh_with_retry gh api -X POST "repos/${repo}/milestones" \
    -f "title=${title}" -f "description=${body}" \
    --jq '.number'
}

# it_milestone_update <repo> <num> [--title T] [--body B]
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
  local args=()
  [ "${have_title}" -eq 1 ] && args+=(-f "title=${title}")
  [ "${have_body}" -eq 1 ]  && args+=(-f "description=${body}")
  if [ "${#args[@]}" -eq 0 ]; then
    log_warn "it_milestone_update: no fields to update"
    return 0
  fi
  gh_with_retry gh api -X PATCH "repos/${repo}/milestones/${num}" "${args[@]}" >/dev/null
}

# it_milestone_set_state <repo> <num> <new_state> [<old_state>]
# Description 안의 hidden marker 로 상태를 인코딩. 멱등.
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
  local desc new_marker old_marker
  desc="$(_github_milestone_get_description "${repo}" "${num}")" || return 1
  new_marker="$(state_marker milestone "${new_state}")"
  if ! printf '%s' "${desc}" | grep -Fq "${new_marker}"; then
    desc="${desc}"$'\n'"${new_marker}"
  fi
  if [ -n "${old_state}" ]; then
    old_marker="$(state_marker milestone "${old_state}")"
    desc="$(printf '%s\n' "${desc}" | grep -Fv "${old_marker}" || true)"
  fi
  _github_milestone_patch_description "${repo}" "${num}" "${desc}"
}

# it_milestone_get_state <repo> <num>
# Description 의 첫 milestone-state marker 를 추출. 없으면 빈 문자열.
it_milestone_get_state() {
  local repo="$1" num="$2"
  local desc
  desc="$(_github_milestone_get_description "${repo}" "${num}")" || return 1
  printf '%s\n' "${desc}" \
    | grep -oE '<!-- llm-team:milestone-state:[A-Z_]+ -->' \
    | head -1 \
    | sed -E 's/<!-- llm-team:milestone-state:([A-Z_]+) -->/\1/'
}

# it_milestone_close <repo> <num>
it_milestone_close() {
  local repo="$1" num="$2"
  gh_with_retry gh api -X PATCH "repos/${repo}/milestones/${num}" -f state=closed >/dev/null
}

# it_milestone_get_progress <repo> <num>  → "open=N closed=M"
it_milestone_get_progress() {
  local repo="$1" num="$2"
  local data open_count closed_count
  data="$(gh_with_retry gh api "repos/${repo}/milestones/${num}" \
            --jq '{open: .open_issues, closed: .closed_issues}')" || return 1
  open_count="$(printf '%s' "${data}" | jq -r '.open // 0')"
  closed_count="$(printf '%s' "${data}" | jq -r '.closed // 0')"
  printf 'open=%s closed=%s\n' "${open_count}" "${closed_count}"
}

# it_milestone_list_open <repo>  → milestone numbers (oldest first)
it_milestone_list_open() {
  local repo="$1"
  gh_with_retry gh api "repos/${repo}/milestones?state=open&sort=created_at&direction=asc" \
    --jq '.[].number'
}

# it_milestone_list_in_state <repo> <state>  → milestone numbers (oldest first) in that state.
it_milestone_list_in_state() {
  local repo="$1" state="$2"
  state_is_valid milestone "${state}" || {
    log_error "it_milestone_list_in_state: invalid state '${state}'"
    return 1
  }
  local marker
  marker="$(state_marker milestone "${state}")"
  # Filter inside jq so multi-line descriptions stay intact.
  gh_with_retry gh api "repos/${repo}/milestones?state=open&sort=created_at&direction=asc" \
    | jq -r --arg marker "${marker}" \
        '.[] | select((.description // "") | contains($marker)) | .number'
}

# ============================================================================
# Port API: Issue
# ============================================================================

# it_issue_create <repo> --title T --body B [--labels L,L] [--milestone N]  → echo number
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
  # NOTE: We use the REST API rather than `gh issue create` because the CLI's
  # `--milestone` flag resolves milestones by title and fails with
  # "could not add to milestone 'N': 'N' not found" when given a numeric id.
  # The REST API accepts the milestone *number* directly.
  local payload
  payload="$(jq -nc \
    --arg title "${title}" \
    --arg body  "${body}" \
    --arg ms    "${milestone}" \
    --arg lbls  "${labels}" \
    '
      {title: $title, body: $body}
      + ( if ($ms | length) > 0 then {milestone: ($ms | tonumber)} else {} end )
      + ( if ($lbls | length) > 0
          then {labels: ($lbls | split(",") | map(select(length>0)))}
          else {} end )
    ')" || { log_error "it_issue_create: failed to build payload"; return 1; }
  local response num
  response="$(gh_with_retry gh api -X POST "repos/${repo}/issues" --input - <<<"${payload}")" \
    || return 1
  num="$(printf '%s' "${response}" | jq -r '.number // empty')"
  [ -n "${num}" ] || { log_error "it_issue_create: response missing .number"; return 1; }
  printf '%s\n' "${num}"
}

# it_issue_set_state <repo> <num> <new_state> [<old_state>]
# 라벨 atomic 전이 (add new → remove old).
#
# Invariant (RGC-RECOVERY): 호출 후 partial-fail 로 비0 을 반환하더라도 issue 의
# state label 집합에는 항상 (old_label ∨ new_label) 중 최소 하나가 존재한다.
# add-new 가 remove-old 보다 먼저 수행되므로:
#   • add 단계 실패 시에는 old 가 그대로 남고
#   • remove 단계 실패 시에는 new 와 old 가 함께 남는다 (다음 호출 / recovery
#     에서 it_issue_clear_state_labels 로 정리 가능).
# Self-transition (new_label == old_label) 은 add 만 수행하고 remove 를 skip 한다
# — 그렇지 않으면 동일 label 을 add 한 직후 remove 하여 label 이 사라진다.
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
  local new_label old_label
  new_label="$(task_state_to_label "${new_state}")" || {
    log_error "it_issue_set_state: cannot map state '${new_state}' to label"
    return 1
  }
  new_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${new_label}")"
  _github_issue_add_label "${repo}" "${num}" "${new_label}" \
    || { log_error "it_issue_set_state: add ${new_label} failed on issue #${num}"; return 1; }
  if [ -n "${old_state}" ]; then
    state_is_valid task "${old_state}" || {
      log_error "it_issue_set_state: invalid old state '${old_state}'"
      return 1
    }
    old_label="$(task_state_to_label "${old_state}")" || return 1
    old_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${old_label}")"
    if [ "${old_label}" != "${new_label}" ]; then
      _github_issue_remove_label "${repo}" "${num}" "${old_label}" \
        || { log_error "it_issue_set_state: remove ${old_label} failed on issue #${num}"; return 1; }
    fi
  fi
}

# it_issue_get_state <repo> <num>  → state name (first task label found) or empty
it_issue_get_state() {
  local repo="$1" num="$2"
  local labels label state prefix="${TARGET_LABEL_PREFIX:-}"
  labels="$(gh_with_retry gh api "repos/${repo}/issues/${num}" --jq '.labels[].name')" || return 1
  while IFS= read -r label; do
    [ -n "${label}" ] || continue
    # Strip prefix if present.
    if [ -n "${prefix}" ] && [ "${label#${prefix}}" != "${label}" ]; then
      label="${label#${prefix}}"
    fi
    state="$(label_to_task_state "${label}" 2>/dev/null)" && {
      printf '%s\n' "${state}"
      return 0
    }
  done <<<"${labels}"
}

# it_issue_link_to_milestone <repo> <issue_num> <milestone_num>
it_issue_link_to_milestone() {
  local repo="$1" issue_num="$2" ms_num="$3"
  [ -n "${repo}" ] && [ -n "${issue_num}" ] && [ -n "${ms_num}" ] || {
    log_error "it_issue_link_to_milestone: repo, issue_num, milestone_num are required"
    return 1
  }
  gh_with_retry gh api -X PATCH "repos/${repo}/issues/${issue_num}" \
    -F "milestone=${ms_num}" >/dev/null
}

# it_issue_set_blocked_by <repo> <num> <blocker_num...>
# Body 끝에 멱등하게 `<!-- llm-team:blocked-by:#N -->` 마커들을 부착.
it_issue_set_blocked_by() {
  local repo="$1" num="$2"; shift 2 || true
  [ -n "${repo}" ] && [ -n "${num}" ] && [ "$#" -ge 1 ] || {
    log_error "it_issue_set_blocked_by: repo, num, and at least one blocker are required"
    return 1
  }
  local body="" b marker
  body="$(_github_issue_get_body "${repo}" "${num}")" || return 1
  for b in "$@"; do
    marker="<!-- llm-team:blocked-by:#${b} -->"
    if ! printf '%s' "${body}" | grep -Fq "${marker}"; then
      body="${body}"$'\n'"${marker}"
    fi
  done
  _github_issue_set_body "${repo}" "${num}" "${body}"
}

# it_issue_get_blocked_by <repo> <num>  → echo blocker_nums (one per line)
it_issue_get_blocked_by() {
  local repo="$1" num="$2"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_issue_get_blocked_by: repo and num are required"
    return 1
  }
  local body
  body="$(_github_issue_get_body "${repo}" "${num}")" || return 1
  printf '%s\n' "${body}" \
    | grep -oE '<!-- llm-team:blocked-by:#[0-9]+ -->' \
    | sed -E 's/<!-- llm-team:blocked-by:#([0-9]+) -->/\1/'
}

# it_issue_close_with_note <repo> <num> <note>
it_issue_close_with_note() {
  local repo="$1" num="$2" note="$3"
  if [ -n "${note}" ]; then
    gh_with_retry gh issue comment "${num}" --repo "${repo}" --body "${note}" >/dev/null \
      || log_warn "it_issue_close_with_note: comment failed on #${num}"
  fi
  gh_with_retry gh issue close "${num}" --repo "${repo}" >/dev/null
}

# it_issue_add_label <repo> <num> <label>  (idempotent — label may already exist)
it_issue_add_label() {
  local repo="$1" num="$2" label="$3"
  [ -n "${repo}" ] && [ -n "${num}" ] && [ -n "${label}" ] || {
    log_error "it_issue_add_label: repo, num, label are required"
    return 1
  }
  _github_issue_add_label "${repo}" "${num}" "${label}"
}

# it_issue_remove_label <repo> <num> <label>  (idempotent — absent label is OK)
it_issue_remove_label() {
  local repo="$1" num="$2" label="$3"
  [ -n "${repo}" ] && [ -n "${num}" ] && [ -n "${label}" ] || {
    log_error "it_issue_remove_label: repo, num, label are required"
    return 1
  }
  _github_issue_remove_label "${repo}" "${num}" "${label}" || return 0
}

# it_issue_clear_state_labels <repo> <num> [prefix]
it_issue_clear_state_labels() {
  local repo="$1" num="$2"
  local prefix="${3:-${TARGET_LABEL_PREFIX:-}}"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_issue_clear_state_labels: repo and num are required"
    return 1
  }
  local label prefixed
  for label in "${ALL_ISSUE_LABELS[@]}"; do
    prefixed="$(label_with_prefix "${prefix}" "${label}")"
    _github_issue_remove_label "${repo}" "${num}" "${prefixed}" || true
  done
}

# it_issue_list_in_state <repo> <state>  → numbers (oldest first)
it_issue_list_in_state() {
  local repo="$1" state="$2"
  state_is_valid task "${state}" || {
    log_error "it_issue_list_in_state: invalid task state '${state}'"
    return 1
  }
  local label
  label="$(task_state_to_label "${state}")" || return 1
  label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${label}")"
  # REST list endpoint sorts oldest-first via direction=asc; PRs share the
  # /issues collection so we filter them out with `select(.pull_request|not)`.
  # Using REST instead of `gh issue list` keeps this off the GraphQL pool,
  # which a daemon retry storm can otherwise exhaust.
  local enc; enc="$(jq -rn --arg l "${label}" '$l|@uri')"
  gh_with_retry gh api --paginate \
    "repos/${repo}/issues?state=open&labels=${enc}&sort=created&direction=asc&per_page=100" \
    --jq '.[] | select(.pull_request|not) | .number'
}

# it_issue_list_with_label <repo> <label> [--no-milestone]
# 라벨로 직접 검색. --no-milestone 옵션 시 milestone 미연결만 반환.
it_issue_list_with_label() {
  local repo="$1" label="$2"; shift 2 || true
  local no_ms=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-milestone) no_ms=1; shift ;;
      *) log_error "it_issue_list_with_label: unknown flag '$1'"; return 1 ;;
    esac
  done
  local enc; enc="$(jq -rn --arg l "${label}" '$l|@uri')"
  if [ "${no_ms}" -eq 1 ]; then
    gh_with_retry gh api --paginate \
      "repos/${repo}/issues?state=open&labels=${enc}&sort=created&direction=asc&per_page=100" \
      --jq '.[] | select(.pull_request|not) | select(.milestone == null) | .number'
  else
    gh_with_retry gh api --paginate \
      "repos/${repo}/issues?state=open&labels=${enc}&sort=created&direction=asc&per_page=100" \
      --jq '.[] | select(.pull_request|not) | .number'
  fi
}

# it_issue_get_milestone <repo> <num>  → milestone number or empty
it_issue_get_milestone() {
  local repo="$1" num="$2"
  gh_with_retry gh api "repos/${repo}/issues/${num}" --jq '.milestone.number // empty'
}

# ============================================================================
# Port API: Pull Request
# ============================================================================

# it_pr_create <repo> --head H --base B --title T --body B [--draft]  → echo number
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
  # REST so PR creation does not consume the GraphQL pool.
  local payload
  payload="$(jq -nc \
    --arg head "${head}" --arg base "${base}" \
    --arg title "${title}" --arg body "${body}" \
    --argjson draft "${draft}" \
    '{title:$title, head:$head, base:$base, body:$body, draft:($draft==1)}')" \
    || { log_error "it_pr_create: failed to build payload"; return 1; }
  local response num
  response="$(gh_with_retry gh api -X POST "repos/${repo}/pulls" --input - <<<"${payload}")" \
    || return 1
  num="$(printf '%s' "${response}" | jq -r '.number // empty')"
  [ -n "${num}" ] || { log_error "it_pr_create: response missing .number"; return 1; }
  printf '%s\n' "${num}"
}

# it_pr_set_cp_state <repo> <num> <new_state> [<old_state>]
# Body 안의 cp-state marker 를 멱등 갱신 + (있으면) cp:* queue label 도 갱신.
#
# 순서 invariant (BUG-2): 어떤 시점에 daemon 이 종료되어도 PR 의 cp-state 표기
# 일관성이 깨지지 않도록 다음 순서를 강제한다.
#   1) new_label add  (label 이 marker 보다 먼저 set)
#   2) marker write   (PR body)
#   3) old_label remove
# 이렇게 하면 marker write 후의 어떤 partial-fail 상황에서도 PR 라벨 집합에는
# 항상 (old_label ∨ new_label) 중 최소 하나가 존재한다 (gap window 없음).
# Self-transition (new_label == old_label) 은 add 만 하고 remove 는 skip.
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

  # Resolve labels up-front so dedup can compare even when only the new side
  # has a queue label.
  local new_label old_label
  new_label="$(cp_state_to_label "${new_state}" 2>/dev/null || true)"
  if [ -n "${new_label}" ]; then
    new_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${new_label}")"
  fi
  if [ -n "${old_state}" ]; then
    old_label="$(cp_state_to_label "${old_state}" 2>/dev/null || true)"
    if [ -n "${old_label}" ]; then
      old_label="$(label_with_prefix "${TARGET_LABEL_PREFIX:-}" "${old_label}")"
    fi
  fi

  # Step 1: add new_label (before marker write — gap-free invariant).
  if [ -n "${new_label}" ]; then
    _github_issue_add_label "${repo}" "${num}" "${new_label}" || true
  fi

  # Step 2: marker write.
  local body new_marker
  body="$(_github_pr_get_body "${repo}" "${num}")" || return 1
  new_marker="$(state_marker change_proposal "${new_state}")"
  body="$(_github_replace_cp_state_marker "${body}" "${new_marker}")"
  _github_pr_set_body "${repo}" "${num}" "${body}" || return 1

  # Step 3: remove old_label (skip self-transition / no-op cases).
  if [ -n "${old_label}" ] && [ "${old_label}" != "${new_label}" ]; then
    _github_issue_remove_label "${repo}" "${num}" "${old_label}" || true
  fi
}

# it_pr_get_cp_state <repo> <num>  → state name or empty
it_pr_get_cp_state() {
  local repo="$1" num="$2"
  local body
  body="$(_github_pr_get_body "${repo}" "${num}")" || return 1
  printf '%s\n' "${body}" \
    | grep -oE '<!-- llm-team:cp-state:[A-Z_]+ -->' \
    | head -1 \
    | sed -E 's/<!-- llm-team:cp-state:([A-Z_]+) -->/\1/'
}

# it_pr_merge <repo> <num> --squash|--merge|--rebase  → echo merge_sha
it_pr_merge() {
  local repo="$1" num="$2" mode="$3"
  local merge_method
  case "${mode}" in
    --squash) merge_method="squash" ;;
    --merge)  merge_method="merge" ;;
    --rebase) merge_method="rebase" ;;
    *) log_error "it_pr_merge: mode must be --squash, --merge, or --rebase"; return 1 ;;
  esac
  # REST PUT /pulls/{n}/merge instead of `gh pr merge` (GraphQL).
  local payload
  payload="$(jq -nc --arg m "${merge_method}" '{merge_method:$m}')"
  gh_with_retry gh api -X PUT "repos/${repo}/pulls/${num}/merge" --input - <<<"${payload}" >/dev/null \
    || { log_error "it_pr_merge: merge failed for PR #${num}"; return 1; }
  gh_with_retry gh api "repos/${repo}/pulls/${num}" --jq '.merge_commit_sha // empty'
}

# it_pr_request_changes <repo> <num> <reason>
# 코멘트 추가 + cp-state→CP_REQUEST_CHANGES 마커 갱신.
it_pr_request_changes() {
  local repo="$1" num="$2" reason="$3"
  [ -n "${repo}" ] && [ -n "${num}" ] && [ -n "${reason}" ] || {
    log_error "it_pr_request_changes: repo, num, reason are required"
    return 1
  }
  gh_with_retry gh pr comment "${num}" --repo "${repo}" --body "${reason}" >/dev/null \
    || log_warn "it_pr_request_changes: comment failed on PR #${num}"
  it_pr_set_cp_state "${repo}" "${num}" CP_REQUEST_CHANGES
}

# it_pr_close <repo> <num>
# Close without merging. Idempotent — already-closed PRs return 0.
it_pr_close() {
  local repo="$1" num="$2"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_pr_close: repo and num are required"
    return 1
  }
  local state
  state="$(gh_with_retry gh api "repos/${repo}/pulls/${num}" --jq '.state // empty' 2>/dev/null || true)"
  if [ "${state}" = "closed" ]; then
    return 0
  fi
  gh_with_retry gh api -X PATCH "repos/${repo}/pulls/${num}" -f state=closed >/dev/null
}

# it_pr_get_head_sha <repo> <num>  → echo head sha
it_pr_get_head_sha() {
  local repo="$1" num="$2"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_pr_get_head_sha: repo and num are required"
    return 1
  }
  gh_with_retry gh api "repos/${repo}/pulls/${num}" --jq '.head.sha // empty'
}

# it_pr_get_base_branch <repo> <num>  → echo base branch ref (e.g. integration)
it_pr_get_base_branch() {
  local repo="$1" num="$2"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_pr_get_base_branch: repo and num are required"
    return 1
  }
  gh_with_retry gh api "repos/${repo}/pulls/${num}" --jq '.base.ref // empty'
}

# it_pr_get_base_sha <repo> <num>  → echo base sha (PR 가 분기한 시점의 base SHA)
it_pr_get_base_sha() {
  local repo="$1" num="$2"
  [ -n "${repo}" ] && [ -n "${num}" ] || {
    log_error "it_pr_get_base_sha: repo and num are required"
    return 1
  }
  gh_with_retry gh api "repos/${repo}/pulls/${num}" --jq '.base.sha // empty'
}

# ============================================================================
# Port API: Release
# ============================================================================

# it_release_create <repo> <tag> --target T --title TI --notes N
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
  local args=(--repo "${repo}" --target "${target}")
  [ -n "${title}" ] && args+=(--title "${title}")
  [ -n "${notes}" ] && args+=(--notes "${notes}")
  gh_with_retry gh release create "${tag}" "${args[@]}" >/dev/null
}

# ============================================================================
# Port API: Comments / markers / signals
# ============================================================================

# it_comment_post <repo> <kind> <num> <body>
# kind ∈ issue|pr|milestone. milestone 은 description append.
it_comment_post() {
  local repo="$1" kind="$2" num="$3" body="$4"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] && [ -n "${body}" ] || {
    log_error "it_comment_post: repo, kind, num, body are required"
    return 1
  }
  case "${kind}" in
    issue|pr)
      gh_with_retry gh api -X POST "repos/${repo}/issues/${num}/comments" \
        -f "body=${body}" >/dev/null
      ;;
    milestone)
      local cur new
      cur="$(_github_milestone_get_description "${repo}" "${num}")" || return 1
      new="${cur}"$'\n'"${body}"
      _github_milestone_patch_description "${repo}" "${num}" "${new}"
      ;;
    *) log_error "it_comment_post: invalid kind '${kind}'"; return 1 ;;
  esac
}

# it_comment_collect_signals <repo> <kind> <num>
# 한 줄당 JSON: {actor, comment_id, body, posted_at}
#   • body  : `<!-- llm-team:human-signal {…} -->` 안의 JSON envelope (RGC-SIGNALS).
#   • actor : GitHub user.login (milestone 의 경우 milestone creator.login).
#   • comment_id : GitHub comment id (milestone 의 경우 milestone num).
#   • posted_at  : created_at (milestone 의 경우 milestone updated_at).
# 멱등성·처리 여부 추적은 caller 가 ledger 를 통해 담당 (signal_id / comment_id 기준).
it_comment_collect_signals() {
  local repo="$1" kind="$2" num="$3"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] || {
    log_error "it_comment_collect_signals: repo, kind, num are required"
    return 1
  }
  case "${kind}" in
    issue|pr)
      gh_with_retry gh api "repos/${repo}/issues/${num}/comments" --jq '
        .[]
        | select(.body | test("<!-- llm-team:human-signal[[:space:]]+\\{.*\\}[[:space:]]*-->"))
        | {
            actor:      (.user.login   // ""),
            comment_id: (.id           // null),
            body:       ((.body | capture("<!-- llm-team:human-signal[[:space:]]+(?<json>\\{.*\\})[[:space:]]*-->") | .json) // ""),
            posted_at:  (.created_at   // "")
          }
        | tostring
      '
      ;;
    milestone)
      gh_with_retry gh api "repos/${repo}/milestones/${num}" --jq '
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
        | tostring
      '
      ;;
    *) log_error "it_comment_collect_signals: invalid kind '${kind}'"; return 1 ;;
  esac
}

# it_comment_has_marker <repo> <kind> <num> <marker_kind>
# 0: marker 존재, 1: 부재.
it_comment_has_marker() {
  local repo="$1" kind="$2" num="$3" marker_kind="$4"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] && [ -n "${marker_kind}" ] || {
    log_error "it_comment_has_marker: repo, kind, num, marker_kind are required"
    return 2
  }
  local marker body
  marker="$(marker_notified "${marker_kind}")"
  case "${kind}" in
    issue|pr)
      body="$(gh_with_retry gh api "repos/${repo}/issues/${num}/comments" \
                --jq '.[].body' 2>/dev/null || true)"
      ;;
    milestone)
      body="$(gh_with_retry gh api "repos/${repo}/milestones/${num}" \
                --jq '.description // ""' 2>/dev/null || true)"
      ;;
    *) log_error "it_comment_has_marker: invalid kind '${kind}'"; return 2 ;;
  esac
  printf '%s' "${body}" | grep -Fq "${marker}"
}

# ============================================================================
# Port API: Revision pin
# ============================================================================

# it_revision_pin_get <repo> <kind> <num> <scope>  → echo pin string
# scope: 'metadata' | 'body' | 'description' 등 — adapter 가 알아서 적절한 값 반환.
it_revision_pin_get() {
  local repo="$1" kind="$2" num="$3" scope="${4:-metadata}"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${num}" ] || {
    log_error "it_revision_pin_get: repo, kind, num are required"
    return 1
  }
  case "${kind}" in
    issue|pr|task|feature_request_issue)
      gh_with_retry gh api "repos/${repo}/issues/${num}" --jq '.updated_at // empty'
      ;;
    milestone)
      gh_with_retry gh api "repos/${repo}/milestones/${num}" --jq '.updated_at // empty'
      ;;
    *) log_error "it_revision_pin_get: invalid kind '${kind}'"; return 1 ;;
  esac
}

# ============================================================================
# Port API: Context snapshot
# ============================================================================

# it_object_get_snapshot <repo> <kind> <id>  → echo markdown block | empty
# Read-only fetch of an object's live content for prompt injection. On any
# fetch failure we return 0 with empty stdout — the caller treats that as
# "snapshot unavailable" and falls back to the manifest-only context.
it_object_get_snapshot() {
  local repo="$1" kind="$2" id="$3"
  [ -n "${repo}" ] && [ -n "${kind}" ] && [ -n "${id}" ] || {
    log_error "it_object_get_snapshot: repo, kind, id are required"
    return 1
  }
  case "${kind}" in
    milestone)
      local m
      m="$(gh_with_retry gh api "repos/${repo}/milestones/${id}" 2>/dev/null)" || return 0
      printf '### milestone:%s\n#### title\n%s\n\n#### description\n%s\n' \
        "${id}" \
        "$(printf '%s' "${m}" | jq -r '.title // ""')" \
        "$(printf '%s' "${m}" | jq -r '.description // ""')"
      ;;
    issue|task|feature_request_issue)
      local s labels
      s="$(gh_with_retry gh api "repos/${repo}/issues/${id}" 2>/dev/null)" || return 0
      labels="$(printf '%s' "${s}" | jq -r '[.labels[].name] | join(",")')"
      printf '### issue:%s\n#### title\n%s\n\n#### labels\n%s\n\n#### body\n%s\n' \
        "${id}" \
        "$(printf '%s' "${s}" | jq -r '.title // ""')" \
        "${labels}" \
        "$(printf '%s' "${s}" | jq -r '.body // ""')"
      ;;
    pr)
      local p
      p="$(gh_with_retry gh api "repos/${repo}/pulls/${id}" 2>/dev/null)" || return 0
      printf '### pr:%s\n#### title\n%s\n\n#### body\n%s\n' \
        "${id}" \
        "$(printf '%s' "${p}" | jq -r '.title // ""')" \
        "$(printf '%s' "${p}" | jq -r '.body // ""')"
      ;;
    *)
      # Unknown kind — no snapshot, but not an error (caller only injects
      # when populated).
      return 0
      ;;
  esac
}
