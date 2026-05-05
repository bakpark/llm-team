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

echo "PASS: filesystem cb_open"
