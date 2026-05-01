#!/usr/bin/env bash
# scheduler/run-po.sh — PO Agent entry point.
#
# Usage:
#   scheduler/run-po.sh <target> [--dry-run]
#
# Behaviour (planning.md §8.2 + state-machine.md §4 PO row):
#   1. Load targets/<target>.yaml + start a per-run log file.
#   2. Run inline stale recovery (state-machine.md §5).
#   3. Trigger gate:
#        a) inputs/<target>/*.md must contain at least one unprocessed file
#           (`processed/` subdirectory excluded by glob).
#        b) issue_list_open_milestones <repo> must be empty (open Milestone = 0).
#      If either fails, exit 0 (cron noop).
#   4. Pick the OLDEST unprocessed file; create an empty Milestone via gh API;
#      attach `po:in-progress` via lib/gh.sh#milestone_set_label.
#   5. Compose the LLM prompt by appending the input path/body to prompts/po.md
#      and invoke `claude -p --output-format text` once (1-shot).
#   6. Parse the first `# <title>` line; PATCH the Milestone title + description.
#   7. Atomic transition `po:in-progress` → `needs-human-review:milestone` via
#      milestone_set_label (add → remove order, enforced by lib/gh.sh).
#   8. Notify the human reviewer via lib/notifier.sh#notify_review_needed
#      (kind=milestone, channel from yaml).
#   9. Move the input file into inputs/<target>/processed/.
#
# Failure recovery:
#   • gh API errors → lib/gh.sh#gh_with_retry already does 3-attempt back-off.
#   • Claude failure → leave Milestone with `po:in-progress` (no rollback) and
#     attach a comment; the next stale recovery cycle will reset the label.
#   • input file mv failure → label is already `needs-human-review:milestone`,
#     so the next PO cron is blocked by "open Milestone exists" — no duplicate
#     Milestone is produced.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT
# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <target> [--dry-run]

PO Agent entry point. Picks the oldest unprocessed inputs/<target>/*.md file,
creates a GitHub Milestone, runs the PO prompt via Claude Code, transitions
the Milestone to needs-human-review, and triggers a Notifier alert.

  --dry-run    Walk the full flow without invoking gh, claude, or mv.
EOF
}

DRY_RUN=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

if [ -z "${TARGET}" ]; then
  usage
  exit 2
fi

# 1. Load target config.
load_target "${TARGET}" || { log_error "run-po: load_target failed"; exit 1; }
REPO="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
if [ -z "${TARGET_GH_OWNER}" ] || [ -z "${TARGET_GH_REPO}" ]; then
  log_error "run-po: github.owner / github.repo missing in targets/${TARGET}.yaml"
  exit 1
fi

# 2. Begin per-run logging (skipped under dry-run to keep the developer's
#    terminal output intact).
if [ "${DRY_RUN}" -eq 0 ]; then
  log_init po "${TARGET}"
else
  log_info "DRY: would log_init po ${TARGET}"
fi
log_info "PO Agent starting (target=${TARGET} repo=${REPO} dry_run=${DRY_RUN})"

# 3. Stale recovery (inline at every cron entry — state-machine.md §5).
if [ "${DRY_RUN}" -eq 0 ]; then
  run_stale_recovery "${TARGET}" || log_warn "run-po: stale recovery returned non-zero"
else
  log_info "DRY: would run_stale_recovery ${TARGET}"
fi

# 4a. Trigger gate part 1 — find oldest unprocessed input file.
INPUTS_DIR="${LLM_TEAM_ROOT}/${TARGET_INPUTS_DIR}"
if [ ! -d "${INPUTS_DIR}" ]; then
  log_info "PO: inputs directory '${INPUTS_DIR}' does not exist; nothing to do"
  exit 0
fi

# `*.md` glob matches files directly under INPUTS_DIR — the processed/ subdir
# is intentionally excluded.
INPUT_FILE=""
while IFS= read -r f; do
  [ -n "${f}" ] || continue
  INPUT_FILE="${f}"
  break
done < <(ls -1tr "${INPUTS_DIR}"/*.md 2>/dev/null || true)

if [ -z "${INPUT_FILE}" ]; then
  log_info "PO: no unprocessed inputs in ${INPUTS_DIR}; exiting cleanly"
  exit 0
fi
log_info "PO: selected input ${INPUT_FILE}"

# 4b. Trigger gate part 2 — same target must have ZERO open Milestones.
OPEN_MILESTONES=""
if [ "${DRY_RUN}" -eq 0 ]; then
  OPEN_MILESTONES="$(issue_list_open_milestones "${REPO}" 2>/dev/null || true)"
else
  log_info "DRY: would query issue_list_open_milestones ${REPO}"
fi

if [ -n "${OPEN_MILESTONES}" ]; then
  # Compact multiline output for log readability.
  OPEN_LIST="$(printf '%s' "${OPEN_MILESTONES}" | tr '\n' ',' | sed 's/,$//')"
  log_info "PO: open Milestone(s) exist (#${OPEN_LIST}); skipping (target=${TARGET})"
  exit 0
fi

# 5. Create empty Milestone with a placeholder title; capture its number.
PLACEHOLDER_TITLE="[PO drafting] $(basename "${INPUT_FILE}" .md)"
MILESTONE_NUM=""

if [ "${DRY_RUN}" -eq 0 ]; then
  CREATE_RESPONSE="$(gh_with_retry gh api -X POST "repos/${REPO}/milestones" \
    -f "title=${PLACEHOLDER_TITLE}" -f "description=" 2>&1)" || {
      log_error "PO: failed to create Milestone (response: ${CREATE_RESPONSE})"
      exit 1
  }
  MILESTONE_NUM="$(printf '%s' "${CREATE_RESPONSE}" | jq -r '.number // empty')"
  if [ -z "${MILESTONE_NUM}" ]; then
    log_error "PO: Milestone creation returned no number (response: ${CREATE_RESPONSE})"
    exit 1
  fi
  log_info "PO: created Milestone #${MILESTONE_NUM} title='${PLACEHOLDER_TITLE}'"
else
  MILESTONE_NUM="DRY-RUN"
  log_info "DRY: would create Milestone with title='${PLACEHOLDER_TITLE}' (using #${MILESTONE_NUM})"
fi

# 6. Attach `po:in-progress` label.
PO_LABEL="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${LABEL_PO_IN_PROGRESS}")"
if [ "${DRY_RUN}" -eq 0 ]; then
  if ! milestone_set_label "${REPO}" "${MILESTONE_NUM}" "${PO_LABEL}" ""; then
    log_error "PO: failed to set ${PO_LABEL} on Milestone #${MILESTONE_NUM} — stale recovery will reset"
    exit 1
  fi
else
  log_info "DRY: would milestone_set_label ${REPO} ${MILESTONE_NUM} ${PO_LABEL} ''"
fi

# 7. Build LLM prompt: prompts/po.md + appended input path/body sections.
PROMPT_TEMPLATE_FILE="${LLM_TEAM_ROOT}/prompts/po.md"
if [ ! -f "${PROMPT_TEMPLATE_FILE}" ]; then
  log_error "PO: prompt template ${PROMPT_TEMPLATE_FILE} missing"
  exit 1
fi
INPUT_REL="${INPUT_FILE#${LLM_TEAM_ROOT}/}"
INPUT_BODY="$(cat "${INPUT_FILE}")"
PROMPT_TEMPLATE="$(cat "${PROMPT_TEMPLATE_FILE}")"
PROMPT_FILE="$(mktemp -t po-prompt.XXXXXX)"
trap 'rm -f "${PROMPT_FILE}"' EXIT

printf '%s\n\n---\n\n## 입력 파일 경로\n\n`%s`\n\n## 입력 본문\n\n%s\n' \
  "${PROMPT_TEMPLATE}" "${INPUT_REL}" "${INPUT_BODY}" > "${PROMPT_FILE}"

# 8. 1-shot Claude Code call.
CLAUDE_OUT=""
if [ "${DRY_RUN}" -eq 0 ]; then
  PROMPT_BODY="$(cat "${PROMPT_FILE}")"
  CLAUDE_OUT="$(claude_invoke "${PROMPT_BODY}" 2>&1)" || {
    rc=$?
    log_error "PO: claude_invoke failed (rc=${rc})"
    gh_with_retry gh api -X POST "repos/${REPO}/issues/${MILESTONE_NUM}/comments" \
      -f "body=PO claude call failed: ${CLAUDE_OUT}" >/dev/null 2>&1 || true
    exit 1
  }
else
  CLAUDE_OUT="# DRY-RUN Milestone Title

## 리서치 요약

Dry-run placeholder. The real run would invoke claude with prompt length=$(wc -c < "${PROMPT_FILE}" | tr -d ' ') chars.

## 큰 그림 분해

- 분해 항목 1 (placeholder)
- 분해 항목 2 (placeholder)
- 분해 항목 3 (placeholder)

## 입력 출처

\`${INPUT_REL}\`"
  log_info "DRY: would call 'claude -p --output-format text < ${PROMPT_FILE}' (prompt length=$(wc -c < "${PROMPT_FILE}" | tr -d ' ') bytes)"
fi

# 9. Parse Claude output: first line = title, rest = description body.
FIRST_LINE="$(printf '%s\n' "${CLAUDE_OUT}" | head -n 1)"
TITLE="${FIRST_LINE#\# }"
TITLE="${TITLE#\#}"  # tolerate '#title' without space
TITLE="${TITLE# }"
if [ -z "${TITLE}" ]; then
  log_warn "PO: claude output had no '# title' line; falling back to placeholder"
  TITLE="${PLACEHOLDER_TITLE}"
fi

BODY="$(printf '%s' "${CLAUDE_OUT}" | tail -n +2)"
# Strip leading blank lines so the description starts at "## 리서치 요약".
while [ "${BODY:0:1}" = $'\n' ]; do BODY="${BODY:1}"; done

# 10. PATCH Milestone title + description.
if [ "${DRY_RUN}" -eq 0 ]; then
  if ! gh_with_retry gh api -X PATCH "repos/${REPO}/milestones/${MILESTONE_NUM}" \
        -f "title=${TITLE}" -f "description=${BODY}" >/dev/null; then
    log_error "PO: failed to PATCH Milestone #${MILESTONE_NUM} title/body"
    exit 1
  fi
  log_info "PO: updated Milestone #${MILESTONE_NUM} title='${TITLE}'"
else
  log_info "DRY: would PATCH Milestone #${MILESTONE_NUM} title='${TITLE}' description-length=${#BODY}"
fi

# 11. Atomic transition: po:in-progress → needs-human-review:milestone.
REVIEW_LABEL="$(label_with_prefix "${TARGET_LABEL_PREFIX}" "${LABEL_PO_REVIEW}")"
if [ "${DRY_RUN}" -eq 0 ]; then
  if ! milestone_set_label "${REPO}" "${MILESTONE_NUM}" "${REVIEW_LABEL}" "${PO_LABEL}"; then
    log_error "PO: label transition po:in-progress → needs-human-review:milestone failed"
    exit 1
  fi
else
  log_info "DRY: would milestone_set_label ${REPO} ${MILESTONE_NUM} ${REVIEW_LABEL} ${PO_LABEL}"
fi

# 12. Notifier (idempotency handled inside lib/notifier.sh).
# Build summary using bash string ops to stay multibyte-safe (avoid `tr`/`head -c`
# which mishandle UTF-8 boundaries).
SUMMARY="${BODY//$'\n'/ }"
SUMMARY="${SUMMARY//$'\r'/ }"
SUMMARY="${SUMMARY:0:200}"
SUMMARY="${SUMMARY%"${SUMMARY##*[![:space:]]}"}"
MILESTONE_URL="https://github.com/${REPO}/milestone/${MILESTONE_NUM}"

if [ "${DRY_RUN}" -eq 0 ]; then
  notify_review_needed "${TARGET}" "milestone" "milestone" "${MILESTONE_NUM}" \
    "${MILESTONE_URL}" "${TITLE} — ${SUMMARY}"
else
  log_info "DRY: would notify_review_needed ${TARGET} milestone milestone ${MILESTONE_NUM} ${MILESTONE_URL}"
fi

# 13. Move input file into processed/.
PROCESSED_DIR="${INPUTS_DIR}/processed"
if [ "${DRY_RUN}" -eq 0 ]; then
  if ! mkdir -p "${PROCESSED_DIR}"; then
    log_warn "PO: failed to mkdir ${PROCESSED_DIR}; next cron blocked by open Milestone gate so no duplicate"
  elif ! mv "${INPUT_FILE}" "${PROCESSED_DIR}/$(basename "${INPUT_FILE}")"; then
    log_warn "PO: failed to mv ${INPUT_FILE} → processed/; next cron blocked by open Milestone gate so no duplicate"
  else
    log_info "PO: moved ${INPUT_FILE} → ${PROCESSED_DIR}/"
  fi
else
  log_info "DRY: would mv ${INPUT_FILE} → ${PROCESSED_DIR}/"
fi

log_info "PO Agent done (Milestone #${MILESTONE_NUM} target=${TARGET})"
