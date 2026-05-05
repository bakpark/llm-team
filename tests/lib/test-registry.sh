#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
. "${LLM_TEAM_ROOT}/lib/common.sh"

# in_memory 어댑터로 6 port 모두 로드되는지 검증.
export LLM_TEAM_ADAPTER_ISSUE_TRACKER=in_memory
export LLM_TEAM_ADAPTER_NOTIFIER=none
export LLM_TEAM_ADAPTER_LLM_RUNNER=fake
export LLM_TEAM_ADAPTER_WORKSPACE=in_memory
export LLM_TEAM_ADAPTER_PERSISTENT_STORE=in_memory
export LLM_TEAM_ADAPTER_CYCLE_BUNDLE=in_memory

if ! registry_load_default; then
  echo "FAIL: registry_load_default rc != 0"; exit 1
fi
for fn in cb_open cb_capture_blob_text cb_capture_blob_file cb_capture_blob_stdin \
          cb_capture_attempt cb_promote_to_full cb_finalize cb_get_path \
          cb_collect_abandoned; do
  if ! declare -F "${fn}" >/dev/null 2>&1; then
    echo "FAIL: ${fn} not loaded"; exit 1
  fi
done
echo "PASS: registry loads cycle_bundle as 6th port"
