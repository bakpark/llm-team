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

echo "PASS: cb_open + cb_get_path"
