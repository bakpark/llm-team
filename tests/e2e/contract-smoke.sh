#!/usr/bin/env bash
# Local smoke test for the contract-era runner. No GitHub mutation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

roles=(po pm planner coder reviewer integrator qa)
for role in "${roles[@]}"; do
  if ! bash "${LLM_TEAM_ROOT}/scheduler/runner.sh" "${role}" myapp --dry-run >/tmp/llm-team-runner-${role}.out 2>&1; then
    echo "FAIL: runner dry-run failed for role=${role}" >&2
    tail -20 "/tmp/llm-team-runner-${role}.out" >&2 || true
    exit 1
  fi
  if ! grep -Fq "dry-run manifest=" "/tmp/llm-team-runner-${role}.out"; then
    echo "FAIL: runner dry-run did not create manifest for role=${role}" >&2
    exit 1
  fi
done

if ! bash "${LLM_TEAM_ROOT}/scripts/bootstrap-labels.sh" myapp --dry-run >/tmp/llm-team-bootstrap-labels.out 2>&1; then
  echo "FAIL: bootstrap-labels dry-run failed" >&2
  tail -20 /tmp/llm-team-bootstrap-labels.out >&2 || true
  exit 1
fi

for label in task:ready task:review-ready task:integrated task:escalated cp:ready-for-review; do
  if ! grep -Fq "${label}" /tmp/llm-team-bootstrap-labels.out; then
    echo "FAIL: missing contract label in bootstrap dry-run: ${label}" >&2
    exit 1
  fi
done

echo "PASS: contract runner smoke"
