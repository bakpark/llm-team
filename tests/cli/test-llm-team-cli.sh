#!/usr/bin/env bash
# Smoke tests for the llm-team CLI front door.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1" needle="$2" label="$3"
  if ! grep -Fq "${needle}" "${file}"; then
    echo "FAIL: ${label}: missing '${needle}'" >&2
    echo "--- output ---" >&2
    cat "${file}" >&2
    echo "--------------" >&2
    exit 1
  fi
}

run_capture() {
  local name="$1"; shift
  local out="/tmp/llm-team-cli-${name}.out"
  if ! "$@" >"${out}" 2>&1; then
    echo "FAIL: command failed: $*" >&2
    cat "${out}" >&2
    exit 1
  fi
  printf '%s\n' "${out}"
}

out="$(run_capture help "${LLM_TEAM_ROOT}/bin/llm-team" --help)"
assert_contains "${out}" "Usage: llm-team" "help"
assert_contains "${out}" "target <list|show|add|init|enable|disable>" "help commands"

out="$(run_capture target-list "${LLM_TEAM_ROOT}/bin/llm-team" target list)"
assert_contains "${out}" "myapp" "target list"

out="$(run_capture target-show "${LLM_TEAM_ROOT}/bin/llm-team" target show myapp)"
assert_contains "${out}" "owner: bakparkbj" "target show owner"
assert_contains "${out}" "repo: myapp" "target show repo"

# doctor 는 workdir scaffold + agent-cwd 를 요구하므로
# clean checkout 에서도 동작하도록 target init 을 먼저 실행한다
# (--dry-run 은 clone/labels 네트워크 호출을 건너뛰고 디렉토리만 생성).
out="$(run_capture target-init "${LLM_TEAM_ROOT}/bin/llm-team" target init myapp --dry-run --skip-labels)"
assert_contains "${out}" "target myapp ready" "target init"

out="$(run_capture doctor "${LLM_TEAM_ROOT}/bin/llm-team" doctor myapp)"
assert_contains "${out}" "Doctor: OK" "doctor"

out="$(run_capture status "${LLM_TEAM_ROOT}/bin/llm-team" status myapp)"
assert_contains "${out}" "Target: myapp" "status"
assert_contains "${out}" "scope" "status daemon table"

out="$(run_capture daemon-status "${LLM_TEAM_ROOT}/bin/llm-team" daemon status myapp --role po)"
assert_contains "${out}" "myapp" "daemon status target"
assert_contains "${out}" "po" "daemon status role"

out="$(run_capture run-dry "${LLM_TEAM_ROOT}/bin/llm-team" run po myapp --dry-run)"
assert_contains "${out}" "dry-run manifest=" "run dry-run"

out="$(run_capture run-once-dry "${LLM_TEAM_ROOT}/bin/llm-team" run-once myapp --roles po --dry-run)"
assert_contains "${out}" "dry-run manifest=" "run-once dry-run"

out="$(run_capture labels-dry "${LLM_TEAM_ROOT}/bin/llm-team" labels bootstrap myapp --dry-run)"
assert_contains "${out}" "task:ready" "labels bootstrap"

tmp_target="cli-url-$$"
cleanup_target() {
  rm -f "${LLM_TEAM_ROOT}/targets/${tmp_target}.yaml" "${LLM_TEAM_ROOT}/targets/cli-inferred.yaml"
  rm -rf "${LLM_TEAM_ROOT}/inputs/${tmp_target}" "${LLM_TEAM_ROOT}/inputs/cli-inferred"
}
trap cleanup_target EXIT

out="$(run_capture target-add-url "${LLM_TEAM_ROOT}/bin/llm-team" target add "${tmp_target}" --url https://github.com/example/cli-url.git --branch develop --disabled --force)"
assert_contains "${out}" "Created target ${tmp_target}" "target add url"
out="$(run_capture target-show-url "${LLM_TEAM_ROOT}/bin/llm-team" target show "${tmp_target}")"
assert_contains "${out}" "owner: example" "target add url owner"
assert_contains "${out}" "repo: cli-url" "target add url repo"
assert_contains "${out}" "default_branch: develop" "target add url branch"

out="$(run_capture target-add-inferred "${LLM_TEAM_ROOT}/bin/llm-team" target add --repo git@github.com:example/cli-inferred.git --disabled --force)"
assert_contains "${out}" "Created target cli-inferred" "target add inferred"
out="$(run_capture target-show-inferred "${LLM_TEAM_ROOT}/bin/llm-team" target show cli-inferred)"
assert_contains "${out}" "owner: example" "target add inferred owner"
assert_contains "${out}" "repo: cli-inferred" "target add inferred repo"

echo "PASS: llm-team CLI smoke"
