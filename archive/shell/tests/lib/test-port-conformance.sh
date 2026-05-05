#!/usr/bin/env bash
# tests/lib/test-port-conformance.sh
#
# Phase 2 — Port Conformance 테스트.
#
# 동일한 port-call 시나리오를 in_memory 와 github (가능한 경우) 양쪽에서 검증해
# in_memory 를 prod 의 sound 한 testing-double 로 유지하기 위한 안전망이다.
#
# 본 테스트의 두 가지 모드:
#   1. in_memory 단정 — issue_tracker / workspace 시나리오를 in_memory adapter
#      로 실행해 결과(반환값/상태/멱등성)를 깊게 단정한다.
#   2. github syntactic verify — gh 가 설치되고 인증되어 있으면 github adapter
#      를 source 한 후 registry_verify_port + 핵심 함수 declare -F 만 검사한다.
#      실제 gh 호출(실 repo 변경) 은 하지 않는다 — 본 conformance 의 의도가
#      "선언/시그니처 동치성 + in_memory 의미 검증" 이기 때문.
#
# Skip 조건 (github 분기 한정):
#   • LLM_TEAM_PORT_CONFORMANCE_SKIP_GITHUB=1
#   • command -v gh 실패
#   • gh auth status 실패
#
# 격리: LLM_TEAM_INMEM_*_DIR 을 mktemp 로 분리, trap cleanup 으로 정리.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# ----------------------------------------------------------------------------
# 격리: 모든 in_memory adapter 의 루트를 임시 디렉토리로.
# ----------------------------------------------------------------------------
INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-conformance-it-XXXXXX")"
INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-conformance-ps-XXXXXX")"
INMEM_WS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-conformance-ws-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${INMEM_IT_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${INMEM_PS_DIR}"
export LLM_TEAM_INMEM_WS_DIR="${INMEM_WS_DIR}"

# 기본 adapter 를 in_memory 로 바인딩.
export LLM_TEAM_ADAPTER_ISSUE_TRACKER="in_memory"
export LLM_TEAM_ADAPTER_PERSISTENT_STORE="in_memory"
export LLM_TEAM_ADAPTER_WORKSPACE="in_memory"

# in_memory adapter 가 참조하는 target context (load_target 없이 직접 설정).
export TARGET_NAME="conformance-test"
export TARGET_LABEL_PREFIX=""

cleanup() {
  rm -rf "${INMEM_IT_DIR}" "${INMEM_PS_DIR}" "${INMEM_WS_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

REPO="conformance-test/repo"

# ============================================================================
# Section 1: in_memory issue_tracker 시나리오 단정
# ============================================================================
echo "--- Section 1: in_memory issue_tracker scenario ---"

[ "${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-}" = "in_memory" ] \
  || fail "expected active issue_tracker = in_memory (got '${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-}')"

# (1) it_milestone_create
ms_num="$(it_milestone_create "${REPO}" "ms-1" "milestone body" 2>/dev/null)"
[ -n "${ms_num}" ] || fail "it_milestone_create returned empty"
case "${ms_num}" in
  *[!0-9]*|'') fail "it_milestone_create did not return numeric id (got='${ms_num}')" ;;
esac

# (2) it_milestone_set_state PO_DRAFT (멱등 호출 포함)
it_milestone_set_state "${REPO}" "${ms_num}" PO_DRAFT \
  || fail "it_milestone_set_state PO_DRAFT failed"
it_milestone_set_state "${REPO}" "${ms_num}" PO_DRAFT \
  || fail "it_milestone_set_state PO_DRAFT idempotent re-apply failed"

# (3) it_milestone_get_state → "PO_DRAFT"
got_state="$(it_milestone_get_state "${REPO}" "${ms_num}" 2>/dev/null)"
[ "${got_state}" = "PO_DRAFT" ] \
  || fail "it_milestone_get_state expected 'PO_DRAFT', got '${got_state}'"

# (4) it_milestone_list_in_state PO_DRAFT → "${ms_num}"
list_state="$(it_milestone_list_in_state "${REPO}" PO_DRAFT 2>/dev/null \
  | tr -d ' \n')"
[ "${list_state}" = "${ms_num}" ] \
  || fail "it_milestone_list_in_state PO_DRAFT expected '${ms_num}', got '${list_state}'"

# 잘못된 state 는 invariant I2 — 비0 반환
if it_milestone_set_state "${REPO}" "${ms_num}" NOT_A_STATE 2>/dev/null; then
  fail "it_milestone_set_state should reject invalid state (I2)"
fi

# (5) it_issue_create with --milestone, --labels
issue_num="$(it_issue_create "${REPO}" \
  --title "task1" \
  --body "task1 body" \
  --milestone "${ms_num}" \
  --labels "task:pending" \
  2>/dev/null)"
[ -n "${issue_num}" ] || fail "it_issue_create returned empty"
case "${issue_num}" in
  *[!0-9]*|'') fail "it_issue_create did not return numeric id (got='${issue_num}')" ;;
esac

# (6) it_issue_list_with_label task:pending → ${issue_num}
issue_list="$(it_issue_list_with_label "${REPO}" task:pending 2>/dev/null \
  | tr -d ' \n')"
[ "${issue_list}" = "${issue_num}" ] \
  || fail "it_issue_list_with_label task:pending expected '${issue_num}', got '${issue_list}'"

# milestone 링크 검증
got_ms="$(it_issue_get_milestone "${REPO}" "${issue_num}" 2>/dev/null)"
[ "${got_ms}" = "${ms_num}" ] \
  || fail "it_issue_get_milestone expected '${ms_num}', got '${got_ms}'"

# revision_pin 가 빈 값이 아니어야 한다 (updated_at)
pin="$(it_revision_pin_get "${REPO}" milestone "${ms_num}" 2>/dev/null)"
[ -n "${pin}" ] || fail "it_revision_pin_get milestone returned empty"

# (7) it_milestone_close + (의미 동치를 위해) issue 도 close
# 진행률은 in_memory/github 양쪽 모두 issue.state 기반으로 계산되는 것이
# 의미 동치이므로, 시나리오 의도("open=0 closed=1") 를 충족하기 위해
# 명시적으로 issue 를 닫는다.
it_milestone_close "${REPO}" "${ms_num}" \
  || fail "it_milestone_close failed"
it_issue_close_with_note "${REPO}" "${issue_num}" "task done" \
  || fail "it_issue_close_with_note failed"

# (8) it_milestone_get_progress → "open=0 closed=1"
progress="$(it_milestone_get_progress "${REPO}" "${ms_num}" 2>/dev/null)"
[ "${progress}" = "open=0 closed=1" ] \
  || fail "it_milestone_get_progress expected 'open=0 closed=1', got '${progress}'"

# 추가: PR 생성 + cp_state 멱등성 (markdown marker 형식)
pr_num="$(it_pr_create "${REPO}" \
  --head feat/task1 --base main \
  --title "task1 PR" --body "" \
  2>/dev/null)"
[ -n "${pr_num}" ] || fail "it_pr_create returned empty"
it_pr_set_cp_state "${REPO}" "${pr_num}" CP_DRAFT \
  || fail "it_pr_set_cp_state CP_DRAFT failed"
got_cp="$(it_pr_get_cp_state "${REPO}" "${pr_num}" 2>/dev/null)"
[ "${got_cp}" = "CP_DRAFT" ] \
  || fail "it_pr_get_cp_state expected CP_DRAFT, got '${got_cp}'"
# 전이: CP_DRAFT → CP_READY_FOR_REVIEW (old marker 제거)
it_pr_set_cp_state "${REPO}" "${pr_num}" CP_READY_FOR_REVIEW CP_DRAFT \
  || fail "it_pr_set_cp_state CP_READY_FOR_REVIEW failed"
got_cp2="$(it_pr_get_cp_state "${REPO}" "${pr_num}" 2>/dev/null)"
[ "${got_cp2}" = "CP_READY_FOR_REVIEW" ] \
  || fail "after transition, expected CP_READY_FOR_REVIEW, got '${got_cp2}'"

# pr 헤드 sha 가 비어있지 않아야 한다 (Phase 1.5 함수)
head_sha_pr="$(it_pr_get_head_sha "${REPO}" "${pr_num}" 2>/dev/null)"
[ -n "${head_sha_pr}" ] || fail "it_pr_get_head_sha returned empty"

# pr_close 멱등성
it_pr_close "${REPO}" "${pr_num}" \
  || fail "it_pr_close failed"
it_pr_close "${REPO}" "${pr_num}" \
  || fail "it_pr_close idempotent re-call failed (I3)"

# ============================================================================
# Section 2: in_memory workspace 시나리오 단정
# ============================================================================
echo "--- Section 2: in_memory workspace scenario ---"

[ "${LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER:-}" = "in_memory" ] \
  || fail "expected active workspace = in_memory (got '${LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER:-}')"

ws_ensure_clone "${TARGET_NAME}" >/dev/null \
  || fail "ws_ensure_clone failed"

unit_id="task-${issue_num}"
wt_path="$(ws_ensure "${unit_id}" 2>/dev/null)"
[ -n "${wt_path}" ] && [ -d "${wt_path}" ] \
  || fail "ws_ensure did not return a valid workspace path (got='${wt_path}')"

# 멱등 (I1): 두 번째 호출은 같은 path
wt_path2="$(ws_ensure "${unit_id}" 2>/dev/null)"
[ "${wt_path}" = "${wt_path2}" ] \
  || fail "ws_ensure not idempotent (path1='${wt_path}' path2='${wt_path2}')"

# patch 적용 (in_memory JSON 형식)
ws_apply_patch "${unit_id}" '[{"path":"src/a.txt","content":"hello\n"}]' \
  || fail "ws_apply_patch failed"
[ -f "${wt_path}/src/a.txt" ] \
  || fail "ws_apply_patch did not create file"
[ "$(cat "${wt_path}/src/a.txt")" = "$(printf 'hello\n')" ] \
  || fail "ws_apply_patch content mismatch"

# 잘못된 형식의 patch — 워크스페이스 미변경 (I2)
prev_sha="$(shasum "${wt_path}/src/a.txt" | awk '{print $1}')"
if ws_apply_patch "${unit_id}" 'not-json' 2>/dev/null; then
  fail "ws_apply_patch should reject non-JSON payload"
fi
new_sha="$(shasum "${wt_path}/src/a.txt" | awk '{print $1}')"
[ "${prev_sha}" = "${new_sha}" ] \
  || fail "ws_apply_patch failure must not mutate workspace (I2)"

# branch publish + branch sha 조회
branch_name="feat/task-${issue_num}"
ws_publish_branch "${unit_id}" "${branch_name}" \
  || fail "ws_publish_branch failed"

head_sha="$(ws_get_branch_head "${REPO}" "${branch_name}" 2>/dev/null)"
[ -n "${head_sha}" ] || fail "ws_get_branch_head returned empty"

base_sha="$(ws_get_branch_base "${REPO}" "${branch_name}" 2>/dev/null)"
[ -n "${base_sha}" ] || fail "ws_get_branch_base returned empty"

# ws_list 결과에 unit_id 가 보여야 한다
ws_list_out="$(ws_list "${TARGET_NAME}" 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
case ",${ws_list_out}," in
  *",${unit_id},"*) ;;
  *) fail "ws_list should contain unit_id '${unit_id}' (got='${ws_list_out}')" ;;
esac

# destroy 멱등 (I3)
ws_destroy "${unit_id}" \
  || fail "ws_destroy failed"
ws_destroy "${unit_id}" \
  || fail "ws_destroy idempotent re-call failed"
[ ! -d "${wt_path}" ] \
  || fail "ws_destroy did not remove workspace dir"

# ============================================================================
# Section 3: github adapter syntactic verify (선언/검증만)
# ============================================================================
echo "--- Section 3: github adapter syntactic verify ---"

skip_github=0
skip_reason=""
if [ "${LLM_TEAM_PORT_CONFORMANCE_SKIP_GITHUB:-0}" = "1" ]; then
  skip_github=1
  skip_reason="LLM_TEAM_PORT_CONFORMANCE_SKIP_GITHUB=1"
elif ! command -v gh >/dev/null 2>&1; then
  skip_github=1
  skip_reason="gh CLI not installed"
elif ! gh auth status >/dev/null 2>&1; then
  skip_github=1
  skip_reason="gh auth status not OK"
fi

if [ "${skip_github}" = "1" ]; then
  echo "SKIP github branch (${skip_reason})"
else
  # github adapter 를 같은 프로세스에서 다시 source — 동일 함수명 재정의 가능.
  registry_load_adapter issue_tracker github \
    || fail "registry_load_adapter issue_tracker github failed"
  [ "${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-}" = "github" ] \
    || fail "active issue_tracker not 'github' after rebind"
  registry_verify_port issue_tracker \
    || fail "registry_verify_port issue_tracker failed for github"
  for fn in \
      it_milestone_create it_milestone_set_state it_milestone_get_state \
      it_milestone_close it_milestone_get_progress it_milestone_list_open \
      it_milestone_list_in_state \
      it_issue_create it_issue_set_state it_issue_get_state \
      it_issue_link_to_milestone it_issue_close_with_note \
      it_issue_set_blocked_by it_issue_get_blocked_by \
      it_issue_list_with_label it_issue_get_milestone \
      it_issue_add_label it_issue_remove_label \
      it_pr_create it_pr_set_cp_state it_pr_get_cp_state \
      it_pr_close it_pr_get_head_sha it_pr_get_base_branch it_pr_get_base_sha \
      it_release_create \
      it_comment_post it_comment_collect_signals it_comment_has_marker \
      it_revision_pin_get; do
    declare -F "${fn}" >/dev/null \
      || fail "github adapter missing function declaration: ${fn}"
  done

  # in_memory 로 다시 바인딩 — adapter 두 번 source 가 깨지지 않는다 (4단계).
  registry_load_adapter issue_tracker in_memory \
    || fail "re-bind to in_memory after github failed"
  [ "${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-}" = "in_memory" ] \
    || fail "after re-bind, active adapter not 'in_memory'"
  registry_verify_port issue_tracker \
    || fail "registry_verify_port issue_tracker failed after re-bind"

  # in_memory 의 기존 상태가 보존되어야 한다 (같은 LLM_TEAM_INMEM_IT_DIR).
  got_state2="$(it_milestone_get_state "${REPO}" "${ms_num}" 2>/dev/null)"
  [ "${got_state2}" = "PO_DRAFT" ] \
    || fail "after re-bind to in_memory, milestone state lost (got='${got_state2}')"
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} port conformance check(s) failed" >&2
  exit 1
fi

echo "PASS: port conformance (in_memory issue_tracker + workspace scenarios; github syntactic verify)"
