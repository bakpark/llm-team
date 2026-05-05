#!/usr/bin/env bash
# tests/_helpers/ephemeral_target.sh
#
# Test helper: create / cleanup an ephemeral target yaml under
# ${LLM_TEAM_ROOT}/targets/. Used by tests that need a valid target name
# resolvable by load_target without depending on a shipped fixture pointing
# to a real GitHub repo.
#
# Usage:
#   . "${LLM_TEAM_ROOT}/tests/_helpers/ephemeral_target.sh"
#   EPHEMERAL_TARGET="$(ephemeral_target_create)"
#   trap 'ephemeral_target_cleanup "${EPHEMERAL_TARGET}"' EXIT

ephemeral_target_create() {
  local name="${1:-eph-target-$$-${RANDOM}}"
  local owner="${2:-example-owner}"
  local yaml="${LLM_TEAM_ROOT}/targets/${name}.yaml"
  cat >"${yaml}" <<EOF
name: ${name}
github:
  owner: ${owner}
  repo: ${name}
  default_branch: main
local:
  clone_path: /tmp/${name}-clone
inputs_dir: inputs/${name}
labels:
  prefix: ""
notifier:
  channel: none
  webhook_or_id: ""
dev_concurrency: 1
stale_threshold_minutes: 60
verification:
  commands: ["true"]
enabled: true
EOF
  printf '%s\n' "${name}"
}

ephemeral_target_cleanup() {
  local name="$1"
  [ -n "${name}" ] || return 0
  rm -f "${LLM_TEAM_ROOT}/targets/${name}.yaml" 2>/dev/null || true
  rm -rf "${LLM_TEAM_ROOT}/workdir/${name}" 2>/dev/null || true
  rm -rf "${LLM_TEAM_ROOT}/inputs/${name}" 2>/dev/null || true
}
