#!/usr/bin/env bash
# tests/application/test-caller-dispatch-target-id.sh
#
# Verify _caller_target_id_strip_kind handles:
#   - bare numeric ids (legacy fixture form)
#   - "<kind>:<num>" form documented in prompts/*.md (real LLM output form)
#   - CP hierarchical ids ("cp:...:rN") preserved as-is

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

. "${LLM_TEAM_ROOT}/lib/log.sh"
. "${LLM_TEAM_ROOT}/application/caller_dispatch.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

assert_eq() {
  local got="$1" want="$2" desc="$3"
  [ "${got}" = "${want}" ] || fail "${desc}: got='${got}' want='${want}'"
}

assert_eq "$(_caller_target_id_strip_kind 'milestone:42')" '42'   'milestone:42 → 42'
assert_eq "$(_caller_target_id_strip_kind 'milestone:1')"  '1'    'milestone:1 → 1'
assert_eq "$(_caller_target_id_strip_kind 'task:7')"       '7'    'task:7 → 7'
assert_eq "$(_caller_target_id_strip_kind 'issue:13')"     '13'   'issue:13 → 13'
assert_eq "$(_caller_target_id_strip_kind '42')"           '42'   'bare 42 → 42'
assert_eq "$(_caller_target_id_strip_kind 'cp:code:auth-login:r3')" \
                                                          'cp:code:auth-login:r3' \
                                                          'cp:* preserved'
assert_eq "$(_caller_target_id_strip_kind '')"             ''     'empty → empty'

echo "PASS: _caller_target_id_strip_kind"
