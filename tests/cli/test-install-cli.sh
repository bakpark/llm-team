#!/usr/bin/env bash
# Verify the local CLI install script with a temp bin directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT
INSTALL_SCRIPT="${LLM_TEAM_ROOT}/scripts/install-cli.sh"
TMP_BIN="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-bin-XXXXXX")"

# shellcheck source=../_helpers/ephemeral_target.sh
. "${LLM_TEAM_ROOT}/tests/_helpers/ephemeral_target.sh"
TARGET="$(ephemeral_target_create install-cli-$$)"

cleanup() {
  rm -rf "${TMP_BIN}"
  ephemeral_target_cleanup "${TARGET}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

"${INSTALL_SCRIPT}" --bin-dir "${TMP_BIN}" --name llm-team-test >/tmp/llm-team-install.out

LINK="${TMP_BIN}/llm-team-test"
[ -L "${LINK}" ] || fail "expected symlink at ${LINK}"
[ "$(readlink "${LINK}")" = "${LLM_TEAM_ROOT}/bin/llm-team" ] || fail "symlink points to unexpected target"

"${LINK}" version >/tmp/llm-team-version.out
grep -Fq "llm-team dev" /tmp/llm-team-version.out || fail "installed command did not execute"

"${LINK}" target list >/tmp/llm-team-target-list.out
grep -Fq "${TARGET}" /tmp/llm-team-target-list.out || fail "installed command did not resolve repo root"

"${INSTALL_SCRIPT}" --bin-dir "${TMP_BIN}" --name llm-team-test >/tmp/llm-team-install-again.out
grep -Fq "Already installed" /tmp/llm-team-install-again.out || fail "install should be idempotent"

"${INSTALL_SCRIPT}" --bin-dir "${TMP_BIN}" --name llm-team-test --uninstall >/tmp/llm-team-uninstall.out
[ ! -e "${LINK}" ] && [ ! -L "${LINK}" ] || fail "expected uninstall to remove symlink"

echo "PASS: install-cli"
