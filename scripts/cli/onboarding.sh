#!/usr/bin/env bash
# Onboarding checklist CLI: status / ack / list-schemas / wizard.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  llm-team onboarding status <target> [--json] [--quiet]
  llm-team onboarding ack <target> <ack_key> [--note "text"] [--unset]
  llm-team onboarding list-schemas
  llm-team onboarding wizard <target>
EOF
}

# 컬러 (TTY 일 때만).
_onb_color() {
  if [ -t 1 ]; then
    case "$1" in
      green)  printf '\033[32m' ;;
      red)    printf '\033[31m' ;;
      yellow) printf '\033[33m' ;;
      gray)   printf '\033[90m' ;;
      reset)  printf '\033[0m' ;;
    esac
  fi
}

_onb_status_color() {
  case "$1" in
    PASS) _onb_color green ;;
    FAIL) _onb_color red ;;
    WARN) _onb_color yellow ;;
    SKIP) _onb_color gray ;;
  esac
}

_onb_load_engine() {
  cli_source_runtime
  # shellcheck source=../../application/onboarding/verify.sh
  . "${LLM_TEAM_ROOT}/application/onboarding/verify.sh"
}

# onboarding_status_run <target> <json:0|1> <quiet:0|1>
# stdout: 표 또는 json. exit 0 = 모든 block PASS, 2 = 1+ block FAIL.
onboarding_status_run() {
  local target="$1" want_json="$2" quiet="$3"
  cli_require_target_file "${target}"
  _onb_load_engine

  local out tmp rc=0
  tmp="$(mktemp "${TMPDIR:-/tmp}/onboarding-status-XXXXXX")"
  set +e
  onboarding_verify "${target}" >"${tmp}" 2>/dev/null
  rc=$?
  set -e
  out="$(cat "${tmp}")"
  rm -f "${tmp}"

  if [ "${want_json}" = "1" ]; then
    _onb_to_json "${target}" "${out}" "${rc}"
  elif [ "${quiet}" = "0" ]; then
    _onb_print_table "${target}" "${out}"
  fi
  return "${rc}"
}

_onb_print_table() {
  local target="$1" body="$2"
  local schema sh
  schema="$(yq -r '.onboarding.preset // .onboarding.schema // "github-pipeline/v1"' \
    "$(cli_target_file "${target}")")"
  sh="$(yq -r '.onboarding.self_hosting // false' \
    "$(cli_target_file "${target}")")"

  printf '[%s] target=%s  self_hosting=%s\n\n' "${schema}" "${target}" "${sh}"

  local total=0 pass=0 fail=0 warn=0 skip=0
  local status id severity message remediation color reset
  reset="$(_onb_color reset)"
  while IFS=$'\t' read -r status id severity message remediation; do
    [ -n "${status}" ] || continue
    color="$(_onb_status_color "${status}")"
    printf '%s%-4s%s  %-36s  %s\n' "${color}" "${status}" "${reset}" "${id}" "${message}"
    if [ "${status}" = "FAIL" ] && [ -n "${remediation}" ]; then
      printf '      %s→ %s%s\n' "$(_onb_color gray)" "${remediation}" "${reset}"
    fi
    total=$((total + 1))
    case "${status}" in
      PASS) pass=$((pass + 1)) ;;
      FAIL) fail=$((fail + 1)) ;;
      WARN) warn=$((warn + 1)) ;;
      SKIP) skip=$((skip + 1)) ;;
    esac
  done <<<"${body}"

  printf '\n%d pass, %d fail (block), %d warn, %d skip\n' \
    "${pass}" "${fail}" "${warn}" "${skip}"
}

_onb_to_json() {
  local target="$1" body="$2" rc="$3"
  local schema sh
  schema="$(yq -r '.onboarding.preset // .onboarding.schema // "github-pipeline/v1"' \
    "$(cli_target_file "${target}")")"
  sh="$(yq -r '.onboarding.self_hosting // false' \
    "$(cli_target_file "${target}")")"

  jq -n \
    --arg target "${target}" \
    --arg schema "${schema}" \
    --argjson self_hosting "$([ "${sh}" = "true" ] && echo true || echo false)" \
    --argjson exit_code "${rc}" \
    --rawfile body <(printf '%s' "${body}") \
    '
    {
      target: $target,
      schema: $schema,
      self_hosting: $self_hosting,
      exit_code: $exit_code,
      items: ($body | split("\n") | map(select(length > 0)) | map(
        split("\t") | {
          status: .[0],
          id: .[1],
          severity: .[2],
          message: .[3],
          remediation: (.[4] // "")
        }
      ))
    }'
}

onboarding_ack_run() {
  local target="$1" ack_key="$2"
  shift 2
  cli_require_target_file "${target}"
  cli_require_cmd yq

  local note="" unset=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --note) note="${2:-}"; shift 2 ;;
      --unset) unset=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) cli_die "unknown ack argument: $1" ;;
    esac
  done

  case "${ack_key}" in
    *' '*|*$'\t'*|*$'\n'*) cli_die "ack_key must not contain whitespace" ;;
    '') cli_die "ack_key required" ;;
  esac
  if ! printf '%s' "${ack_key}" | grep -Eq '^[A-Za-z][A-Za-z0-9_]*$'; then
    cli_die "ack_key must match [A-Za-z][A-Za-z0-9_]* (got: ${ack_key})"
  fi

  local file ts
  file="$(cli_target_file "${target}")"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ "${unset}" -eq 1 ]; then
    yq -i "del(.onboarding.acks.\"${ack_key}\")" "${file}"
    printf 'onboarding ack removed: target=%s key=%s\n' "${target}" "${ack_key}"
    return 0
  fi

  # ack 키가 preset 에 등록된 것인지 가벼운 검증 (warn-only).
  _onb_load_engine
  local schema
  schema="$(yq -r '.onboarding.preset // .onboarding.schema // "github-pipeline/v1"' "${file}")"
  if onboarding_preset_load "${schema}" 2>/dev/null; then
    if ! preset_items | awk -F'\t' -v k="${ack_key}" '$6==k {found=1} END{exit !found}' \
        ; then
      cli_warn "ack_key '${ack_key}' is not declared in preset ${schema} (saved anyway)"
    fi
  fi

  if [ -n "${note}" ]; then
    # strenv 로 yq 표현식 인젝션과 YAML 이스케이프 재해석을 동시에 차단.
    # ack_key 는 위에서 정규식으로 이미 검증됨.
    NOTE_VAL="${note}" yq -i \
      ".onboarding.acks.\"${ack_key}\" = {\"value\": true, \"note\": strenv(NOTE_VAL), \"ts\": \"${ts}\"}" \
      "${file}"
  else
    yq -i ".onboarding.acks.\"${ack_key}\" = {\"value\": true, \"ts\": \"${ts}\"}" \
      "${file}"
  fi
  printf 'onboarding ack set: target=%s key=%s\n' "${target}" "${ack_key}"
}

onboarding_list_schemas_run() {
  _onb_load_engine
  local schema
  while IFS= read -r schema; do
    [ -n "${schema}" ] || continue
    printf '%s\n' "${schema}"
    if onboarding_preset_load "${schema}" 2>/dev/null; then
      preset_items | awk -F'\t' '{
        printf "  - %-36s kind=%s severity=%s sh_only=%s\n", $1, $2, $3, $4
      }'
    fi
  done < <(onboarding_list_schemas)
}

onboarding_wizard_run() {
  local target="$1"
  cli_require_target_file "${target}"
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    cli_die "wizard requires an interactive TTY" 2
  fi
  _onb_load_engine

  local body
  body="$(onboarding_verify "${target}" || true)"

  local file
  file="$(cli_target_file "${target}")"

  printf 'Onboarding wizard for target=%s\n\n' "${target}"

  local schema
  schema="$(yq -r '.onboarding.preset // .onboarding.schema // "github-pipeline/v1"' "${file}")"
  onboarding_preset_load "${schema}" || cli_die "failed to load preset ${schema}"

  # preset items 의 kind/ack_key 를 lookup 테이블로.
  declare -A KIND ACK_KEY
  local id kind severity sh_only auto_fn ack_key summary
  while IFS=$'\t' read -r id kind severity sh_only auto_fn ack_key summary; do
    [ -n "${id}" ] || continue
    [ "${ack_key}" = "-" ] && ack_key=""
    KIND[$id]="${kind}"
    ACK_KEY[$id]="${ack_key}"
  done < <(preset_items)

  local pending=0
  local status item_id item_severity item_message item_remediation
  while IFS=$'\t' read -r status item_id item_severity item_message item_remediation; do
    [ "${status}" = "FAIL" ] || continue
    pending=$((pending + 1))
    printf '─── [%d] %s ─────────────────────────────\n' "${pending}" "${item_id}"
    printf '  severity: %s\n' "${item_severity}"
    printf '  current : %s\n' "${item_message}"
    [ -n "${item_remediation}" ] && printf '  fix     : %s\n' "${item_remediation}"

    local k="${KIND[$item_id]:-}" ak="${ACK_KEY[$item_id]:-}"
    if { [ "${k}" = "ack" ] || [ "${k}" = "auto_or_ack" ]; } && [ -n "${ak}" ]; then
      printf '\n  ack key: %s\n' "${ak}"
      printf '  Ack now? [y/N/skip]: '
      local answer
      read -r answer || answer=""
      case "${answer}" in
        y|Y|yes)
          printf '  note (optional, ENTER to skip): '
          local note
          read -r note || note=""
          if [ -n "${note}" ]; then
            onboarding_ack_run "${target}" "${ak}" --note "${note}"
          else
            onboarding_ack_run "${target}" "${ak}"
          fi
          ;;
        *) printf '  → skipped\n' ;;
      esac
    else
      printf '\n  (auto-only check — fix the underlying state then re-run)\n'
    fi
    printf '\n'
  done <<<"${body}"

  if [ "${pending}" -eq 0 ]; then
    printf 'No pending FAIL items. Onboarding complete.\n'
    return 0
  fi

  printf 'Wizard finished. Re-run `llm-team onboarding status %s` to confirm.\n' "${target}"
}

cmd="${1:-}"
shift || true
case "${cmd}" in
  -h|--help|'') usage ;;
  status)
    target="${1:-}"
    [ -n "${target}" ] || cli_die "status requires <target>"
    shift
    want_json=0 quiet=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --json) want_json=1; shift ;;
        --quiet) quiet=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) cli_die "unknown status argument: $1" ;;
      esac
    done
    onboarding_status_run "${target}" "${want_json}" "${quiet}"
    ;;
  ack)
    target="${1:-}"; ack_key="${2:-}"
    [ -n "${target}" ] && [ -n "${ack_key}" ] || cli_die "ack requires <target> <ack_key>"
    shift 2
    onboarding_ack_run "${target}" "${ack_key}" "$@"
    ;;
  list-schemas)
    onboarding_list_schemas_run
    ;;
  wizard)
    target="${1:-}"
    [ -n "${target}" ] || cli_die "wizard requires <target>"
    onboarding_wizard_run "${target}"
    ;;
  *) cli_die "unknown onboarding command: ${cmd}" ;;
esac
