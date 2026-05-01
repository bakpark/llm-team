#!/usr/bin/env bash
# scheduler/run-pm.sh — PM Agent 진입점.
#
# 용법:
#   scheduler/run-pm.sh <target>
#
# 동작 (memory/state-machine.md §4 PM 행, planning.md §8.3):
#   1. stale 복구 inline 실행.
#   2. needs-scenarios 라벨이 붙은 Milestone 1개 픽업 (가장 오래된 것).
#   3. 같은 타겟에 pm:in-progress Milestone 있으면 skip.
#   4. 라벨 atomic 전이: needs-scenarios → pm:in-progress.
#   5. 같은 Milestone에 이미 연결된 Issue 제목 목록 수집 (멱등성).
#   6. 1-shot Claude Code 호출. prompt = prompts/pm.md + 입력 3블록.
#   7. 출력의 "--- ISSUE N ---" 블록을 파싱해 각 항목마다 Issue 생성
#      (라벨 needs-human-review:scenario 자동 부착).
#   8. Milestone 라벨 atomic 전이: pm:in-progress → pm:done.
#   9. 생성된 각 Issue마다 Notifier 호출 (kind=scenario, N개 알림).
#
# 멱등성:
#   - LLM이 기존 Issue와 의미적으로 같은 시나리오는 출력에서 제외.
#   - 부분 실패 시 라벨은 pm:in-progress 유지 → stale 복구가 needs-scenarios로
#     회수 → 다음 cron이 누락분만 추가 생성.
#
# Claude Code 호출:
#   기본 명령은 `claude --print`. 환경변수 LLM_TEAM_CLAUDE_CMD 로 오버라이드 가능
#   (테스트/대체 모델용). 명령은 stdin으로 prompt를 받아 stdout으로 응답을 출력해야 한다.

set -euo pipefail

usage() {
  echo "Usage: $0 <target>" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
TARGET="$1"
[ -n "${TARGET}" ] || usage

# Resolve framework root from this script's location and source the lib.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT
# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# Claude invocation is centralised in lib/claude.sh#claude_invoke (stdin pipe,
# LLM_TEAM_CLAUDE_CMD override). 본 변수 자체는 더 이상 사용하지 않는다.

# ---------------------------------------------------------------------------
# 1. Bootstrapping: load target, init log, run stale recovery.
# ---------------------------------------------------------------------------

load_target "${TARGET}"
log_init pm "${TARGET}"
log_info "run-pm: starting target=${TARGET}"
run_stale_recovery "${TARGET}"

REPO="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
PREFIX="${TARGET_LABEL_PREFIX}"
LBL_NEEDS_SCENARIOS="$(label_with_prefix "${PREFIX}" "${LABEL_NEEDS_SCENARIOS}")"
LBL_PM_IN_PROGRESS="$(label_with_prefix "${PREFIX}" "${LABEL_PM_IN_PROGRESS}")"
LBL_PM_DONE="$(label_with_prefix "${PREFIX}" "${LABEL_PM_DONE}")"
LBL_SCENARIO_REVIEW="$(label_with_prefix "${PREFIX}" "${LABEL_SCENARIO_REVIEW}")"

# ---------------------------------------------------------------------------
# 2-3. Trigger conditions.
# ---------------------------------------------------------------------------

# (a) pm:in-progress Milestone이 같은 타겟에 이미 있으면 skip (직렬성 보장).
PM_IN_PROGRESS_NUMS="$(milestone_list_by_label "${REPO}" "${LBL_PM_IN_PROGRESS}" 2>/dev/null || true)"
if [ -n "${PM_IN_PROGRESS_NUMS}" ]; then
  log_info "run-pm: pm:in-progress milestone(s) exist — skip pickup. nums=${PM_IN_PROGRESS_NUMS}"
  exit 0
fi

# (b) needs-scenarios Milestone 픽업 (가장 오래된 1개).
NEEDS_NUMS="$(milestone_list_by_label "${REPO}" "${LBL_NEEDS_SCENARIOS}" 2>/dev/null || true)"
if [ -z "${NEEDS_NUMS}" ]; then
  log_info "run-pm: no milestone with label '${LBL_NEEDS_SCENARIOS}' — exit"
  exit 0
fi
MS_NUM="$(printf '%s\n' "${NEEDS_NUMS}" | head -n 1)"
log_info "run-pm: picked milestone #${MS_NUM}"

# ---------------------------------------------------------------------------
# 4. Atomic label transition: needs-scenarios → pm:in-progress.
# ---------------------------------------------------------------------------

if ! milestone_set_label "${REPO}" "${MS_NUM}" "${LBL_PM_IN_PROGRESS}" "${LBL_NEEDS_SCENARIOS}"; then
  log_error "run-pm: label transition needs-scenarios → pm:in-progress failed on milestone #${MS_NUM}"
  exit 1
fi

# Failure trap: leave label as pm:in-progress (stale recovery will regress to
# needs-scenarios after threshold). Best-effort extra log on unclean exit.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then log_error "run-pm: aborted rc=$rc on milestone #'"${MS_NUM}"' — label remains pm:in-progress; stale recovery will regress"; fi' EXIT

# ---------------------------------------------------------------------------
# 5. Idempotency input: existing issue titles + milestone body + comments.
# ---------------------------------------------------------------------------

MS_TITLE="$(gh_with_retry gh api "repos/${REPO}/milestones/${MS_NUM}" --jq '.title // ""')"
MS_BODY="$(gh_with_retry gh api "repos/${REPO}/milestones/${MS_NUM}" --jq '.description // ""')"

# Strip our internal milestone-label markers from the body the LLM sees.
MS_BODY_CLEAN="$(printf '%s\n' "${MS_BODY}" | sed -E '/<!-- llm-team:milestone-label:[^>]*-->/d; /<!-- llm-team:notified:[a-z-]+ -->/d')"

# Comments authored on the milestone via attached issues' parent? Milestones lack
# a comment endpoint, so user feedback typically lives in the milestone
# description itself (PO appends) or as a 0-issue placeholder. We surface any
# explicit "## 사람 코멘트" subsection from the description if present, else "(없음)".
HUMAN_COMMENTS="(없음)"
if printf '%s' "${MS_BODY_CLEAN}" | grep -q '^## 사람 코멘트'; then
  HUMAN_COMMENTS="$(printf '%s\n' "${MS_BODY_CLEAN}" | awk '/^## 사람 코멘트/{flag=1;next} /^## /{flag=0} flag')"
  [ -n "${HUMAN_COMMENTS}" ] || HUMAN_COMMENTS="(없음)"
fi

EXISTING_TITLES="$(gh_with_retry gh issue list --repo "${REPO}" \
  --milestone "${MS_TITLE}" --state all --limit 200 \
  --json title --jq '.[].title' 2>/dev/null || true)"
if [ -z "${EXISTING_TITLES}" ]; then
  EXISTING_TITLES_BLOCK="(없음)"
else
  EXISTING_TITLES_BLOCK="$(printf '%s\n' "${EXISTING_TITLES}" | sed 's/^/- /')"
fi

# ---------------------------------------------------------------------------
# 6. 1-shot Claude Code call.
# ---------------------------------------------------------------------------

PROMPT_TEMPLATE="$(cat "${LLM_TEAM_ROOT}/prompts/pm.md")"

# Compose the full prompt with the three input blocks appended.
PROMPT="$(cat <<EOF
${PROMPT_TEMPLATE}

---

## 입력: Milestone 본문

${MS_BODY_CLEAN}

---

## 입력: 사람 코멘트

${HUMAN_COMMENTS}

---

## 입력: 이미 생성된 Issue 제목 목록

${EXISTING_TITLES_BLOCK}
EOF
)"

LLM_RAW_FILE="${LLM_TEAM_ROOT}/workdir/${TARGET}/logs/pm-llm-$(date -u +%Y%m%dT%H%M%SZ).out"
mkdir -p "$(dirname "${LLM_RAW_FILE}")"

log_info "run-pm: invoking Claude Code via claude_invoke"
if ! claude_invoke "${PROMPT}" >"${LLM_RAW_FILE}" 2>>"${LLM_RAW_FILE}.err"; then
  log_error "run-pm: claude_invoke failed; raw output at ${LLM_RAW_FILE}{,.err}"
  # Leave label as pm:in-progress; stale recovery will eventually regress.
  exit 1
fi

LLM_OUTPUT="$(cat "${LLM_RAW_FILE}")"

# ---------------------------------------------------------------------------
# 7. Parse "--- ISSUE N ---" blocks and create Issues.
# ---------------------------------------------------------------------------

# NO_ISSUES sentinel: no missing scenarios — proceed to pm:done with zero work.
created_count=0
parse_failed=0
created_numbers=()

if printf '%s' "${LLM_OUTPUT}" | grep -qE '^[[:space:]]*NO_ISSUES[[:space:]]*$'; then
  log_info "run-pm: LLM returned NO_ISSUES — all scenarios already created"
elif ! printf '%s' "${LLM_OUTPUT}" | grep -qE '^--- ISSUE [0-9]+ ---'; then
  log_error "run-pm: LLM output did not contain any '--- ISSUE N ---' block; output stored at ${LLM_RAW_FILE}"
  # Leave label pm:in-progress for retry. Comment on milestone for traceability.
  err_note="## PM Agent 출력 형식 위반"$'\n\n'"LLM 출력에서 '--- ISSUE N ---' 블록을 찾지 못했습니다. 원본 출력은 \`${LLM_RAW_FILE}\` 참조."
  # Milestones lack a comment API — append a note to the description so the
  # human reviewer sees the failure context next time they look.
  desc_now="$(_milestone_get_description "${REPO}" "${MS_NUM}" 2>/dev/null || echo "")"
  _milestone_patch_description "${REPO}" "${MS_NUM}" "${desc_now}"$'\n\n'"${err_note}" || true
  parse_failed=1
  exit 1
else
  # Stream-iterate the raw output and track --- ISSUE N --- / --- END ---
  # markers directly in bash (no awk-escape portability issues).
  TMP_RAW="$(mktemp -t pm-raw.XXXXXX)"
  printf '%s\n' "${LLM_OUTPUT}" >"${TMP_RAW}"

  block=""
  in_block=0
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      '--- ISSUE '*' ---'*)
        in_block=1
        block=""
        continue
        ;;
      '--- END ---'*)
        in_block=0
        if [ -n "${block}" ]; then
          # Extract TITLE: line and BODY: section.
          title="$(printf '%s\n' "${block}" | awk '/^TITLE:/{sub(/^TITLE:[[:space:]]*/,""); print; exit}')"
          body="$(printf '%s\n' "${block}" | awk 'BEGIN{f=0} /^BODY:[[:space:]]*$/{f=1; next} f{print}')"
          if [ -z "${title}" ] || [ -z "${body}" ]; then
            log_warn "run-pm: skipping malformed block (missing TITLE or BODY)"
          else
            # Append the agent-message-contract §2 footer (Milestone backref).
            full_body="${body}"$'\n\n'"## 출처 Milestone"$'\n\n'"#${MS_NUM}"
            log_info "run-pm: creating issue title='${title}'"
            if issue_url="$(gh_with_retry gh issue create --repo "${REPO}" \
                              --title "${title}" \
                              --body "${full_body}" \
                              --milestone "${MS_TITLE}" \
                              --label "${LBL_SCENARIO_REVIEW}" 2>&1)"; then
              # gh issue create prints the issue URL on success.
              issue_num="$(printf '%s' "${issue_url}" | sed -E 's|.*/issues/([0-9]+).*|\1|')"
              if [ -n "${issue_num}" ] && [ "${issue_num}" != "${issue_url}" ]; then
                created_numbers+=("${issue_num}")
                created_count=$((created_count+1))
                log_info "run-pm: created issue #${issue_num} (${issue_url})"
              else
                log_warn "run-pm: gh issue create succeeded but could not parse issue number: ${issue_url}"
              fi
            else
              log_error "run-pm: gh issue create failed for title='${title}': ${issue_url}"
              parse_failed=1
            fi
          fi
        fi
        block=""
        continue
        ;;
      *)
        if [ "${in_block}" -eq 1 ]; then
          block="${block}${line}"$'\n'
        fi
        ;;
    esac
  done <"${TMP_RAW}"
  rm -f "${TMP_RAW}"
fi

# ---------------------------------------------------------------------------
# 8. Final milestone label transition.
# ---------------------------------------------------------------------------

if [ "${parse_failed}" -ne 0 ]; then
  log_error "run-pm: at least one issue creation failed; leaving milestone #${MS_NUM} as pm:in-progress for stale recovery"
  exit 1
fi

if ! milestone_set_label "${REPO}" "${MS_NUM}" "${LBL_PM_DONE}" "${LBL_PM_IN_PROGRESS}"; then
  log_error "run-pm: label transition pm:in-progress → pm:done failed on milestone #${MS_NUM}"
  # Stale recovery would regress this back to needs-scenarios — the new Issues
  # are already in place, so the next PM cron will see them and produce no work.
  exit 1
fi
log_info "run-pm: milestone #${MS_NUM} → pm:done (${created_count} new issues)"

# ---------------------------------------------------------------------------
# 9. Notifier: one call per newly created Issue.
# ---------------------------------------------------------------------------

if [ "${#created_numbers[@]}" -gt 0 ]; then
 for issue_num in "${created_numbers[@]}"; do
  [ -n "${issue_num}" ] || continue
  issue_data="$(gh_with_retry gh api "repos/${REPO}/issues/${issue_num}" \
                  --jq '{title: .title, body: .body, html_url: .html_url}' 2>/dev/null || echo '{}')"
  ititle="$(printf '%s' "${issue_data}" | jq -r '.title // ""')"
  iurl="$(printf '%s' "${issue_data}" | jq -r '.html_url // ""')"
  ibody="$(printf '%s' "${issue_data}" | jq -r '.body // ""')"
  scenario_excerpt="$(printf '%s\n' "${ibody}" \
                       | awk 'BEGIN{f=0} /^## User Scenario[[:space:]]*$/{f=1; next} /^## /{f=0} f' \
                       | tr '\n' ' ' | cut -c1-200)"
  summary="${ititle} — ${scenario_excerpt}"
  notify_review_needed "${TARGET}" "scenario" "issue" "${issue_num}" "${iurl}" "${summary}" || true
 done
fi

# Clear the trap on clean exit.
trap - EXIT
log_info "run-pm: done target=${TARGET} milestone=#${MS_NUM} created=${created_count}"
exit 0
