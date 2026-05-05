#!/usr/bin/env bash
# lib/output.sh - Agent output envelope validation.

agent_output_validate() {
  local output_file="$1" expected_role="$2" expected_operation="$3" expected_manifest_id="$4"
  if [ ! -f "${output_file}" ]; then
    log_error "agent_output_validate: output not found: ${output_file}"
    return 1
  fi
  command -v jq >/dev/null 2>&1 || {
    log_error "agent_output_validate: jq is required"
    return 1
  }

  local expected_kind
  expected_kind="$(role_output_kind "${expected_role}")" || {
    log_error "agent_output_validate: invalid role '${expected_role}'"
    return 1
  }

  jq -e \
    --arg expected_role "$(role_normalize "${expected_role}")" \
    --arg expected_operation "${expected_operation}" \
    --arg expected_manifest_id "${expected_manifest_id}" \
    --arg expected_kind "${expected_kind}" '
      (.output_kind == $expected_kind or .output_kind == "failure") and
      (.agent_role == $expected_role) and
      (.operation == $expected_operation) and
      (.object_id | type == "string" and length > 0) and
      (.manifest_id == $expected_manifest_id) and
      (.input_revision_pins | type == "array") and
      (.idempotency_key | type == "string" and length > 0) and
      (.summary | type == "string" and length > 0) and
      (has("operational_actions") | not) and
      (has("state_transition") | not) and
      (has("merge") | not) and
      (has("notify") | not)
    ' "${output_file}" >/dev/null || {
      log_error "agent_output_validate: required envelope fields failed"
      return 1
    }

  if jq -e '
      [
        paths(scalars) as $p
        | getpath($p)
        | select(type == "string")
        | select(test("\\b(gh pr merge|gh issue close|gh issue edit|set_label|close_issue|lease_expire|notify_webhook)\\b"))
      ] | length == 0
    ' "${output_file}" >/dev/null; then
    return 0
  fi

  log_error "agent_output_validate: output contains operational side-effect text"
  return 1
}
