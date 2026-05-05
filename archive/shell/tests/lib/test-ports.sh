#!/usr/bin/env bash
# tests/lib/test-ports.sh
#
# 검증:
#   1. lib/ports/*.sh 의 PORT_*_REQUIRED_FUNCTIONS 가 정상적으로 로드된다.
#   2. 마이그레이션 완료된 port 들 (issue_tracker, notifier, llm_runner,
#      workspace) 의 모든 required function 이 declare -F 로 발견된다.
#   3. 활성 adapter 추적 변수가 기본값으로 설정된다.
#   4. registry_load_adapter 가 누락 adapter 에 대해 비0 반환.
#   5. 핵심 매핑 헬퍼(task_state_to_label / label_to_task_state) 동작 확인.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# (1) Port 명세 배열 비어있지 않음
# ----------------------------------------------------------------------------
[ "${#PORT_ISSUE_TRACKER_REQUIRED_FUNCTIONS[@]}" -gt 0 ] \
  || fail "PORT_ISSUE_TRACKER_REQUIRED_FUNCTIONS is empty"
[ "${#PORT_NOTIFIER_REQUIRED_FUNCTIONS[@]}" -gt 0 ] \
  || fail "PORT_NOTIFIER_REQUIRED_FUNCTIONS is empty"
[ "${#PORT_LLM_RUNNER_REQUIRED_FUNCTIONS[@]}" -gt 0 ] \
  || fail "PORT_LLM_RUNNER_REQUIRED_FUNCTIONS is empty"
[ "${#PORT_WORKSPACE_REQUIRED_FUNCTIONS[@]}" -gt 0 ] \
  || fail "PORT_WORKSPACE_REQUIRED_FUNCTIONS is empty"
[ "${#PORT_PERSISTENT_STORE_REQUIRED_FUNCTIONS[@]}" -gt 0 ] \
  || fail "PORT_PERSISTENT_STORE_REQUIRED_FUNCTIONS is empty"

# ----------------------------------------------------------------------------
# (2) 마이그레이션 완료된 port 의 verification 통과
# ----------------------------------------------------------------------------
registry_verify_port issue_tracker     || fail "issue_tracker port verification failed"
registry_verify_port notifier          || fail "notifier port verification failed"
registry_verify_port llm_runner        || fail "llm_runner port verification failed"
registry_verify_port workspace         || fail "workspace port verification failed"
registry_verify_port persistent_store  || fail "persistent_store port verification failed"

# ----------------------------------------------------------------------------
# (3) 활성 adapter 추적 변수
# ----------------------------------------------------------------------------
expected_it_adapter="${LLM_TEAM_ADAPTER_ISSUE_TRACKER:-github}"
[ "${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-}" = "${expected_it_adapter}" ] \
  || fail "active issue_tracker adapter is not '${expected_it_adapter}' (got: '${LLM_TEAM_ACTIVE_ISSUE_TRACKER_ADAPTER:-}')"
[ "${LLM_TEAM_ACTIVE_NOTIFIER_ADAPTER:-}" = "none" ] \
  || fail "active notifier adapter is not 'none' (got: '${LLM_TEAM_ACTIVE_NOTIFIER_ADAPTER:-}')"
expected_lr_adapter="${LLM_TEAM_ADAPTER_LLM_RUNNER:-claude_code}"
[ "${LLM_TEAM_ACTIVE_LLM_RUNNER_ADAPTER:-}" = "${expected_lr_adapter}" ] \
  || fail "active llm_runner adapter is not '${expected_lr_adapter}' (got: '${LLM_TEAM_ACTIVE_LLM_RUNNER_ADAPTER:-}')"
expected_ws_adapter="${LLM_TEAM_ADAPTER_WORKSPACE:-git_worktree}"
[ "${LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER:-}" = "${expected_ws_adapter}" ] \
  || fail "active workspace adapter is not '${expected_ws_adapter}' (got: '${LLM_TEAM_ACTIVE_WORKSPACE_ADAPTER:-}')"
expected_ps_adapter="${LLM_TEAM_ADAPTER_PERSISTENT_STORE:-filesystem}"
[ "${LLM_TEAM_ACTIVE_PERSISTENT_STORE_ADAPTER:-}" = "${expected_ps_adapter}" ] \
  || fail "active persistent_store adapter is not '${expected_ps_adapter}' (got: '${LLM_TEAM_ACTIVE_PERSISTENT_STORE_ADAPTER:-}')"

# ----------------------------------------------------------------------------
# (4) Adapter swap: notifier 를 discord 로 다시 바인딩 가능
# ----------------------------------------------------------------------------
if registry_load_adapter notifier discord 2>/dev/null; then
  [ "${LLM_TEAM_ACTIVE_NOTIFIER_ADAPTER:-}" = "discord" ] \
    || fail "after rebinding notifier to discord, active adapter not updated"
  # Restore default.
  registry_load_adapter notifier none >/dev/null 2>&1
else
  fail "registry_load_adapter notifier discord should succeed"
fi

# ----------------------------------------------------------------------------
# (5) 누락 adapter / port 에 대한 fail-fast
# ----------------------------------------------------------------------------
if registry_load_adapter issue_tracker nonexistent_adapter 2>/dev/null; then
  fail "registry_load_adapter should fail for missing adapter file"
fi
if registry_verify_port nonexistent_port 2>/dev/null; then
  fail "registry_verify_port should fail for unknown port"
fi

# ----------------------------------------------------------------------------
# (6) state ↔ label 매핑
# ----------------------------------------------------------------------------
got="$(task_state_to_label TASK_READY)" \
  || fail "task_state_to_label TASK_READY returned non-zero"
[ "${got}" = "task:ready" ] || fail "task_state_to_label TASK_READY: got '${got}', expected 'task:ready'"
got="$(label_to_task_state task:integrated)" \
  || fail "label_to_task_state task:integrated returned non-zero"
[ "${got}" = "TASK_INTEGRATED" ] || fail "label_to_task_state task:integrated: got '${got}'"
if task_state_to_label NOT_A_STATE 2>/dev/null; then
  fail "task_state_to_label should fail for unknown state"
fi

# ----------------------------------------------------------------------------
# (7) port 함수가 글로벌 네임스페이스에 노출됨
# ----------------------------------------------------------------------------
for fn in \
    it_milestone_create it_issue_create it_pr_create it_release_create \
    it_comment_post it_comment_collect_signals it_revision_pin_get \
    it_milestone_set_state it_issue_set_state it_pr_set_cp_state \
    it_pr_close it_pr_get_head_sha it_pr_get_base_branch it_pr_get_base_sha \
    it_issue_add_label it_issue_remove_label \
    it_issue_get_blocked_by \
    nt_send \
    lr_invoke \
    ws_ensure_clone ws_ensure ws_apply_patch ws_publish_branch ws_destroy ws_list ws_path_of \
    ws_get_branch_head ws_get_branch_base \
    ps_put ps_get ps_delete ps_list_ids ps_exists ps_append_log ps_read_log \
    ps_lock_acquire ps_lock_release ps_namespace_init; do
  declare -F "${fn}" >/dev/null \
    || fail "port function not declared: ${fn}"
done

# ----------------------------------------------------------------------------
# (8) lr_invoke 는 빈 prompt 에서 비0 반환 (적합성 smoke, port I2/I3)
# ----------------------------------------------------------------------------
if printf '' | lr_invoke 2>/dev/null; then
  fail "lr_invoke should fail for empty prompt"
fi

# ----------------------------------------------------------------------------
# (9) nt_send (none) 은 항상 0 반환 (no-op)
# ----------------------------------------------------------------------------
nt_send test-kind https://example.com/x "summary" >/dev/null 2>&1 \
  || fail "nt_send (none adapter) should succeed as no-op"

# ----------------------------------------------------------------------------
# (10) persistent_store(filesystem) round-trip
# ----------------------------------------------------------------------------
ns="ports-test-$$"
ps_namespace_init "${ns}" || fail "ps_namespace_init failed"
ps_put "${ns}" obj-1 '{"hello":"world"}' || fail "ps_put failed"
got="$(ps_get "${ns}" obj-1 || echo MISSING)"
[ "$(printf '%s' "${got}" | jq -r '.hello')" = "world" ] || fail "ps_get round-trip failed (got=${got})"
ps_exists "${ns}" obj-1 || fail "ps_exists should return 0 after put"
ps_exists "${ns}" obj-missing 2>/dev/null && fail "ps_exists should fail for missing id"

ps_lock_acquire "${ns}" obj-2 || fail "ps_lock_acquire first call should succeed"
if ps_lock_acquire "${ns}" obj-2 2>/dev/null; then
  fail "ps_lock_acquire second call should be contended"
fi
ps_lock_release "${ns}" obj-2 || fail "ps_lock_release failed"
ps_lock_acquire "${ns}" obj-2 || fail "ps_lock_acquire after release should succeed"
ps_lock_release "${ns}" obj-2 >/dev/null

ps_append_log "${ns}/log" '{"event":"a"}' || fail "ps_append_log failed"
ps_append_log "${ns}/log" '{"event":"b"}' || fail "ps_append_log second failed"
log_lines="$(ps_read_log "${ns}/log" | wc -l | tr -d ' ')"
[ "${log_lines}" = "2" ] || fail "ps_read_log expected 2 lines, got ${log_lines}"

# rejection: invalid JSON
if ps_put "${ns}" obj-bad 'not-json' 2>/dev/null; then
  fail "ps_put should reject invalid JSON"
fi
if ps_append_log "${ns}/log" 'still-not-json' 2>/dev/null; then
  fail "ps_append_log should reject invalid JSON"
fi

# Cleanup test namespace (filesystem adapter writes under workdir; in_memory
# adapter writes under LLM_TEAM_INMEM_PS_DIR).
rm -rf "${LLM_TEAM_ROOT}/workdir/${ns}" "${LLM_TEAM_ROOT}/workdir/${ns}.jsonl" \
       "${LLM_TEAM_ROOT}/workdir/${ns}/log.jsonl" 2>/dev/null || true
if [ -n "${LLM_TEAM_INMEM_PS_DIR:-}" ]; then
  rm -rf "${LLM_TEAM_INMEM_PS_DIR}/${ns}" "${LLM_TEAM_INMEM_PS_DIR}/${ns}.jsonl" \
         "${LLM_TEAM_INMEM_PS_DIR}/${ns}/log.jsonl" 2>/dev/null || true
fi

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} port check(s) failed" >&2
  exit 1
fi

echo "PASS: ports skeleton + 5 adapters bound (issue_tracker, notifier, llm_runner, workspace, persistent_store)"
