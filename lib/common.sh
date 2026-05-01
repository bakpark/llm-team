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
# shellcheck source=lib/labels.sh
. "${LLM_TEAM_ROOT}/lib/labels.sh"
# shellcheck source=lib/config.sh
. "${LLM_TEAM_ROOT}/lib/config.sh"
# shellcheck source=lib/gh.sh
. "${LLM_TEAM_ROOT}/lib/gh.sh"
# shellcheck source=lib/markers.sh
. "${LLM_TEAM_ROOT}/lib/markers.sh"
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
