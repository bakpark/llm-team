#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"
. "${LLM_TEAM_ROOT}/lib/ports/cycle_bundle.sh"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/filesystem.sh"

ROOT_OVERRIDE="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-fs-XXXXXX")"
export LLM_TEAM_ROOT_FS_OVERRIDE="${ROOT_OVERRIDE}"   # 어댑터가 우선 검사
export TARGET_NAME="tgt"
trap 'rm -rf "${ROOT_OVERRIDE}"' EXIT

h="$(cb_open "Coder-task-1-cafeface0001" "tgt" "Coder" "m:1" "lt:1")"
[ -n "${h}" ] || { echo "FAIL: cb_open"; exit 1; }
[ -d "${h}" ] || { echo "FAIL: bundle dir not created"; exit 1; }
[ -d "${h}/diff" ] && [ -d "${h}/attempts" ] || { echo "FAIL: subdirs"; exit 1; }
[ -f "${h}/pidfile.json" ] || { echo "FAIL: pidfile"; exit 1; }

# Permissions (mode 0700 dir).
mode_dir="$(stat -f '%Lp' "${h}" 2>/dev/null || stat -c '%a' "${h}" 2>/dev/null)"
[ "${mode_dir}" = "700" ] || { echo "FAIL: dir mode '${mode_dir}' != 700"; exit 1; }

# 빈 handle case. (DISABLED 변수 leak 방지를 위해 reset)
LLM_TEAM_CYCLE_BUNDLE_DISABLED=1
h2="$(cb_open "Coder-task-2-aaaaaaaaaaaa" "tgt" "Coder" "m:2" "")"
LLM_TEAM_CYCLE_BUNDLE_DISABLED=0
[ -z "${h2}" ] || { echo "FAIL: disabled should yield empty"; exit 1; }

h="$(cb_open "Coder-task-9-aaaa11112222" "tgt" "Coder" "m:9" "")"
cb_capture_blob_text "${h}" "summary-note.txt" "ok"
[ "$(cat "${h}/summary-note.txt")" = "ok" ] || { echo "FAIL: blob_text"; exit 1; }
mode_file="$(stat -f '%Lp' "${h}/summary-note.txt" 2>/dev/null || stat -c '%a' "${h}/summary-note.txt" 2>/dev/null)"
[ "${mode_file}" = "600" ] || { echo "FAIL: file mode '${mode_file}' != 600"; exit 1; }

env_ref="$(mktemp)"; echo '{"k":"v"}' > "${env_ref}"
diag_ref="$(mktemp)"; echo 'diag-line' > "${diag_ref}"
cb_capture_attempt "${h}" 1 "${env_ref}" "${diag_ref}" '{"exit_status":"ok"}'
[ -f "${h}/attempts/1/envelope.json" ] || { echo "FAIL: attempts envelope"; exit 1; }
mode_attempt="$(stat -f '%Lp' "${h}/attempts/1/envelope.json" 2>/dev/null || stat -c '%a' "${h}/attempts/1/envelope.json" 2>/dev/null)"
[ "${mode_attempt}" = "600" ] || { echo "FAIL: attempt file mode '${mode_attempt}' != 600"; exit 1; }
rm -f "${env_ref}" "${diag_ref}"

# Promote + finalize (slim ok cycle: diagnostics 삭제).
h="$(cb_open "Fin-task-1-aaaaaaaaaaaa" "tgt" "Coder" "m:fin1" "")"
echo 'foo' > "${h}/diagnostics.txt"
chmod 0600 "${h}/diagnostics.txt" 2>/dev/null || true
cb_finalize "${h}" "ok" '{}'
[ ! -f "${h}/diagnostics.txt" ] || { echo "FAIL: ok+no-promote should drop diagnostics.txt"; exit 1; }
[ -f "${h}/summary.json" ] || { echo "FAIL: summary.json"; exit 1; }
[ "$(jq -r .result "${h}/summary.json")" = "ok" ] || { echo "FAIL: summary.result"; exit 1; }
[ ! -f "${h}/pidfile.json" ] || { echo "FAIL: pidfile not removed"; exit 1; }

# Promote 가 한 번이라도 호출되면 ok 여도 보존 (I6).
h="$(cb_open "Fin-task-2-bbbbbbbbbbbb" "tgt" "Coder" "m:fin2" "")"
echo 'kept' > "${h}/diagnostics.txt"
chmod 0600 "${h}/diagnostics.txt" 2>/dev/null || true
cb_promote_to_full "${h}" "lr:transport_error:5xx"
cb_finalize "${h}" "ok" '{}'
[ -f "${h}/diagnostics.txt" ] || { echo "FAIL: I6 promote-then-ok should preserve diagnostics"; exit 1; }
[ "$(jq '.failure_reasons | length' "${h}/summary.json")" = "1" ] || { echo "FAIL: failure_reasons"; exit 1; }

# Promote 두 번 (additive, I5).
h="$(cb_open "Fin-task-3-cccccccccccc" "tgt" "Coder" "m:fin3" "")"
cb_promote_to_full "${h}" "lr:transport_error:5xx"
cb_promote_to_full "${h}" "envelope_invalid"
cb_finalize "${h}" "invalid" '{}'
[ "$(jq '.failure_reasons | length' "${h}/summary.json")" = "2" ] || { echo "FAIL: I5 additive"; exit 1; }
[ "$(jq -r '.failure_reasons[1]' "${h}/summary.json")" = "envelope_invalid" ] || { echo "FAIL: I5 order"; exit 1; }

# Finalize-once (I7).
h="$(cb_open "Fin-task-4-dddddddddddd" "tgt" "Coder" "m:fin4" "")"
cb_finalize "${h}" "ok" '{}'
cb_finalize "${h}" "error" '{}' 2>/dev/null
[ "$(jq -r .result "${h}/summary.json")" = "ok" ] || { echo "FAIL: I7 second finalize must be no-op"; exit 1; }

# Abandoned (dead pid → stamp).
h="$(cb_open "Aban-task-1-eeeeeeeeeeee" "tgt" "Coder" "m:aban1" "")"
jq -n --arg pid "99999999" --arg manifest_id "m:aban1" \
   '{pid:$pid, hostname:"x", started_at:"2020-01-01T00:00:00Z", manifest_id:$manifest_id, lease_token:null}' \
   > "${h}/pidfile.json"
chmod 0600 "${h}/pidfile.json" 2>/dev/null || true
cb_collect_abandoned "tgt"
[ -f "${h}/summary.json" ] || { echo "FAIL: abandoned should write summary"; exit 1; }
[ "$(jq -r .result "${h}/summary.json")" = "abandoned" ] || { echo "FAIL: result=abandoned"; exit 1; }

# Abandoned: alive pid 보호.
h="$(cb_open "Aban-task-2-ffffffffffff" "tgt" "Coder" "m:aban2" "")"
jq -n --arg pid "$$" --arg manifest_id "m:aban2" \
   '{pid:$pid, hostname:"x", started_at:"2020-01-01T00:00:00Z", manifest_id:$manifest_id, lease_token:null}' \
   > "${h}/pidfile.json"
chmod 0600 "${h}/pidfile.json" 2>/dev/null || true
cb_collect_abandoned "tgt"
[ ! -f "${h}/summary.json" ] || { echo "FAIL: alive pid must NOT be stamped abandoned"; exit 1; }

echo "PASS: filesystem cb_open"
