#!/usr/bin/env bash
# tests/application/test-human-signal.sh
#
# Phase 6 — application/human_signal.sh 단위 테스트.
#
# 검증 (RGC-SIGNALS / RGC-HUMAN-GATES):
#   1. envelope schema 검증 (lib/signals.sh 통과 여부) + actor 일치.
#   2. 8 종 signal_type 모두 적용:
#      approve / reject / request_rework / request_recover /
#      pause / resume / amendment_approve / stop.
#   3. signal_id 멱등 (동일 signal_id 두 번 → 1번만 적용).
#   4. actor mismatch → 거부.
#   5. invalid envelope (필수 필드 누락) → 거부.
#   6. revision pin mismatch (approve) → stale + 적용 skip.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# 격리: in_memory adapter + persistent_store 모두 mktemp.
INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-hs-it-XXXXXX")"
INMEM_PS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-hs-ps-XXXXXX")"
HS_WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-hs-work-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${INMEM_IT_DIR}"
export LLM_TEAM_INMEM_PS_DIR="${INMEM_PS_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER="in_memory"
export LLM_TEAM_ADAPTER_PERSISTENT_STORE="in_memory"
export TARGET_NAME="hs-test"
export TARGET_LABEL_PREFIX=""

# control_state_path 가 LLM_TEAM_ROOT/workdir/control-state 를 사용하므로
# 격리를 위해 LLM_TEAM_ROOT 를 임시 path 로 한 차례 override 하지 않고,
# 대신 control state 파일을 직접 정리한다.

cleanup() {
  rm -rf "${INMEM_IT_DIR}" "${INMEM_PS_DIR}" "${HS_WORKDIR}" 2>/dev/null || true
  # control-state 가 RUNNING 으로 남도록 초기화.
  rm -f "${LLM_TEAM_ROOT}/workdir/control-state" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/human_signal.sh
. "${LLM_TEAM_ROOT}/application/human_signal.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

REPO="hs-test/repo"

# ----------------------------------------------------------------------------
# Helpers: post a signal envelope as a comment from a specific actor.
# ----------------------------------------------------------------------------
post_signal() {
  # post_signal <kind> <num> <actor> <signal_id> <signal_type> <target_kind> <target_id> [<target_revision_pin>]
  local kind="$1" num="$2" actor="$3" sid="$4" stype="$5" tk="$6" tid="$7"
  local pin="${8:-}"
  local body
  if [ -n "${pin}" ]; then
    body="$(jq -nc \
      --arg sid "${sid}" --arg t "${stype}" \
      --arg tk "${tk}"   --arg tid "${tid}" \
      --arg a "${actor}" --arg c "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg pin "${pin}" \
      '{signal_id:$sid, signal_type:$t, target_kind:$tk, target_id:$tid, actor:$a, created_at:$c, target_revision_pin:$pin}')"
  else
    body="$(jq -nc \
      --arg sid "${sid}" --arg t "${stype}" \
      --arg tk "${tk}"   --arg tid "${tid}" \
      --arg a "${actor}" --arg c "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{signal_id:$sid, signal_type:$t, target_kind:$tk, target_id:$tid, actor:$a, created_at:$c}')"
  fi
  local marker
  marker="$(printf '<!-- llm-team:human-signal %s -->' "${body}")"
  LLM_TEAM_INMEM_IT_ACTOR="${actor}" \
    it_comment_post "${REPO}" "${kind}" "${num}" "${marker}" >/dev/null \
    || fail "post_signal: it_comment_post failed (kind=${kind} num=${num} sid=${sid})"
}

# ----------------------------------------------------------------------------
# (1) approve on milestone PO_GATE → PM_DRAFT.
# ----------------------------------------------------------------------------
ms_approve="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_milestone_create "${REPO}" "approve target" "" 2>/dev/null)" \
  || fail "create approve milestone failed"
it_milestone_set_state "${REPO}" "${ms_approve}" PO_GATE \
  || fail "set PO_GATE on approve target failed"

post_signal milestone "${ms_approve}" alice sig-approve-1 approve milestone "${ms_approve}"

# ----------------------------------------------------------------------------
# (2) reject on milestone PO_GATE → PO_DRAFT.
# ----------------------------------------------------------------------------
ms_reject="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_milestone_create "${REPO}" "reject target" "" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms_reject}" PO_GATE \
  || fail "set PO_GATE on reject target failed"
post_signal milestone "${ms_reject}" alice sig-reject-1 reject milestone "${ms_reject}"

# ----------------------------------------------------------------------------
# (3) request_recover on milestone PM_GATE → PO_DRAFT.
# ----------------------------------------------------------------------------
ms_recover="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_milestone_create "${REPO}" "recover target" "" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms_recover}" PM_GATE \
  || fail "set PM_GATE on recover target failed"
post_signal milestone "${ms_recover}" alice sig-recover-1 request_recover milestone "${ms_recover}"

# ----------------------------------------------------------------------------
# (4) stop on milestone IMPLEMENTING → ESCALATED.
# ----------------------------------------------------------------------------
ms_stop="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_milestone_create "${REPO}" "stop target" "" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms_stop}" IMPLEMENTING \
  || fail "set IMPLEMENTING on stop target failed"
post_signal milestone "${ms_stop}" alice sig-stop-1 stop milestone "${ms_stop}"

# ----------------------------------------------------------------------------
# (5) request_rework on issue ESCALATED → TASK_READY.
# Per RGC-SIGNAL-MATRIX, request_rework allowed-state for tasks is ESCALATED.
# ----------------------------------------------------------------------------
issue_rework="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_issue_create "${REPO}" --title "rework target" --body "" 2>/dev/null)"
it_issue_set_state "${REPO}" "${issue_rework}" ESCALATED \
  || fail "set ESCALATED on rework target failed"
post_signal issue "${issue_rework}" alice sig-rework-1 request_rework issue "${issue_rework}"

# ----------------------------------------------------------------------------
# (6) pause / resume — control state toggle. Posted on any open object.
#     Use the recover milestone as the carrier (signal does not change it).
# ----------------------------------------------------------------------------
post_signal milestone "${ms_recover}" alice sig-pause-1  pause  control system
post_signal milestone "${ms_recover}" alice sig-resume-1 resume control system

# ----------------------------------------------------------------------------
# (7) amendment_approve — ledger only.
# ----------------------------------------------------------------------------
post_signal milestone "${ms_recover}" alice sig-amend-1 amendment_approve milestone "${ms_recover}"

# ----------------------------------------------------------------------------
# (8) actor mismatch — wrapper.actor (poster) != envelope.actor (claimed).
#     in_memory: milestone signals derive wrapper.actor from milestone.creator,
#     so a real mismatch can only be exercised on issue/PR comments where the
#     comment actor is preserved. We use an issue here.
# ----------------------------------------------------------------------------
issue_mismatch="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_issue_create "${REPO}" --title "mismatch target" --body "" 2>/dev/null)"
it_issue_set_state "${REPO}" "${issue_mismatch}" TASK_REVIEW_READY \
  || fail "set TASK_REVIEW_READY on mismatch target failed"
mismatch_body="$(jq -nc \
  --arg sid "sig-mismatch-1" --arg t "request_rework" \
  --arg tk "issue" --arg tid "${issue_mismatch}" \
  --arg a "alice" --arg c "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{signal_id:$sid, signal_type:$t, target_kind:$tk, target_id:$tid, actor:$a, created_at:$c}')"
mismatch_marker="<!-- llm-team:human-signal ${mismatch_body} -->"
LLM_TEAM_INMEM_IT_ACTOR=mallory \
  it_comment_post "${REPO}" issue "${issue_mismatch}" "${mismatch_marker}" >/dev/null \
  || fail "post mismatch signal failed"

# ----------------------------------------------------------------------------
# (9) invalid envelope — missing signal_type. Wrapper still has actor=alice.
# ----------------------------------------------------------------------------
ms_invalid="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_milestone_create "${REPO}" "invalid target" "" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms_invalid}" PO_GATE \
  || fail "set PO_GATE on invalid target failed"
invalid_body='{"signal_id":"sig-invalid-1","actor":"alice","target_kind":"milestone","target_id":"'"${ms_invalid}"'","created_at":"2026-05-01T00:00:00Z"}'
invalid_marker="<!-- llm-team:human-signal ${invalid_body} -->"
LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_comment_post "${REPO}" milestone "${ms_invalid}" "${invalid_marker}" >/dev/null \
  || fail "post invalid signal failed"

# ----------------------------------------------------------------------------
# (10) Duplicate signal_id — post sig-approve-1 a second time on a different
#      milestone. Drain should skip with status='duplicate'.
# ----------------------------------------------------------------------------
ms_dup="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_milestone_create "${REPO}" "dup target" "" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms_dup}" PO_GATE \
  || fail "set PO_GATE on dup target failed"
post_signal milestone "${ms_dup}" alice sig-approve-1 approve milestone "${ms_dup}"

# ============================================================================
# Run drain.
# ============================================================================
applied="$(human_signal_drain "${REPO}")" \
  || fail "human_signal_drain returned non-zero rc"

# Expected applied count:
#   approve(1) + reject(1) + recover(1) + stop(1) + rework(1) + pause(1) +
#   resume(1) + amendment_approve(1) = 8.
[ "${applied}" = "8" ] \
  || fail "expected 8 applied signals, got '${applied}'"

# ----------------------------------------------------------------------------
# Verify per-signal effects.
# ----------------------------------------------------------------------------
got="$(it_milestone_get_state "${REPO}" "${ms_approve}")"
[ "${got}" = "PM_DRAFT" ] \
  || fail "approve: expected PM_DRAFT on ms #${ms_approve}, got '${got}'"

got="$(it_milestone_get_state "${REPO}" "${ms_reject}")"
[ "${got}" = "PO_DRAFT" ] \
  || fail "reject: expected PO_DRAFT on ms #${ms_reject}, got '${got}'"

got="$(it_milestone_get_state "${REPO}" "${ms_recover}")"
[ "${got}" = "PO_DRAFT" ] \
  || fail "request_recover: expected PO_DRAFT on ms #${ms_recover}, got '${got}'"

got="$(it_milestone_get_state "${REPO}" "${ms_stop}")"
[ "${got}" = "ESCALATED" ] \
  || fail "stop: expected ESCALATED on ms #${ms_stop}, got '${got}'"

got="$(it_issue_get_state "${REPO}" "${issue_rework}")"
[ "${got}" = "TASK_READY" ] \
  || fail "request_rework: expected TASK_READY on issue #${issue_rework}, got '${got}'"

# pause + resume net result: control state RUNNING (resume came last).
got="$(control_state_get)"
[ "${got}" = "RUNNING" ] \
  || fail "after pause+resume: expected RUNNING, got '${got}'"

# Mismatch issue + invalid milestone unaffected.
got="$(it_issue_get_state "${REPO}" "${issue_mismatch}")"
[ "${got}" = "TASK_REVIEW_READY" ] \
  || fail "actor mismatch should not transition issue #${issue_mismatch} (got '${got}')"
got="$(it_milestone_get_state "${REPO}" "${ms_invalid}")"
[ "${got}" = "PO_GATE" ] \
  || fail "invalid envelope should not transition ms #${ms_invalid} (got '${got}')"

# Duplicate target untouched (sig-approve-1 was already applied to ms_approve).
got="$(it_milestone_get_state "${REPO}" "${ms_dup}")"
[ "${got}" = "PO_GATE" ] \
  || fail "duplicate signal_id should not transition ms #${ms_dup} (got '${got}')"

# ----------------------------------------------------------------------------
# Idempotency ledger (ps_*) checks.
# ----------------------------------------------------------------------------
ns="signals/${TARGET_NAME}"
for sid in sig-approve-1 sig-reject-1 sig-recover-1 sig-stop-1 sig-rework-1 \
           sig-pause-1 sig-resume-1 sig-amend-1 sig-mismatch-1 sig-invalid-1; do
  if ! ps_exists "${ns}" "${sid}"; then
    fail "ps_exists missing record for signal_id '${sid}'"
    continue
  fi
done

# Mismatch + invalid statuses should be 'rejected'.
status_mismatch="$(ps_get "${ns}" sig-mismatch-1 | jq -r '.status')"
[ "${status_mismatch}" = "rejected" ] \
  || fail "sig-mismatch-1 status expected 'rejected', got '${status_mismatch}'"

status_invalid="$(ps_get "${ns}" sig-invalid-1 | jq -r '.status')"
[ "${status_invalid}" = "rejected" ] \
  || fail "sig-invalid-1 status expected 'rejected', got '${status_invalid}'"

# applied signals should have status='applied'.
for sid in sig-approve-1 sig-reject-1 sig-recover-1 sig-stop-1 sig-rework-1 \
           sig-pause-1 sig-resume-1 sig-amend-1; do
  st="$(ps_get "${ns}" "${sid}" | jq -r '.status')"
  [ "${st}" = "applied" ] \
    || fail "${sid} status expected 'applied', got '${st}'"
done

# ----------------------------------------------------------------------------
# Second drain — every signal now resolved or in ledger; second pass produces
# zero new applies, every wrapper logs as duplicate.
# ----------------------------------------------------------------------------
applied2="$(human_signal_drain "${REPO}")"
[ "${applied2}" = "0" ] \
  || fail "second drain expected 0 applied, got '${applied2}'"

# ----------------------------------------------------------------------------
# revision-pin mismatch (approve) → 'stale'. Use a fresh signal_id.
# ----------------------------------------------------------------------------
ms_pin="$(LLM_TEAM_INMEM_IT_ACTOR=alice \
  it_milestone_create "${REPO}" "pin target" "" 2>/dev/null)"
it_milestone_set_state "${REPO}" "${ms_pin}" PO_GATE \
  || fail "set PO_GATE on pin target failed"
# Inject an obviously stale pin via extra jq arg.
post_signal milestone "${ms_pin}" alice sig-stale-1 approve milestone "${ms_pin}" \
  "definitely-not-current"
applied3="$(human_signal_drain "${REPO}")"
[ "${applied3}" = "0" ] \
  || fail "stale-pin drain expected 0 applied, got '${applied3}'"
got="$(it_milestone_get_state "${REPO}" "${ms_pin}")"
[ "${got}" = "PO_GATE" ] \
  || fail "stale-pin signal must not transition ms #${ms_pin} (got '${got}')"
status_stale="$(ps_get "${ns}" sig-stale-1 | jq -r '.status')"
[ "${status_stale}" = "stale" ] \
  || fail "sig-stale-1 status expected 'stale', got '${status_stale}'"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} human_signal check(s) failed" >&2
  exit 1
fi

echo "PASS: human_signal_drain (8 signal types + idempotency + actor mismatch + invalid + stale-pin)"
