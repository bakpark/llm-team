#!/usr/bin/env bash
# tests/lib/test-config-secret.sh — verify resolve_secret fails fast.
#
# Strategy:
#   • Stand up a temp HOME and a temp LLM_TEAM_ROOT (with no .env files).
#   • Run resolve_secret in a *separate bash* process so its `exit 1` does not
#     terminate the test driver.
#   • Use a guaranteed-not-set env var name.
#   • Assert: exit code = 1, and stderr mentions the missing key.

set -uo pipefail

DRIVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_REAL_ROOT="$(cd "${DRIVER_DIR}/../.." && pwd)"

TMP_HOME="$(mktemp -d)"
TMP_ROOT="$(mktemp -d)"
stderr_log="$(mktemp)"
cleanup() { rm -rf "${TMP_HOME}" "${TMP_ROOT}"; rm -f "${stderr_log}"; }
trap cleanup EXIT

# Mirror the lib/ tree into the temp root so common.sh can resolve.
cp -R "${LLM_TEAM_REAL_ROOT}/lib" "${TMP_ROOT}/lib"

# Pick a key that is virtually guaranteed not to exist anywhere.
MISSING_KEY="LLM_TEAM_TEST_MISSING_$(date +%s)_$$"

set +e
HOME="${TMP_HOME}" LLM_TEAM_ROOT="${TMP_ROOT}" \
  bash -c '. "${LLM_TEAM_ROOT}/lib/common.sh"; resolve_secret "$1"' \
  -- "${MISSING_KEY}" 2> "${stderr_log}" >/dev/null
rc=$?
set -e

if [ "${rc}" -eq 0 ]; then
  echo "FAIL: resolve_secret returned 0 for a missing key" >&2
  cat "${stderr_log}" >&2
  exit 1
fi
if [ "${rc}" -ne 1 ]; then
  echo "FAIL: resolve_secret exited with rc=${rc}, expected 1" >&2
  cat "${stderr_log}" >&2
  exit 1
fi
if ! grep -Fq "${MISSING_KEY}" "${stderr_log}"; then
  echo "FAIL: stderr did not mention the missing key '${MISSING_KEY}'" >&2
  cat "${stderr_log}" >&2
  exit 1
fi
if ! grep -q 'ERROR' "${stderr_log}"; then
  echo "FAIL: stderr did not contain an ERROR-level log line" >&2
  cat "${stderr_log}" >&2
  exit 1
fi

echo "PASS: resolve_secret exited 1 with stderr error for missing key"
