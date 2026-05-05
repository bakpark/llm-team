#!/usr/bin/env bash
# lib/roles.sh - role and operation mapping from AGC/SOC contracts.

LLM_TEAM_ROLES=(PO PM Planner Coder Reviewer Integrator QA)
LLM_TEAM_OPERATIONS=(Compose-PO Compose-PM Decompose Implement Review Refactor Validate)

role_normalize() {
  case "$1" in
    po|PO) printf 'PO' ;;
    pm|PM) printf 'PM' ;;
    planner|Planner) printf 'Planner' ;;
    coder|Coder) printf 'Coder' ;;
    reviewer|Reviewer) printf 'Reviewer' ;;
    integrator|Integrator) printf 'Integrator' ;;
    qa|QA) printf 'QA' ;;
    *) return 1 ;;
  esac
}

role_is_valid() {
  role_normalize "$1" >/dev/null 2>&1
}

role_operation() {
  local role
  role="$(role_normalize "$1")" || return 1
  case "${role}" in
    PO) printf 'Compose-PO' ;;
    PM) printf 'Compose-PM' ;;
    Planner) printf 'Decompose' ;;
    Coder) printf 'Implement' ;;
    Reviewer) printf 'Review' ;;
    Integrator) printf 'Refactor' ;;
    QA) printf 'Validate' ;;
  esac
}

operation_role() {
  case "$1" in
    Compose-PO) printf 'PO' ;;
    Compose-PM) printf 'PM' ;;
    Decompose) printf 'Planner' ;;
    Implement) printf 'Coder' ;;
    Review) printf 'Reviewer' ;;
    Refactor) printf 'Integrator' ;;
    Validate) printf 'QA' ;;
    *) return 1 ;;
  esac
}

role_output_kind() {
  local role
  role="$(role_normalize "$1")" || return 1
  case "${role}" in
    PO|PM) printf 'spec_proposal' ;;
    Planner) printf 'task_plan' ;;
    Coder) printf 'patch' ;;
    Reviewer) printf 'verdict' ;;
    Integrator|QA) printf 'milestone_package' ;;
  esac
}

role_prompt_path() {
  local role lower
  role="$(role_normalize "$1")" || return 1
  lower="$(printf '%s' "${role}" | tr '[:upper:]' '[:lower:]')"
  printf '%s/prompts/%s.md' "${LLM_TEAM_ROOT}" "${lower}"
}
