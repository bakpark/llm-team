#!/usr/bin/env bash
# tests/e2e/mvp-flow.sh — End-to-end verification driver for the llm-team
# framework (planning.md §10, sub-e2e-verification.md).
#
# Two-phase design:
#   Phase A (default, --phase=a or no flag): run every static / lib-only check
#     that does NOT touch a real GitHub repo. These cover ~70 % of the
#     completion checklist and require no external credentials.
#
#   Phase B (--phase=b <test-target>): run the live MVP scenario against a real
#     GitHub repo. Requires a registered targets/<test-target>.yaml, a
#     gh-authenticated environment, and explicit user opt-in (Phase B mutates
#     remote state — labels, milestones, issues, branches, PRs, merges).
#
# Usage:
#   tests/e2e/mvp-flow.sh                  # Phase A (default)
#   tests/e2e/mvp-flow.sh --phase=a        # Phase A explicit
#   tests/e2e/mvp-flow.sh --phase=b myapp  # Phase B (live, requires user OK)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

PHASE="a"
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --phase=a) PHASE="a"; shift ;;
    --phase=b) PHASE="b"; shift ;;
    -h|--help)
      sed -n '3,20p' "$0" >&2
      exit 0
      ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

# Counters
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
RESULTS=()

_record() {
  local status="$1" name="$2" detail="${3:-}"
  RESULTS+=("${status}|${name}|${detail}")
  case "${status}" in
    PASS) PASS_COUNT=$((PASS_COUNT+1)); printf '  \033[32m✓ PASS\033[0m  %s\n' "${name}" ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT+1)); printf '  \033[31m✗ FAIL\033[0m  %s — %s\n' "${name}" "${detail}" ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT+1)); printf '  \033[33m⊘ SKIP\033[0m  %s — %s\n' "${name}" "${detail}" ;;
  esac
}

_h() { printf '\n=== %s ===\n' "$*"; }

# -----------------------------------------------------------------------------
# Phase A — static / lib-only checks (no GitHub repo)
# -----------------------------------------------------------------------------
phase_a() {
  cd "${LLM_TEAM_ROOT}"
  _h "Phase A — Static and lib-only checks"

  # 1. bash -n on every shell artefact
  _h "1) bash -n syntax check"
  local f rc
  rc=0
  for f in lib/*.sh scripts/*.sh tests/lib/*.sh scheduler/*.sh tests/e2e/*.sh; do
    [ -f "${f}" ] || continue
    if bash -n "${f}" 2>/tmp/mvp_bashn.err; then
      :
    else
      rc=1
      _record FAIL "bash -n ${f}" "$(cat /tmp/mvp_bashn.err)"
    fi
  done
  if [ "${rc}" -eq 0 ]; then
    _record PASS "bash -n on all 19 shell files"
  fi

  # 2. lib smoke tests (4)
  _h "2) lib smoke tests"
  for t in tests/lib/test-labels-consistency.sh \
           tests/lib/test-config-secret.sh \
           tests/lib/test-gh-retry.sh \
           tests/lib/test-bootstrap-dry-run.sh; do
    if bash "${t}" >/tmp/mvp_smoke.out 2>&1; then
      _record PASS "$(basename "${t}")"
    else
      _record FAIL "$(basename "${t}")" "$(tail -3 /tmp/mvp_smoke.out)"
    fi
  done

  # 3. Prompt headings match memory/agent-message-contract.md
  _h "3) Prompt contract headings"
  # PO must list all four §1 headings.
  local po_missing=""
  for h in '## 리서치 요약' '## 큰 그림 분해' '## 제약/주의사항' '## 입력 출처'; do
    grep -Fq "${h}" prompts/po.md || po_missing="${po_missing} ${h}"
  done
  if [ -z "${po_missing}" ]; then
    _record PASS "prompts/po.md exposes all §1 headings"
  else
    _record FAIL "prompts/po.md missing headings" "${po_missing}"
  fi

  # PM must mention §2 headings (Issue body) — the actual `## 출처 Milestone`
  # is appended by run-pm.sh, but the prompt must reference the contract.
  local pm_missing=""
  for h in '## User Scenario' '## 수용 기준' '## 영향 범위'; do
    grep -Fq "${h}" prompts/pm.md || pm_missing="${pm_missing} ${h}"
  done
  if [ -z "${pm_missing}" ]; then
    _record PASS "prompts/pm.md exposes §2 issue-body headings"
  else
    _record FAIL "prompts/pm.md missing headings" "${pm_missing}"
  fi

  # DEV produces three blocks (TITLE/SUMMARY/VALIDATION) — run-dev.sh assembles
  # them into the §3 PR-body shape.
  if grep -Fq '## 변경 요약' prompts/dev.md && grep -Fq '## 검증 방법' prompts/dev.md; then
    _record PASS "prompts/dev.md references §3 PR-body section names"
  else
    _record FAIL "prompts/dev.md does not reference §3 section names" \
      "(expected '## 변경 요약' and '## 검증 방법')"
  fi

  # QA must reference both §4 (1차 실패) and §5 (2차 실패) comment formats.
  if grep -Fq 'QA 검증 실패 (1차)' prompts/qa.md \
     && grep -Fq 'QA 검증 실패 (2차) — Human Review Required' prompts/qa.md; then
    _record PASS "prompts/qa.md references §4 and §5 failure-comment headings"
  else
    _record FAIL "prompts/qa.md missing §4 or §5 headings"
  fi

  # 4. Schedulers assemble the contract sections that the prompts can't author
  _h "4) Scheduler contract assembly"
  if grep -Fq '## 출처 Milestone' scheduler/run-pm.sh; then
    _record PASS "run-pm.sh appends '## 출처 Milestone' to issue body"
  else
    _record FAIL "run-pm.sh missing '## 출처 Milestone' assembly"
  fi
  # NOTE (.plan/26050112-daemon-self-fetch §3.1): DEV scheduler is now thin —
  # the LLM (prompts/dev.md) creates/edits the PR itself, so the §3 PR body
  # contract lives in prompts/dev.md rather than in the scheduler.
  if grep -Fq '## Closes' prompts/dev.md \
     && grep -Fq '## 변경 요약' prompts/dev.md \
     && grep -Fq '## 검증 방법' prompts/dev.md \
     && grep -Fq 'llm-team:qa-attempts' prompts/dev.md; then
    _record PASS "prompts/dev.md instructs the LLM to author full PR body (§3)"
  else
    _record FAIL "prompts/dev.md missing one of §3 PR-body sections"
  fi

  # 5. Direct webhook / curl in schedulers — must be 0 (Notifier rule)
  _h "5) Notifier purity (no direct webhook/curl in schedulers)"
  if grep -nE 'webhook|hooks\.|discord\.com/api|slack\.com/api' scheduler/*.sh \
       | grep -v '^[[:space:]]*#' | grep -q .; then
    _record FAIL "scheduler/*.sh contains direct webhook reference"
  else
    _record PASS "no direct webhook reference in schedulers"
  fi
  if grep -nE '^[^#]*\bcurl\b' scheduler/*.sh | grep -q .; then
    _record FAIL "scheduler/*.sh contains direct curl call"
  else
    _record PASS "no direct curl call in schedulers"
  fi

  # 6. Atomic transition rule — direct gh ... --add/remove-label outside lib
  _h "6) Atomic-transition centralisation"
  local stray
  stray="$(grep -nE -- '(gh issue edit|gh pr edit).*(add-label|remove-label)' \
            scheduler/*.sh scripts/*.sh 2>/dev/null \
            | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*//' \
            | grep -v ':[0-9]*:[[:space:]]*#' || true)"
  if [ -z "${stray}" ]; then
    _record PASS "all label add/remove flags routed via lib helpers"
  else
    _record FAIL "direct label flag found outside lib" "${stray}"
  fi

  # Lib must use add → remove order
  if awk '/^issue_set_label\(\)/,/^}/' lib/gh.sh | grep -nE 'add-label|remove-label' \
     | head -2 | awk -F: '{print $2}' | xargs | grep -q 'add-label.*remove-label'; then
    _record PASS "issue_set_label preserves add → remove order"
  else
    # Inspect ordering manually
    local order
    order="$(awk '/^issue_set_label\(\)/,/^}/' lib/gh.sh | grep -oE 'add-label|remove-label' | xargs)"
    if [ "${order}" = "add-label remove-label" ]; then
      _record PASS "issue_set_label preserves add → remove order"
    else
      _record FAIL "issue_set_label order: ${order}"
    fi
  fi

  # 7. Stale recovery: every scheduler runs run_stale_recovery on entry
  _h "7) Stale recovery wiring"
  for s in scheduler/run-po.sh scheduler/run-pm.sh scheduler/run-dev.sh scheduler/run-qa.sh; do
    if grep -Fq 'run_stale_recovery' "${s}"; then
      _record PASS "$(basename "${s}") calls run_stale_recovery"
    else
      _record FAIL "$(basename "${s}") missing run_stale_recovery"
    fi
  done

  # 8. Notifier kinds: PO=milestone, PM=scenario, DEV/QA=dev-failure
  _h "8) Notifier kind binding"
  if grep -E 'notify_review_needed.*"milestone"' scheduler/run-po.sh >/dev/null; then
    _record PASS "run-po.sh: kind=milestone"
  else
    _record FAIL "run-po.sh: kind=milestone not found"
  fi
  if grep -E 'notify_review_needed.*"scenario"' scheduler/run-pm.sh >/dev/null; then
    _record PASS "run-pm.sh: kind=scenario"
  else
    _record FAIL "run-pm.sh: kind=scenario not found"
  fi
  if grep -E 'notify_review_needed.*"dev-failure"' scheduler/run-dev.sh >/dev/null; then
    _record PASS "run-dev.sh: kind=dev-failure"
  else
    _record FAIL "run-dev.sh: kind=dev-failure not found"
  fi
  if grep -E 'notify_review_needed.*"dev-failure"' scheduler/run-qa.sh >/dev/null; then
    _record PASS "run-qa.sh: kind=dev-failure"
  else
    _record FAIL "run-qa.sh: kind=dev-failure not found"
  fi

  # 9. PO --dry-run end-to-end
  _h "9) PO dry-run e2e"
  if bash scheduler/run-po.sh myapp --dry-run >/tmp/mvp_po_dry.out 2>&1; then
    # Verify expected stages
    local missing=""
    for marker in \
      'PO Agent starting' \
      'DRY: would run_stale_recovery' \
      'PO: selected input' \
      'DRY: would query issue_list_open_milestones' \
      'DRY: would create Milestone' \
      'DRY: would milestone_set_label' \
      'DRY: would call' \
      'DRY: would PATCH Milestone' \
      'DRY: would notify_review_needed' \
      'DRY: would mv' \
      'PO Agent done'; do
      grep -Fq "${marker}" /tmp/mvp_po_dry.out || missing="${missing}${marker}|"
    done
    if [ -z "${missing}" ]; then
      _record PASS "run-po.sh --dry-run walks all 11 stages"
    else
      _record FAIL "run-po.sh --dry-run missing stages" "${missing}"
    fi
  else
    _record FAIL "run-po.sh --dry-run exited non-zero" "$(tail -3 /tmp/mvp_po_dry.out)"
  fi

  # 10. lib API surface — all advertised public functions defined after sourcing common
  _h "10) lib public-API surface"
  local missing_fns=""
  for fn in log_info log_warn log_error log_init \
            label_with_prefix \
            load_target resolve_secret list_active_targets \
            gh_with_retry issue_set_label milestone_set_label \
            milestone_get_progress milestone_close \
            issue_list_by_label milestone_list_by_label \
            issue_list_open_milestones issue_get_milestone \
            issue_clear_state_labels \
            marker_notified marker_qa_attempts comments_have_marker \
            pr_body_get_attempts pr_body_set_attempts \
            notify_review_needed \
            worktree_create worktree_remove worktree_list \
            count_in_progress \
            recover_stale_milestones recover_stale_issues \
            recover_orphan_milestones run_stale_recovery; do
    bash -c ". ${LLM_TEAM_ROOT}/lib/common.sh; type -t ${fn} >/dev/null" 2>/dev/null \
      || missing_fns="${missing_fns} ${fn}"
  done
  if [ -z "${missing_fns}" ]; then
    _record PASS "all advertised lib functions defined after sourcing common.sh"
  else
    _record FAIL "missing lib functions" "${missing_fns}"
  fi

  # 11. Label-array sizes (5 + 7 = 12)
  _h "11) Label-array invariants"
  local m_count i_count
  m_count="$(bash -c ". ${LLM_TEAM_ROOT}/lib/common.sh; echo \${#ALL_MILESTONE_LABELS[@]}")"
  i_count="$(bash -c ". ${LLM_TEAM_ROOT}/lib/common.sh; echo \${#ALL_ISSUE_LABELS[@]}")"
  if [ "${m_count}" = "5" ] && [ "${i_count}" = "7" ]; then
    _record PASS "ALL_MILESTONE_LABELS=5, ALL_ISSUE_LABELS=7 (total 12)"
  else
    _record FAIL "label arrays" "milestone=${m_count} issue=${i_count}"
  fi

  # 12. Stale recovery exposes 4 regression scenarios + orphan
  _h "12) Stale recovery scenarios"
  local stale_fns=""
  for fn in recover_stale_milestones recover_stale_issues \
            recover_orphan_milestones run_stale_recovery; do
    grep -qE "^${fn}\(\)" lib/stale.sh || stale_fns="${stale_fns} ${fn}"
  done
  if [ -z "${stale_fns}" ]; then
    _record PASS "lib/stale.sh exposes po/pm/dev/qa + orphan recovery"
  else
    _record FAIL "lib/stale.sh missing functions" "${stale_fns}"
  fi
}

# -----------------------------------------------------------------------------
# Phase B — live GitHub run (placeholder)
# -----------------------------------------------------------------------------
phase_b() {
  if [ -z "${TARGET}" ]; then
    echo "Phase B requires a target name. Usage: $(basename "$0") --phase=b <target>" >&2
    exit 2
  fi
  cat <<EOF >&2

Phase B is a LIVE end-to-end run against a real GitHub repository.
It mutates remote state (labels, milestones, issues, branches, PRs, merges).
It requires:
  - targets/${TARGET}.yaml registered with a real github.owner / github.repo
  - .env with GH_TOKEN and (optional) Notifier secrets
  - gh CLI authenticated with sufficient scopes
  - User explicit opt-in (this script does not auto-run Phase B in CI)

Suggested manual sequence (per sub-e2e-verification.md §B):
  1. scripts/bootstrap-labels.sh ${TARGET}
  2. scheduler/run-po.sh ${TARGET}
  3. (manual) GitHub UI: relabel needs-human-review:milestone → needs-scenarios
  4. scheduler/run-pm.sh ${TARGET}
  5. (manual) relabel one needs-human-review:scenario → needs-dev
  6. scheduler/run-dev.sh ${TARGET}
  7. scheduler/run-qa.sh ${TARGET}
  8. inspect labels/milestone state and confirm Milestone closes when last issue closes
  9. add a fresh inputs/${TARGET}/foo2.md, re-run PO to confirm the new cycle starts

The verification report at docs/superpowers/specs/e2e-verification-report.md
records pass/fail of each step. Phase B execution is gated on user approval
because it is irreversible.

EOF
  exit 3
}

case "${PHASE}" in
  a) phase_a ;;
  b) phase_b ;;
esac

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
printf '\n=== Summary ===\n'
printf 'PASS=%d  FAIL=%d  SKIP=%d  TOTAL=%d\n' \
  "${PASS_COUNT}" "${FAIL_COUNT}" "${SKIP_COUNT}" \
  "$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))"

if [ "${FAIL_COUNT}" -gt 0 ]; then
  printf '\nFailures:\n'
  for r in "${RESULTS[@]}"; do
    case "${r}" in
      FAIL\|*) printf '  - %s\n' "${r#FAIL|}" ;;
    esac
  done
  exit 1
fi
exit 0
