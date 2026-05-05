#!/usr/bin/env bash
# tests/lib/test-lease-token.sh
#
# Verifies #RGC-LEASE lease_token semantics and #RGC-LEDGER split-brain guard.
#
# Coverage:
#   1. lease_claim attaches a lease_token to the JSON.
#   2. lease_token is monotonically increasing per object_id (across releases).
#   3. lease_token is per-object: distinct object_ids get independent counters.
#   4. lease_get_token returns the active lease's token.
#   5. transition_ledger_write requires lease_token field (string|null).
#   6. transition_ledger_write rejects writes citing a strictly older
#      lease_token for the same object_id (split-brain guard).
#   7. Null lease_token entries (recovery / signals) are exempt and do NOT
#      block subsequent writes citing a token greater than any prior non-null.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

target="lease-token-test-$$"
cleanup() { rm -rf "${LLM_TEAM_ROOT}/workdir/${target}" 2>/dev/null || true; }
trap cleanup EXIT

# ── (1) lease_claim attaches lease_token ──────────────────────────────────
lease1="$(lease_claim "${target}" T-A Implement worker-1 60 '[]')" \
  || fail "first lease claim should pass"
lease_file="$(lease_dir "${target}")/T-A.json"
[ -f "${lease_file}" ] || fail "lease file missing"
tok1="$(jq -r '.lease_token // ""' "${lease_file}")"
[ -n "${tok1}" ] || fail "lease_token should be set on lease"

# ── (4) lease_get_token returns the token ──────────────────────────────────
got="$(lease_get_token "${target}" T-A)"
[ "${got}" = "${tok1}" ] \
  || fail "lease_get_token expected '${tok1}', got '${got}'"

# Release and re-claim — token must be strictly greater (per-object monotonic).
lease_release "${target}" T-A "${lease1}" || fail "release should pass"
lease2="$(lease_claim "${target}" T-A Implement worker-2 60 '[]')" \
  || fail "second lease claim should pass after release"
tok2="$(jq -r '.lease_token // ""' "${lease_file}")"
[ -n "${tok2}" ] || fail "second lease_token should be set"

# ── (2) Monotonicity (lex/numeric — tokens are zero-padded). ───────────────
if ! [ "${tok2}" \> "${tok1}" ]; then
  fail "lease_token monotonicity: tok2='${tok2}' must be > tok1='${tok1}'"
fi

# ── (3) Per-object independence ────────────────────────────────────────────
lease_release "${target}" T-A "${lease2}" || fail "release T-A should pass"
lease_b="$(lease_claim "${target}" T-B Implement worker-3 60 '[]')" \
  || fail "T-B lease claim should pass"
tok_b="$(jq -r '.lease_token // ""' "$(lease_dir "${target}")/T-B.json")"
case "${tok_b}" in
  T-B-lt-*) ;;
  *) fail "T-B lease_token namespaced by object_id, got '${tok_b}'" ;;
esac
case "${tok2}" in
  T-A-lt-*) ;;
  *) fail "T-A lease_token namespaced by object_id, got '${tok2}'" ;;
esac
lease_release "${target}" T-B "${lease_b}" || fail "release T-B should pass"

# ── (5) transition_ledger_write enforces lease_token field ────────────────
ledger_dir="${LLM_TEAM_ROOT}/workdir/${target}/ledger"
mkdir -p "${ledger_dir}"
entry_no_tok="${ledger_dir}/no-tok.json"
jq -n '{
  transition_id: "tx-1",
  target_id: "'"${target}"'",
  object_id: "T-A",
  object_kind: "task",
  from_state: "TASK_READY",
  to_state: "TASK_IN_PROGRESS",
  operation: "Implement",
  caller_id: "test",
  idempotency_key: "T-A:1",
  timestamp: "2026-05-03T00:00:00Z",
  result: "success"
}' >"${entry_no_tok}"
if transition_ledger_write "${target}" "${entry_no_tok}" 2>/dev/null; then
  fail "ledger should reject entry without lease_token field"
fi

# Valid entry with non-null lease_token cites tok1 (oldest).
entry1="${ledger_dir}/entry1.json"
jq -n --arg tt "${tok1}" '{
  transition_id: "tx-2",
  target_id: "'"${target}"'",
  object_id: "T-A",
  object_kind: "task",
  from_state: "TASK_READY",
  to_state: "TASK_IN_PROGRESS",
  operation: "Implement",
  caller_id: "test",
  idempotency_key: "T-A:2",
  timestamp: "2026-05-03T00:00:01Z",
  lease_token: $tt,
  result: "success"
}' >"${entry1}"
transition_ledger_write "${target}" "${entry1}" \
  || fail "first valid ledger write should pass"

# A subsequent entry citing tok2 (newer) MUST pass.
entry2="${ledger_dir}/entry2.json"
jq -n --arg tt "${tok2}" '{
  transition_id: "tx-3",
  target_id: "'"${target}"'",
  object_id: "T-A",
  object_kind: "task",
  from_state: "TASK_IN_PROGRESS",
  to_state: "TASK_REVIEW_READY",
  operation: "Implement",
  caller_id: "test",
  idempotency_key: "T-A:3",
  timestamp: "2026-05-03T00:00:02Z",
  lease_token: $tt,
  result: "success"
}' >"${entry2}"
transition_ledger_write "${target}" "${entry2}" \
  || fail "newer-token write should pass"

# ── (6) Split-brain guard — older token must be rejected ──────────────────
entry_stale="${ledger_dir}/entry-stale.json"
jq -n --arg tt "${tok1}" '{
  transition_id: "tx-4",
  target_id: "'"${target}"'",
  object_id: "T-A",
  object_kind: "task",
  from_state: "TASK_IN_PROGRESS",
  to_state: "TASK_REVIEW_READY",
  operation: "Implement",
  caller_id: "test-zombie-worker",
  idempotency_key: "T-A:4",
  timestamp: "2026-05-03T00:00:03Z",
  lease_token: $tt,
  result: "success"
}' >"${entry_stale}"
if transition_ledger_write "${target}" "${entry_stale}" 2>/dev/null; then
  fail "split-brain: stale older-token write must be rejected"
fi

# Cross-object isolation — older token on a different object must NOT be blocked.
entry_other="${ledger_dir}/entry-other.json"
jq -n --arg tt "${tok_b}" '{
  transition_id: "tx-5",
  target_id: "'"${target}"'",
  object_id: "T-B",
  object_kind: "task",
  from_state: "TASK_READY",
  to_state: "TASK_IN_PROGRESS",
  operation: "Implement",
  caller_id: "test",
  idempotency_key: "T-B:1",
  timestamp: "2026-05-03T00:00:04Z",
  lease_token: $tt,
  result: "success"
}' >"${entry_other}"
transition_ledger_write "${target}" "${entry_other}" \
  || fail "T-B token should be unaffected by T-A bound"

# ── (7) Null lease_token (recovery / signals) is exempt ───────────────────
entry_recover="${ledger_dir}/entry-recover.json"
jq -n '{
  transition_id: "tx-6",
  target_id: "'"${target}"'",
  object_id: "T-A",
  object_kind: "task",
  from_state: "TASK_REVIEW_READY",
  to_state: "TASK_READY",
  operation: "Recover",
  caller_id: "recovery_scan",
  idempotency_key: "T-A:5",
  timestamp: "2026-05-03T00:00:05Z",
  lease_token: null,
  result: "recovered"
}' >"${entry_recover}"
transition_ledger_write "${target}" "${entry_recover}" \
  || fail "null-token recovery write must pass through"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} lease_token check(s) failed" >&2
  exit 1
fi

echo "PASS: lease_token + ledger split-brain"
