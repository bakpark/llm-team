#!/usr/bin/env bash
# tests/application/test-release.sh
#
# Phase 4 — application/release.sh 단위 테스트.
#
# 검증:
#   1. release_compute_tag — semver 통과 (v 접두사 정규화), 비-semver 거부.
#   2. release_extract_notes — release_notes_md 우선, summary 폴백.
#   3. release_publish_from_milestone:
#      a. envelope.artifacts.release_tag 가 있으면 그 값 사용 + it_release_create 호출.
#      b. envelope.summary 안의 semver 토큰 fallback.
#      c. 후보가 없으면 비0 + it_release_create 호출 없음.
#      d. 잘못된 semver 후보 → 비0.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

INMEM_IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-release-XXXXXX")"
export LLM_TEAM_INMEM_IT_DIR="${INMEM_IT_DIR}"
export LLM_TEAM_ADAPTER_ISSUE_TRACKER="in_memory"
export TARGET_NAME="release-test"

cleanup() { rm -rf "${INMEM_IT_DIR}" 2>/dev/null || true; }
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"
# shellcheck source=../../application/release.sh
. "${LLM_TEAM_ROOT}/application/release.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

REPO="release-test/repo"

# ----------------------------------------------------------------------------
# 1. release_compute_tag
# ----------------------------------------------------------------------------
got="$(release_compute_tag "1.2.3" 2>/dev/null)" || got=""
[ "${got}" = "v1.2.3" ] || fail "compute_tag: '1.2.3' expected v1.2.3, got '${got}'"

got="$(release_compute_tag "v0.1.0" 2>/dev/null)" || got=""
[ "${got}" = "v0.1.0" ] || fail "compute_tag: 'v0.1.0' expected v0.1.0, got '${got}'"

got="$(release_compute_tag "1.2.3-rc.1" 2>/dev/null)" || got=""
[ "${got}" = "v1.2.3-rc.1" ] || fail "compute_tag: '1.2.3-rc.1' expected v1.2.3-rc.1, got '${got}'"

# Invalid candidates → nonzero.
if release_compute_tag "" 2>/dev/null; then fail "compute_tag: empty should fail"; fi
if release_compute_tag "abc" 2>/dev/null; then fail "compute_tag: 'abc' should fail"; fi
if release_compute_tag "1.2" 2>/dev/null; then fail "compute_tag: '1.2' should fail"; fi
if release_compute_tag "v1.2" 2>/dev/null; then fail "compute_tag: 'v1.2' should fail"; fi

# ----------------------------------------------------------------------------
# 2. release_extract_notes
# ----------------------------------------------------------------------------
env_a="$(mktemp)"
cat >"${env_a}" <<'JSON'
{ "summary": "fallback summary", "artifacts": { "release_notes_md": "# Notes\nLine 1" } }
JSON
got="$(release_extract_notes "${env_a}")"
[ "${got}" = "# Notes
Line 1" ] || fail "extract_notes: artifacts.release_notes_md not preferred (got '${got}')"

env_b="$(mktemp)"
cat >"${env_b}" <<'JSON'
{ "summary": "summary fallback only" }
JSON
got="$(release_extract_notes "${env_b}")"
[ "${got}" = "summary fallback only" ] || fail "extract_notes: summary fallback failed (got '${got}')"

env_c="$(mktemp)"
cat >"${env_c}" <<'JSON'
{ "release_notes_md": "top-level notes" }
JSON
got="$(release_extract_notes "${env_c}")"
[ "${got}" = "top-level notes" ] || fail "extract_notes: top-level release_notes_md fallback failed (got '${got}')"

rm -f "${env_a}" "${env_b}" "${env_c}"

# ----------------------------------------------------------------------------
# 3. release_publish_from_milestone
# ----------------------------------------------------------------------------
ms_num="$(it_milestone_create "${REPO}" "v1.0.0 release" "milestone body" 2>/dev/null)" \
  || fail "seed: milestone_create failed"

# 3a. explicit artifacts.release_tag
env_pass="$(mktemp)"
cat >"${env_pass}" <<'JSON'
{
  "summary": "QA validate passed",
  "artifacts": {
    "release_tag": "1.0.0",
    "release_notes_md": "## v1.0.0\n* item 1",
    "release_target": "main"
  }
}
JSON
if release_publish_from_milestone "${REPO}" "${ms_num}" "${env_pass}" >/dev/null 2>&1; then
  release_path="${INMEM_IT_DIR}/releases/v1.0.0.json"
  [ -f "${release_path}" ] || fail "publish: release file v1.0.0 missing"
  if [ -f "${release_path}" ]; then
    tag="$(jq -r '.tag' "${release_path}")"
    target="$(jq -r '.target' "${release_path}")"
    notes="$(jq -r '.notes' "${release_path}")"
    [ "${tag}" = "v1.0.0" ] || fail "publish: tag mismatch (${tag})"
    [ "${target}" = "main" ] || fail "publish: target mismatch (${target})"
    case "${notes}" in
      *"v1.0.0"*) ;;
      *) fail "publish: notes don't include v1.0.0 ('${notes}')" ;;
    esac
  fi
  pass "publish 3a: explicit release_tag → it_release_create called"
else
  fail "publish 3a: release_publish_from_milestone returned nonzero"
fi

# 3b. fallback: tag from summary token (use new milestone for unique tag)
ms_num2="$(it_milestone_create "${REPO}" "next" "x" 2>/dev/null)"
env_summary="$(mktemp)"
cat >"${env_summary}" <<'JSON'
{
  "summary": "release v2.0.0 with new features",
  "artifacts": { "release_target": "main" }
}
JSON
if release_publish_from_milestone "${REPO}" "${ms_num2}" "${env_summary}" >/dev/null 2>&1; then
  [ -f "${INMEM_IT_DIR}/releases/v2.0.0.json" ] \
    || fail "publish 3b: release file v2.0.0 missing"
  pass "publish 3b: summary semver token fallback"
else
  fail "publish 3b: release_publish_from_milestone returned nonzero"
fi

# 3c. no candidate → nonzero
ms_num3="$(it_milestone_create "${REPO}" "no-tag" "x" 2>/dev/null)"
env_none="$(mktemp)"
cat >"${env_none}" <<'JSON'
{ "summary": "no tag here at all", "artifacts": {} }
JSON
if release_publish_from_milestone "${REPO}" "${ms_num3}" "${env_none}" 2>/dev/null; then
  fail "publish 3c: should reject envelope without tag candidate"
else
  pass "publish 3c: missing tag rejected"
fi

# 3d. invalid semver → nonzero
ms_num4="$(it_milestone_create "${REPO}" "bad-tag" "x" 2>/dev/null)"
env_bad="$(mktemp)"
cat >"${env_bad}" <<'JSON'
{ "summary": "x", "artifacts": { "release_tag": "not-a-semver" } }
JSON
if release_publish_from_milestone "${REPO}" "${ms_num4}" "${env_bad}" 2>/dev/null; then
  fail "publish 3d: should reject invalid semver"
else
  pass "publish 3d: invalid semver rejected"
fi

# Missing-arg validation
if release_publish_from_milestone "${REPO}" "${ms_num}" "" 2>/dev/null; then
  fail "publish: missing env_path should fail"
fi

rm -f "${env_pass}" "${env_summary}" "${env_none}" "${env_bad}"

if [ "${failures}" -ne 0 ]; then
  echo "FAIL: ${failures} assertion(s) failed in test-release" >&2
  exit 1
fi
echo "PASS: tests/application/test-release.sh"
