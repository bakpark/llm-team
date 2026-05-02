#!/usr/bin/env bash
# lib/context.sh - Context Manifest creation and validation.

context_manifest_dir() {
  local target="$1"
  printf '%s/workdir/%s/manifests' "${LLM_TEAM_ROOT}" "${target}"
}

context_manifest_create() {
  local target="$1" operation="$2" target_kind="$3" target_id="$4"
  if [ -z "${target}" ] || [ -z "${operation}" ] || [ -z "${target_kind}" ] || [ -z "${target_id}" ]; then
    log_error "context_manifest_create: target, operation, target_kind, target_id are required"
    return 1
  fi
  command -v jq >/dev/null 2>&1 || {
    log_error "context_manifest_create: jq is required"
    return 1
  }

  local dir ts manifest_id path
  dir="$(context_manifest_dir "${target}")"
  mkdir -p "${dir}" || return 1
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  manifest_id="${operation}-${target_kind}-${target_id}-${ts}-$$"
  path="${dir}/${manifest_id}.json"

  jq -n \
    --arg manifest_id "${manifest_id}" \
    --arg operation "${operation}" \
    --arg target_kind "${target_kind}" \
    --arg target_id "${target_id}" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      manifest_id: $manifest_id,
      operation: $operation,
      target: {kind: $target_kind, id: $target_id},
      entries: [],
      created_at: $created_at
    }' >"${path}"
  printf '%s\n' "${path}"
}

context_manifest_add_entry() {
  local manifest_file="$1" object_kind="$2" object_id="$3" fetch_scope="$4" revision_pin="$5" required="$6" purpose="$7"
  local truncated="${8:-false}" truncation_reason="${9:-}"
  if [ ! -f "${manifest_file}" ]; then
    log_error "context_manifest_add_entry: manifest not found: ${manifest_file}"
    return 1
  fi
  case "${fetch_scope}" in
    metadata|body|body+comments) ;;
    *)
      log_error "context_manifest_add_entry: invalid fetch_scope '${fetch_scope}' (must be metadata|body|body+comments)"
      return 1
      ;;
  esac
  local tmp
  tmp="${manifest_file}.tmp.$$"
  jq \
    --arg object_kind "${object_kind}" \
    --arg object_id "${object_id}" \
    --arg fetch_scope "${fetch_scope}" \
    --arg revision_pin "${revision_pin}" \
    --argjson required "${required}" \
    --arg purpose "${purpose}" \
    --argjson truncated "${truncated}" \
    --arg truncation_reason "${truncation_reason}" \
    '.entries += [
      ({
        object_kind: $object_kind,
        object_id: $object_id,
        fetch_scope: $fetch_scope,
        revision_pin: $revision_pin,
        required: $required,
        purpose: $purpose
      }
      + (if $truncated then {truncated: true} else {} end)
      + (if $truncation_reason != "" then {truncation_reason: $truncation_reason} else {} end))
    ]' "${manifest_file}" >"${tmp}" && mv "${tmp}" "${manifest_file}"
}

context_manifest_validate() {
  local manifest_file="$1"
  if [ ! -f "${manifest_file}" ]; then
    log_error "context_manifest_validate: manifest not found: ${manifest_file}"
    return 1
  fi
  jq -e '
    (.manifest_id | type == "string" and length > 0) and
    (.operation | type == "string" and length > 0) and
    (.target.kind | type == "string" and length > 0) and
    (.target.id | type == "string" and length > 0) and
    (.entries | type == "array") and
    (.created_at | type == "string" and length > 0) and
    all(.entries[];
      (.object_kind | type == "string" and length > 0) and
      (.object_id | type == "string" and length > 0) and
      (.fetch_scope | IN("metadata", "body", "body+comments")) and
      (.revision_pin | type == "string" and length > 0) and
      (.required | type == "boolean") and
      (.purpose | type == "string" and length > 0) and
      (if has("truncated") then (.truncated | type == "boolean") else true end) and
      (if has("truncation_reason") then (.truncation_reason | type == "string") else true end)
    )
  ' "${manifest_file}" >/dev/null
}

context_manifest_id() {
  jq -r '.manifest_id' "$1"
}
