#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"
. "${LLM_TEAM_ROOT}/lib/ports/cycle_bundle.sh"
. "${LLM_TEAM_ROOT}/adapters/cycle_bundle/in_memory.sh"

INMEM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-cb-inmem-XXXXXX")"
export LLM_TEAM_INMEM_CB_DIR="${INMEM_DIR}"
trap 'rm -rf "${INMEM_DIR}"' EXIT

# Case 1: 정상 open 은 비어있지 않은 handle 반환.
h="$(cb_open "Coder-task-1-abcdef123456" "tgt" "Coder" "manifest:1" "lease:1")"
[ -n "${h}" ] || { echo "FAIL: cb_open returned empty handle"; exit 1; }

# Case 2: 같은 cycle_id reopen 시 같은 handle 반환 (I1).
h2="$(cb_open "Coder-task-1-abcdef123456" "tgt" "Coder" "manifest:1" "lease:1")"
[ "${h}" = "${h2}" ] || { echo "FAIL: I1 violated: ${h} vs ${h2}"; exit 1; }

# Case 3: DISABLED=1 일 때 빈 handle (I2).
LLM_TEAM_CYCLE_BUNDLE_DISABLED=1 \
  h3="$(cb_open "Coder-task-2-deadbeef0000" "tgt" "Coder" "manifest:2" "lease:2")"
[ -z "${h3}" ] || { echo "FAIL: I2 violated, expected empty got '${h3}'"; exit 1; }

# Case 4: 빈 handle 에 대한 cb_get_path 는 빈 stdout + rc 0.
out="$(cb_get_path "")"
[ -z "${out}" ] || { echo "FAIL: cb_get_path empty handle should be empty"; exit 1; }

# Capture cases.
LLM_TEAM_CYCLE_BUNDLE_DISABLED=0
h="$(cb_open "Cap-task-1-cafebabe1234" "tgt" "Coder" "m:cap" "")"

# blob_text
cb_capture_blob_text "${h}" "summary.txt" "hello"
[ "$(cat "${h}/summary.txt")" = "hello" ] || { echo "FAIL: blob_text"; exit 1; }

# blob_file (cp -p 보존: mtime/perm)
src="$(mktemp)"; printf 'src-content' > "${src}"
cb_capture_blob_file "${h}" "from-file.txt" "${src}"
[ "$(cat "${h}/from-file.txt")" = "src-content" ] || { echo "FAIL: blob_file"; exit 1; }
rm -f "${src}"

# blob_stdin
echo "stream-content" | cb_capture_blob_stdin "${h}" "diff/pre.dirty.diff"
[ "$(cat "${h}/diff/pre.dirty.diff")" = "stream-content" ] || { echo "FAIL: blob_stdin"; exit 1; }

# Idempotent re-capture (I3) — 덮어쓰기 가능.
cb_capture_blob_text "${h}" "summary.txt" "world"
[ "$(cat "${h}/summary.txt")" = "world" ] || { echo "FAIL: I3 re-capture"; exit 1; }

# 빈 handle 에 대한 capture 는 no-op rc 0.
cb_capture_blob_text "" "x" "y" || { echo "FAIL: empty handle should be no-op"; exit 1; }

# Attempt capture.
h="$(cb_open "Att-task-1-1234567890ab" "tgt" "Coder" "m:att" "")"
env_ref="$(mktemp)"; echo '{"output_kind":"patch"}' > "${env_ref}"
diag_ref="$(mktemp)"; echo 'WARN something' > "${diag_ref}"
meta_json='{"exit_status":"ok","attempts":1,"wall_ms":12}'
cb_capture_attempt "${h}" 1 "${env_ref}" "${diag_ref}" "${meta_json}"
[ -d "${h}/attempts/1" ] || { echo "FAIL: attempts/1 dir"; exit 1; }
[ -f "${h}/attempts/1/envelope.json" ] || { echo "FAIL: env"; exit 1; }
[ -f "${h}/attempts/1/diagnostics.txt" ] || { echo "FAIL: diag"; exit 1; }
[ -f "${h}/attempts/1/lr_meta.json" ] || { echo "FAIL: meta"; exit 1; }
[ "$(jq -r '.exit_status' "${h}/attempts/1/lr_meta.json")" = "ok" ] || { echo "FAIL: meta content"; exit 1; }
rm -f "${env_ref}" "${diag_ref}"

# Promote + finalize (slim ok cycle: diagnostics 삭제).
h="$(cb_open "Fin-task-1-aaaaaaaaaaaa" "tgt" "Coder" "m:fin1" "")"
echo 'foo' > "${h}/diagnostics.txt"
cb_finalize "${h}" "ok" '{}'
[ ! -f "${h}/diagnostics.txt" ] || { echo "FAIL: ok+no-promote should drop diagnostics.txt"; exit 1; }
[ -f "${h}/summary.json" ] || { echo "FAIL: summary.json"; exit 1; }
[ "$(jq -r .result "${h}/summary.json")" = "ok" ] || { echo "FAIL: summary.result"; exit 1; }
[ ! -f "${h}/pidfile.json" ] || { echo "FAIL: pidfile not removed"; exit 1; }

# Promote 가 한 번이라도 호출되면 ok 여도 보존 (I6).
h="$(cb_open "Fin-task-2-bbbbbbbbbbbb" "tgt" "Coder" "m:fin2" "")"
echo 'kept' > "${h}/diagnostics.txt"
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
cb_finalize "${h}" "error" '{}' 2>/dev/null  # 두 번째는 no-op
[ "$(jq -r .result "${h}/summary.json")" = "ok" ] || { echo "FAIL: I7 second finalize must be no-op"; exit 1; }

echo "PASS: cb_open + cb_get_path"
