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
# Test 5: H3 — ws_destroy removes worktree dir and is idempotent
# ----------------------------------------------------------------------------

ws_destroy "${UNIT_ID}" >/dev/null 2>&1 || fail "ws_destroy failed"
if [ -d "${WS_PATH}" ]; then
  fail "H3 regression: ws_destroy did not remove worktree dir ${WS_PATH}"
fi
# Idempotent: re-destroy must succeed without error.
ws_destroy "${UNIT_ID}" >/dev/null 2>&1 || fail "ws_destroy second call must succeed (idempotent)"

# ----------------------------------------------------------------------------
# Test 6: H5 — fetchlock acquire/release is reentrant within sequence and
#               never blocks indefinitely on stale lock.
# ----------------------------------------------------------------------------

# Stale lock removal: pre-create a >60s-old lock dir and ensure acquire reclaims.
LOCK_DIR="${LLM_TEAM_ROOT}/workdir/${TEST_TARGET}/repo.fetchlock"
mkdir -p "$(dirname "${LOCK_DIR}")"
mkdir "${LOCK_DIR}" 2>/dev/null
# Set lock dir mtime 120s ago.
touch -A -000200 "${LOCK_DIR}" 2>/dev/null \
  || touch -d "@$(( $(date +%s) - 120 ))" "${LOCK_DIR}" 2>/dev/null \
  || true
if ! _workspace_fetchlock_acquire; then
  fail "H5 regression: fetchlock did not reclaim stale lock"
fi
_workspace_fetchlock_release
if [ -d "${LOCK_DIR}" ]; then
  fail "H5 regression: fetchlock_release left lock dir behind"
fi

# ----------------------------------------------------------------------------
# Test 7: B1 — ws_apply_patch rejects malformed patch via --check precheck
# ----------------------------------------------------------------------------

# Create a fresh unit for negative tests so failures don't pollute task-1.
UNIT_NEG="task-neg"
WS_NEG="$(ws_ensure "${UNIT_NEG}" 2>/dev/null)" || fail "ws_ensure for ${UNIT_NEG} failed"
NEG_PRE_HEAD="$(cd "${WS_NEG}" && git rev-parse HEAD)"

BAD_PATCH="${TEST_TMP}/bad.diff"
cat >"${BAD_PATCH}" <<'EOF'
diff --git a/missing.txt b/missing.txt
index abcdef0..fedcba0 100644
--- a/missing.txt
+++ b/missing.txt
@@ -1 +1 @@
-old
+new
EOF
if ws_apply_patch "${UNIT_NEG}" "${BAD_PATCH}" "test: bad patch" >/dev/null 2>&1; then
  fail "B1 regression: ws_apply_patch accepted malformed patch (file missing, blob unknown)"
fi
NEG_HEAD_AFTER="$(cd "${WS_NEG}" && git rev-parse HEAD)"
if [ "${NEG_HEAD_AFTER}" != "${NEG_PRE_HEAD}" ]; then
  fail "I2 regression: malformed patch advanced HEAD"
fi
if [ -n "$(cd "${WS_NEG}" && git status --porcelain)" ]; then
  fail "I2 regression: malformed patch left dirty working tree"
fi

# B-2 (precheck diagnostics): stderr 가 단순 "malformed or non-applicable" 만이
# 아니라 git apply --check 의 실제 진단 출력을 함께 노출해야 한다. 이 테스트가
# 없으면 회귀로 stderr 가 다시 silenced 될 위험.
NEG_DIAG="$(ws_apply_patch "${UNIT_NEG}" "${BAD_PATCH}" "test: bad patch" 2>&1 >/dev/null || true)"
echo "${NEG_DIAG}" | grep -q "patch precheck failed" \
  || fail "B-2: precheck diagnostics missing 'patch precheck failed' header"
echo "${NEG_DIAG}" | grep -q "git apply --check stderr" \
  || fail "B-2: precheck diagnostics missing 'git apply --check stderr' section"

# ----------------------------------------------------------------------------
# Test 8: B1 — 3way conflict markers force rollback (working tree unchanged)
# ----------------------------------------------------------------------------

# Setup: in WS_NEG seed file foo with "A", commit. Capture blob A. Then change
# foo to "B" and commit. Build a patch that goes A→C; apply on top of "B" must
# trigger 3way conflict (markers in working tree).
UNIT_CFL="task-conflict"
WS_CFL="$(ws_ensure "${UNIT_CFL}" 2>/dev/null)" || fail "ws_ensure for ${UNIT_CFL} failed"
(
  cd "${WS_CFL}"
  printf 'A\n' >foo.txt
  git add foo.txt
  git -c user.name=t -c user.email=t@local -c commit.gpgsign=false \
      commit --quiet -m "seed A"
) >/dev/null 2>&1
A_BLOB="$(cd "${WS_CFL}" && git hash-object foo.txt)"
HEAD_AT_A="$(cd "${WS_CFL}" && git rev-parse HEAD)"

# Build A→C patch using real A blob hash so --3way can locate base.
C_BLOB="$(printf 'C\n' | git --git-dir="${WS_CFL}/.git" hash-object --stdin -w 2>/dev/null)"
PATCH_AC="${TEST_TMP}/ac.diff"
cat >"${PATCH_AC}" <<EOF
diff --git a/foo.txt b/foo.txt
index ${A_BLOB:0:7}..${C_BLOB:0:7} 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1 +1 @@
-A
+C
EOF

# Advance worktree to "B".
(
  cd "${WS_CFL}"
  printf 'B\n' >foo.txt
  git -c user.name=t -c user.email=t@local -c commit.gpgsign=false \
      commit --quiet -am "advance to B"
) >/dev/null 2>&1
HEAD_AT_B="$(cd "${WS_CFL}" && git rev-parse HEAD)"

# Apply A→C patch on top of B. --3way will produce conflict markers; our guard
# must detect and rollback.
if ws_apply_patch "${UNIT_CFL}" "${PATCH_AC}" "test: should conflict" >/dev/null 2>&1; then
  fail "B1 regression: ws_apply_patch accepted patch that produced conflict markers"
fi
HEAD_POST_CFL="$(cd "${WS_CFL}" && git rev-parse HEAD)"
if [ "${HEAD_POST_CFL}" != "${HEAD_AT_B}" ]; then
  fail "I2 regression: conflict-leaving patch advanced HEAD (expected ${HEAD_AT_B}, got ${HEAD_POST_CFL})"
fi
if [ -n "$(cd "${WS_CFL}" && git status --porcelain)" ]; then
  fail "I2 regression: conflict-leaving patch left dirty working tree"
fi
if [ "$(cd "${WS_CFL}" && cat foo.txt)" != "B" ]; then
  fail "I2 regression: conflict rollback did not restore foo.txt to B"
fi

# ----------------------------------------------------------------------------
# Test 9: G1 — commit failure (gpgsign with missing key) triggers rollback
# ----------------------------------------------------------------------------

UNIT_COMMIT="task-commit-fail"
WS_COMMIT="$(ws_ensure "${UNIT_COMMIT}" 2>/dev/null)" || fail "ws_ensure for ${UNIT_COMMIT} failed"
HEAD_PRE_COMMIT="$(cd "${WS_COMMIT}" && git rev-parse HEAD)"

# Force commit to fail by enabling gpgsign with a non-existent signing key. Our
# function passes -c user.name/user.email but does NOT override commit.gpgsign,
# so this propagates and `git commit` fails.
(
  cd "${WS_COMMIT}"
  git config commit.gpgsign true
  git config gpg.program /bin/false
  git config user.signingkey "AAAAAAAAAAAAAAAA"
)

GOOD_PATCH="${TEST_TMP}/good.diff"
cat >"${GOOD_PATCH}" <<'EOF'
diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..1eb19ce
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+payload
EOF

if ws_apply_patch "${UNIT_COMMIT}" "${GOOD_PATCH}" "test: commit fail" >/dev/null 2>&1; then
  fail "G1 regression: ws_apply_patch reported success despite commit failure"
fi
HEAD_POST_COMMIT="$(cd "${WS_COMMIT}" && git rev-parse HEAD)"
if [ "${HEAD_POST_COMMIT}" != "${HEAD_PRE_COMMIT}" ]; then
  fail "I2 regression: commit failure case advanced HEAD"
fi
if [ -n "$(cd "${WS_COMMIT}" && git status --porcelain)" ]; then
  fail "I2 regression: commit failure left dirty working tree (status not clean)"
fi
if [ -e "${WS_COMMIT}/added.txt" ]; then
  fail "I2 regression: commit failure left untracked file added.txt behind"
fi

# Restore good config so this worktree could be reused later if needed.
(
  cd "${WS_COMMIT}"
  git config --unset commit.gpgsign
  git config --unset gpg.program
  git config --unset user.signingkey
) >/dev/null 2>&1

# ----------------------------------------------------------------------------
# Test 10: G4 — multi-hunk patch idempotent re-apply (real agent shape)
# ----------------------------------------------------------------------------

UNIT_MULTI="task-multi"
WS_MULTI="$(ws_ensure "${UNIT_MULTI}" 2>/dev/null)" || fail "ws_ensure for ${UNIT_MULTI} failed"

MULTI_PATCH="${TEST_TMP}/multi.diff"
cat >"${MULTI_PATCH}" <<'EOF'
diff --git a/a.txt b/a.txt
new file mode 100644
index 0000000..7898192
--- /dev/null
+++ b/a.txt
@@ -0,0 +1 @@
+a
diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..6178079
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+b
diff --git a/c.txt b/c.txt
new file mode 100644
index 0000000..f2ad6c7
--- /dev/null
+++ b/c.txt
@@ -0,0 +1 @@
+c
EOF

ws_apply_patch "${UNIT_MULTI}" "${MULTI_PATCH}" "test: multi-file" \
  || fail "G4 regression: ws_apply_patch failed on multi-file patch"
HEAD_M1="$(cd "${WS_MULTI}" && git rev-parse HEAD)"

# Re-apply identical patch — must be idempotent (HEAD unchanged, exit 0).
ws_apply_patch "${UNIT_MULTI}" "${MULTI_PATCH}" "test: multi-file retry" \
  || fail "G4 regression: idempotent retry of multi-file patch failed"
HEAD_M2="$(cd "${WS_MULTI}" && git rev-parse HEAD)"
if [ "${HEAD_M2}" != "${HEAD_M1}" ]; then
  fail "G4 regression: multi-file idempotent retry advanced HEAD"
fi
if [ -n "$(cd "${WS_MULTI}" && git status --porcelain)" ]; then
  fail "G4 regression: multi-file idempotent retry left dirty working tree"
fi

# ----------------------------------------------------------------------------
# Test 11: G2 — ws_ensure / ws_refresh fail-fast when fetchlock is held
# ----------------------------------------------------------------------------

LOCK_HOLD="${LLM_TEAM_ROOT}/workdir/${TEST_TARGET}/repo.fetchlock"
mkdir -p "$(dirname "${LOCK_HOLD}")"
mkdir "${LOCK_HOLD}" 2>/dev/null \
  || fail "fixture: could not pre-create lock dir for held-lock test"
# Force fresh mtime so stale-reclaim heuristic does NOT fire (60s threshold).
touch "${LOCK_HOLD}"

UNIT_LOCKED="task-locked"
if ws_ensure "${UNIT_LOCKED}" >/dev/null 2>&1; then
  fail "G2 regression: ws_ensure proceeded despite fetchlock being held"
fi

# ----------------------------------------------------------------------------
# Test 12: ws_ensure_ro_tree — RO tree 생성 및 idempotence
# ----------------------------------------------------------------------------

RO_PATH="$(ws_ensure_ro_tree "${TEST_TARGET}" 2>/dev/null)" || \
  fail "R1: ws_ensure_ro_tree failed"
if [ ! -d "${RO_PATH}" ]; then
  fail "R1: RO tree directory not found at ${RO_PATH}"
fi
# detached HEAD 확인
DETACHED="$(cd "${RO_PATH}" && git symbolic-ref --short HEAD 2>&1 || true)"
if [ "${DETACHED}" != "HEAD" ] && ! printf '%s' "${DETACHED}" | grep -q 'detached'; then
  fail "R1: RO tree is not detached (got: ${DETACHED})"
fi

# idempotence: 두 번째 호출 시 동일한 경로 반환, SHA 불변
RO_PIN_1="$(ws_ro_tree_revision_pin "${TEST_TARGET}" 2>/dev/null)" || \
  fail "R2: ws_ro_tree_revision_pin failed"
RO_PATH_2="$(ws_ensure_ro_tree "${TEST_TARGET}" 2>/dev/null)" || \
  fail "R2: ws_ensure_ro_tree retry failed"
RO_PIN_2="$(ws_ro_tree_revision_pin "${TEST_TARGET}" 2>/dev/null)" || \
  fail "R2: ws_ro_tree_revision_pin retry failed"
if [ "${RO_PIN_1}" != "${RO_PIN_2}" ]; then
  fail "R2: RO pin changed on idempotent call (${RO_PIN_1} vs ${RO_PIN_2})"
fi

# ----------------------------------------------------------------------------
# Test 13: ws_ensure_ro_tree — stale refresh
# ----------------------------------------------------------------------------
(
  cd "${TARGET_CLONE_PATH}"
  git checkout --quiet main
  echo "stale-trigger" >stale-marker.txt
  git add stale-marker.txt
  git commit --quiet -m "trigger stale"
  git push --quiet origin main
)

RO_PATH_NEW="$(ws_ensure_ro_tree "${TEST_TARGET}" 2>/dev/null)" || \
  fail "R3: ws_ensure_ro_tree failed after origin advance"
RO_PIN_3="$(ws_ro_tree_revision_pin "${TEST_TARGET}" 2>/dev/null)" || \
  fail "R3: ws_ro_tree_revision_pin failed after refresh"
if [ "${RO_PIN_3}" = "${RO_PIN_1}" ]; then
  fail "R3: RO pin did not update after origin advance (${RO_PIN_3})"
fi

# ----------------------------------------------------------------------------
# Test 14: agent_workspace_for — repo symlink 상대경로
# ----------------------------------------------------------------------------
AGENT_PATH="$(agent_workspace_for PO "${TEST_TARGET}" 2>/dev/null)" || \
  fail "S1: agent_workspace_for failed"
if [ ! -L "${AGENT_PATH}/repo" ]; then
  fail "S1: ${AGENT_PATH}/repo is not a symlink"
fi
LINK_TARGET="$(readlink "${AGENT_PATH}/repo")"
case "${LINK_TARGET}" in
  /*) fail "S1: repo symlink is absolute path (${LINK_TARGET}), expected relative" ;;
  *) true ;;
esac
RESOLVED="$(cd "${AGENT_PATH}" && realpath repo 2>/dev/null)"
if [ ! -d "${RESOLVED}" ]; then
  fail "S1: repo symlink does not resolve to a directory"
fi

# ----------------------------------------------------------------------------
# Released the lock.
rmdir "${LOCK_HOLD}" 2>/dev/null || rm -rf "${LOCK_HOLD}" 2>/dev/null

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------

if [ "${failures}" -gt 0 ]; then
  echo "${failures} failure(s)" >&2
  exit 1
fi
echo "ok: tests/adapters/test-workspace-git_worktree.sh"
