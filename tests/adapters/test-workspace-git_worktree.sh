#!/usr/bin/env bash
# tests/adapters/test-workspace-git_worktree.sh
#
# adapters/workspace/git_worktree.sh 회귀 테스트.
#
# 시나리오 (H1·H2 회귀 방지):
#   1. ws_apply_patch 후 ws_publish_branch → bare remote tip 의 sha 가 base 와
#      달라진다 (= 패치가 commit + push 까지 영속화됨, H1 회귀 차단).
#   2. 동일 patch 두 번 적용 → 멱등 (빈 diff 면 commit 생략, push tip 유지).
#   3. 다른 패치 추가 → tip sha 가 다시 갱신된다.
#   4. ws_refresh: 외부에서 origin/<branch> 를 advance 시킨 뒤 호출하면
#      worktree HEAD 가 새 tip 과 일치한다 (H2 회귀 차단).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

if ! command -v git >/dev/null 2>&1; then
  echo "SKIP: git not available" >&2
  exit 0
fi

TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/llm-team-ws-git-XXXXXX")"
TEST_TARGET="ws-git-test-$$-${RANDOM}"
TEST_BARE="${TEST_TMP}/bare.git"
TEST_SEED="${TEST_TMP}/seed"

cleanup() {
  rm -rf "${TEST_TMP}" 2>/dev/null || true
  rm -rf "${LLM_TEAM_ROOT}/workdir/${TEST_TARGET}" 2>/dev/null || true
}
trap cleanup EXIT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# Force git_worktree adapter (default), but rebind explicitly to be safe.
adapter_load workspace git_worktree >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------
# Fixture: bare remote with `main` and `integration` branches (single seed
# commit). git_worktree adapter clones from this bare repo.
# ----------------------------------------------------------------------------

git init --quiet --bare --initial-branch=main "${TEST_BARE}"
git init --quiet --initial-branch=main "${TEST_SEED}"
(
  cd "${TEST_SEED}"
  git config user.name "seed"
  git config user.email "seed@local"
  echo "seed" >README.md
  git add README.md
  git -c commit.gpgsign=false commit --quiet -m "seed"
  git branch integration
  git remote add origin "${TEST_BARE}"
  git push --quiet origin main
  git push --quiet origin integration
) >/dev/null 2>&1

# git_worktree adapter expects HTTPS clone; we point TARGET_CLONE_PATH to a
# pre-cloned canonical so ws_ensure_clone short-circuits to fetch.
export TARGET_NAME="${TEST_TARGET}"
export TARGET_GH_OWNER="example"
export TARGET_GH_REPO="${TEST_TARGET}"
export TARGET_DEFAULT_BRANCH="main"
export LLM_TEAM_INTEGRATION_BRANCH="integration"
export TARGET_CLONE_PATH="${TEST_TMP}/canonical"

# Pre-clone canonical from bare so ws_ensure_clone hits the fetch-only branch.
git clone --quiet "${TEST_BARE}" "${TARGET_CLONE_PATH}" >/dev/null 2>&1
( cd "${TARGET_CLONE_PATH}" && git remote set-url origin "${TEST_BARE}" )

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# ----------------------------------------------------------------------------
# Test 1+2: H1 — apply patch → publish → bare tip moves & is non-empty diff
# ----------------------------------------------------------------------------

ws_ensure_clone "${TEST_TARGET}" >/dev/null 2>&1 \
  || fail "ws_ensure_clone failed"

UNIT_ID="task-1"
WS_PATH="$(ws_ensure "${UNIT_ID}" 2>/dev/null)" \
  || fail "ws_ensure failed"

if [ -z "${WS_PATH}" ] || { [ ! -d "${WS_PATH}/.git" ] && [ ! -f "${WS_PATH}/.git" ]; }; then
  fail "ws_ensure did not produce a git worktree at ${WS_PATH}"
fi

# Capture base sha (before any patch).
BASE_SHA="$(cd "${WS_PATH}" && git rev-parse HEAD)"

# Build a unified-diff patch that adds a new file. `git apply --3way` accepts
# a patch even when the file is brand new because of the index hash.
PATCH_FILE="${TEST_TMP}/patch1.diff"
cat >"${PATCH_FILE}" <<'EOF'
diff --git a/hello.txt b/hello.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
+hello
EOF

ws_apply_patch "${UNIT_ID}" "${PATCH_FILE}" "test: add hello.txt" \
  || fail "ws_apply_patch failed (H1)"

# After apply, HEAD must have advanced from BASE_SHA (commit happened).
HEAD_AFTER_APPLY="$(cd "${WS_PATH}" && git rev-parse HEAD)"
if [ "${HEAD_AFTER_APPLY}" = "${BASE_SHA}" ]; then
  fail "H1 regression: HEAD did not advance after ws_apply_patch (no commit)"
fi

# Publish must succeed and bare remote tip must equal HEAD_AFTER_APPLY.
ws_publish_branch "${UNIT_ID}" "llm-team/${UNIT_ID}" \
  || fail "ws_publish_branch failed"

REMOTE_TIP="$(git --git-dir="${TEST_BARE}" rev-parse "refs/heads/llm-team/${UNIT_ID}" 2>/dev/null)"
if [ -z "${REMOTE_TIP}" ]; then
  fail "remote ref refs/heads/llm-team/${UNIT_ID} not present after publish"
elif [ "${REMOTE_TIP}" != "${HEAD_AFTER_APPLY}" ]; then
  fail "remote tip ${REMOTE_TIP} != local HEAD ${HEAD_AFTER_APPLY}"
fi
if [ "${REMOTE_TIP}" = "${BASE_SHA}" ]; then
  fail "H1 regression: remote tip equals base — push had empty diff"
fi

# Idempotent re-apply of identical content (file already committed) — should
# succeed without crashing and remote tip must remain unchanged.
ws_apply_patch "${UNIT_ID}" "${PATCH_FILE}" "test: add hello.txt (retry)" \
  || fail "ws_apply_patch idempotent retry failed"
HEAD_AFTER_RETRY="$(cd "${WS_PATH}" && git rev-parse HEAD)"
if [ "${HEAD_AFTER_RETRY}" != "${HEAD_AFTER_APPLY}" ]; then
  fail "idempotent retry advanced HEAD unexpectedly"
fi

# ----------------------------------------------------------------------------
# Test 3: another patch → tip moves again
# ----------------------------------------------------------------------------

PATCH2="${TEST_TMP}/patch2.diff"
cat >"${PATCH2}" <<'EOF'
diff --git a/world.txt b/world.txt
new file mode 100644
index 0000000..cc628cc
--- /dev/null
+++ b/world.txt
@@ -0,0 +1 @@
+world
EOF
ws_apply_patch "${UNIT_ID}" "${PATCH2}" "test: add world.txt" \
  || fail "ws_apply_patch second patch failed"
ws_publish_branch "${UNIT_ID}" "llm-team/${UNIT_ID}" \
  || fail "ws_publish_branch second push failed"
HEAD_AFTER_2="$(cd "${WS_PATH}" && git rev-parse HEAD)"
if [ "${HEAD_AFTER_2}" = "${HEAD_AFTER_APPLY}" ]; then
  fail "second patch did not advance HEAD"
fi
REMOTE_TIP_2="$(git --git-dir="${TEST_BARE}" rev-parse "refs/heads/llm-team/${UNIT_ID}" 2>/dev/null)"
if [ "${REMOTE_TIP_2}" != "${HEAD_AFTER_2}" ]; then
  fail "remote tip not updated after second push"
fi

# ----------------------------------------------------------------------------
# Test 4: H2 — ws_refresh syncs worktree to origin/<branch> tip
# ----------------------------------------------------------------------------

# Simulate: another worker (e.g., from a different host) advances the same
# branch on origin. We use a side worktree of the canonical to push a new
# commit without touching the unit worktree.
SIDE_WT="${TEST_TMP}/side-wt"
(
  cd "${TARGET_CLONE_PATH}"
  git fetch --quiet origin "llm-team/${UNIT_ID}" >/dev/null 2>&1 || true
  git worktree add --quiet -B "side-${UNIT_ID}" "${SIDE_WT}" "origin/llm-team/${UNIT_ID}"
)
(
  cd "${SIDE_WT}"
  echo "external" >external.txt
  git add external.txt
  git -c user.name=ext -c user.email=ext@local -c commit.gpgsign=false \
      commit --quiet -m "external advance"
  git push --quiet origin "HEAD:llm-team/${UNIT_ID}"
) >/dev/null 2>&1

NEW_REMOTE_TIP="$(git --git-dir="${TEST_BARE}" rev-parse "refs/heads/llm-team/${UNIT_ID}" 2>/dev/null)"
if [ "${NEW_REMOTE_TIP}" = "${HEAD_AFTER_2}" ]; then
  fail "fixture: external advance did not move remote tip"
fi

# Before refresh: unit worktree HEAD still points at HEAD_AFTER_2.
PRE_REFRESH="$(cd "${WS_PATH}" && git rev-parse HEAD)"
if [ "${PRE_REFRESH}" != "${HEAD_AFTER_2}" ]; then
  fail "fixture: unit worktree HEAD unexpectedly moved before refresh"
fi

ws_refresh "${UNIT_ID}" \
  || fail "ws_refresh failed"

POST_REFRESH="$(cd "${WS_PATH}" && git rev-parse HEAD)"
if [ "${POST_REFRESH}" != "${NEW_REMOTE_TIP}" ]; then
  fail "H2 regression: ws_refresh did not sync to origin tip (got ${POST_REFRESH}, expected ${NEW_REMOTE_TIP})"
fi
if [ ! -f "${WS_PATH}/external.txt" ]; then
  fail "H2 regression: refreshed worktree missing externally-pushed file"
fi

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------

if [ "${failures}" -gt 0 ]; then
  echo "${failures} failure(s)" >&2
  exit 1
fi
echo "ok: tests/adapters/test-workspace-git_worktree.sh"
