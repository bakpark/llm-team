#!/usr/bin/env bash
# lib/common.sh — single sourcing entrypoint for the framework lib modules.
#
# Usage:
#   . "${LLM_TEAM_ROOT:-/path/to/llm-team}/lib/common.sh"
#
# Side effects on source:
#   • Exports LLM_TEAM_ROOT (resolved from this file's location if unset).
#   • Sources every lib module in dependency order so every public function
#     is available to the caller.
#
# This file is intentionally minimal and contains no business logic.

if [ -z "${LLM_TEAM_ROOT:-}" ]; then
  _llm_common_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  LLM_TEAM_ROOT="$(cd "${_llm_common_dir}/.." && pwd)"
  export LLM_TEAM_ROOT
  unset _llm_common_dir
fi

# Source order: leaf modules first, then those depending on them.
# shellcheck source=lib/log.sh
. "${LLM_TEAM_ROOT}/lib/log.sh"
# shellcheck source=lib/roles.sh
. "${LLM_TEAM_ROOT}/lib/roles.sh"
# shellcheck source=lib/state.sh
. "${LLM_TEAM_ROOT}/lib/state.sh"
# shellcheck source=lib/labels.sh
. "${LLM_TEAM_ROOT}/lib/labels.sh"
# shellcheck source=lib/config.sh
. "${LLM_TEAM_ROOT}/lib/config.sh"
# shellcheck source=lib/registry.sh
. "${LLM_TEAM_ROOT}/lib/registry.sh"
# Load port specs + bind concrete adapters.
#  • issue_tracker → adapters/issue_tracker/github.sh (gh_with_retry, it_*).
#  • 다른 port 는 아직 lib/<file>.sh 에 잔존 — 아래에서 직접 source.
registry_load_default || log_warn "common.sh: registry_load_default reported errors"
# shellcheck source=lib/markers.sh
. "${LLM_TEAM_ROOT}/lib/markers.sh"
# shellcheck source=lib/context.sh
. "${LLM_TEAM_ROOT}/lib/context.sh"
# shellcheck source=lib/output.sh
. "${LLM_TEAM_ROOT}/lib/output.sh"
# shellcheck source=lib/lease.sh
. "${LLM_TEAM_ROOT}/lib/lease.sh"
# shellcheck source=lib/ledger.sh
. "${LLM_TEAM_ROOT}/lib/ledger.sh"
# shellcheck source=lib/backoff.sh
. "${LLM_TEAM_ROOT}/lib/backoff.sh"
# shellcheck source=lib/signals.sh
. "${LLM_TEAM_ROOT}/lib/signals.sh"
# shellcheck source=lib/verification.sh
. "${LLM_TEAM_ROOT}/lib/verification.sh"
# shellcheck source=lib/change_proposal.sh
. "${LLM_TEAM_ROOT}/lib/change_proposal.sh"
# shellcheck source=lib/notifier.sh
. "${LLM_TEAM_ROOT}/lib/notifier.sh"
# shellcheck source=lib/claude.sh
. "${LLM_TEAM_ROOT}/lib/claude.sh"
# shellcheck source=lib/worktree.sh
. "${LLM_TEAM_ROOT}/lib/worktree.sh"
# shellcheck source=lib/concurrency.sh
. "${LLM_TEAM_ROOT}/lib/concurrency.sh"
# shellcheck source=lib/stale.sh
. "${LLM_TEAM_ROOT}/lib/stale.sh"
