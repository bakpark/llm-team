#!/usr/bin/env bash
# adapters/notifier/slack.sh
#
# Slack webhook notifier adapter.

# nt_send <kind> <url> <summary>
nt_send() {
  local kind="$1" url="$2" summary="$3"
  local target="${TARGET_NAME:-unknown}"

  local webhook
  if ! webhook="$(resolve_secret "${TARGET_NOTIFIER_REF}" 2>/dev/null)"; then
    log_warn "nt_send(slack): webhook secret '${TARGET_NOTIFIER_REF}' missing; skipping"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "nt_send(slack): curl not available; skipping"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log_warn "nt_send(slack): jq not available; skipping"
    return 1
  fi

  local payload
  payload="$(jq -n \
    --arg t "${target}" \
    --arg k "${kind}" \
    --arg u "${url}" \
    --arg s "${summary}" \
    '{blocks: [
       {type: "header", text: {type: "plain_text", text: ("[" + $t + "] " + $k + " — Human Review Required")}},
       {type: "section", text: {type: "mrkdwn", text: ("<" + $u + "|GitHub Link>\n\n" + $s)}}
     ]}')"

  if curl -s --fail -X POST -H "Content-Type: application/json" \
       -d "${payload}" "${webhook}" >/dev/null; then
    return 0
  fi
  log_warn "nt_send(slack): webhook POST failed"
  return 1
}
